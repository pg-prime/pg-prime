/**
 * Frozen node constructors and the **node registry**.
 *
 * ## Why a registry (and not a `k` field check)
 *
 * The `sql` tag has to answer one question per template hole: "is this value a piece of SQL,
 * or is it data?" If that question is answered *structurally* — `typeof v === 'object' &&
 * 'k' in v` — then `JSON.parse(untrustedBody)` can forge a node. A payload of
 * `{"k":"unsafeRaw","text":"; DROP TABLE users --"}` interpolated into a template would be
 * spliced verbatim into the SQL, from pure data, with no `any` and no raw SQL at the call
 * site. That is exactly the shape of Kysely's GHSA-pv5w-4p9q-p3v2 ("bites even in fully
 * type-safe code").
 *
 * So the answer is *nominal*: a value is SQL iff it is in this `WeakSet`, which only the
 * constructors below write to. `JSON.parse` cannot produce a value that is already in a
 * WeakSet. Everything else — including a perfect structural copy of a node — is data, and
 * data becomes `$n`. `WeakSet` also keeps nodes garbage-collectable and reusable across
 * queries, which is the MikroORM v7 fragment model (research/mikroorm.md §ADAPT).
 */

import { quoteIdentPart } from '../sql/ident.js'
import type { Codec } from '../sql/codec.js'
import { spikeCodecs } from '../sql/codec.js'
import type {
  AggNode,
  BinaryOp,
  BoolNode,
  CastNode,
  ColumnMeta,
  ColumnNode,
  Expr,
  ExistsNode,
  FromItem,
  FuncCallNode,
  InNode,
  InsertNode,
  IsNode,
  JoinNode,
  JsonAggNode,
  JsonBuildNode,
  LiteralNode,
  NestedPlan,
  OrderItem,
  ParamNode,
  PlaceholderNode,
  ProjectionItem,
  RawNode,
  RawPart,
  SelectNode,
  SetOpNode,
  SubqueryExprNode,
  SubqueryNode,
  TableMeta,
  TableRefNode,
  UnaryNode,
} from './ast.js'

const NODES = new WeakSet<object>()

/** Freeze, register, return. The only way a value becomes "SQL" rather than "data". */
export function mkNode<T extends object>(n: T): T {
  Object.freeze(n)
  NODES.add(n)
  return n
}

/**
 * Nominal check. Never replace this with a structural `'k' in v` test — see the module
 * docblock for the attack it would reopen.
 */
export function isAstNode(v: unknown): v is Expr {
  return typeof v === 'object' && v !== null && NODES.has(v)
}

// ─────────────────────────── Schema seam helpers ───────────────────────────

/** Pre-quotes at build time (03 §7: the compiler never quotes a schema identifier). */
export function tableMeta(schema: string, name: string): TableMeta {
  return mkNode({
    schema,
    name,
    qualified: `${quoteIdentPart(schema)}.${quoteIdentPart(name)}`,
  })
}

export function columnMeta(name: string, codec: Codec): ColumnMeta {
  return mkNode({ name, quoted: quoteIdentPart(name), codec })
}

// ─────────────────────────── FROM items ───────────────────────────

export function table(meta: TableMeta, alias = meta.name): TableRefNode {
  return mkNode({ k: 'table' as const, table: meta, alias, qAlias: quoteIdentPart(alias) })
}

export function subquery(
  query: SelectNode | SetOpNode,
  alias: string,
  lateral = false,
): SubqueryNode {
  return mkNode({ k: 'subquery' as const, query, alias, qAlias: quoteIdentPart(alias), lateral })
}

export function join(
  type: JoinNode['type'],
  item: FromItem,
  on?: Expr | undefined,
): JoinNode {
  return mkNode({ k: 'join' as const, type, item, on })
}

/** `left join lateral (...) as alias on true` — what nesting hoists to. */
export function leftJoinLateral(item: FromItem): JoinNode {
  return join('left', item, undefined)
}

// ─────────────────────────── Expressions ───────────────────────────

export function col(alias: string, name: string, codec: Codec): ColumnNode {
  const qa = quoteIdentPart(alias)
  const qn = quoteIdentPart(name)
  return mkNode({ k: 'col' as const, alias, name, q: `${qa}.${qn}`, qn, codec })
}

export function param(value: unknown, codec: Codec = spikeCodecs.unknownParam): ParamNode {
  return mkNode({ k: 'param' as const, value, codec })
}

export function placeholder(name: string, codec: Codec): PlaceholderNode {
  return mkNode({ k: 'ph' as const, name, codec })
}

/**
 * Non-string literals only. The type signature is the primary guard; the runtime check in
 * `sql.lit` is the backstop for untyped callers. Strings in a query position are parameters.
 */
export function lit(
  value: number | bigint | boolean | null,
  codec: Codec = spikeCodecs.unknownParam,
): LiteralNode {
  return mkNode({ k: 'lit' as const, value, codec })
}

export function bin(
  op: BinaryOp,
  l: Expr,
  r: Expr,
  resultCodec: Codec = spikeCodecs.bool,
): Expr {
  return mkNode({ k: 'bin' as const, op, l, r, resultCodec })
}

export const eq = (l: Expr, r: Expr): Expr => bin('=', l, r)
export const neq = (l: Expr, r: Expr): Expr => bin('<>', l, r)
export const lt = (l: Expr, r: Expr): Expr => bin('<', l, r)
export const lte = (l: Expr, r: Expr): Expr => bin('<=', l, r)
export const gt = (l: Expr, r: Expr): Expr => bin('>', l, r)
export const gte = (l: Expr, r: Expr): Expr => bin('>=', l, r)

export function and(...args: Expr[]): BoolNode {
  return mkNode({ k: 'bool' as const, op: 'and' as const, args: Object.freeze(args) })
}

export function or(...args: Expr[]): BoolNode {
  return mkNode({ k: 'bool' as const, op: 'or' as const, args: Object.freeze(args) })
}

export function not(e: Expr): UnaryNode {
  return mkNode({ k: 'un' as const, op: 'not' as const, e, resultCodec: spikeCodecs.bool })
}

export function is(e: Expr, test: IsNode['test'], r?: Expr): IsNode {
  return mkNode({ k: 'is' as const, e, test, r })
}

export const isNull = (e: Expr): IsNode => is(e, 'null')
export const isNotNull = (e: Expr): IsNode => is(e, 'not null')
export const isTrue = (e: Expr): IsNode => is(e, 'true')

/** `e in (a, b, c)`. `items` empty compiles to `false` (03 §2.1). */
export function inList(e: Expr, items: readonly Expr[], negated = false): InNode {
  return mkNode({
    k: 'in' as const,
    e,
    not: negated,
    set: Object.freeze({ k: 'list' as const, items: Object.freeze([...items]) }),
  })
}

/** `e = any($n)` — one parameter, no plan-cache pollution from varying list lengths. */
export function inAny(e: Expr, array: Expr, negated = false): InNode {
  return mkNode({
    k: 'in' as const,
    e,
    not: negated,
    set: Object.freeze({ k: 'any' as const, array }),
  })
}

export function inQuery(e: Expr, query: SelectNode | SetOpNode, negated = false): InNode {
  return mkNode({
    k: 'in' as const,
    e,
    not: negated,
    set: Object.freeze({ k: 'query' as const, query }),
  })
}

// ─────────────────────────── JSON accessors (D7) ───────────────────────────
//
// Every PostgreSQL JSON accessor takes a *value* operand, so there is no reason to ever emit
// user text into a path position. These constructors are the entire JSON-path surface of the
// library, and every one of them routes the caller's key/path through `param()`, i.e. `$n`.
//
// That is why `sanitizeJSONPathMemberValue` — the function at the heart of Kysely's
// GHSA-wmrf-hv6w-mr66 and GHSA-pv5w-4p9q-p3v2 — has no analogue in this codebase: the CVE
// class is deleted rather than patched. A key of `')-- ` or `"].sibling["` is just a string
// in a bind slot; PostgreSQL plans `->` on a parameter identically to a literal.

/** `jsonb -> $n` — key or array index lookup, returning json. */
export function jsonGet(e: Expr, key: string | number): Expr {
  return bin('->', e, param(key, spikeCodecs.text), spikeCodecs.jsonb)
}

/** `jsonb ->> $n` — key lookup returning text. */
export function jsonGetText(e: Expr, key: string | number): Expr {
  return bin('->>', e, param(key, spikeCodecs.text), spikeCodecs.text)
}

/** `jsonb #> $n` — path lookup returning json. The path is a `text[]` parameter. */
export function jsonPath(e: Expr, path: readonly string[]): Expr {
  return bin('#>', e, param(path, spikeCodecs.textArray), spikeCodecs.jsonb)
}

/** `jsonb #>> $n` — path lookup returning text. The path is a `text[]` parameter. */
export function jsonPathText(e: Expr, path: readonly string[]): Expr {
  return bin('#>>', e, param(path, spikeCodecs.textArray), spikeCodecs.text)
}

/** `jsonb ? $n` — key-existence test. */
export function jsonHasKey(e: Expr, key: string): Expr {
  return bin('?', e, param(key, spikeCodecs.text), spikeCodecs.bool)
}

/** `jsonb @> $n` — containment. The probe document is a parameter, never inlined JSON. */
export function jsonContains(e: Expr, doc: unknown): Expr {
  return bin('@>', e, param(doc, spikeCodecs.jsonb), spikeCodecs.bool)
}

export function fn(name: string, args: readonly Expr[], resultCodec: Codec): FuncCallNode {
  return mkNode({ k: 'fn' as const, name, args: Object.freeze([...args]), resultCodec })
}

export function agg(
  name: string,
  args: readonly Expr[],
  resultCodec: Codec,
  opts: { distinct?: boolean; orderBy?: readonly OrderItem[]; filter?: Expr; star?: boolean } = {},
): AggNode {
  return mkNode({
    k: 'agg' as const,
    name,
    args: Object.freeze([...args]),
    distinct: opts.distinct ?? false,
    orderBy: opts.orderBy,
    filter: opts.filter,
    star: opts.star,
    resultCodec,
  })
}

export const countStar = (): AggNode =>
  agg('count', [], spikeCodecs.int8, { star: true })

export function cast(e: Expr, to: string, resultCodec: Codec): CastNode {
  return mkNode({ k: 'cast' as const, e, to, resultCodec })
}

export function jsonBuild(
  entries: readonly (readonly [string, Expr])[],
  variant: 'json' | 'jsonb' = 'json',
): JsonBuildNode {
  return mkNode({ k: 'jsonBuild' as const, entries: Object.freeze([...entries]), variant })
}

export function jsonAgg(
  e: Expr,
  opts: { orderBy?: readonly OrderItem[]; variant?: 'json' | 'jsonb'; emptyAs?: '[]' } = {},
): JsonAggNode {
  return mkNode({
    k: 'jsonAgg' as const,
    e,
    orderBy: opts.orderBy,
    variant: opts.variant ?? 'json',
    emptyAs: opts.emptyAs,
  })
}

export function exists(query: SelectNode, negated = false): ExistsNode {
  return mkNode({ k: 'exists' as const, not: negated, query })
}

export function scalarSubquery(
  query: SelectNode | SetOpNode,
  resultCodec: Codec,
): SubqueryExprNode {
  return mkNode({ k: 'sq' as const, query, resultCodec })
}

export function raw(
  chunks: readonly string[],
  parts: readonly RawPart[],
  resultCodec: Codec | null = null,
): RawNode {
  if (chunks.length !== parts.length + 1) {
    throw new Error(
      `raw(): chunks/parts interleave invariant violated (${chunks.length} chunks, ${parts.length} parts)`,
    )
  }
  return mkNode({
    k: 'raw' as const,
    chunks: Object.freeze([...chunks]),
    parts: Object.freeze([...parts]),
    resultCodec,
  })
}

// ─────────────────────────── Clauses / statements ───────────────────────────

export function order(
  e: Expr,
  dir: 'asc' | 'desc' = 'asc',
  nulls?: 'first' | 'last',
): OrderItem {
  return mkNode({ e, dir, nulls })
}

export const asc = (e: Expr, nulls?: 'first' | 'last'): OrderItem => order(e, 'asc', nulls)
export const desc = (e: Expr, nulls?: 'first' | 'last'): OrderItem => order(e, 'desc', nulls)

export function projection(
  key: string,
  expr: Expr,
  nested?: ProjectionItem['nested'],
): ProjectionItem {
  return mkNode({ key, expr, nested })
}

/**
 * A relation-projection item. `expr` is a placeholder that `hoist.ts` replaces with the
 * reference to the hoisted lateral, so callers never have to invent one.
 */
export function nested(key: string, plan: NestedPlan): ProjectionItem {
  return mkNode({ key, expr: lit(null), nested: plan })
}

export function select(n: Omit<SelectNode, 'k'>): SelectNode {
  return mkNode({ k: 'select' as const, ...n })
}

export function insert(n: Omit<InsertNode, 'k'>): InsertNode {
  return mkNode({ k: 'insert' as const, ...n })
}
