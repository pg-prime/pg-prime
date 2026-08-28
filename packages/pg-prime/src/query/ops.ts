/**
 * The PostgreSQL operator vocabulary — design/03 §2.9, as **free functions** (fork F1, 09 §3.0).
 *
 * ## The three promises
 *
 * 1. **The operand comes from the operator, not the column.** `jsonb ? text`, `tsvector @@
 *    tsquery`, `int4range @> int4`. `./ops.types.ts` holds the per-class operand table; this file
 *    holds the per-operator choice of which right-hand codec encodes the value.
 * 2. **Every operator carries an exact result codec.** `count → int8`, `sum(int4) → int8`,
 *    `sum(int8) → numeric`, `avg(float8) → float8`, `ts_rank → float4`, `array_length → int4`.
 *    Nothing here is a guess: `test/live-query/ops.test.ts` executes `select <expr>` for every row
 *    of {@link OPS} and asserts `fields[0].dataTypeID === <the codec's oid>`, so PostgreSQL's own
 *    inference is the oracle for the one thing a user cannot see.
 * 3. **Nothing a caller supplies reaches the SQL text.** Every key, path, pattern and probe
 *    document below goes through `param()`, i.e. `$n`. That is why `sanitizeJSONPathMemberValue`
 *    — the function at the centre of GHSA-wmrf-hv6w-mr66 and GHSA-pv5w-4p9q-p3v2 — has no
 *    analogue here: the CVE class is deleted rather than patched (03 §3.4, D7).
 *
 * ## Immutability
 *
 * Operators build; they never mutate. `bin()`/`fn()` freeze and register each node, and an operand
 * is used by reference, so `eq(u.id, 1n)` leaves `u.id` byte-identical and reusable. Pinned as a
 * property in `test/query/ops.test.ts`.
 */

import type { AnyCodec } from '../codec/index.js'
import type { CodecIn, CodecOut } from '../codec/index.js'
import {
  arrayCodecOf,
  boolCodec,
  dateCodec,
  float4Codec,
  int4Codec,
  int8Codec,
  jsonCodecJson,
  jsonbCodec,
  jsonpathCodec,
  numericCodec,
  textCodec,
  timestampCodec,
  timestamptzCodec,
  tsqueryCodec,
  unknownCodec,
} from '../codec/index.js'
import type { BinaryOp, Expr as Node, SelectNode, SetOpNode } from '../compile/ast.js'
import {
  bin,
  cast as castNode,
  fn as fnNode,
  inAny,
  inList as inListNode,
  inQuery as inQueryNode,
  is as isNode,
  lit,
  mkNode,
  param,
} from '../compile/nodes.js'
import { codecOf } from '../compile/hoist.js'
import { isAstNode } from '../compile/nodes.js'
import { isFragment, toNode } from '../sql/fragment.js'
import { NullOperandError } from '../sql/errors.js'
import { queryAstOf } from './nominal.js'
import type { QuerySource } from './nominal.js'
import type { META, OUT } from '../schema/index.js'
import type {
  AnyOperand,
  ArrayOperand,
  BoolOperand,
  JsonOperand,
  JsonbOperand,
  NetOperand,
  NonNullOperand,
  NumOperand,
  NumPg,
  RangeElem,
  RangeElemPg,
  RangeOperand,
  RangePg,
  TextOperand,
  TsqueryOperand,
  TsvectorOperand,
} from './ops.types.js'
import type { Expr, ExprOf, Operand } from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Operand plumbing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coerce an operand to an AST expression.
 *
 * The classification is **nominal**, exactly as in the `sql` tag: a value is SQL iff it is in the
 * AST WeakSet or the fragment WeakMap. Anything else — including a structurally perfect copy of a
 * node produced by `JSON.parse` — is data, and data becomes `$n`.
 */
function toExpr(v: unknown, codec: AnyCodec): Node {
  if (isAstNode(v)) return v
  if (isFragment(v)) return toNode(v)
  return param(v, codec)
}

/** The codec describing an operand's result; `unknown` for a bare value or an untyped fragment. */
function codecOfOperand(v: unknown): AnyCodec {
  if (isAstNode(v)) return codecOf(v)
  if (isFragment(v)) return codecOf(toNode(v))
  return unknownCodec
}

/** `a <op> b`, with `b` encoded by `rhs` (default: whatever `a` is). */
function binary(
  op: BinaryOp,
  a: unknown,
  b: unknown,
  rhs: AnyCodec | undefined,
  result: AnyCodec,
): never | Node {
  return bin(op, toExpr(a, unknownCodec), toExpr(b, rhs ?? codecOfOperand(a)), result)
}

/** A predicate: same as {@link binary} but the result is always `bool`. */
function pred(op: BinaryOp, a: unknown, b: unknown, rhs?: AnyCodec): Node {
  return binary(op, a, b, rhs, boolCodec)
}

/**
 * The sub-select of `inQuery(a, q)`.
 *
 * Nominal, like everything else that decides SQL-vs-data here: `q` is a builder this library made
 * or a node `src/compile/nodes.ts` built, and a structurally identical plain object — a
 * `JSON.parse` of `{ k: 'select', projection: [{ expr: { k: 'raw', … } }] }`, say — is refused
 * instead of being handed to the emitter.
 */
function toSelect(q: QuerySource, where: string): SelectNode | SetOpNode {
  return queryAstOf(q, where)
}

/**
 * The right operand of a comparison, rejected when it is NULL.
 *
 * `eq` and `neq` did this from the start; `lt`/`lte`/`gt`/`gte` and the pattern operators did not,
 * so `gt(u.views, null)` compiled to `"views" > $1` with a NULL bind — always NULL, therefore
 * always no rows. Same defect, same answer: {@link NullOperandError} names the operator and points
 * at `isNull` / `isDistinctFrom`.
 */
function nonNull<T>(b: T, operator: string): T {
  if (b === null || b === undefined) throw new NullOperandError(operator)
  return b
}

/** `E[]` codec for an operand whose codec is the element's. */
function arrayOf(a: unknown): AnyCodec {
  return arrayCodecOf(codecOfOperand(a))
}

/** The element codec of an array operand — `text[]` → `text`. */
function elementOf(a: unknown): AnyCodec {
  return codecOfOperand(a).arrayOf ?? unknownCodec
}

const textArrayCodec = arrayCodecOf(textCodec)

// ─────────────────────────────────────────────────────────────────────────────
// Every class — comparison, null tests, membership (03 §2.9 row "all")
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `a = b`.
 *
 * `b` may not be the literal `null`, at the type level and at runtime: `a = NULL` is `NULL`, not
 * `false`, so the query would silently return nothing. See {@link NullOperandError} for why this
 * is a rejection and not a rewrite to `IS NULL`.
 *
 * `b` is typed by the column's **decoded** type (`TOut`), not by its codec's `TIn`. So
 * `gt(u.createdAt, '2026-01-01')` is a compile error even though `timestamptz.encode` accepts a
 * string: `TIn` is a *write* surface where the target type is unambiguous, but in a comparison a
 * widened `Date | string` would make `gt(u.createdAt, u.name)` compile — a `timestamptz` against a
 * `text` column — because `Expr<string>` is assignable to `ExprOf<Date | string>`. Pinned in
 * `test/query/types/ops.probe.ts`.
 */
export function eq<A extends AnyOperand>(
  a: A,
  b: NonNullOperand<A[typeof OUT]>,
): Expr<boolean, 'bool'> {
  if (b === null || b === undefined) throw new NullOperandError('eq')
  return pred('=', a, b) as unknown as Expr<boolean, 'bool'>
}

export function neq<A extends AnyOperand>(
  a: A,
  b: NonNullOperand<A[typeof OUT]>,
): Expr<boolean, 'bool'> {
  if (b === null || b === undefined) throw new NullOperandError('neq')
  return pred('<>', a, b) as unknown as Expr<boolean, 'bool'>
}

export function lt<A extends AnyOperand>(
  a: A,
  b: NonNullOperand<A[typeof OUT]>,
): Expr<boolean, 'bool'> {
  return pred('<', a, nonNull(b, 'lt')) as unknown as Expr<boolean, 'bool'>
}
export function lte<A extends AnyOperand>(
  a: A,
  b: NonNullOperand<A[typeof OUT]>,
): Expr<boolean, 'bool'> {
  return pred('<=', a, nonNull(b, 'lte')) as unknown as Expr<boolean, 'bool'>
}
export function gt<A extends AnyOperand>(
  a: A,
  b: NonNullOperand<A[typeof OUT]>,
): Expr<boolean, 'bool'> {
  return pred('>', a, nonNull(b, 'gt')) as unknown as Expr<boolean, 'bool'>
}
export function gte<A extends AnyOperand>(
  a: A,
  b: NonNullOperand<A[typeof OUT]>,
): Expr<boolean, 'bool'> {
  return pred('>=', a, nonNull(b, 'gte')) as unknown as Expr<boolean, 'bool'>
}

/**
 * `a is distinct from b` — the null-safe comparison, and the reason `eq` can afford to reject
 * `null`. The operand is widened to `| null` even for a NOT NULL column, because
 * `x is distinct from null` is a meaningful (if verbose) way to write `x is not null`, and
 * because comparing a non-null column to a nullable one is exactly what this operator is for.
 */
export function isDistinctFrom<A extends AnyOperand>(
  a: A,
  b: Operand<A[typeof OUT] | null>,
): Expr<boolean, 'bool'> {
  return isNode(
    toExpr(a, unknownCodec),
    'distinct from',
    toExpr(b, codecOfOperand(a)),
  ) as unknown as Expr<boolean, 'bool'>
}

export function isNotDistinctFrom<A extends AnyOperand>(
  a: A,
  b: Operand<A[typeof OUT] | null>,
): Expr<boolean, 'bool'> {
  return isNode(
    toExpr(a, unknownCodec),
    'not distinct from',
    toExpr(b, codecOfOperand(a)),
  ) as unknown as Expr<boolean, 'bool'>
}

export function isNull(a: AnyOperand): Expr<boolean, 'bool'> {
  return isNode(toExpr(a, unknownCodec), 'null') as unknown as Expr<boolean, 'bool'>
}
export function isNotNull(a: AnyOperand): Expr<boolean, 'bool'> {
  return isNode(toExpr(a, unknownCodec), 'not null') as unknown as Expr<boolean, 'bool'>
}

/**
 * `a is true` / `a is false` and their negations — three-valued logic made explicit.
 *
 * Not the same as `eq(a, true)`: a NULL boolean compared with `=` yields NULL (so the row is
 * filtered out *and* `not(eq(a, true))` also filters it out), whereas `a is true` yields `false`
 * and `a is not true` yields `true`. That difference is the whole reason SQL has the form, and it
 * is why `03` §2.1 spells the predicate `published.isTrue()` rather than `published.eq(true)`.
 *
 * Gated on `bool` rather than taken as `ExprOf<boolean>` so a nullable `bool` column reaches it
 * (its `[OUT]` is `boolean | null`) and a `text` column does not.
 */
export function isTrue(a: BoolOperand): Expr<boolean, 'bool'> {
  return isNode(toExpr(a, boolCodec), 'true') as unknown as Expr<boolean, 'bool'>
}
export function isNotTrue(a: BoolOperand): Expr<boolean, 'bool'> {
  return isNode(toExpr(a, boolCodec), 'not true') as unknown as Expr<boolean, 'bool'>
}
export function isFalse(a: BoolOperand): Expr<boolean, 'bool'> {
  return isNode(toExpr(a, boolCodec), 'false') as unknown as Expr<boolean, 'bool'>
}
export function isNotFalse(a: BoolOperand): Expr<boolean, 'bool'> {
  return isNode(toExpr(a, boolCodec), 'not false') as unknown as Expr<boolean, 'bool'>
}

/**
 * `a between lo and hi`.
 *
 * Built through `mkNode`, like every other operator here. The object literal it used to return was
 * structurally a `BetweenNode` but was never registered, so it was not an AST node by the only
 * test that counts: `.where(between(…))` threw "not an expression", and inside `and(…)` it was
 * classified as *data* and JSON-encoded as a bind (a `bigint` operand then died in
 * `JSON.stringify`). `test/query/ops.test.ts` missed it because it called `compileExpr` directly.
 */
export function between<A extends AnyOperand>(
  a: A,
  lo: NonNullOperand<A[typeof OUT]>,
  hi: NonNullOperand<A[typeof OUT]>,
): Expr<boolean, 'bool'> {
  const codec = codecOfOperand(a)
  return mkNode({
    k: 'between' as const,
    e: toExpr(a, unknownCodec),
    lo: toExpr(nonNull(lo, 'between'), codec),
    hi: toExpr(nonNull(hi, 'between'), codec),
    symmetric: false,
    not: false,
  }) as unknown as Expr<boolean, 'bool'>
}

/**
 * `a = any($1)`, one parameter regardless of list length — so a hundred different list sizes
 * share one prepared plan instead of minting a hundred (03 §2.6).
 *
 * The empty list is the exception and compiles to the constant `false`, which PostgreSQL can
 * prune outright. That is a *shape* difference decided by a compile-time-known length, not by a
 * value, so `.compile()` stays deterministic: there are exactly two shapes, not N.
 */
export function inList<A extends AnyOperand>(
  a: A,
  xs: readonly NonNullable<A[typeof OUT]>[],
): Expr<boolean, 'bool'> {
  if (xs.length === 0)
    return inListNode(toExpr(a, unknownCodec), []) as unknown as Expr<boolean, 'bool'>
  return inAny(toExpr(a, unknownCodec), param(xs, arrayOf(a))) as unknown as Expr<boolean, 'bool'>
}

export function notInList<A extends AnyOperand>(
  a: A,
  xs: readonly NonNullable<A[typeof OUT]>[],
): Expr<boolean, 'bool'> {
  if (xs.length === 0)
    return inListNode(toExpr(a, unknownCodec), [], true) as unknown as Expr<boolean, 'bool'>
  return inAny(toExpr(a, unknownCodec), param(xs, arrayOf(a)), true) as unknown as Expr<
    boolean,
    'bool'
  >
}

export function inQuery(a: AnyOperand, q: QuerySource): Expr<boolean, 'bool'> {
  return inQueryNode(toExpr(a, unknownCodec), toSelect(q, 'inQuery()')) as unknown as Expr<
    boolean,
    'bool'
  >
}

/** `coalesce(a, b)` — the result cannot be null, so the type drops it. */
export function coalesce<A extends AnyOperand, P extends string = string>(
  a: A & { readonly [META]: { readonly pg: P } },
  b: NonNullOperand<NonNullable<A[typeof OUT]>>,
): Expr<NonNullable<A[typeof OUT]>, P> {
  const codec = codecOfOperand(a)
  return fnNode('coalesce', [toExpr(a, unknownCodec), toExpr(b, codec)], codec) as unknown as Expr<
    NonNullable<A[typeof OUT]>,
    P
  >
}

/**
 * An explicitly-typed parameter: `$n`, encoded and **declared** with `c`.
 *
 * The missing primitive without which a class-gated operator has no literal operand. A value
 * inside a `sql` template is a `$n` with no declared type (OID 0, "infer from context"), and
 * `.as(codec)` types the *fragment's result*, not the hole — so `` sql`${'[1,5)'}`.as(int4range) ``
 * is an untyped parameter wearing a range's clothes, and `int4range && $1` has no unique
 * resolution. `val('[1,5)', int4rangeCodec)` sends `Parse` with OID 3904 and the operator resolves.
 */
export function val<C extends AnyCodec>(v: CodecIn<C>, c: C): Expr<CodecOut<C>, C['name']> {
  return param(v, c) as unknown as Expr<CodecOut<C>, C['name']>
}

/**
 * `a::<codec.sqlName>`.
 *
 * The cast is spelled from the codec, so the SQL type and the decoder can never disagree — which
 * is the same guarantee `.as(codec)` gives a fragment, from the other direction.
 */
export function cast<A extends AnyOperand, C extends AnyCodec>(
  a: A,
  c: C,
): Expr<CodecOut<C> | Extract<A[typeof OUT], null>, C['name']> {
  // `NULL::text` is NULL. The cast changes the type, never the nullability, so the operand's
  // `| null` is threaded through rather than dropped — dropping it made a left-joined column
  // read as non-nullable in the result type.
  return castNode(toExpr(a, unknownCodec), c.sqlName, c) as unknown as Expr<
    CodecOut<C> | Extract<A[typeof OUT], null>,
    C['name']
  >
}

// ─────────────────────────────────────────────────────────────────────────────
// text / citext (03 §2.9 row "text")
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The pattern operand of `like`/`ilike`/`^@` is encoded with the LEFT operand's codec, so a
 * `citext` column keeps `citext ~~ citext` (case-insensitive) instead of being down-cast to
 * `text ~~ text` by a parameter we declared too narrowly. The regex family is different: PG has
 * no `citext ~ citext`, only `text ~ text`, so those pass `text` explicitly.
 */
export function like(a: TextOperand, p: Operand<string>): Expr<boolean, 'bool'> {
  return pred('like', a, nonNull(p, 'like')) as unknown as Expr<boolean, 'bool'>
}
export function ilike(a: TextOperand, p: Operand<string>): Expr<boolean, 'bool'> {
  return pred('ilike', a, nonNull(p, 'ilike')) as unknown as Expr<boolean, 'bool'>
}
export function notLike(a: TextOperand, p: Operand<string>): Expr<boolean, 'bool'> {
  return pred('not like', a, nonNull(p, 'notLike')) as unknown as Expr<boolean, 'bool'>
}
export function notILike(a: TextOperand, p: Operand<string>): Expr<boolean, 'bool'> {
  return pred('not ilike', a, nonNull(p, 'notILike')) as unknown as Expr<boolean, 'bool'>
}
/** `a ^@ p` — prefix match, index-backed by an SP-GiST or a `text_pattern_ops` btree. */
export function startsWith(a: TextOperand, p: Operand<string>): Expr<boolean, 'bool'> {
  return pred('^@', a, nonNull(p, 'startsWith')) as unknown as Expr<boolean, 'bool'>
}
export function regex(a: TextOperand, p: Operand<string>): Expr<boolean, 'bool'> {
  return pred('~', a, p, textCodec) as unknown as Expr<boolean, 'bool'>
}
export function iregex(a: TextOperand, p: Operand<string>): Expr<boolean, 'bool'> {
  return pred('~*', a, p, textCodec) as unknown as Expr<boolean, 'bool'>
}
export function notRegex(a: TextOperand, p: Operand<string>): Expr<boolean, 'bool'> {
  return pred('!~', a, p, textCodec) as unknown as Expr<boolean, 'bool'>
}
export function notIRegex(a: TextOperand, p: Operand<string>): Expr<boolean, 'bool'> {
  return pred('!~*', a, p, textCodec) as unknown as Expr<boolean, 'bool'>
}
export function similarTo(a: TextOperand, p: Operand<string>): Expr<boolean, 'bool'> {
  return pred('similar to', a, p, textCodec) as unknown as Expr<boolean, 'bool'>
}
/** `a || b` — text concatenation. `NULL || 'x'` is NULL, so the operand's nullability survives. */
export function concat<A extends TextOperand>(
  a: A,
  b: Operand<string>,
): Expr<string | Extract<A[typeof OUT], null>, 'text'> {
  return binary('||', a, b, textCodec, textCodec) as unknown as Expr<
    string | Extract<A[typeof OUT], null>,
    'text'
  >
}

// ─────────────────────────────────────────────────────────────────────────────
// array (03 §2.9 row "array T[]")
// ─────────────────────────────────────────────────────────────────────────────

export function overlaps<E>(a: ArrayOperand<E>, b: Operand<readonly E[]>): Expr<boolean, 'bool'> {
  return pred('&&', a, b) as unknown as Expr<boolean, 'bool'>
}
export function arrayContains<E>(
  a: ArrayOperand<E>,
  b: Operand<readonly E[]>,
): Expr<boolean, 'bool'> {
  return pred('@>', a, b) as unknown as Expr<boolean, 'bool'>
}
export function arrayContainedBy<E>(
  a: ArrayOperand<E>,
  b: Operand<readonly E[]>,
): Expr<boolean, 'bool'> {
  return pred('<@', a, b) as unknown as Expr<boolean, 'bool'>
}
/** `$1 = any(a)` — one scalar against the array, encoded with the array's ELEMENT codec. */
export function has<E>(a: ArrayOperand<E>, v: Operand<E>): Expr<boolean, 'bool'> {
  return inAny(toExpr(v, elementOf(a)), toExpr(a, unknownCodec)) as unknown as Expr<boolean, 'bool'>
}
/** `a @> $1` — every element of `b` is in `a`. */
export function hasAll<E>(a: ArrayOperand<E>, b: Operand<readonly E[]>): Expr<boolean, 'bool'> {
  return pred('@>', a, b) as unknown as Expr<boolean, 'bool'>
}
/** `array_length(a, 1)` → `int4`, and `null` for an empty array (PostgreSQL's own answer). */
export function arrayLength(a: ArrayOperand<unknown>): Expr<number | null, 'int4'> {
  return fnNode(
    'array_length',
    [toExpr(a, unknownCodec), lit(1, int4Codec)],
    int4Codec,
  ) as unknown as Expr<number | null, 'int4'>
}
export function arrayConcat<E, P extends string>(
  a: ArrayOperand<E> & { readonly [META]: { readonly pg: P } },
  b: Operand<readonly E[]>,
): Expr<E[], P> {
  const codec = codecOfOperand(a)
  return binary('||', a, b, codec, codec) as unknown as Expr<E[], P>
}
/** `any(a)` — an operand, not a predicate: `eq(u.name, anyOf(u.tags))`. */
export function anyOf<E>(a: ArrayOperand<E>): ExprOf<E> {
  return fnNode('any', [toExpr(a, unknownCodec)], elementOf(a)) as unknown as ExprOf<E>
}
export function allOf<E>(a: ArrayOperand<E>): ExprOf<E> {
  return fnNode('all', [toExpr(a, unknownCodec)], elementOf(a)) as unknown as ExprOf<E>
}

// ─────────────────────────────────────────────────────────────────────────────
// json / jsonb (03 §2.9 row "jsonb")
//
// EVERY key, path and probe document below is a `$n`. See the module docblock, and 03 §3.4 D7.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `a -> $1`.
 *
 * PostgreSQL has two `->` operators — `jsonb -> text` (object key) and `jsonb -> integer` (array
 * index) — so the parameter's declared type is chosen from the JavaScript type of the key. Sending
 * a number under `text` would make `textCodec.encode` throw; sending it untyped would make PG pick
 * the key overload and return `null` for every array.
 */
export function jsonGet(a: JsonOperand, k: string | number): Expr<unknown, 'json' | 'jsonb'> {
  return binary('->', a, k, keyCodec(k), jsonCodecOf(a)) as unknown as Expr<
    unknown,
    'json' | 'jsonb'
  >
}

/**
 * `json -> k` yields **json**; `jsonb -> k` yields **jsonb**. Different OIDs (114 vs 3802), so a
 * hard-coded `jsonb` here would make `assertShape` reject every accessor on a `json` column.
 */
function jsonCodecOf(a: unknown): AnyCodec {
  const codec = codecOfOperand(a)
  return codec.name === 'json' ? jsonCodecJson : jsonbCodec
}
export function jsonGetText(a: JsonOperand, k: string | number): Expr<string | null, 'text'> {
  return binary('->>', a, k, keyCodec(k), textCodec) as unknown as Expr<string | null, 'text'>
}
function keyCodec(k: string | number): AnyCodec {
  return typeof k === 'number' ? int4Codec : textCodec
}

/** `a #> $1` — the path is ONE `text[]` parameter, never spliced text. */
export function jsonPath(a: JsonOperand, path: readonly string[]): Expr<unknown, 'json' | 'jsonb'> {
  return binary('#>', a, path, textArrayCodec, jsonCodecOf(a)) as unknown as Expr<
    unknown,
    'json' | 'jsonb'
  >
}
export function jsonPathText(a: JsonOperand, path: readonly string[]): Expr<string | null, 'text'> {
  return binary('#>>', a, path, textArrayCodec, textCodec) as unknown as Expr<string | null, 'text'>
}
export function jsonContains(a: JsonbOperand, doc: unknown): Expr<boolean, 'bool'> {
  return pred('@>', a, doc, jsonbCodec) as unknown as Expr<boolean, 'bool'>
}
export function jsonContainedBy(a: JsonbOperand, doc: unknown): Expr<boolean, 'bool'> {
  return pred('<@', a, doc, jsonbCodec) as unknown as Expr<boolean, 'bool'>
}
/** `a ? $1` — key existence. The operand is TEXT, which is exactly the Kysely defect. */
export function hasKey(a: JsonbOperand, k: Operand<string>): Expr<boolean, 'bool'> {
  return pred('?', a, k, textCodec) as unknown as Expr<boolean, 'bool'>
}
export function hasAnyKey(a: JsonbOperand, ks: readonly string[]): Expr<boolean, 'bool'> {
  return pred('?|', a, ks, textArrayCodec) as unknown as Expr<boolean, 'bool'>
}
export function hasAllKeys(a: JsonbOperand, ks: readonly string[]): Expr<boolean, 'bool'> {
  return pred('?&', a, ks, textArrayCodec) as unknown as Expr<boolean, 'bool'>
}
/** `a @? $1` — does the SQL/JSON path match anything? The path is a `jsonpath` parameter. */
export function jsonPathExists(a: JsonbOperand, jp: Operand<string>): Expr<boolean, 'bool'> {
  return pred('@?', a, jp, jsonpathCodec) as unknown as Expr<boolean, 'bool'>
}
/** `a @@ $1` — does the SQL/JSON path predicate evaluate to true? */
export function jsonPathMatch(a: JsonbOperand, jp: Operand<string>): Expr<boolean, 'bool'> {
  return pred('@@', a, jp, jsonpathCodec) as unknown as Expr<boolean, 'bool'>
}
export function jsonConcat(a: JsonbOperand, b: unknown): Expr<unknown, 'jsonb'> {
  return binary('||', a, b, jsonbCodec, jsonbCodec) as unknown as Expr<unknown, 'jsonb'>
}
/** `a - $1` — delete a key (or, with a `text[]`, several). */
export function jsonDelete(a: JsonbOperand, k: Operand<string>): Expr<unknown, 'jsonb'> {
  return binary('-', a, k, textCodec, jsonbCodec) as unknown as Expr<unknown, 'jsonb'>
}
/** `a #- $1` — delete at a path. */
export function jsonDeletePath(a: JsonbOperand, path: readonly string[]): Expr<unknown, 'jsonb'> {
  return binary('#-', a, path, textArrayCodec, jsonbCodec) as unknown as Expr<unknown, 'jsonb'>
}

// ─────────────────────────────────────────────────────────────────────────────
// numeric / int (03 §2.9 row "numeric/int") — "result codec preserved"
// ─────────────────────────────────────────────────────────────────────────────

function arith<T, P extends NumPg>(op: BinaryOp, a: NumOperand<T, P>, b: Operand<T>): Expr<T, P> {
  const codec = codecOfOperand(a)
  return binary(op, a, b, codec, codec) as unknown as Expr<T, P>
}

export const add = <T, P extends NumPg>(a: NumOperand<T, P>, b: Operand<T>): Expr<T, P> =>
  arith('+', a, b)
export const sub = <T, P extends NumPg>(a: NumOperand<T, P>, b: Operand<T>): Expr<T, P> =>
  arith('-', a, b)
export const mul = <T, P extends NumPg>(a: NumOperand<T, P>, b: Operand<T>): Expr<T, P> =>
  arith('*', a, b)
/** Integer operands mean INTEGER division — `div(int4, int4)` is `int4`, and `7 / 2` is `3`. */
export const div = <T, P extends NumPg>(a: NumOperand<T, P>, b: Operand<T>): Expr<T, P> =>
  arith('/', a, b)
export const mod = <T, P extends NumPg>(a: NumOperand<T, P>, b: Operand<T>): Expr<T, P> =>
  arith('%', a, b)

export function abs<T, P extends NumPg>(a: NumOperand<T, P>): Expr<T, P> {
  const codec = codecOfOperand(a)
  return fnNode('abs', [toExpr(a, unknownCodec)], codec) as unknown as Expr<T, P>
}

// ─────────────────────────────────────────────────────────────────────────────
// tsvector (03 §2.9 row "tsvector")
// ─────────────────────────────────────────────────────────────────────────────

/** `a @@ q`. The right operand is a **tsquery**, never a string — the Kysely defect again. */
export function matches(a: TsvectorOperand, q: TsqueryOperand): Expr<boolean, 'bool'> {
  return pred('@@', a, q, tsqueryCodec) as unknown as Expr<boolean, 'bool'>
}
/** `ts_rank(a, q)` → **float4** (`real`), not float8. Confirmed by the OID differential. */
export function tsRank(a: TsvectorOperand, q: TsqueryOperand): Expr<number, 'float4'> {
  return fnNode(
    'ts_rank',
    [toExpr(a, unknownCodec), toExpr(q, tsqueryCodec)],
    float4Codec,
  ) as unknown as Expr<number, 'float4'>
}
export function tsRankCd(a: TsvectorOperand, q: TsqueryOperand): Expr<number, 'float4'> {
  return fnNode(
    'ts_rank_cd',
    [toExpr(a, unknownCodec), toExpr(q, tsqueryCodec)],
    float4Codec,
  ) as unknown as Expr<number, 'float4'>
}

// ─────────────────────────────────────────────────────────────────────────────
// range (03 §2.9 row "range")
// ─────────────────────────────────────────────────────────────────────────────

export function rangeOverlaps<P extends RangePg>(
  a: RangeOperand<P>,
  b: Operand<string>,
): Expr<boolean, 'bool'> {
  return pred('&&', a, b) as unknown as Expr<boolean, 'bool'>
}
/** `a @> b` — `b` is the range's ELEMENT or another range; PG resolves the two `@>` overloads. */
export function rangeContains<P extends RangePg>(
  a: RangeOperand<P>,
  b: Operand<string> | Operand<RangeElem<P>>,
): Expr<boolean, 'bool'> {
  return pred('@>', a, b) as unknown as Expr<boolean, 'bool'>
}
export function rangeContainedBy<P extends RangePg>(
  a: RangeOperand<P>,
  b: Operand<string>,
): Expr<boolean, 'bool'> {
  return pred('<@', a, b) as unknown as Expr<boolean, 'bool'>
}
/** `a << b` — strictly left of. For `inet` the same token means "is contained by"; the gate is
 *  the only thing that keeps the two apart, which is this whole section's point. */
export function strictlyLeft<P extends RangePg>(
  a: RangeOperand<P>,
  b: Operand<string>,
): Expr<boolean, 'bool'> {
  return pred('<<', a, b) as unknown as Expr<boolean, 'bool'>
}
export function strictlyRight<P extends RangePg>(
  a: RangeOperand<P>,
  b: Operand<string>,
): Expr<boolean, 'bool'> {
  return pred('>>', a, b) as unknown as Expr<boolean, 'bool'>
}
export function adjacent<P extends RangePg>(
  a: RangeOperand<P>,
  b: Operand<string>,
): Expr<boolean, 'bool'> {
  return pred('-|-', a, b) as unknown as Expr<boolean, 'bool'>
}
/** `a + b`. Throws `22000` on the server if the union would not be contiguous. */
export function rangeUnion<P extends RangePg, A extends RangeOperand<P> = RangeOperand<P>>(
  a: A,
  b: Operand<string>,
): Expr<string | Extract<A[typeof OUT], null>, P> {
  const codec = codecOfOperand(a)
  return binary('+', a, b, codec, codec) as unknown as Expr<
    string | Extract<A[typeof OUT], null>,
    P
  >
}
export function rangeIntersection<P extends RangePg, A extends RangeOperand<P> = RangeOperand<P>>(
  a: A,
  b: Operand<string>,
): Expr<string | Extract<A[typeof OUT], null>, P> {
  const codec = codecOfOperand(a)
  return binary('*', a, b, codec, codec) as unknown as Expr<
    string | Extract<A[typeof OUT], null>,
    P
  >
}

/**
 * The range's subtype, resolved from the range codec — `int4range` → `int4`.
 *
 * A literal map and not `registry.byName(...)`: `lower()`/`upper()` must give the same answer
 * whether or not a registry is in scope, and a range type's subtype is a fixed property of
 * PostgreSQL, not of this database. `RangeElemPg` in `./ops.types.ts` is the same table at the
 * type level; `test/query/ops.test.ts` asserts the two agree row for row, so they cannot drift.
 */
const RANGE_ELEMENT: Readonly<Record<string, AnyCodec>> = {
  int4range: int4Codec as AnyCodec,
  int8range: int8Codec as AnyCodec,
  numrange: numericCodec as AnyCodec,
  tsrange: timestampCodec as AnyCodec,
  tstzrange: timestamptzCodec as AnyCodec,
  daterange: dateCodec as AnyCodec,
}

/**
 * The runtime half of `RangeElemPg`, as names. Exported for one reason: `test/query/ops.test.ts`
 * pins it against the literal table so the two maps cannot drift apart silently.
 */
export const RANGE_ELEMENT_NAMES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(RANGE_ELEMENT).map(([k, v]) => [k, v.name])),
)

function rangeBound<P extends RangePg>(
  name: 'lower' | 'upper',
  a: RangeOperand<P>,
): Expr<RangeElem<P> | null, RangeElemPg<P>> {
  const element = RANGE_ELEMENT[codecOfOperand(a).name] ?? unknownCodec
  return fnNode(name, [toExpr(a, unknownCodec)], element) as unknown as Expr<
    RangeElem<P> | null,
    RangeElemPg<P>
  >
}

export const rangeLower = <P extends RangePg>(
  a: RangeOperand<P>,
): Expr<RangeElem<P> | null, RangeElemPg<P>> => rangeBound('lower', a)
export const rangeUpper = <P extends RangePg>(
  a: RangeOperand<P>,
): Expr<RangeElem<P> | null, RangeElemPg<P>> => rangeBound('upper', a)

// ─────────────────────────────────────────────────────────────────────────────
// net — inet / cidr (03 §2.9 row "net")
//
// `<<` and `>>` are the SAME TOKENS the range class uses, with the opposite reading: for a range
// `<<` is "strictly left of", for a network it is "is contained by". Nothing but the operand gate
// distinguishes them, which is the concrete payoff of 03 §2.9 over a stringly-typed operator API.
// ─────────────────────────────────────────────────────────────────────────────

export function containsNet(a: NetOperand, b: Operand<string>): Expr<boolean, 'bool'> {
  return pred('>>', a, b) as unknown as Expr<boolean, 'bool'>
}
export function containedByNet(a: NetOperand, b: Operand<string>): Expr<boolean, 'bool'> {
  return pred('<<', a, b) as unknown as Expr<boolean, 'bool'>
}
export function overlapsNet(a: NetOperand, b: Operand<string>): Expr<boolean, 'bool'> {
  return pred('&&', a, b) as unknown as Expr<boolean, 'bool'>
}
