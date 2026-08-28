import type { META, NAME, OUT, SRC } from './symbols.js'
import type { ColumnRuntime } from './column.js'
import type { ColMeta, Cols } from './types.js'

/** Everything projectable exposes the same phantom output slot. */
export interface Projectable {
  readonly [OUT]: unknown
}

/**
 * Runtime metadata reachable from a column reference. Non-generic, so it costs
 * nothing per instantiation. Lives behind a single `$` key (design/05 D2).
 */
export interface RefRuntime {
  /** Source alias / table name. */
  readonly table: string
  /**
   * The table's schema, or `undefined` for the emitter's default schema.
   *
   * Carried here — not only on `TableRuntime` — because `.references(() => other.id)` hands the
   * emitter a column reference and nothing else: without the schema the FK target of a
   * cross-schema reference would have to be guessed by table name, which is ambiguous the moment
   * two schemas hold a table of the same name (design/11 §3 K2a's cross-schema FK test).
   */
  readonly schema: string | undefined
  /** TS key of the column. */
  readonly key: string
  /** Resolved DB column name (casing strategy applied). */
  readonly dbName: string
  readonly column: ColumnRuntime
}

/**
 * A reference to one column of one source alias.
 *
 * NOTE (deviation from design/04 §2.1's listing): that listing declares
 * `Ref<A, K, M>` but never uses `K` in the body. We keep `readonly [NAME]: K`
 * so refs of two different columns are not mutually assignable and so the
 * compile seam can read the column key at the type level. Cost: one string
 * literal per ref.
 */
export interface Ref<A extends string, K extends string, M extends ColMeta> extends Projectable {
  readonly [SRC]: A
  readonly [NAME]: K
  readonly [OUT]: M['t']
  readonly [META]: M
  readonly $: RefRuntime
}

/** Minimal `Any` supertype (design/04 §3.3) — O(1) constraint check. */
export interface AnyRef {
  readonly [SRC]: any
  readonly [NAME]: any
  readonly [OUT]: any
  readonly [META]: any
  readonly $: RefRuntime
}

/** Pre-computed once per table and reused by every query. */
export type RefsOfCols<N extends string, C extends Cols> = {
  readonly [K in keyof C]: Ref<N, K & string, C[K]>
}
