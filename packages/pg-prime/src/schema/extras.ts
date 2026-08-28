import { SchemaError } from '../sql/errors.js'
import type { AnyFragment } from '../sql/fragment.js'
import { checkName } from './column.js'
import { checkFkAction, fragmentDdlText } from './ddl.js'
import type { FkAction, ForeignKeyOptions, RefLike } from './ddl.js'
import type { AnyRef } from './ref.js'

/**
 * Table-level nodes (design/05 D5): one heterogeneous array of tagged nodes,
 * extensible by extension packs without an API change.
 *
 * Every node is plain frozen data plus — for `foreignKey` — one thunk, which is the same
 * lazy-resolution device `.references()` uses (design/11 §1.7).
 */
export type TableExtra =
  | { readonly node: 'primaryKey'; readonly name: string | undefined; readonly columns: readonly string[] }
  | {
      readonly node: 'index'
      readonly name: string
      readonly unique: boolean
      /**
       * The bare column names, in order — the shape WS0 shipped, kept so that everything
       * which already reads it keeps working. {@link TableExtra} `items` is the same list
       * with each column's per-column options beside it.
       */
      readonly columns: readonly string[]
      readonly items: readonly IndexItem[]
      /** `USING gin` / `USING gist` / `USING hnsw`; `undefined` = PostgreSQL's default b-tree. */
      readonly using: string | undefined
      /** A partial index's predicate, as DDL text. */
      readonly where: string | undefined
      /** `INCLUDE (a, b)` — a covering index's payload columns. */
      readonly include: readonly string[]
      /** PG15+: `NULLS NOT DISTINCT` on a unique index. */
      readonly nullsNotDistinct: boolean
    }
  | { readonly node: 'comment'; readonly text: string }
  | {
      readonly node: 'unique'
      readonly name: string | undefined
      readonly columns: readonly string[]
      readonly nullsNotDistinct: boolean
    }
  | { readonly node: 'check'; readonly name: string; readonly expression: string }
  | {
      readonly node: 'foreignKey'
      readonly name: string | undefined
      /** Local column DB names, in order. */
      readonly columns: readonly string[]
      /** Referenced columns, resolved at emit time and paired positionally with `columns`. */
      readonly references: () => readonly RefLike[]
      readonly onDelete: FkAction | undefined
      readonly onUpdate: FkAction | undefined
      readonly deferrable: boolean
      readonly initiallyDeferred: boolean
    }
  | { readonly node: 'renamedFrom'; readonly from: string }
  /** `ALTER TABLE … CLUSTER ON <index>` (`pg_index.indisclustered`). */
  | { readonly node: 'clusterOn'; readonly index: string }
  /** `… PARTITION BY RANGE (created_at)` on the parent. */
  | { readonly node: 'partitionBy'; readonly strategy: 'range' | 'list' | 'hash'; readonly key: string }
  /** `CREATE TABLE child PARTITION OF parent FOR VALUES …` on a child. */
  | {
      readonly node: 'partitionOf'
      readonly parent: string
      readonly parentSchema: string | undefined
      /** `FOR VALUES FROM (…) TO (…)` / `DEFAULT`, verbatim. */
      readonly bound: string
    }

function dbNames(refs: readonly AnyRef[], what: string): readonly string[] {
  if (refs.length === 0) throw new SchemaError(`pg-prime: ${what} was given no columns.`)
  return refs.map((r) => r.$.dbName)
}

/** `primaryKey({ name: 'pk_ab', columns: [t.a, t.b] })` — design/05 §2.4's second form. */
export interface PrimaryKeyInput {
  readonly name?: string
  readonly columns: readonly AnyRef[]
}

/**
 * `primaryKey(t.a, t.b)` or `primaryKey({ name, columns })`.
 *
 * The named form exists because PostgreSQL's own default (`<table>_pkey`) is only the
 * default: a database adopted from another tool routinely names its primary keys
 * `PK_Something`, and a DSL that could not say so would make `pg-prime pull` emit a schema
 * whose first generated migration renames every primary key in the database.
 */
export function primaryKey(...refs: [PrimaryKeyInput] | AnyRef[]): TableExtra {
  const first = refs[0]
  if (refs.length === 1 && isPrimaryKeyInput(first)) {
    if (first.name !== undefined) checkName(first.name, `primaryKey({ name: "${first.name}" })`)
    return { node: 'primaryKey', name: first.name, columns: dbNames([...first.columns], 'primaryKey({ columns })') }
  }
  return { node: 'primaryKey', name: undefined, columns: dbNames(refs as AnyRef[], 'primaryKey()') }
}

function isPrimaryKeyInput(v: unknown): v is PrimaryKeyInput {
  return typeof v === 'object' && v !== null && Array.isArray((v as { columns?: unknown }).columns)
}

/** `NULLS FIRST` / `NULLS LAST` on one index column. */
export type IndexNulls = 'first' | 'last'

/** One column of an index, with its per-column options resolved to DB names. */
export interface IndexItem {
  readonly column: string
  readonly desc: boolean
  readonly nulls: IndexNulls | undefined
  readonly opclass: string | undefined
}

/**
 * `index('i').on(t.a, { column: t.b, desc: true, nulls: 'last' })` — design/05 §2.4's
 * per-column index options.
 *
 * Design/05 spells these as methods on the column reference (`t.b.desc().nullsLast()`).
 * They are an **item object** here instead, because `Ref` is the hottest type in the
 * package — it is what `[REFS]` holds for every column of every table — and three more
 * methods on it would be paid for by every schema in every program, for a feature that
 * appears in a handful of index declarations. The item object costs nothing at the type
 * level and says exactly the same thing. Recorded in `05` §2.4 AS BUILT.
 */
export interface IndexColumn {
  readonly column: AnyRef
  readonly desc?: boolean
  readonly nulls?: IndexNulls
  /** e.g. `'text_pattern_ops'`, `'vector_cosine_ops'`. Emitted verbatim after the column. */
  readonly opclass?: string
}

/** The whole-index options of design/05 §2.4, also available as builder methods. */
export interface IndexOptions {
  readonly using?: string
  readonly where?: AnyFragment
  readonly include?: readonly AnyRef[]
  readonly nullsNotDistinct?: boolean
}

export type IndexColumnLike = AnyRef | IndexColumn

const isItem = (v: IndexColumnLike): v is IndexColumn =>
  typeof v === 'object' && v !== null && 'column' in v && (v as { column?: unknown }).column !== undefined

class IndexBuilder {
  #name: string
  #unique: boolean
  #using: string | undefined
  #where: string | undefined
  #include: readonly string[] = []
  #nullsNotDistinct = false

  constructor(name: string, unique: boolean, options?: IndexOptions) {
    this.#name = name
    this.#unique = unique
    if (options?.using !== undefined) this.using(options.using)
    if (options?.where !== undefined) this.where(options.where)
    if (options?.include !== undefined) this.include(...options.include)
    if (options?.nullsNotDistinct === true) this.#nullsNotDistinct = true
  }

  #what(): string {
    return `${this.#unique ? 'uniqueIndex' : 'index'}("${this.#name}")`
  }

  /** `USING gin` and friends. The method name is not validated — extensions add methods. */
  using(method: string): IndexBuilder {
    if (typeof method !== 'string' || method.trim() === '') {
      throw new SchemaError(`pg-prime: ${this.#what()}.using() needs an access-method name, e.g. 'gin'.`)
    }
    checkName(method, `${this.#what()}.using("${method}")`)
    this.#using = method
    return this
  }

  /** A partial index's predicate. Bind parameters are rejected, as in `check()`. */
  where(expression: AnyFragment): IndexBuilder {
    const text = fragmentDdlText(expression, `${this.#what()}.where()`)
    if (text.trim() === '') throw new SchemaError(`pg-prime: ${this.#what()}.where() has an empty expression.`)
    this.#where = text
    return this
  }

  /** `INCLUDE (a, b)` — covering columns, which are stored but not part of the key. */
  include(...refs: AnyRef[]): IndexBuilder {
    this.#include = dbNames(refs, `${this.#what()}.include()`)
    return this
  }

  /** PG15+: two NULLs collide instead of both being allowed. Only meaningful on a unique index. */
  nullsNotDistinct(): IndexBuilder {
    this.#nullsNotDistinct = true
    return this
  }

  on(...columns: IndexColumnLike[]): TableExtra {
    if (columns.length === 0) throw new SchemaError(`pg-prime: ${this.#what()} was given no columns.`)
    const items: IndexItem[] = columns.map((c) => {
      if (!isItem(c)) return { column: refName(c, this.#what()), desc: false, nulls: undefined, opclass: undefined }
      if (c.nulls !== undefined && c.nulls !== 'first' && c.nulls !== 'last') {
        throw new SchemaError(
          `pg-prime: ${this.#what()} column option \`nulls\` is ${JSON.stringify(c.nulls)}; it must be 'first' or 'last'.`,
        )
      }
      if (c.opclass !== undefined) checkName(c.opclass, `${this.#what()} opclass "${c.opclass}"`)
      return {
        column: refName(c.column, this.#what()),
        desc: c.desc === true,
        nulls: c.nulls,
        opclass: c.opclass,
      }
    })
    return {
      node: 'index',
      name: this.#name,
      unique: this.#unique,
      columns: items.map((i) => i.column),
      items,
      using: this.#using,
      where: this.#where,
      include: this.#include,
      nullsNotDistinct: this.#nullsNotDistinct,
    }
  }
}

function refName(ref: AnyRef, what: string): string {
  const name = (ref as { $?: { dbName?: unknown } } | null)?.$?.dbName
  if (typeof name !== 'string') {
    throw new SchemaError(`pg-prime: ${what} was given something that is not a column reference.`)
  }
  return name
}

export function index(name: string, options?: IndexOptions): IndexBuilder {
  checkName(name, `index("${name}") index name`)
  return new IndexBuilder(name, false, options)
}

export function uniqueIndex(name: string, options?: IndexOptions): IndexBuilder {
  checkName(name, `uniqueIndex("${name}") index name`)
  return new IndexBuilder(name, true, options)
}

export function comment(text: string): TableExtra {
  if (typeof text !== 'string') {
    throw new SchemaError(`pg-prime: comment() expects a string; received ${typeof text}.`)
  }
  return { node: 'comment', text }
}

/**
 * `unique('u_ab').on(t.a, t.b)` — a UNIQUE **constraint** (design/05 §2.4).
 *
 * Distinct from `uniqueIndex`, and deliberately so: a constraint is a `pg_constraint` row that an
 * FK can point at, an index is not, and `pg_dump` prints the two differently. Both spellings exist
 * because both objects exist.
 */
class UniqueBuilder {
  #name: string | undefined
  #nullsNotDistinct = false
  constructor(name: string | undefined) {
    this.#name = name
  }
  /** PG15+: `UNIQUE NULLS NOT DISTINCT` — two NULLs collide instead of both being allowed. */
  nullsNotDistinct(): UniqueBuilder {
    this.#nullsNotDistinct = true
    return this
  }
  on(...refs: AnyRef[]): TableExtra {
    return {
      node: 'unique',
      name: this.#name,
      columns: dbNames(refs, `unique(${this.#name === undefined ? '' : `"${this.#name}"`})`),
      nullsNotDistinct: this.#nullsNotDistinct,
    }
  }
}

export function unique(name?: string): UniqueBuilder {
  if (name !== undefined) checkName(name, `unique("${name}") constraint name`)
  return new UniqueBuilder(name)
}

/**
 * `check('c_positive', sql`…`)` — a table-level CHECK.
 *
 * The name is mandatory here (unlike `.check()` on a column, where the server's
 * `<table>_<column>_check` is derivable): PostgreSQL's own default for a multi-column check is
 * the bare `<table>_check`, which collides the moment a second one is declared.
 */
export function check(name: string, expression: AnyFragment): TableExtra {
  checkName(name, `check("${name}") constraint name`)
  const text = fragmentDdlText(expression, `check("${name}")`)
  if (text.trim() === '') throw new SchemaError(`pg-prime: check("${name}") has an empty expression.`)
  return { node: 'check', name, expression: text }
}

/**
 * `foreignKey({ columns: [t.a], references: () => [other.cols.id], onDelete: 'cascade' })`.
 *
 * This is also the spelling for a **self**-referencing key — `references: () => [t.id]`, using the
 * extras callback's own parameter — and for the composite case `.references()` cannot express.
 */
export interface ForeignKeyExtraInput extends ForeignKeyOptions {
  readonly columns: readonly AnyRef[]
  /**
   * A thunk, for the same reason `.references()` takes one (design/11 §1.7).
   *
   * In a **mutually** referencing pair, annotate it once — `(): readonly RefLike[] => [...]` —
   * or TypeScript reports TS7022/TS7024 while walking the two tables' inference loop.
   */
  readonly references: () => readonly RefLike[]
}

export function foreignKey(input: ForeignKeyExtraInput): TableExtra {
  if (typeof input.references !== 'function') {
    throw new SchemaError(
      'pg-prime: foreignKey({ references }) takes a THUNK — references: () => [orgs.id] — so ' +
        'that a mutually-referencing pair of tables can be declared in either order.',
    )
  }
  if (input.name !== undefined) checkName(input.name, `foreignKey({ name: "${input.name}" })`)
  return {
    node: 'foreignKey',
    name: input.name,
    columns: dbNames(input.columns, 'foreignKey({ columns })'),
    references: input.references,
    onDelete: checkFkAction(input.onDelete, 'foreignKey({ onDelete })'),
    onUpdate: checkFkAction(input.onUpdate, 'foreignKey({ onUpdate })'),
    deferrable: input.deferrable ?? input.initiallyDeferred ?? false,
    initiallyDeferred: input.initiallyDeferred ?? false,
  }
}

/** Table-level rename annotation (design/05 §5.1). */
export function renamedFrom(from: string): TableExtra {
  checkName(from, `renamedFrom("${String(from)}")`)
  return { node: 'renamedFrom', from }
}

/**
 * `clusterOn('orders_created_at_idx')` — `ALTER TABLE … CLUSTER ON`.
 *
 * Beyond design/05 §2.4's list, and here because `06` §2.2 AS BUILT models
 * `pg_index.indisclustered` as a Tier-M fact: design/11 K2b found it missing on all 68 of
 * AdventureWorks' tables through the D10 witness. A fact the differ can drop is a fact the
 * DSL has to be able to declare, or every adopted database's first migration un-clusters
 * it.
 */
export function clusterOn(index: string): TableExtra {
  checkName(index, `clusterOn("${String(index)}") index name`)
  return { node: 'clusterOn', index }
}

/**
 * `partitionBy('range', 'created_at')` on the parent of a partitioned table.
 *
 * The key travels as **text** rather than as column references, because PostgreSQL's own
 * `pg_get_partkeydef` is an expression (`RANGE (date_trunc('month', at))` is legal) and a
 * column-list-only spelling would round-trip some partitioned tables and silently mangle
 * the rest.
 */
export function partitionBy(strategy: 'range' | 'list' | 'hash', key: string): TableExtra {
  if (strategy !== 'range' && strategy !== 'list' && strategy !== 'hash') {
    throw new SchemaError(`pg-prime: partitionBy() strategy is ${JSON.stringify(strategy)}; use 'range', 'list' or 'hash'.`)
  }
  if (typeof key !== 'string' || key.trim() === '') {
    throw new SchemaError(`pg-prime: partitionBy('${strategy}') needs a key, e.g. partitionBy('range', 'created_at').`)
  }
  return { node: 'partitionBy', strategy, key }
}

/** `partitionOf('payment', "FOR VALUES FROM ('2022-01-01') TO ('2022-02-01')")`. */
export interface PartitionOfOptions {
  /** the parent's schema; `undefined` means "the same as this table's". */
  readonly schema?: string
}

export function partitionOf(parent: string, bound: string, options?: PartitionOfOptions): TableExtra {
  checkName(parent, `partitionOf("${String(parent)}") parent table`)
  if (options?.schema !== undefined) checkName(options.schema, `partitionOf("${parent}", { schema })`)
  if (typeof bound !== 'string' || bound.trim() === '') {
    throw new SchemaError(`pg-prime: partitionOf("${parent}") needs a bound, e.g. "FOR VALUES FROM (1) TO (10)" or "DEFAULT".`)
  }
  return { node: 'partitionOf', parent, parentSchema: options?.schema, bound }
}
