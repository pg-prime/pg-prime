import { COLS, INS, META, NAME, REFS, RELS, SEL, SRC, UPD } from './symbols.js'
import { kit } from './column.js'
import type { AnyCol, ColumnKit, ColumnRuntime } from './column.js'
import type { TableExtra } from './extras.js'
import type { RefRuntime, RefsOfCols } from './ref.js'
import type { Cols, InsertRow, Rels, SelectRow, UpdateRow } from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// The table (design/04 §1.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `B[K][typeof META]`, **not** `B[K] extends Col<infer M> ? M : never`. Because
 * `B` is inferred as a literal object type, the indexed access resolves to the
 * exact meta with no conditional — small, repeated N-columns × N-tables.
 */
export type ColsOf<B extends Record<string, AnyCol>> = { [K in keyof B]: B[K][typeof META] }

/** Runtime metadata for a table. Non-generic: free at the type level. */
export interface TableRuntime {
  readonly name: string
  readonly schema: string | undefined
  readonly columns: readonly RefRuntime[]
  readonly extras: readonly TableExtra[]
  column(key: string): ColumnRuntime | undefined
}

/**
 * A table.
 *
 * The row shapes and the column-reference object are *properties of an
 * instantiated interface*: TypeScript computes an instantiated type's property
 * type lazily and then caches it on that instantiation. So `SelectRow<C>` for
 * `users` is computed at most once per program, no matter how many queries
 * touch `users`. **This is the load-bearing perf decision** (design/04 §1.3).
 *
 * Deliberately absent: the Drizzle `Table & Columns` intersection. Columns are
 * reached through callbacks whose parameter type is the pre-computed `[REFS]`
 * slot.
 */
export interface Table<N extends string, C extends Cols, R extends Rels = {}> {
  readonly [NAME]: N
  readonly [COLS]: C
  readonly [REFS]: RefsOfCols<N, C>
  readonly [SEL]: SelectRow<C>
  readonly [INS]: InsertRow<C>
  readonly [UPD]: UpdateRow<C>
  readonly [RELS]: R
  readonly $: TableRuntime
}

/**
 * Minimal `Any` supertype (design/04 §3.3): members are `any`, **not**
 * `Table<any, any, any>`, so `X extends AnyTable` is an O(1) check that never
 * forces `SEL`/`INS`/`UPD`/`REFS` to be computed. Measured there at −2,561
 * instantiations on a 100-table schema.
 */
export interface AnyTable {
  readonly [NAME]: any
  readonly [COLS]: any
  readonly [REFS]: any
  readonly [SEL]: any
  readonly [INS]: any
  readonly [UPD]: any
  readonly [RELS]: any
  readonly $: TableRuntime
}

/** `$inferSelect`. */
export type Selectable<T extends AnyTable> = T[typeof SEL]
/** `$inferInsert`. */
export type Insertable<T extends AnyTable> = T[typeof INS]
/** `$inferUpdate`. */
export type Updateable<T extends AnyTable> = T[typeof UPD]

/** design/05 D3 spellings. Aliases, so they cost one alias resolution. */
export type Row<T extends AnyTable> = T[typeof SEL]
export type Insert<T extends AnyTable> = T[typeof INS]
export type Update<T extends AnyTable> = T[typeof UPD]

/** Column refs of a table — the parameter type of every column callback. */
export type Refs<T extends AnyTable> = T[typeof REFS]

// ─────────────────────────────────────────────────────────────────────────────
// Runtime
// ─────────────────────────────────────────────────────────────────────────────

/** design/05 D12: DB names default from the TS key via the casing strategy. */
export function snakeCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase()
}

export interface TableOptions {
  readonly schema?: string
  readonly casing?: (key: string) => string
}

class TableImpl implements TableRuntime {
  readonly name: string
  readonly schema: string | undefined
  readonly columns: readonly RefRuntime[]
  readonly extras: readonly TableExtra[]
  readonly #byKey: Map<string, RefRuntime>

  constructor(name: string, schema: string | undefined, columns: readonly RefRuntime[], extras: readonly TableExtra[]) {
    this.name = name
    this.schema = schema
    this.columns = columns
    this.extras = extras
    this.#byKey = new Map(columns.map((c) => [c.key, c]))
  }

  column(key: string): ColumnRuntime | undefined {
    return this.#byKey.get(key)?.column
  }
}

/**
 * `pgTable(name, cols, extras?)` — design/05 D1 + design/04 §1.3.
 *
 * Columns may be a plain record or a `(t: ColumnKit) => record` callback; the
 * callback form keeps a schema file's import list short and gives extension
 * packs one place to hang new column types.
 *
 * All three row shapes and the refs object are flattened **eagerly, once per
 * table** into the returned interface's slots.
 */
export function pgTable<N extends string, B extends Record<string, AnyCol>>(
  name: N,
  columns: B | ((t: ColumnKit) => B),
  extras?: (t: RefsOfCols<N, ColsOf<B>>) => readonly TableExtra[],
  options?: TableOptions,
): Table<N, ColsOf<B>> {
  const casing = options?.casing ?? snakeCase
  const record = (typeof columns === 'function' ? columns(kit) : columns) as unknown as Record<
    string,
    { $: ColumnRuntime }
  >

  const refs: Record<string, unknown> = {}
  const runtimes: RefRuntime[] = []

  for (const key of Object.keys(record)) {
    if (key.startsWith('$')) throw new Error(`pgorm: column key "${key}" may not start with "$"`)
    const col = record[key]!.$
    const rt: RefRuntime = { table: name, key, dbName: col.ddl.dbName ?? casing(key), column: col }
    runtimes.push(rt)
    refs[key] = { [SRC]: name, [NAME]: key, [META]: col, $: rt }
  }

  const refsObj = refs as RefsOfCols<N, ColsOf<B>>
  const extraNodes = extras ? [...extras(refsObj)] : []

  const runtime = new TableImpl(name, options?.schema, runtimes, extraNodes)

  return {
    [NAME]: name,
    [COLS]: undefined,
    [REFS]: refsObj,
    [SEL]: undefined,
    [INS]: undefined,
    [UPD]: undefined,
    [RELS]: {},
    $: runtime,
  } as unknown as Table<N, ColsOf<B>>
}

/** design/04 §1.3 spelling. */
export const table = pgTable
