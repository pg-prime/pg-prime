/**
 * Constraint name → schema object (design/07 §4.4).
 *
 * PostgreSQL tells you `duplicate key value violates unique constraint "users_email_key"`. Because
 * `pgPrime({ schema })` was handed the schema, we can turn that opaque string into the table and
 * the columns the user actually declared — and then let them match on the *column reference*
 * rather than on the name, so a rename is a compile error instead of a silent behaviour change.
 *
 * ## Structural, on purpose
 *
 * `TableRef` and `ColumnRef` are declared as "anything carrying the right `$`". The generic
 * `Table<N, C, R>` and `Ref<A, K, M>` would drag the whole type layer into every error's
 * signature — this file is imported by `./classes.ts`, which is imported by everything — and the
 * only thing an error message or an `isUniqueViolation(e, users.email)` predicate reads is the
 * runtime metadata. A schema `Table`, a `defineSchema` handle and a `Ref` all satisfy these.
 *
 * ## Lazily, on first constraint error
 *
 * Not at startup: `07` §4.4 is explicit that startup cost matters for serverless, and the vast
 * majority of processes never see a `23xxx`. The index is built once per schema object and cached
 * in a `WeakMap`, so it costs nothing until the first violation and nothing after it.
 */

import type { TableExtra } from '../schema/extras.js'
import type { RefRuntime } from '../schema/ref.js'
import type { TableRuntime } from '../schema/table.js'

/** A schema table, structurally. `pgTable(...)` and a `defineSchema` handle both satisfy it. */
export interface TableRef {
  readonly $: TableRuntime
}

/** One column of one table, structurally. `users.cols.email` satisfies it. */
export interface ColumnRef {
  readonly $: RefRuntime
}

export type ConstraintKind =
  | 'unique'
  | 'primaryKey'
  | 'foreignKey'
  | 'check'
  | 'exclusion'
  | 'notNull'

/** `07` §4.4's resolved constraint — schema objects, never strings. */
export interface ConstraintRef {
  readonly kind: ConstraintKind
  readonly name: string
  readonly table: TableRef
  readonly columns: readonly ColumnRef[]
  /** For foreign keys. */
  readonly referencedTable?: TableRef
  readonly referencedColumns?: readonly ColumnRef[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Building the index
// ─────────────────────────────────────────────────────────────────────────────

const INDEXES = new WeakMap<object, ReadonlyMap<string, ConstraintRef>>()

/** `users_email_key` — PostgreSQL's own default for a single-column unique index/constraint. */
function defaultUniqueName(table: string, columns: readonly string[]): string {
  return `${table}_${columns.join('_')}_key`
}

function defaultPkName(table: string): string {
  return `${table}_pkey`
}

function defaultFkName(table: string, columns: readonly string[]): string {
  return `${table}_${columns.join('_')}_fkey`
}

function defaultCheckName(table: string, column: string | undefined): string {
  return column === undefined ? `${table}_check` : `${table}_${column}_check`
}

/**
 * `TableRuntime.columns` holds the bare `RefRuntime`, but a `ColumnRef` — the thing a user writes
 * as `users.cols.email` — is the object that *carries* one under `$`. The wrapper is built once
 * per constraint column, on the lazy path, and comparison in `./predicates.ts` is structural
 * (table + DB name), so a synthesized wrapper and the user's own `Ref` match each other.
 */
function asColumnRef(c: RefRuntime): ColumnRef {
  return Object.freeze({ $: c })
}

function columnsByDbName(t: TableRuntime): Map<string, ColumnRef> {
  const m = new Map<string, ColumnRef>()
  for (const c of t.columns) m.set(c.dbName, asColumnRef(c))
  return m
}

function pick(byName: Map<string, ColumnRef>, names: readonly string[]): readonly ColumnRef[] {
  const out: ColumnRef[] = []
  for (const n of names) {
    const c = byName.get(n)
    if (c !== undefined) out.push(c)
  }
  return Object.freeze(out)
}

/**
 * Walk one table's columns and extras into constraint entries.
 *
 * Both the *declared* name and PostgreSQL's *default* name are registered for an unnamed
 * constraint, because which one the server reports depends on whether the migration named it —
 * and we would rather resolve a constraint twice than not at all.
 */
function indexTable(
  handle: TableRef,
  out: Map<string, ConstraintRef>,
  tables: readonly TableRef[],
): void {
  const t = handle.$
  const byName = columnsByDbName(t)
  // Keyed three ways: PostgreSQL only requires a constraint name to be unique per table, so the
  // bare name is the fallback for a server that reported no table.
  const add = (name: string | undefined, ref: Omit<ConstraintRef, 'name'>): void => {
    if (name === undefined || name === '') return
    const entry = { ...ref, name }
    for (const key of [name, `${t.name}/${name}`, `${t.schema ?? ''}/${t.name}/${name}`]) {
      if (!out.has(key)) out.set(key, entry)
    }
  }

  const pkCols: string[] = []
  for (const c of t.columns) {
    const ddl = c.column.ddl
    if (ddl.primaryKey) pkCols.push(c.dbName)
    const cols = Object.freeze([byName.get(c.dbName) ?? asColumnRef(c)])
    if (ddl.unique) {
      add(ddl.uniqueSpec?.name ?? defaultUniqueName(t.name, [c.dbName]), {
        kind: 'unique',
        table: handle,
        columns: cols,
      })
    }
    if (ddl.references !== undefined) {
      add(ddl.references.name ?? defaultFkName(t.name, [c.dbName]), {
        kind: 'foreignKey',
        table: handle,
        columns: cols,
        ...resolveTarget(ddl.references.target, tables),
      })
    }
    for (const check of ddl.checks) {
      add(check.name ?? defaultCheckName(t.name, c.dbName), {
        kind: 'check',
        table: handle,
        columns: cols,
      })
    }
    // A NOT NULL violation reports no constraint name at all (23502 carries `column`), so it is
    // resolved by column in `resolveConstraint` rather than registered here.
  }
  if (pkCols.length > 0) {
    add(defaultPkName(t.name), { kind: 'primaryKey', table: handle, columns: pick(byName, pkCols) })
  }

  for (const extra of t.extras as readonly TableExtra[]) {
    switch (extra.node) {
      case 'primaryKey':
        add(extra.name ?? defaultPkName(t.name), {
          kind: 'primaryKey',
          table: handle,
          columns: pick(byName, extra.columns),
        })
        break
      case 'unique':
        add(extra.name ?? defaultUniqueName(t.name, extra.columns), {
          kind: 'unique',
          table: handle,
          columns: pick(byName, extra.columns),
        })
        break
      case 'index':
        if (extra.unique) {
          add(extra.name, { kind: 'unique', table: handle, columns: pick(byName, extra.columns) })
        }
        break
      case 'check':
        add(extra.name, { kind: 'check', table: handle, columns: Object.freeze([]) })
        break
      case 'foreignKey':
        add(extra.name ?? defaultFkName(t.name, extra.columns), {
          kind: 'foreignKey',
          table: handle,
          columns: pick(byName, extra.columns),
          ...resolveTarget(extra.references, tables),
        })
        break
      default:
        break
    }
  }
}

/**
 * Call the FK's thunk. Wrapped, because the thunk is user code evaluated at *error* time: a
 * schema file with a circular import can make it throw, and an error path that throws while
 * building a nicer message is strictly worse than the original error.
 */
function resolveTarget(
  target: (() => readonly unknown[]) | undefined,
  tables: readonly TableRef[],
): {
  referencedTable?: TableRef
  referencedColumns?: readonly ColumnRef[]
} {
  if (typeof target !== 'function') return {}
  let refs: readonly unknown[]
  try {
    refs = target()
  } catch {
    return {}
  }
  const columns: ColumnRef[] = []
  for (const r of refs) {
    if (typeof r === 'object' && r !== null && '$' in r) columns.push(r as ColumnRef)
  }
  if (columns.length === 0) return {}
  const [{ $: c }] = columns as [ColumnRef]
  const referencedTable = tables.find((x) => x.$.name === c.table && x.$.schema === c.schema)
  return {
    ...(referencedTable === undefined ? {} : { referencedTable }),
    referencedColumns: Object.freeze(columns),
  }
}

/**
 * The `Map<constraintName, ConstraintRef>` for a schema, built once and cached on the schema
 * object itself.
 */
export function constraintIndex(schema: object | undefined): ReadonlyMap<string, ConstraintRef> {
  if (schema === undefined) return EMPTY
  const hit = INDEXES.get(schema)
  if (hit !== undefined) return hit
  const out = new Map<string, ConstraintRef>()
  const tables = Object.values(
    (schema as { tables?: Readonly<Record<string, TableRef>> }).tables ?? {},
  ).filter((t): t is TableRef => typeof (t as Partial<TableRef>).$ === 'object')
  for (const t of tables) indexTable(t, out, tables)
  const frozen: ReadonlyMap<string, ConstraintRef> = out
  INDEXES.set(schema, frozen)
  return frozen
}

const EMPTY: ReadonlyMap<string, ConstraintRef> = new Map()

/**
 * Resolve what the server told us into a schema object.
 *
 * `23502 not_null_violation` reports `table` + `column` and **no** constraint name, so it is
 * resolved by (table, column) instead; everything else in class 23 reports a constraint name.
 */
export function resolveConstraint(
  schema: object | undefined,
  constraintName: string | undefined,
  tableName: string | undefined,
  columnName: string | undefined,
  schemaName?: string,
): ConstraintRef | undefined {
  const index = constraintIndex(schema)
  if (constraintName !== undefined) {
    const byTable =
      tableName === undefined
        ? undefined
        : (index.get(`${schemaName ?? ''}/${tableName}/${constraintName}`) ??
          index.get(`${tableName}/${constraintName}`))
    const hit = byTable ?? index.get(constraintName)
    if (hit !== undefined) return hit
  }
  if (tableName === undefined || columnName === undefined) return undefined
  const tables = (schema as { tables?: Readonly<Record<string, TableRef>> } | undefined)?.tables
  if (tables === undefined) return undefined
  for (const key of Object.keys(tables)) {
    const t = tables[key]
    if (t === undefined || t.$.name !== tableName) continue
    for (const c of t.$.columns) {
      if (c.dbName !== columnName) continue
      return {
        kind: 'notNull',
        name: constraintName ?? `${tableName}.${columnName} NOT NULL`,
        table: t,
        columns: Object.freeze([asColumnRef(c)]),
      }
    }
  }
  return undefined
}

/** `users(email)` — the human half of `07` §4.4's improved message. */
export function describeConstraint(ref: ConstraintRef): string {
  const cols = ref.columns.map((c) => c.$.dbName).join(', ')
  return cols === '' ? ref.table.$.name : `${ref.table.$.name}(${cols})`
}
