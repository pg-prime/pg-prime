import { SchemaError } from '../sql/errors.js'
import { COLS, INS, META, NAME, REFS, RELS, SEL, SRC, UPD } from './symbols.js'
import { checkName, kit, pgEnum } from './column.js'
import type { AnyCol, ColumnKit, ColumnRuntime, PgEnum } from './column.js'
import { fragmentDdlText } from './ddl.js'
import type { RefLike } from './ddl.js'
import type { TableExtra } from './extras.js'
import type { RefRuntime, RefsOfCols } from './ref.js'
import type { ViewInfo } from './view.js'
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
  /**
   * Present iff this runtime belongs to a `pgView` / `pgMaterializedView` (design/01 §3 row 58).
   *
   * One optional field rather than a `kind` discriminant on every table: `sourceOf`, the session
   * layer's `REFRESH` helper and the kit's schema walk each need to answer "is this a view?", and
   * a table pays one absent property for it. `undefined` is the whole answer for a table.
   */
  readonly view?: ViewInfo
  column(key: string): ColumnRuntime | undefined
}

/**
 * A table.
 *
 * `R` is always `{}` for a `pgTable(...)` and the `[RELS]` slot is always the empty record:
 * relations live on the **schema** (`defineSchema(tables, rels)`), never on the table, because a
 * fully-cyclic graph cannot be declared table-by-table without thunks (design/04 §1.5). Both are
 * kept — rather than deleted — so that `Table<N, C>` stays structurally assignable to `AnyTable`,
 * whose `[RELS]` slot the query layer reads through `RelsAtH`, and so an extension pack that does
 * attach relations to a table has a slot to put them in. Nothing in this package writes it.
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
  /**
   * The same pre-computed `[REFS]` slot under a name a schema file can type.
   *
   * `.references(() => orgs.cols.id)` (design/11 §1.7) has to name one column of a table declared
   * elsewhere in the file, and the symbol spelling — `orgs[REFS].id` — requires importing a
   * phantom slot key whose only reason for being exported is TS2527. This is deliberately NOT the
   * Drizzle `Table & Columns` intersection design/04 §1.3 rejects: it is one property, its type is
   * the identical instantiation `[REFS]` already holds (so the instantiation cache serves both),
   * and a column keyed `cols` cannot collide with it because columns never live on the table.
   */
  readonly cols: RefsOfCols<N, C>
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
  readonly cols: any
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
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
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

  constructor(
    name: string,
    schema: string | undefined,
    columns: readonly RefRuntime[],
    extras: readonly TableExtra[],
  ) {
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
 * The `{ [tsKey]: ref }` record a `.generatedAlwaysAs((c) => …)` callback is handed.
 *
 * Built only when some column actually declares one — the check is a scan of the record's
 * own values, which every table already pays for once — because the whole point of design/11
 * §3 K2a's rule is that a DDL modifier nobody uses costs nothing. What the callback needs is
 * `$.dbName` and nothing else (`fragmentDdlText` renders a column reference as its quoted DB
 * name), so this is a *names-only* pre-pass rather than a second construction of the refs:
 * the real ones do not exist yet, which is the reason the callback exists at all.
 */
function lateGenerationRefs(
  table: string,
  schema: string | undefined,
  casing: (key: string) => string,
  record: Readonly<Record<string, { $?: ColumnRuntime } | undefined>>,
  keys: readonly string[],
): Readonly<Record<string, RefLike>> | undefined {
  let needed = false
  for (const key of keys) {
    if (record[key]?.$?.ddl.generatedAsFrom !== undefined) {
      needed = true
      break
    }
  }
  if (!needed) return undefined
  const out: Record<string, RefLike> = Object.create(null) as Record<string, RefLike>
  for (const key of keys) {
    const ddl = record[key]?.$?.ddl
    if (ddl === undefined) continue
    out[key] = Object.freeze({
      $: Object.freeze({ table, schema, dbName: ddl.dbName ?? casing(key) }),
    })
  }
  return Object.freeze(out)
}

/**
 * Turn `.generatedAlwaysAs((c) => …)` into DDL text, now that the DB names are known.
 *
 * The result is a plain `ColumnRuntime` rather than the builder, and it replaces the builder
 * on BOTH the `RefRuntime` and the ref's `[META]` slot, so nothing in the package can read a
 * half-resolved column: `metaOf`, the emitter and every query path go through one of those
 * two. A column with no late-bound expression is returned untouched, which is every column
 * in every schema that does not use the feature.
 */
function resolveGeneration(
  col: ColumnRuntime,
  refs: Readonly<Record<string, RefLike>> | undefined,
  table: string,
  key: string,
): ColumnRuntime {
  const late = col.ddl.generatedAsFrom
  if (late === undefined) return col
  const what = `pgTable("${table}").${key}.generatedAlwaysAs()`
  const text = fragmentDdlText(late(refs ?? {}), what)
  if (text.trim() === '') throw new SchemaError(`pg-prime: ${what} produced an empty expression.`)
  return { ddl: { ...col.ddl, generatedAs: text, generatedAsFrom: undefined }, ts: col.ts }
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
  checkName(name, `pgTable("${name}") table name`)
  if (options?.schema !== undefined) checkName(options.schema, `pgTable("${name}") schema name`)

  const record = (typeof columns === 'function' ? columns(kit) : columns) as unknown as Record<
    string,
    { $?: ColumnRuntime } | undefined
  >
  // `{ __proto__: text() }` sets the *prototype* — the key is not an own property, so the column
  // would vanish silently and the table would ship one column short. A record whose prototype is
  // not `Object.prototype` is the only way that literal can manifest, so reject it here rather
  // than emit DDL for a table the schema file does not describe.
  const proto = Object.getPrototypeOf(record)
  if (proto !== Object.prototype) {
    throw new SchemaError(
      `pg-prime: pgTable("${name}") was given a column record with a non-standard prototype. The ` +
        `usual cause is a \`__proto__:\` key, which JavaScript applies to the prototype instead ` +
        `of creating a column. "__proto__" is reserved, like a leading "$".`,
    )
  }

  // Null-prototype, so a column literally keyed `['__proto__']` lands as an own property here too
  // instead of silently retargeting the object's prototype.
  const refs: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const runtimes: RefRuntime[] = []
  const dbNames = new Map<string, string>()

  const keys = Object.keys(record)
  const generationRefs = lateGenerationRefs(name, options?.schema, casing, record, keys)

  for (const key of keys) {
    if (key.startsWith('$')) throw new Error(`pg-prime: column key "${key}" may not start with "$"`)
    if (key === '__proto__') {
      throw new SchemaError(`pg-prime: column key "__proto__" is reserved in pgTable("${name}").`)
    }
    const col = record[key]?.$
    // `pgTable('r', { id: 'text' })` used to die at `record[key]!.$` with a bare `TypeError:
    // Cannot read properties of undefined`. The column DSL is the whole point of the package, so
    // handing it something that is not a column deserves a sentence naming the key.
    if (col === undefined || typeof col.ddl !== 'object' || col.ddl === null) {
      throw new SchemaError(
        `pg-prime: pgTable("${name}").${key} is not a column. Write \`${key}: t.text()\` (or any ` +
          `other column builder), not a bare value.`,
      )
    }
    const dbName = col.ddl.dbName ?? casing(key)
    checkName(dbName, `pgTable("${name}").${key} column name "${dbName}"`)
    const taken = dbNames.get(dbName)
    if (taken !== undefined) {
      throw new SchemaError(
        `pg-prime: pgTable("${name}") maps both "${taken}" and "${key}" to the DB column ` +
          `"${dbName}" (casing strategy: ${options?.casing ? 'custom' : 'snakeCase'}). One of ` +
          `the two would be unreachable — rename it, or pass an explicit name to the builder.`,
      )
    }
    dbNames.set(dbName, key)
    const resolved = resolveGeneration(col, generationRefs, name, key)
    const rt: RefRuntime = Object.freeze({
      table: name,
      schema: options?.schema,
      key,
      dbName,
      column: resolved,
    })
    runtimes.push(rt)
    refs[key] = Object.freeze({ [SRC]: name, [NAME]: key, [META]: resolved, $: rt })
  }

  // Frozen: a `Table` is the schema's single source of truth for DDL, the migration IR and every
  // compiled query, and all three memoise off it. A mutation after declaration would desync them
  // silently, so it fails loudly instead.
  const refsObj = Object.freeze(refs) as RefsOfCols<N, ColsOf<B>>
  const extraNodes = Object.freeze(extras ? [...extras(refsObj)] : [])

  const runtime = new TableImpl(name, options?.schema, Object.freeze(runtimes), extraNodes)

  return Object.freeze({
    [NAME]: name,
    [COLS]: undefined,
    [REFS]: refsObj,
    cols: refsObj,
    [SEL]: undefined,
    [INS]: undefined,
    [UPD]: undefined,
    [RELS]: Object.freeze({}),
    $: runtime,
  }) as unknown as Table<N, ColsOf<B>>
}

/** design/04 §1.3 spelling. */
export const table = pgTable

// ─────────────────────────────────────────────────────────────────────────────
// pgSchema (design/05 §3.1)
// ─────────────────────────────────────────────────────────────────────────────

/** `pgSchema('audit', { renamedFrom: 'auditing' })`. */
export interface PgSchemaOptions {
  readonly renamedFrom?: string
}

/**
 * A namespace factory bound to one PostgreSQL schema.
 *
 * `audit.table(...)` is `pgTable(..., { schema: 'audit' })` with the schema already applied, which
 * is the only thing design/05 §3.1 asks of it: the binding is what makes a schema move a one-line
 * edit instead of a find-and-replace over every table in the file.
 */
export interface PgSchema {
  readonly kind: 'schema'
  readonly name: string
  readonly renamedFrom: string | undefined
  table<N extends string, B extends Record<string, AnyCol>>(
    name: N,
    columns: B | ((t: ColumnKit) => B),
    extras?: (t: RefsOfCols<N, ColsOf<B>>) => readonly TableExtra[],
    options?: Omit<TableOptions, 'schema'>,
  ): Table<N, ColsOf<B>>
  /** `audit.enum('event_kind', [...])` — `pgEnum` with `{ schema }` already applied. */
  enum<EN extends string, const V extends readonly [string, ...string[]]>(
    name: EN,
    values: V,
  ): PgEnum<EN, V>
}

export function pgSchema(name: string, options?: PgSchemaOptions): PgSchema {
  checkName(name, `pgSchema("${name}") schema name`)
  if (options?.renamedFrom !== undefined) {
    checkName(options.renamedFrom, `pgSchema("${name}", { renamedFrom })`)
  }
  return Object.freeze({
    kind: 'schema' as const,
    name,
    renamedFrom: options?.renamedFrom,
    table<N extends string, B extends Record<string, AnyCol>>(
      tableName: N,
      columns: B | ((t: ColumnKit) => B),
      extras?: (t: RefsOfCols<N, ColsOf<B>>) => readonly TableExtra[],
      tableOptions?: Omit<TableOptions, 'schema'>,
    ): Table<N, ColsOf<B>> {
      return pgTable(tableName, columns, extras, { ...tableOptions, schema: name })
    },
    enum<EN extends string, const V extends readonly [string, ...string[]]>(
      enumName: EN,
      values: V,
    ): PgEnum<EN, V> {
      return pgEnum(enumName, values, { schema: name })
    },
  })
}
