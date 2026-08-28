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

import { InvalidFragmentError } from '../sql/errors.js'
import { quoteIdentPart } from '../sql/ident.js'
import type { AnyCodec } from '../codec/index.js'
import {
  arrayCodecOf,
  boolCodec,
  int8Codec,
  jsonbCodec,
  textCodec,
  unknownCodec,
} from '../codec/index.js'
import type {
  AggNode,
  ArrayNode,
  BinaryOp,
  BoolNode,
  CaseNode,
  CastNode,
  ColumnMeta,
  ColumnNode,
  CteNode,
  CteRefNode,
  DeleteNode,
  Expr,
  ExistsNode,
  FromItem,
  FuncCallNode,
  FuncNode,
  GroupPlan,
  InNode,
  InsertNode,
  IsNode,
  JoinNode,
  JsonAggNode,
  JsonBuildNode,
  LiteralNode,
  NestedPlan,
  OrderItem,
  OverNode,
  ParamNode,
  PlaceholderNode,
  ProjectionItem,
  RawNode,
  RawPart,
  RowNode,
  SelectNode,
  SetItem,
  SetOpNode,
  SubqueryExprNode,
  SubqueryNode,
  TableMeta,
  TableRefNode,
  UnaryNode,
  UpdateNode,
  ValuesNode,
  WindowDef,
} from './ast.js'

const NODES = new WeakSet<object>()

/**
 * Nesting depth of the **compiler-internal** window (see {@link inInternalNodes}).
 *
 * A plain counter and not a boolean because `planSelect` recurses: the emitter plans the inner
 * select of a lateral it has just planned, so the window opens inside itself.
 */
let internalDepth = 0

/**
 * Run `f` with node *registration* suppressed, and give back what it returns.
 *
 * ## Why this exists
 *
 * `WeakSet.prototype.add` has no TurboFan fast path — it is a runtime call — and `mkNode` was the
 * top frame of the profile design/09 §3.7 recorded, at 25 %. Measured in situ by turning this
 * suppression off and re-running `bench:compile`: design/03 §1.1's query compiles in **24.7 µs
 * with it off and 20.2 µs with it on**, at **31 125 B against 31 099 B** — i.e. ~18 % of the
 * compile and, per operation, no heap at all. That shape is the argument: what the registry costs
 * is CPU on a runtime call, so the only way to stop paying it is to stop making the call for nodes
 * that provably do not need to be in the set.
 *
 * ## Why suppressing it is not a hole in D7
 *
 * The registry answers exactly one question — "did *this library* build this value, or did it
 * arrive as data?" — and it is asked in exactly one place: the boundary where a caller hands a
 * value back to us (`sql`'s hole classifier, `toExprNode`, `queryAstOf`, `allOf`; see the
 * `isAstNode` call sites). Nodes built by `./hoist.ts` never cross that boundary in the other
 * direction: the planner is a pure AST → AST pass whose output is read by `./compiler.ts` and by
 * nothing else, it invokes no user callback, and the only things it hands back to the query layer
 * are `FieldPlan`s (codecs and keys, not nodes).
 *
 * The failure mode if that analysis is ever wrong is also the safe one. An *unregistered* node
 * reaching a template hole is classified as **data** and becomes `$n` — a wrong query, loudly, at
 * the first test that touches it. The dangerous direction is the opposite one, and nothing here
 * adds a way to get into the set; `NODES` still has exactly one writer.
 *
 * Registration is suppressed, `Object.freeze` is not. Immutability is a different property from
 * nominality — it is what lets a node be shared by reference between a query and its derivatives —
 * and it is separately tested: R10 M1 (drop the freeze) is caught by `test/compile/contract.ts`'s
 * "AST nodes are frozen, so a builder can structurally share them" and by `test/query/ops.ts`'s
 * "an operator never mutates its operands", neither of which the registry mutations reach.
 */
export function inInternalNodes<T>(f: () => T): T {
  internalDepth++
  try {
    return f()
  } finally {
    internalDepth--
  }
}

/**
 * `text[]`, for the jsonb path operators whose right operand is a path array (03 §3.4, D7 — the
 * GHSA-wmrf-hv6w-mr66 class: a path is a PARAMETER, never spliced text). Derived rather than taken
 * from a registry so importing the node constructors does not build 50 codecs; it carries
 * `textCodec.arrayOid` (1009), so it is the same type PostgreSQL will see.
 */
const textArrayCodec = arrayCodecOf(textCodec)

/**
 * Freeze, register, return. The only way a value becomes "SQL" rather than "data".
 *
 * Inside {@link inInternalNodes} the registration is skipped — see that function for why that is
 * a cost decision and not a security one.
 */
export function mkNode<T extends object>(n: T): T {
  Object.freeze(n)
  if (internalDepth === 0) NODES.add(n)
  return n
}

/**
 * Nominal check. Never replace this with a structural `'k' in v` test — see the module
 * docblock for the attack it would reopen.
 *
 * Note that the registry holds **every** node kind, not just expressions: statements, order
 * items, joins and column metadata are all in it. Use {@link isRawPart} where the answer has to
 * be "can this stand in an expression position?".
 */
export function isAstNode(v: unknown): v is Expr {
  return typeof v === 'object' && v !== null && NODES.has(v)
}

/**
 * Every `k` that may appear in a `sql` fragment's `parts`: the {@link Expr} kinds plus the two
 * splice parts (`ident`, `unsafeRaw`).
 *
 * An `order` item or a `select` node passed into a template hole used to be accepted here and
 * then failed in the emitter as `node kind 'undefined' is not implemented`, pointing at the
 * compiler rather than at the interpolation that caused it.
 */
const PART_KINDS: ReadonlySet<string> = new Set([
  'col',
  'param',
  'ph',
  'lit',
  'bin',
  'bool',
  'un',
  'is',
  'in',
  'between',
  'fn',
  'agg',
  'over',
  'case',
  'cast',
  'row',
  'array',
  'sq',
  'exists',
  'jsonBuild',
  'jsonAgg',
  'raw',
  'ident',
  'unsafeRaw',
])

/** Nominal + kind check: a registered node that may stand in a fragment's part position. */
export function isRawPart(v: unknown): v is RawPart {
  if (typeof v !== 'object' || v === null || !NODES.has(v)) return false
  const k: unknown = (v as { k?: unknown }).k
  return typeof k === 'string' && PART_KINDS.has(k)
}

/** The `k` of a registered node, for an error message. Never reaches SQL. */
export function nodeKindOf(v: unknown): string {
  const k: unknown = (v as { k?: unknown } | null)?.k
  return typeof k === 'string' ? k : 'clause'
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

export function columnMeta(name: string, codec: AnyCodec): ColumnMeta {
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

export function col(alias: string, name: string, codec: AnyCodec): ColumnNode {
  const qa = quoteIdentPart(alias)
  const qn = quoteIdentPart(name)
  return mkNode({ k: 'col' as const, alias, name, q: `${qa}.${qn}`, qn, codec })
}

export function param(value: unknown, codec: AnyCodec = unknownCodec): ParamNode {
  return mkNode({ k: 'param' as const, value, codec })
}

export function placeholder(name: string, codec: AnyCodec): PlaceholderNode {
  return mkNode({ k: 'ph' as const, name, codec })
}

/**
 * Non-string literals only. The type signature is the primary guard; the runtime check in
 * `sql.lit` is the backstop for untyped callers. Strings in a query position are parameters.
 */
export function lit(
  value: number | bigint | boolean | null,
  codec: AnyCodec = unknownCodec,
): LiteralNode {
  return mkNode({ k: 'lit' as const, value, codec })
}

export function bin(
  op: BinaryOp,
  l: Expr,
  r: Expr,
  resultCodec: AnyCodec = boolCodec,
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
  return mkNode({ k: 'un' as const, op: 'not' as const, e, resultCodec: boolCodec })
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
  return bin('->', e, param(key, textCodec), jsonbCodec)
}

/** `jsonb ->> $n` — key lookup returning text. */
export function jsonGetText(e: Expr, key: string | number): Expr {
  return bin('->>', e, param(key, textCodec), textCodec)
}

/** `jsonb #> $n` — path lookup returning json. The path is a `text[]` parameter. */
export function jsonPath(e: Expr, path: readonly string[]): Expr {
  return bin('#>', e, param(path, textArrayCodec), jsonbCodec)
}

/** `jsonb #>> $n` — path lookup returning text. The path is a `text[]` parameter. */
export function jsonPathText(e: Expr, path: readonly string[]): Expr {
  return bin('#>>', e, param(path, textArrayCodec), textCodec)
}

/** `jsonb ? $n` — key-existence test. */
export function jsonHasKey(e: Expr, key: string): Expr {
  return bin('?', e, param(key, textCodec), boolCodec)
}

/** `jsonb @> $n` — containment. The probe document is a parameter, never inlined JSON. */
export function jsonContains(e: Expr, doc: unknown): Expr {
  return bin('@>', e, param(doc, jsonbCodec), boolCodec)
}

export function fn(name: string, args: readonly Expr[], resultCodec: AnyCodec): FuncCallNode {
  return mkNode({ k: 'fn' as const, name, args: Object.freeze([...args]), resultCodec })
}

export function agg(
  name: string,
  args: readonly Expr[],
  resultCodec: AnyCodec,
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
  agg('count', [], int8Codec, { star: true })

export function cast(e: Expr, to: string, resultCodec: AnyCodec): CastNode {
  return mkNode({ k: 'cast' as const, e, to, resultCodec })
}

/**
 * `case when a then b [when …] [else z] end`, or the "simple" form when `operand` is given.
 *
 * `resultCodec` is the caller's: PostgreSQL resolves the branches to one common type, and the
 * decoder needs to know which one before the query runs.
 */
export function caseWhen(
  whens: readonly { when: Expr; then: Expr }[],
  resultCodec: AnyCodec,
  opts: { operand?: Expr; else?: Expr } = {},
): CaseNode {
  return mkNode({
    k: 'case' as const,
    operand: opts.operand,
    whens: Object.freeze(whens.map((w) => mkNode({ when: w.when, then: w.then }))),
    else: opts.else,
    resultCodec,
  })
}

/** `row(a, b)` — a composite value, e.g. for a row-wise comparison. */
export function rowExpr(items: readonly Expr[]): RowNode {
  return mkNode({ k: 'row' as const, items: Object.freeze([...items]) })
}

/** `array[a, b]`. `elemCodec` is the ELEMENT codec; the expression's type is the array of it. */
export function arrayExpr(items: readonly Expr[], elemCodec: AnyCodec): ArrayNode {
  return mkNode({ k: 'array' as const, items: Object.freeze([...items]), elemCodec })
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

/**
 * `(select … )` in expression position.
 *
 * `hoist` is the relation layer's marker (see {@link SubqueryExprNode.hoist}); every other caller
 * leaves it `undefined`, and the field is written unconditionally so all `sq` nodes share one
 * hidden class.
 */
export function scalarSubquery(
  query: SelectNode | SetOpNode,
  resultCodec: AnyCodec,
  hoist?: boolean,
): SubqueryExprNode {
  return mkNode({ k: 'sq' as const, query, resultCodec, hoist })
}

export function raw(
  chunks: readonly string[],
  parts: readonly RawPart[],
  resultCodec: AnyCodec | null = null,
): RawNode {
  if (chunks.length !== parts.length + 1) {
    throw new InvalidFragmentError(
      `raw(): chunks/parts interleave invariant violated (${chunks.length} chunks, ` +
        `${parts.length} parts). A fragment must have exactly one more chunk than parts.`,
    )
  }
  return mkNode({
    k: 'raw' as const,
    chunks: Object.freeze([...chunks]),
    parts: Object.freeze([...parts]),
    resultCodec,
  })
}

/**
 * The `.as(codec)` call site of a raw node, kept in a side table rather than on the node
 * (design/09 WS6; `03` §3.2's `CodecMismatchError` prints it).
 *
 * A WeakMap and not a `RawNode` field for one reason worth stating: an AST node is compared with
 * `toStrictEqual` by the compiler suite and by the WS4 AST-equivalence oracle, and a field that
 * is present in dev and absent in production would make those comparisons depend on `NODE_ENV`.
 * A side table is invisible to structural equality, collectable with the node, and read exactly
 * once per compile — never per row.
 */
const AS_SITES = new WeakMap<object, string>()

/** Record where `.as(codec)` was called. No-op for a falsy site, so the caller need not branch. */
export function markSite(node: RawNode, site: string | undefined): RawNode {
  if (site !== undefined) AS_SITES.set(node, site)
  return node
}

/** The recorded `.as(codec)` call site, or `undefined` in production (nothing was captured). */
export function siteOf(node: object): string | undefined {
  return AS_SITES.get(node)
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

/**
 * A `nest({...})` projection item (03 §2.2). `expr` is a placeholder the planner never reads:
 * the group's children are the emitted columns, and `hoist.ts` expands them.
 */
export function group(key: string, plan: GroupPlan): ProjectionItem {
  return mkNode({ key, expr: lit(null), group: plan })
}

export function select(n: Omit<SelectNode, 'k'>): SelectNode {
  return mkNode({ k: 'select' as const, ...n })
}

export function insert(n: Omit<InsertNode, 'k'>): InsertNode {
  return mkNode({ k: 'insert' as const, ...n })
}

export function update(n: Omit<UpdateNode, 'k'>): UpdateNode {
  return mkNode({ k: 'update' as const, ...n })
}

/** `delete` is a reserved word, so the constructor is `del`. */
export function del(n: Omit<DeleteNode, 'k'>): DeleteNode {
  return mkNode({ k: 'delete' as const, ...n })
}

export function setop(n: Omit<SetOpNode, 'k'>): SetOpNode {
  return mkNode({ k: 'setop' as const, ...n })
}

export function cte(n: CteNode): CteNode {
  return mkNode({ ...n })
}

export function cteRef(name: string, alias = name): CteRefNode {
  return mkNode({ k: 'cteRef' as const, name, alias, qAlias: quoteIdentPart(alias) })
}

export function setItem(column: ColumnMeta, value: Expr): SetItem {
  return mkNode({ column, value })
}

/** `(values (…), (…)) as "v"("a", "b")` — the bulk-update source (03 §2.6). */
export function valuesFrom(n: Omit<ValuesNode, 'k' | 'qAlias'>): ValuesNode {
  return mkNode({ k: 'values' as const, ...n, qAlias: quoteIdentPart(n.alias) })
}

/** A set-returning function in FROM: `unnest($1, $2) as "v"("a", "b")`. */
export function funcFrom(n: Omit<FuncNode, 'k' | 'qAlias'>): FuncNode {
  return mkNode({ k: 'func' as const, ...n, qAlias: quoteIdentPart(n.alias) })
}

export function over(f: AggNode | FuncCallNode, window: WindowDef | { ref: string }): OverNode {
  return mkNode({ k: 'over' as const, fn: f, window })
}
