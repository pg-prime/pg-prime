/**
 * The shared state records every builder stage is a thin wrapper around (design/09 WS4).
 *
 * ## Why a state record and not a class per stage
 *
 * `03` §1.4a requires builders to be immutable, and immutability is only affordable if deriving a
 * query is O(1). So a builder is *one frozen object* — the state — plus a prototype of methods,
 * and every method returns a new builder over `{ ...state, one: field }`. That copies a dozen
 * pointers; it never walks or clones the AST, and every node in the old tree is shared by
 * reference with the new one. The AST is frozen too (`mkNode`), so sharing is safe by
 * construction rather than by discipline.
 *
 * The stages (`Query` → `GroupedQuery` → `SetQuery`) are separate *interfaces* for type reasons
 * (`04` §4, and the `GROUP BY` guard's conditionals must not reach an ungrouped query), but they
 * are the same *runtime* shape. `SelectBuilder` implements all three; the type system is what
 * decides which methods are reachable.
 *
 * ## What is deliberately NOT in the state
 *
 * The compiled artifact. `.compile()` memoises onto the *instance* (`03` §1.4a) rather than into
 * the state, because the state is what gets copied: a memo inside it would be copied along with
 * everything else and would then describe the wrong query. An instance field cannot go stale
 * because the instance cannot change.
 */

import type { CodecRegistry } from '../codec/index.js'
import type {
  CteNode,
  Expr,
  FromItem,
  InsertSource,
  JoinNode,
  NamedWindow,
  OnConflictNode,
  OrderItem,
  ProjectionItem,
  SelectNode,
  SetItem,
  SetOpNode,
  TableRefNode,
  ColumnMeta,
} from '../compile/ast.js'
import type { Compiled } from '../compile/contract.js'
import type { RelsRecord, Tables } from '../schema/index.js'
import type { RefScope } from './ref.js'

/**
 * How a builder reaches a database, and what it is allowed to assume about one.
 *
 * WS4 needs exactly this much of WS6's executor: run a `Compiled`, and know whether we are already
 * inside a transaction (which is what decides whether a chunked bulk insert opens its own —
 * `03` §2.6). `prepare` / `stream` / `explain` / `assertShape` are WS6's and are deliberately
 * absent rather than stubbed.
 */
export interface Runner {
  /** Execute and decode. `Compiled` already carries the decode plan and its codecs. */
  run<Row>(compiled: Compiled<Row>): Promise<Row[]>
  /**
   * Execute several statements atomically, concatenating their rows. Opens a transaction unless
   * {@link inTransaction} is already true — nesting `BEGIN` is a 25001 warning and, worse, a
   * commit that does not commit what the caller thinks.
   */
  runChunked<Row>(compiled: readonly Compiled<Row>[]): Promise<Row[]>
  readonly inTransaction: boolean
}

/** Everything a builder carries that is not part of the statement being built. */
export interface BuilderCtx {
  readonly registry: CodecRegistry
  /** `undefined` for a builder made by `compileOnly()` — `.compile()` works, `.execute()` throws. */
  readonly runner: Runner | undefined
  /** Relation declarations, for WS5's accessors. Present iff the db was built from a schema. */
  readonly tables: Tables | undefined
  readonly rels: RelsRecord<Tables> | undefined
}

/** Aliases currently in scope, in declaration order, plus their ref records. */
export interface Scopes {
  readonly byAlias: Readonly<Record<string, RefScope>>
}

export interface SelectState {
  readonly ctx: BuilderCtx
  readonly ctes: readonly CteNode[]
  readonly distinct: { on?: readonly Expr[] | undefined } | undefined
  readonly projection: readonly ProjectionItem[] | undefined
  readonly from: FromItem | undefined
  readonly joins: readonly JoinNode[]
  readonly where: Expr | undefined
  readonly groupBy: readonly Expr[] | undefined
  readonly having: Expr | undefined
  readonly windows: readonly NamedWindow[]
  readonly orderBy: readonly OrderItem[]
  readonly limit: Expr | undefined
  readonly offset: Expr | undefined
  readonly locking: SelectNode['locking']
  /**
   * Alias → the handle it was bound from, so widening the statement can re-derive **every**
   * scope against the new alias set. A relation accessor's child alias avoids the names visible
   * at the time its scope was built, and joining afterwards changes that set.
   */
  readonly sources: Readonly<Record<string, object>>
  readonly scope: Readonly<Record<string, RefScope>>
}

export interface SetOpState {
  readonly ctx: BuilderCtx
  readonly node: SetOpNode
  readonly orderBy: readonly OrderItem[]
  readonly limit: Expr | undefined
  readonly offset: Expr | undefined
  /** Result refs, by output key — what an `ORDER BY` on a set-op result may name. */
  readonly resultRefs: Readonly<Record<string, Expr>>
}

export interface InsertState {
  readonly ctx: BuilderCtx
  readonly ctes: readonly CteNode[]
  /** The handle `insertInto` was given — the only thing that can produce refs and codecs. */
  readonly handle: object
  readonly into: TableRefNode
  readonly columns: readonly ColumnMeta[]
  readonly source: InsertSource | undefined
  readonly castFirstRow: boolean
  readonly onConflict: OnConflictNode | undefined
  readonly returning: readonly ProjectionItem[] | undefined
  readonly scope: Readonly<Record<string, RefScope>>
  /** Rows for a bulk insert, kept unencoded so the strategy can still change (03 §2.6). */
  readonly rows: readonly Record<string, unknown>[] | undefined
  readonly bulk: BulkOpts | undefined
  /**
   * The executor that created this builder, so `.fromSelect(d => …)` can hand it back with the
   * CTEs already in scope. Typed `unknown` on purpose: `src/query/cte.ts` imports this module, so
   * naming `Executor` here would close an import cycle for no type-safety gain at this seam.
   */
  readonly owner: unknown
}

/** `03` §2.6's two strategies and the automatic switch between them. */
export interface BulkOpts {
  readonly strategy?: 'values' | 'unnest' | 'auto'
  readonly chunkSize?: number
}

export interface UpdateState {
  readonly ctx: BuilderCtx
  readonly ctes: readonly CteNode[]
  readonly handle: object
  readonly target: TableRefNode
  readonly set: readonly SetItem[]
  readonly from: readonly FromItem[]
  readonly where: Expr | undefined
  readonly returning: readonly ProjectionItem[] | undefined
  /** Set by `fromValues`, so `.set((t, v) => …)` and `.where((t, v) => …)` get their second scope. */
  readonly valuesAlias: string | undefined
  /** See {@link SelectState.sources}. */
  readonly sources: Readonly<Record<string, object>>
  readonly scope: Readonly<Record<string, RefScope>>
  /** `03` §2.5 has no unconditional UPDATE; `.allRows()` is the opt-in. */
  readonly allRows: boolean
}

export interface DeleteState {
  readonly ctx: BuilderCtx
  readonly ctes: readonly CteNode[]
  readonly from: TableRefNode
  readonly using: readonly FromItem[]
  readonly where: Expr | undefined
  readonly returning: readonly ProjectionItem[] | undefined
  /** See {@link SelectState.sources}. */
  readonly sources: Readonly<Record<string, object>>
  readonly scope: Readonly<Record<string, RefScope>>
  /** `03` §2.5 has no unconditional DELETE; `.allRows()` is the opt-in. */
  readonly allRows: boolean
}
