/**
 * The immutable AST (03 §1.2).
 *
 * Discriminated union, `k` is the tag. All nodes are frozen plain objects: no classes, no
 * methods, because the compiler is the only thing that reads them. That keeps them cheap to
 * allocate and trivially structurally-shareable when a builder method returns a new tree.
 *
 * Nodes marked `[spike]` are implemented by `compiler.ts` in this spike; the rest are
 * declared because they are the design's contract (other agents build against these shapes)
 * and are rejected at compile time with a precise `UnsupportedNodeError`.
 *
 * Deviation from the design sketch: optional members are declared `?: T | undefined` rather
 * than `?: T`, because the repo enables `exactOptionalPropertyTypes` and the nesting
 * transform in `hoist.ts` builds new nodes by spreading old ones.
 */

import type { AnyCodec } from '../codec/index.js'

// ─────────────────────────── Schema seam (agent 05 owns the real ones) ───────────────────

/**
 * SPIKE-LOCAL. Minimum the compiler consumes from the schema layer. Note `qualified` and
 * `quoted`: 03 §7 requires identifiers to be pre-quoted once at schema-build time so the
 * compiler never quotes a schema identifier on the hot path.
 */
export interface TableMeta {
  readonly schema: string
  readonly name: string
  /** Pre-quoted `"schema"."name"`. */
  readonly qualified: string
}

export interface ColumnMeta {
  readonly name: string
  /** Pre-quoted `"name"`. */
  readonly quoted: string
  readonly codec: AnyCodec
}

export interface QualifiedName {
  readonly schema: string
  readonly name: string
}

// ─────────────────────────── Statements ───────────────────────────

export type Statement = SelectNode | InsertNode | UpdateNode | DeleteNode | SetOpNode

/** [spike] */
export interface SelectNode {
  k: 'select'
  with?: readonly CteNode[] | undefined
  distinct?: { on?: readonly Expr[] | undefined } | undefined
  /** Ordered; index === result column index. */
  projection: readonly ProjectionItem[]
  from?: FromItem | undefined
  /** Includes compiler-hoisted LATERALs. */
  joins?: readonly JoinNode[] | undefined
  where?: Expr | undefined
  groupBy?: readonly Expr[] | undefined
  having?: Expr | undefined
  /** `window "w" as (...)`. Ordered; PostgreSQL allows a definition to reference an earlier one. */
  windows?: readonly NamedWindow[] | undefined
  orderBy?: readonly OrderItem[] | undefined
  limit?: Expr | undefined
  offset?: Expr | undefined
  locking?:
    | {
        strength: 'update' | 'no key update' | 'share' | 'key share'
        of?: readonly string[] | undefined
        wait: 'block' | 'nowait' | 'skip locked'
      }
    | undefined
}

/** [spike] — `values` source only. */
export interface InsertNode {
  k: 'insert'
  with?: readonly CteNode[] | undefined
  into: TableRefNode
  columns: readonly ColumnMeta[]
  source: InsertSource
  /**
   * Emit per-column `::type` casts on the first VALUES row (03 §2.6). PostgreSQL infers the
   * rest from row 1, so this costs one row's worth of tokens and pins the types for bulk
   * inserts. Off by default to match the §2.5 single-row golden.
   */
  castFirstRow?: boolean | undefined
  onConflict?: OnConflictNode | undefined
  returning?: readonly ProjectionItem[] | undefined
}

export type InsertSource =
  /** [spike] multi-row VALUES */
  | { k: 'values'; rows: readonly (readonly Expr[])[] }
  /** bulk: one parameter per column regardless of row count */
  | { k: 'unnest'; arrays: readonly Expr[] }
  | { k: 'select'; query: SelectNode | SetOpNode }
  | { k: 'defaults' }

export interface OnConflictNode {
  target?:
    | { k: 'columns'; columns: readonly ColumnMeta[]; where?: Expr | undefined }
    | { k: 'expressions'; exprs: readonly Expr[]; where?: Expr | undefined }
    | { k: 'constraint'; name: string }
    | undefined
  action: { k: 'nothing' } | { k: 'update'; set: readonly SetItem[]; where?: Expr | undefined }
}

export interface UpdateNode {
  k: 'update'
  with?: readonly CteNode[] | undefined
  target: TableRefNode
  set: readonly SetItem[]
  from?: readonly FromItem[] | undefined
  where?: Expr | undefined
  returning?: readonly ProjectionItem[] | undefined
}

export interface DeleteNode {
  k: 'delete'
  with?: readonly CteNode[] | undefined
  from: TableRefNode
  using?: readonly FromItem[] | undefined
  where?: Expr | undefined
  returning?: readonly ProjectionItem[] | undefined
}

export interface SetOpNode {
  k: 'setop'
  op: 'union' | 'union all' | 'intersect' | 'intersect all' | 'except' | 'except all'
  left: SelectNode | SetOpNode
  right: SelectNode | SetOpNode
  orderBy?: readonly OrderItem[] | undefined
  limit?: Expr | undefined
  offset?: Expr | undefined
}

export interface CteNode {
  name: string
  columns?: readonly string[] | undefined
  recursive: boolean
  materialized?: boolean | undefined
  query: Statement
}

// ─────────────────────────── FROM items ───────────────────────────

export type FromItem = TableRefNode | SubqueryNode | ValuesNode | FuncNode | CteRefNode

/** [spike] */
export interface TableRefNode {
  k: 'table'
  table: TableMeta
  alias: string
  /** Pre-quoted alias. */
  qAlias: string
}

/** [spike] */
export interface SubqueryNode {
  k: 'subquery'
  query: SelectNode | SetOpNode
  alias: string
  qAlias: string
  lateral: boolean
}

export interface ValuesNode {
  k: 'values'
  rows: readonly (readonly Expr[])[]
  alias: string
  qAlias: string
  columns: readonly string[]
  casts: readonly (string | null)[]
}

export interface FuncNode {
  k: 'func'
  fn: string
  args: readonly Expr[]
  alias: string
  qAlias: string
  /** `unnest($1::int8[], $2::numeric[]) as "v"("id", "price")` — the bulk-update source (03 §2.6). */
  columns?: readonly string[] | undefined
  lateral: boolean
  ordinality: boolean
}

export interface CteRefNode {
  k: 'cteRef'
  name: string
  alias: string
  qAlias: string
}

/** [spike] — `left` with `on: undefined` (=> ON TRUE) is what nesting hoists. */
export interface JoinNode {
  k: 'join'
  type: 'inner' | 'left' | 'right' | 'full' | 'cross'
  item: FromItem
  /** undefined => ON TRUE (lateral projections) */
  on?: Expr | undefined
}

// ─────────────────────────── Expressions ───────────────────────────

export type Expr =
  | ColumnNode
  | ParamNode
  | PlaceholderNode
  | LiteralNode
  | BinaryNode
  | BoolNode
  | UnaryNode
  | BetweenNode
  | InNode
  | IsNode
  | FuncCallNode
  | AggNode
  | OverNode
  | CaseNode
  | CastNode
  | RowNode
  | ArrayNode
  | SubqueryExprNode
  | ExistsNode
  | JsonBuildNode
  | JsonAggNode
  | RawNode

/** [spike] `q` is the pre-quoted `"alias"."name"`; `qn` the pre-quoted bare `"name"`. */
export interface ColumnNode {
  k: 'col'
  alias: string
  name: string
  q: string
  qn: string
  codec: AnyCodec
}

/** [spike] A user value. Always emitted as `$n`; never interpolated. */
export interface ParamNode {
  k: 'param'
  value: unknown
  codec: AnyCodec
}

/** [spike] A named hole filled at `.execute(args)` time on a prepared query. */
export interface PlaceholderNode {
  k: 'ph'
  name: string
  codec: AnyCodec
}

/** [spike] Non-string literals ONLY (03 §3.4 / D7). Strings are always params. */
export interface LiteralNode {
  k: 'lit'
  value: number | bigint | boolean | null
  codec: AnyCodec
}

/**
 * Every infix operator the builder can emit, as the exact token the emitter splices.
 *
 * The list is closed on purpose: `bin()` takes a member of this union, never a string, so
 * `src/query/ops.ts` cannot invent an operator and no caller-supplied text ever reaches the
 * operator position. Adding a row here is the only way to grow the vocabulary, which makes the
 * diff the review artifact (03 §2.9's table is generated from the `OPS` manifest that consumes
 * this union — `tools/ops-table`).
 *
 * Grouped by the PostgreSQL type class that owns them; several are shared (`@>` is array, jsonb
 * AND range; `&&` is array, range AND net), which is exactly why the *operand* type comes from
 * the operator rather than from the column (03 §2.9, the Kysely defect).
 */
export type BinaryOp =
  // comparison / arithmetic / concat — every class
  | '='
  | '<>'
  | '<'
  | '<='
  | '>'
  | '>='
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '||'
  // text
  | 'like'
  | 'ilike'
  | 'not like'
  | 'not ilike'
  | 'similar to'
  | 'not similar to'
  | '~'
  | '~*'
  | '!~'
  | '!~*'
  | '^@'
  // array / jsonb / range / net (shared containment + overlap)
  | '@>'
  | '<@'
  | '&&'
  // jsonb
  | '->'
  | '->>'
  | '#>'
  | '#>>'
  | '#-'
  | '?'
  | '?|'
  | '?&'
  | '@?'
  | '@@'
  // range / net
  | '<<'
  | '>>'
  | '-|-'

/** [spike] Exactly two operands. `and`/`or` are `BoolNode` instead — see below. */
export interface BinaryNode {
  k: 'bin'
  op: BinaryOp
  l: Expr
  r: Expr
  resultCodec: AnyCodec
}

/**
 * [spike] n-ary boolean connective. Deliberately not a right-leaning `BinaryNode` spine:
 * `and(a, b, c)` emits `(a and b and c)` in one pass with one paren pair, and the empty
 * case has a defined identity (`and()` => `true`, `or()` => `false`).
 */
export interface BoolNode {
  k: 'bool'
  op: 'and' | 'or'
  args: readonly Expr[]
}

/** [spike] `name(arg, ...)`. */
export interface FuncCallNode {
  k: 'fn'
  name: string
  args: readonly Expr[]
  resultCodec: AnyCodec
}

/** [spike] */
export interface UnaryNode {
  k: 'un'
  op: 'not' | '-' | '+' | '~'
  e: Expr
  resultCodec: AnyCodec
}

/** [spike] */
export interface IsNode {
  k: 'is'
  e: Expr
  test:
    | 'null'
    | 'not null'
    | 'true'
    | 'not true'
    | 'false'
    | 'not false'
    | 'distinct from'
    | 'not distinct from'
  r?: Expr | undefined
}

/** [spike] `list` (with the `in([])` => `false` rule) and `any` (`= any($1)`). */
export interface InNode {
  k: 'in'
  e: Expr
  not: boolean
  set:
    | { k: 'list'; items: readonly Expr[] }
    | { k: 'query'; query: SelectNode | SetOpNode }
    | { k: 'any'; array: Expr }
}

export interface BetweenNode {
  k: 'between'
  e: Expr
  lo: Expr
  hi: Expr
  symmetric: boolean
  not: boolean
}

/** [spike] — `count`/`sum` used by relation aggregates. */
export interface AggNode {
  k: 'agg'
  name: string
  args: readonly Expr[]
  distinct: boolean
  /** `agg(x order by y)` */
  orderBy?: readonly OrderItem[] | undefined
  /** `agg(x) filter (where ...)` */
  filter?: Expr | undefined
  /** `count(*)` */
  star?: boolean | undefined
  resultCodec: AnyCodec
}

export interface WindowDef {
  partitionBy?: readonly Expr[] | undefined
  orderBy?: readonly OrderItem[] | undefined
  frame?:
    | {
        mode: 'rows' | 'range' | 'groups'
        start: FrameBound
        end?: FrameBound | undefined
        exclude?: 'current row' | 'group' | 'ties' | 'no others' | undefined
      }
    | undefined
}

/** One entry of a `WINDOW` clause. `03` §2.8's `.window('byAuthor', ...)`. */
export interface NamedWindow {
  name: string
  def: WindowDef
}

export interface OverNode {
  k: 'over'
  fn: AggNode | FuncCallNode
  window: WindowDef | { ref: string }
}

export interface CaseNode {
  k: 'case'
  operand?: Expr | undefined
  whens: readonly { when: Expr; then: Expr }[]
  else?: Expr | undefined
  resultCodec: AnyCodec
}

/** [spike] — used for the per-codec JSON casts. */
export interface CastNode {
  k: 'cast'
  e: Expr
  to: string
  resultCodec: AnyCodec
}

export interface RowNode {
  k: 'row'
  items: readonly Expr[]
}

export interface ArrayNode {
  k: 'array'
  items: readonly Expr[]
  elemCodec: AnyCodec
}

/** [spike] */
export interface SubqueryExprNode {
  k: 'sq'
  query: SelectNode | SetOpNode
  resultCodec: AnyCodec
  /**
   * Set **only** by the relation layer (`src/query/relations.ts`), on the correlated subquery a
   * `.count()` / `.sum(f)` accessor produces. It marks the node as a candidate for `03` §2.3
   * point 6: `planSelect` lifts it into a `LEFT JOIN LATERAL … ON TRUE` and replaces every
   * structurally identical occurrence with one reference to that lateral's `"v"`.
   *
   * A user's own `sq` node never carries it, which is what confines the compiler's only
   * common-subexpression elimination to nodes the compiler itself generated. Absent — or present
   * in a position with no FROM clause to hoist onto, such as a RETURNING list — the node still
   * emits as an ordinary correlated subquery, so the flag can only change the *plan*, never the
   * answer.
   */
  hoist?: boolean | undefined
}

/** [spike] */
export interface ExistsNode {
  k: 'exists'
  not: boolean
  query: SelectNode
}

/** Relation projection support. The compiler builds these; users never construct them. */
export interface JsonBuildNode {
  k: 'jsonBuild'
  entries: readonly (readonly [string, Expr])[]
  variant: 'json' | 'jsonb'
}

/** `emptyAs: '[]'` makes the emitter wrap in `coalesce(..., '[]'::json)`. */
export interface JsonAggNode {
  k: 'jsonAgg'
  e: Expr
  orderBy?: readonly OrderItem[] | undefined
  variant: 'json' | 'jsonb'
  emptyAs?: '[]' | undefined
}

/**
 * The escape hatch, and the runtime representation of a `sql` fragment.
 * `chunks` and `parts` interleave: chunks[0] parts[0] chunks[1] … chunks[n].
 * Invariant: `chunks.length === parts.length + 1`.
 */
export interface RawNode {
  k: 'raw'
  /** Compile-time constant strings only — these come from a TemplateStringsArray. */
  chunks: readonly string[]
  parts: readonly RawPart[]
  /** null => decode dynamically by OID (03 §3.2). */
  resultCodec: AnyCodec | null
}

export type RawPart = Expr | IdentPart | RawSpliceNode

/**
 * An identifier hole (03 §3.4). Validation and quoting happen eagerly, at `sql.ident()`
 * call time, for two reasons: the `InvalidIdentifierError` then points at the offending
 * call site rather than at `compile()`, and a reused fragment quotes once rather than once
 * per compile. The compiler splices `quoted` verbatim.
 */
export interface IdentPart {
  k: 'ident'
  parts: readonly string[]
  quoted: string
}

/** The only node that can put arbitrary caller text into the output (03 §3.5). */
export interface RawSpliceNode {
  k: 'unsafeRaw'
  text: string
  origin?: string | undefined
}

// ─────────────────────────── Clauses ───────────────────────────

export interface ProjectionItem {
  key: string
  expr: Expr
  /** Present iff this projection item is a nested relation (03 §2.3, D4). */
  nested?: NestedPlan | undefined
  /** Present iff this projection item is a nested *literal* — `nest({...})` (03 §2.2, fork F2). */
  group?: GroupPlan | undefined
}

/**
 * A `nest({...})` group: pure grouping, **zero SQL cost**.
 *
 * Unlike {@link NestedPlan} this is not a relation and hoists nothing. Its children are emitted as
 * ordinary projection columns of the enclosing select — so one `ProjectionItem` here stands for
 * `n` result columns — and the decoder reassembles the object positionally. `03` §2.2's promise
 * that grouping costs nothing is this: the SQL of a query with `nest` is byte-identical to the
 * same query with the group's members spelled flat.
 *
 * **`nullable` is whole-object, not per-field** (03 §2.2, the one thing Drizzle gets right):
 * `author: { id: bigint } | null`, never `author: { id: bigint | null }`. Deciding *which* rows
 * are the null ones needs a witness, and `sentinel` is it: the index within {@link items} of a
 * child the schema declares NOT NULL, so a null there can only mean the left join found no row.
 * `undefined` when the group projects no such column, and the decoder then falls back to
 * "every field is null" — the Drizzle rule, which is right in every case except a real row whose
 * projected columns happen to all be NULL. `src/query/scope.ts` picks the sentinel.
 */
export interface GroupPlan {
  items: readonly ProjectionItem[]
  nullable: boolean
  sentinel?: number | undefined
  /**
   * Indexes into {@link items} whose simultaneous NULL means "this group is null", overriding
   * both `sentinel` and the decoder's fallback.
   *
   * The fallback ("every column of the group is NULL") is a heuristic, and only the builder knows
   * the two things that would settle it: whether the group came from an outer join at all, and
   * which of its columns the schema declares NOT NULL. This field is the seam for that decision;
   * an empty array means "never null". Members that are not plain columns are ignored — a nested
   * group or a relation has no single column to test.
   */
  witnesses?: readonly number[] | undefined
}

/**
 * A nested-relation projection, pre-hoist. `hoist.ts` turns this into a
 * `LEFT JOIN LATERAL` on the parent plus a `"alias"."v"` reference in the projection.
 *
 * The correlation predicate lives inside `query.where` — the relation layer (agent 05) is
 * responsible for building it from `RelationMeta.from`/`.to`; the compiler only hoists.
 */
export interface NestedPlan {
  kind: 'many' | 'one'
  query: SelectNode
  /**
   * Lateral alias. Deterministic and caller-visible so goldens can pin it.
   *
   * Optional since WS5: a hand-built node names its own alias (the compiler suite's `"lp"`,
   * `"cc"`, `"au"`), while a builder-generated relation cannot — the accessor that creates it
   * does not know how many siblings precede it. When absent, `planSelect` assigns `_r0`, `_r1`,
   * … in left-to-right order over the whole plan, sharing one number between occurrences that
   * {@link SubqueryExprNode.hoist} has already collapsed.
   */
  alias?: string | undefined
  variant?: 'json' | 'jsonb' | undefined
  /** `one` relations: false => the decoded value is `T | null`. */
  required?: boolean | undefined
  /**
   * `03` §2.3 point 1: `LEFT JOIN LATERAL` by default because it plans better for large fan-outs,
   * with the correlated-subquery form available per projection for the cases where the planner
   * prefers it. The two are differentials of each other — same rows, same decode plan, and
   * `test/live-query/relations.test.ts` asserts exactly that.
   */
  strategy?: 'lateral' | 'subquery' | undefined
}

export interface OrderItem {
  e: Expr
  dir: 'asc' | 'desc'
  nulls?: 'first' | 'last' | undefined
}

export interface SetItem {
  column: ColumnMeta
  value: Expr
}

export type FrameBound =
  | { k: 'unbounded preceding' }
  | { k: 'current row' }
  | { k: 'unbounded following' }
  | { k: 'preceding' | 'following'; n: Expr }
