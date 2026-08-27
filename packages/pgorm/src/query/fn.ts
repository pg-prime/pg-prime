/**
 * Boolean combinators, ordering, aggregates and the full-text helpers (design/03 §2.4, §2.9).
 *
 * Kept out of `./ops.ts` for one reason and one reason only: fork F1 was a measurement, and
 * `ops-free.d.ts` had to hold the operator vocabulary and nothing else so its byte count meant
 * something (09 §3.0). These names are spelled identically in both arms, so they never belonged
 * to the fork.
 *
 * **The aggregates are where PostgreSQL disagrees with intuition, and with `03`.** `sum(int4)` is
 * `bigint`; `sum(int8)` and `sum(numeric)` are `numeric`; `avg` is `numeric` for every exact type
 * but `float8` for the two inexact ones. `03` §2.9 says "avg(anything) → numeric", which is wrong
 * for `float4`/`float8` — found by the OID differential in `test/live-query/ops.test.ts`, which
 * asks the server rather than the docs. Kysely returns `string | number | bigint` for these
 * because it cannot know the driver (kysely.md §5.2(2)); owning the codecs makes it exact.
 */

import type { AnyCodec } from '../codec/index.js'
import {
  float4Codec,
  float8Codec,
  int8Codec,
  numericCodec,
  textCodec,
  timestamptzCodec,
  tsqueryCodec,
  tsvectorCodec,
  unknownCodec,
} from '../codec/index.js'
import type { OrderItem } from '../compile/ast.js'
import {
  agg as aggNode,
  and as andNode,
  cast as castNode,
  exists as existsNode,
  fn as fnNode,
  isAstNode,
  not as notNode,
  or as orNode,
  order as orderNode,
  param,
} from '../compile/nodes.js'
import { codecOf } from '../compile/hoist.js'
import { isFragment, toNode } from '../sql/fragment.js'
import { BuilderError } from '../sql/errors.js'
import { queryAstOf } from './nominal.js'
import type { QuerySource } from './nominal.js'
import { toExprNode } from './projection.js'
import type {
  AnyOperand,
  AvgOut,
  AvgPg,
  NumOperand,
  NumPg,
  Order,
  SumOut,
  SumPg,
} from './ops.types.js'
import type { OUT } from '../schema/index.js'
import type { Expr, ExprOf } from './types.js'

/**
 * An operand → an AST expression, with **no `param()` fallback**.
 *
 * Everything in this file takes expressions, never data: `and(a, b)` combines predicates,
 * `desc(x)` orders by a column. Falling back to `param(v, unknownCodec)` turned a typo into
 * silently valid SQL — `and(x, undefined)` compiled to `x and $1` with a NULL bind, so the query
 * returned zero rows, and `desc('id')` ordered by the *constant* `$1`, which is no ordering at
 * all. Both are cases the type layer rejects; this is the backstop for the untyped caller, and
 * `03` §2.4's contract is that a non-expression is an error, not a guess.
 */
function node(v: unknown, where: string): import('../compile/ast.js').Expr {
  return toExprNode(v, where)
}

function codecOfOperand(v: unknown): AnyCodec {
  if (isAstNode(v)) return codecOf(v)
  if (isFragment(v)) return codecOf(toNode(v))
  return unknownCodec
}

// ─────────────────────────────────────────────────────────────────────────────
// Boolean combinators (03 §2.4)
//
// n-ary, not a right-leaning spine of binary nodes: `and(a, b, c)` emits `(a and b and c)` with
// one paren pair in one pass, and the empty case has a defined identity — `and()` is `true`,
// `or()` is `false`, which is what makes `and(...conditions.filter(Boolean))` safe when every
// condition happens to be absent.
// ─────────────────────────────────────────────────────────────────────────────

export function and(...xs: readonly ExprOf<boolean>[]): Expr<boolean, 'bool'> {
  return andNode(...xs.map((x, i) => node(x, `and() argument ${i + 1}`))) as unknown as Expr<
    boolean,
    'bool'
  >
}
export function or(...xs: readonly ExprOf<boolean>[]): Expr<boolean, 'bool'> {
  return orNode(...xs.map((x, i) => node(x, `or() argument ${i + 1}`))) as unknown as Expr<
    boolean,
    'bool'
  >
}
export function not(x: ExprOf<boolean>): Expr<boolean, 'bool'> {
  return notNode(node(x, 'not()')) as unknown as Expr<boolean, 'bool'>
}
/** `exists (select …)`. Takes a select builder, a set operation, or a hand-built node. */
export function exists(q: QuerySource): Expr<boolean, 'bool'> {
  return existsNode(queryAstOf(q, 'exists()') as never) as unknown as Expr<boolean, 'bool'>
}
export function notExists(q: QuerySource): Expr<boolean, 'bool'> {
  return existsNode(queryAstOf(q, 'notExists()') as never, true) as unknown as Expr<boolean, 'bool'>
}

// ─────────────────────────────────────────────────────────────────────────────
// Ordering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `NULLS FIRST` / `NULLS LAST` is a **keyword pair the compiler emits verbatim**, so the value is
 * checked against the closed set here rather than trusted from the TS union: an unchecked
 * `asc(u.id, 'last limit 1 offset (select …)')` executed exactly as written.
 */
function nullsOf(v: unknown, where: string): 'first' | 'last' | undefined {
  if (v === undefined) return undefined
  if (v === 'first' || v === 'last') return v
  throw new BuilderError(
    `pgorm: ${where} takes 'first' or 'last' (got ${JSON.stringify(v)}). The NULLS position is a ` +
      `SQL keyword, emitted as written, so pgorm will not pass an unrecognised one through.`,
  )
}

export function asc(a: AnyOperand, nulls?: 'first' | 'last'): Order {
  return orderNode(node(a, 'asc()'), 'asc', nullsOf(nulls, "asc(x, nulls)")) as unknown as Order
}
export function desc(a: AnyOperand, nulls?: 'first' | 'last'): Order {
  return orderNode(node(a, 'desc()'), 'desc', nullsOf(nulls, "desc(x, nulls)")) as unknown as Order
}

/** Escape hatch for WS4: an `Order` is an `OrderItem`. */
export function toOrderItem(o: Order): OrderItem {
  return o as unknown as OrderItem
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `sum`'s result type, by operand type. The type-level twin is `SumPg` in `./ops.types.ts`;
 * `test/query/ops.test.ts` asserts the two tables agree row for row so they cannot drift.
 */
const SUM_RESULT: Readonly<Record<string, AnyCodec>> = {
  int2: int8Codec as AnyCodec,
  int4: int8Codec as AnyCodec,
  int8: numericCodec as AnyCodec,
  numeric: numericCodec as AnyCodec,
  float4: float4Codec as AnyCodec,
  float8: float8Codec as AnyCodec,
}

/** `avg` is `numeric` everywhere except the two inexact types, where it is `float8`. */
const AVG_RESULT: Readonly<Record<string, AnyCodec>> = {
  int2: numericCodec as AnyCodec,
  int4: numericCodec as AnyCodec,
  int8: numericCodec as AnyCodec,
  numeric: numericCodec as AnyCodec,
  float4: float8Codec as AnyCodec,
  float8: float8Codec as AnyCodec,
}

export interface Fn {
  /** `count(*)` with no argument, `count(x)` with one. Always `int8`, hence `bigint`. */
  count(a?: AnyOperand): Expr<bigint, 'int8'>
  sum<T, P extends NumPg>(a: NumOperand<T, P>): Expr<SumOut<P> | null, SumPg<P>>
  avg<T, P extends NumPg>(a: NumOperand<T, P>): Expr<AvgOut<P> | null, AvgPg<P>>
  min<A extends AnyOperand>(a: A): Expr<A[typeof OUT] | null>
  max<A extends AnyOperand>(a: A): Expr<A[typeof OUT] | null>
  /**
   * The ranking window functions. Legal only inside an `OVER (...)`, which is `over(...)` in
   * `./window.ts` — WS4 gave them their golden; the codec claim was already confirmed in WS3 by
   * the differential against hand-written `select rank() over ()`.
   */
  rank(): Expr<bigint, 'int8'>
  denseRank(): Expr<bigint, 'int8'>
  rowNumber(): Expr<bigint, 'int8'>
  /** `now()` — `transaction_timestamp()`, i.e. constant within a transaction. */
  now(): Expr<Date, 'timestamptz'>

  // ── full-text helpers (03 §2.9, closing paragraph) ────────────────────────
  /**
   * `to_tsvector($1::regconfig, x)`.
   *
   * The configuration is a **parameter cast to `regconfig`**, never spliced text. Without the
   * cast PostgreSQL sees `to_tsvector(text, text)`, which does not exist (42883); with the config
   * interpolated instead, a caller-supplied language name would be SQL text. One node solves both.
   */
  toTsvector(config: string, a: AnyOperand): Expr<unknown, 'tsvector'>
  toTsquery(config: string, q: string): Expr<unknown, 'tsquery'>
  plaintoTsquery(config: string, q: string): Expr<unknown, 'tsquery'>
  phrasetoTsquery(config: string, q: string): Expr<unknown, 'tsquery'>
  websearchToTsquery(config: string, q: string): Expr<unknown, 'tsquery'>
}

function regconfig(config: string): import('../compile/ast.js').Expr {
  return castNode(param(config, textCodec), 'regconfig', unknownCodec)
}

function tsquery(name: string, config: string, q: string): Expr<unknown, 'tsquery'> {
  return fnNode(name, [regconfig(config), param(q, textCodec)], tsqueryCodec) as unknown as Expr<
    unknown,
    'tsquery'
  >
}

export const fn: Fn = {
  // `count()` and `count(undefined)` are different questions: the first is `count(*)`, the second
  // is a typo — `fn.count(u.typoed)` used to compile to `count(*)` and report the wrong number.
  // Arity, not the value, is what tells them apart.
  count(...a: [] | [AnyOperand]) {
    return (
      a.length === 0
        ? aggNode('count', [], int8Codec as AnyCodec, { star: true })
        : aggNode('count', [node(a[0], 'count()')], int8Codec as AnyCodec)
    ) as unknown as Expr<bigint, 'int8'>
  },
  sum(a) {
    const codec = codecOfOperand(a)
    return aggNode('sum', [node(a, 'sum()')], SUM_RESULT[codec.name] ?? codec) as never
  },
  avg(a) {
    const codec = codecOfOperand(a)
    return aggNode('avg', [node(a, 'avg()')], AVG_RESULT[codec.name] ?? numericCodec) as never
  },
  min(a) {
    return aggNode('min', [node(a, 'min()')], codecOfOperand(a)) as never
  },
  max(a) {
    return aggNode('max', [node(a, 'max()')], codecOfOperand(a)) as never
  },
  rank() {
    return fnNode('rank', [], int8Codec as AnyCodec) as unknown as Expr<bigint, 'int8'>
  },
  denseRank() {
    return fnNode('dense_rank', [], int8Codec as AnyCodec) as unknown as Expr<bigint, 'int8'>
  },
  rowNumber() {
    return fnNode('row_number', [], int8Codec as AnyCodec) as unknown as Expr<bigint, 'int8'>
  },
  now() {
    return fnNode('now', [], timestamptzCodec as AnyCodec) as unknown as Expr<Date, 'timestamptz'>
  },
  toTsvector(config, a) {
    return fnNode('to_tsvector', [regconfig(config), node(a, 'toTsvector()')], tsvectorCodec) as unknown as Expr<
      unknown,
      'tsvector'
    >
  },
  toTsquery: (config, q) => tsquery('to_tsquery', config, q),
  plaintoTsquery: (config, q) => tsquery('plainto_tsquery', config, q),
  phrasetoTsquery: (config, q) => tsquery('phraseto_tsquery', config, q),
  websearchToTsquery: (config, q) => tsquery('websearch_to_tsquery', config, q),
}
