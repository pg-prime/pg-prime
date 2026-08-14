import type { ERR, DATE_BRAND } from './symbols.js'

// ─────────────────────────────────────────────────────────────────────────────
// Utility types (design/04 §3.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collapse an intersection into a single object type. Used at *declaration*
 * time only — never inside a query-time signature.
 */
export type Simplify<T> = { [K in keyof T]: T[K] } & {}

/**
 * Kysely's `DrainOuterGeneric`. Keeps the alias unresolved in emitted
 * declarations and avoids TS2589 at depth.
 */
export type Defer<T> = [T] extends [unknown] ? T : never

/**
 * Sentinel error type (design/04 §4.1): resolve to a branded type carrying a
 * sentence instead of failing with a constraint mismatch.
 */
export interface OrmTypeError<M extends string> {
  readonly [ERR]: M
}

/** The `date` codec's TS type: a branded `'YYYY-MM-DD'` string, never a `Date`. */
export type DateString = string & { readonly [DATE_BRAND]: 'date' }

// ─────────────────────────────────────────────────────────────────────────────
// The column carrier (design/04 §1.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The flat, four-field generic payload every column carries.
 *
 * - `t`  — the TS type *as read*; already includes `| null` when nullable, so
 *          `SelectRow` needs zero conditionals.
 * - `pg` — pg type name literal; drives operator operand tables + codec identity.
 * - `opt`— optional at INSERT (nullable | has default | identity-by-default).
 * - `ro` — never insertable/updatable (GENERATED ALWAYS).
 */
export interface ColMeta {
  readonly t: unknown
  readonly pg: string
  readonly opt: boolean
  readonly ro: boolean
}

/** A record of column metas — the flattened payload a `Table` carries. */
export type Cols = Record<string, ColMeta>

// ─────────────────────────────────────────────────────────────────────────────
// Relation metadata (design/04 §1.5) — declared here so `Table` can carry it
// without a module cycle. `to` is a KEY into the registry, never an inlined
// `Table` type: that is what makes mutually-recursive graphs free.
// ─────────────────────────────────────────────────────────────────────────────

export interface RelMeta<N extends string = string> {
  readonly kind: 'one' | 'many'
  readonly opt: boolean
  readonly to: N
}

export type Rels = Record<string, RelMeta>

// ─────────────────────────────────────────────────────────────────────────────
// Row shapes — computed ONCE per table, memoised by the instantiation cache
// ─────────────────────────────────────────────────────────────────────────────

/** `$inferSelect`. One indexed access per column; no conditional at all. */
export type SelectRow<C extends Cols> = Simplify<{ [K in keyof C]: C[K]['t'] }>

/** `$inferInsert`. Required keys and optional keys split by two `as` filters. */
export type InsertRow<C extends Cols> = Simplify<
  {
    [K in keyof C as C[K]['ro'] extends true ? never : C[K]['opt'] extends true ? never : K]: C[K]['t']
  } & {
    [K in keyof C as C[K]['ro'] extends true ? never : C[K]['opt'] extends true ? K : never]?: C[K]['t']
  }
>

/** `$inferUpdate`. Everything writable, all optional. */
export type UpdateRow<C extends Cols> = Simplify<{
  [K in keyof C as C[K]['ro'] extends true ? never : K]?: C[K]['t']
}>
