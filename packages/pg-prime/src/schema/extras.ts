import { SchemaError } from '../sql/errors.js'
import { isFragment } from '../sql/fragment.js'
import { quoteIdentPart } from '../sql/ident.js'
import type { AnyFragment } from '../sql/fragment.js'
import { checkName } from './column.js'
import { checkFkAction, fragmentDdlText } from './ddl.js'
import type { FkAction, ForeignKeyOptions, RefLike } from './ddl.js'
import type { PgExtension } from './objects.js'
import type { AnyRef } from './ref.js'

/**
 * Table-level nodes (design/05 D5): one heterogeneous array of tagged nodes,
 * extensible by extension packs without an API change.
 *
 * Every node is plain frozen data plus — for `foreignKey` — one thunk, which is the same
 * lazy-resolution device `.references()` uses (design/11 §1.7).
 */
export type TableExtra =
  | {
      readonly node: 'primaryKey'
      readonly name: string | undefined
      readonly columns: readonly string[]
    }
  | {
      readonly node: 'index'
      readonly name: string
      readonly unique: boolean
      /**
       * The bare column names, in order — the shape WS0 shipped, kept so that everything
       * which already reads it keeps working. {@link TableExtra} `items` is the same list
       * with each column's per-column options beside it.
       *
       * An **expression** item contributes nothing here: it has no column name, and
       * inventing one (the expression text) would make this list lie about what it is.
       * `items` is the complete key list; this one is the columns among them.
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
      /**
       * `WITH (fillfactor = 70, fastupdate = off)` — storage parameters, as declared.
       *
       * Rendered sorted by key, so two runs over one registry produce byte-identical DDL,
       * and with string values quoted: `pg_get_indexdef` prints every reloption back as
       * `k='v'` whatever it was written as, so the shadow is what settles the spelling.
       */
      readonly with: Readonly<Record<string, string | number | boolean>> | undefined
      /** `TABLESPACE fast_ssd`. */
      readonly tablespace: string | undefined
      /**
       * design/06 §3.5 row 1's `CREATE INDEX CONCURRENTLY` rewrite (D15), per index.
       *
       * `true` (the default) means "rewrite me when the plan can carry a second file".
       * `false` is the opt-out `05` §2.4's `i6` asks for, and it is a **generate-time**
       * fact rather than a schema one: `CONCURRENTLY` is a property of how the index is
       * BUILT, not of the index, so the catalog has nothing to say about it and it can
       * never be a payload field. `generate` reads it straight off this node, the same
       * way it reads `renamedFrom` for the rename hints.
       */
      readonly concurrently: boolean
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
  /** `EXCLUDE USING gist (during WITH &&) WHERE (…)` — design/05 §2.4, design/01 row 49. */
  | {
      readonly node: 'exclude'
      readonly name: string
      /** `USING gist` / `USING btree`; `undefined` = PostgreSQL's default b-tree. */
      readonly using: string | undefined
      /** The `(<element> WITH <operator>)` pairs, in declaration order. */
      readonly items: readonly ExcludeItem[]
      /** A partial exclusion's predicate, as DDL text. */
      readonly where: string | undefined
      readonly deferrable: boolean
      readonly initiallyDeferred: boolean
      /**
       * `.requires(btreeGist)` — the extension whose operator class this exclusion needs.
       *
       * A declaration-time claim the EMITTER checks against the registry's own
       * `pgExtension(...)` list, because that list is the only thing that decides whether
       * `CREATE EXTENSION` runs before the table. Nothing else: the version, and whether
       * the DBA actually installed it, are the cluster's business (design/05 §3.10).
       */
      readonly requires: string | undefined
    }
  | { readonly node: 'renamedFrom'; readonly from: string }
  /** `ALTER TABLE … CLUSTER ON <index>` (`pg_index.indisclustered`). */
  | { readonly node: 'clusterOn'; readonly index: string }
  /** `… PARTITION BY RANGE (created_at)` on the parent. */
  | {
      readonly node: 'partitionBy'
      readonly strategy: 'range' | 'list' | 'hash'
      readonly key: string
    }
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
    return {
      node: 'primaryKey',
      name: first.name,
      columns: dbNames([...first.columns], 'primaryKey({ columns })'),
    }
  }
  return { node: 'primaryKey', name: undefined, columns: dbNames(refs as AnyRef[], 'primaryKey()') }
}

function isPrimaryKeyInput(v: unknown): v is PrimaryKeyInput {
  return typeof v === 'object' && v !== null && Array.isArray((v as { columns?: unknown }).columns)
}

/** `NULLS FIRST` / `NULLS LAST` on one index column. */
export type IndexNulls = 'first' | 'last'

/** One key of an index — a column or an expression — with its per-key options resolved. */
export interface IndexItem {
  /** The column's DB name, or `undefined` when this key is an {@link IndexItem.expression}. */
  readonly column: string | undefined
  /**
   * The DDL text of an expression key — `lower(email)` — or `undefined` for a column key.
   * Exactly one of the two is set.
   */
  readonly expression: string | undefined
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

/**
 * `index('i').on({ expression: sql`lower(${t.email})`, desc: true })` — an **expression**
 * key with the same per-key options a column key takes (design/05 §2.4's `i3`).
 *
 * The bare form `index('i').on(sql`lower(${t.email})`)` is the same thing with every
 * option left at its default, and is what the sketch writes.
 */
export interface IndexExpression {
  readonly expression: AnyFragment
  readonly desc?: boolean
  readonly nulls?: IndexNulls
  readonly opclass?: string
}

/** Storage parameters for `.with({ … })` — `WITH (fillfactor = 70)`. */
export type StorageParameters = Readonly<Record<string, string | number | boolean>>

/** The whole-index options of design/05 §2.4, also available as builder methods. */
export interface IndexOptions {
  readonly using?: string
  readonly where?: AnyFragment
  readonly include?: readonly AnyRef[]
  readonly nullsNotDistinct?: boolean
  /** `WITH (…)` — storage parameters. See {@link TableExtra}'s `with` for the rendering rule. */
  readonly with?: StorageParameters
  readonly tablespace?: string
  /** `false` opts this index out of design/06 §3.5's `CONCURRENTLY` rewrite (D15). */
  readonly concurrently?: boolean
}

export type IndexColumnLike = AnyRef | IndexColumn | IndexExpression | AnyFragment

const isItem = (v: IndexColumnLike): v is IndexColumn =>
  typeof v === 'object' &&
  v !== null &&
  'column' in v &&
  (v as { column?: unknown }).column !== undefined

const isExprItem = (v: IndexColumnLike): v is IndexExpression =>
  typeof v === 'object' &&
  v !== null &&
  'expression' in v &&
  (v as { expression?: unknown }).expression !== undefined

class IndexBuilder {
  #name: string
  #unique: boolean
  #using: string | undefined
  #where: string | undefined
  #include: readonly string[] = []
  #nullsNotDistinct = false
  #with: Record<string, string | number | boolean> | undefined
  #tablespace: string | undefined
  #concurrently = true

  constructor(name: string, unique: boolean, options?: IndexOptions) {
    this.#name = name
    this.#unique = unique
    if (options?.using !== undefined) this.using(options.using)
    if (options?.where !== undefined) this.where(options.where)
    if (options?.include !== undefined) this.include(...options.include)
    if (options?.nullsNotDistinct === true) this.#nullsNotDistinct = true
    if (options?.with !== undefined) this.with(options.with)
    if (options?.tablespace !== undefined) this.tablespace(options.tablespace)
    if (options?.concurrently !== undefined) this.concurrently(options.concurrently)
  }

  #what(): string {
    return `${this.#unique ? 'uniqueIndex' : 'index'}("${this.#name}")`
  }

  /** `USING gin` and friends. The method name is not validated — extensions add methods. */
  using(method: string): IndexBuilder {
    if (typeof method !== 'string' || method.trim() === '') {
      throw new SchemaError(
        `pg-prime: ${this.#what()}.using() needs an access-method name, e.g. 'gin'.`,
      )
    }
    checkName(method, `${this.#what()}.using("${method}")`)
    this.#using = method
    return this
  }

  /** A partial index's predicate. Bind parameters are rejected, as in `check()`. */
  where(expression: AnyFragment): IndexBuilder {
    const text = fragmentDdlText(expression, `${this.#what()}.where()`)
    if (text.trim() === '')
      throw new SchemaError(`pg-prime: ${this.#what()}.where() has an empty expression.`)
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

  /**
   * `WITH (fillfactor = 70, fastupdate = off)` — storage parameters.
   *
   * Merges with any earlier call, so `.fillfactor(70).with({ fastupdate: false })` says
   * both. The parameter NAMES are validated as identifiers (they are, in PostgreSQL's own
   * grammar); the values are not interpreted at all — an access method's reloptions are
   * the access method's business, and a whitelist here would go stale on the next
   * extension.
   */
  with(parameters: StorageParameters): IndexBuilder {
    if (typeof parameters !== 'object' || parameters === null) {
      throw new SchemaError(
        `pg-prime: ${this.#what()}.with() expects an object, e.g. .with({ fillfactor: 70 }).`,
      )
    }
    const out = this.#with ?? {}
    for (const [key, value] of Object.entries(parameters)) {
      checkName(key, `${this.#what()}.with() parameter "${key}"`)
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new SchemaError(
          `pg-prime: ${this.#what()}.with({ ${key} }) is a ${typeof value}; a storage parameter ` +
            `is a string, a number or a boolean.`,
        )
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new SchemaError(
          `pg-prime: ${this.#what()}.with({ ${key} }) is ${String(value)}, which has no SQL form.`,
        )
      }
      out[key] = value
    }
    this.#with = out
    return this
  }

  /** Sugar for `.with({ fillfactor: n })` — design/05 §2.4's `i8`. */
  fillfactor(percent: number): IndexBuilder {
    if (!Number.isInteger(percent) || percent < 10 || percent > 100) {
      throw new SchemaError(
        `pg-prime: ${this.#what()}.fillfactor(${String(percent)}) — PostgreSQL takes an integer ` +
          `percentage between 10 and 100.`,
      )
    }
    return this.with({ fillfactor: percent })
  }

  /**
   * `TABLESPACE fast_ssd`.
   *
   * A tablespace is a CLUSTER-level object with a filesystem path behind it, so it is
   * never created by a migration and never dropped by one: this only says which of the
   * ones the DBA made this index belongs in.
   */
  tablespace(name: string): IndexBuilder {
    checkName(name, `${this.#what()}.tablespace("${String(name)}")`)
    this.#tablespace = name
    return this
  }

  /**
   * `.concurrently(false)` opts this index out of design/06 §3.5 row 1's rewrite (D15).
   *
   * The rewrite is the default and is what the product is for; the opt-out exists for the
   * index you would rather have built inside the migration's transaction — a small table,
   * or a build that must not leave an INVALID index behind if it is killed.
   */
  concurrently(on = true): IndexBuilder {
    if (typeof on !== 'boolean') {
      throw new SchemaError(
        `pg-prime: ${this.#what()}.concurrently() takes a boolean; received ${typeof on}.`,
      )
    }
    this.#concurrently = on
    return this
  }

  on(...columns: IndexColumnLike[]): TableExtra {
    if (columns.length === 0)
      throw new SchemaError(`pg-prime: ${this.#what()} was given no columns.`)
    const items: IndexItem[] = columns.map((c) => this.#item(c))
    return {
      node: 'index',
      name: this.#name,
      unique: this.#unique,
      columns: items.flatMap((i) => (i.column === undefined ? [] : [i.column])),
      items,
      using: this.#using,
      where: this.#where,
      include: this.#include,
      nullsNotDistinct: this.#nullsNotDistinct,
      with: this.#with,
      tablespace: this.#tablespace,
      concurrently: this.#concurrently,
    }
  }

  #item(c: IndexColumnLike): IndexItem {
    // A bare fragment is design/05 §2.4's `i3` spelling: `index('i').on(sql`lower(x)`)`.
    if (isFragment(c)) {
      return { ...this.#modifiers(), expression: this.#expression(c), column: undefined }
    }
    if (isExprItem(c)) {
      return {
        ...this.#modifiers(c),
        expression: this.#expression(c.expression),
        column: undefined,
      }
    }
    if (!isItem(c)) {
      return { ...this.#modifiers(), column: refName(c, this.#what()), expression: undefined }
    }
    return {
      ...this.#modifiers(c),
      column: refName(c.column, this.#what()),
      expression: undefined,
    }
  }

  #expression(f: AnyFragment): string {
    const text = fragmentDdlText(f, `${this.#what()}.on(sql\`…\`)`)
    if (text.trim() === '') {
      throw new SchemaError(`pg-prime: ${this.#what()} was given an empty expression key.`)
    }
    return text
  }

  #modifiers(c?: {
    readonly desc?: boolean
    readonly nulls?: IndexNulls
    readonly opclass?: string
  }): {
    desc: boolean
    nulls: IndexNulls | undefined
    opclass: string | undefined
  } {
    if (c === undefined) return { desc: false, nulls: undefined, opclass: undefined }
    if (c.nulls !== undefined && c.nulls !== 'first' && c.nulls !== 'last') {
      throw new SchemaError(
        `pg-prime: ${this.#what()} column option \`nulls\` is ${JSON.stringify(c.nulls)}; it must be 'first' or 'last'.`,
      )
    }
    if (c.opclass !== undefined) checkName(c.opclass, `${this.#what()} opclass "${c.opclass}"`)
    return { desc: c.desc === true, nulls: c.nulls, opclass: c.opclass }
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
  if (text.trim() === '')
    throw new SchemaError(`pg-prime: check("${name}") has an empty expression.`)
  return { node: 'check', name, expression: text }
}

/* --------------------------------- exclude -------------------------------- */

/** One `(<element> WITH <operator>)` pair of an `EXCLUDE` constraint, resolved to DDL text. */
export interface ExcludeItem {
  /** A quoted column name, or the expression's DDL text, already parenthesised. */
  readonly element: string
  /** The operator, verbatim — `&&`, `=`, `<>`. */
  readonly operator: string
}

/** `[t.during, '&&']`, or `[sql`lower(`{t.room})`, '=']`. */
export type ExcludePair = readonly [AnyRef | AnyFragment, string]

/**
 * The operator half of an `EXCLUDE` element, checked at declaration time.
 *
 * A PostgreSQL operator name is built from a fixed alphabet and an identifier is not one
 * of them. `OPERATOR(schema.&&)` would be legal SQL, but the DSL has no way to say which
 * schema without bringing the operator-resolution rules with it, so it is refused here
 * rather than emitted and rejected three steps away by the shadow.
 */
const OPERATOR = /^[-+*/<>=~!`#%^&|?]{1,63}$/

class ExcludeBuilder {
  #name: string
  #using: string | undefined
  #where: string | undefined
  #deferrable = false
  #initiallyDeferred = false
  #requires: string | undefined

  constructor(name: string) {
    this.#name = name
  }

  #what(): string {
    return `exclude("${this.#name}")`
  }

  /** `USING gist`. Not validated beyond being an identifier — extensions add methods. */
  using(method: string): ExcludeBuilder {
    checkName(method, `${this.#what()}.using("${String(method)}")`)
    this.#using = method
    return this
  }

  /** A partial exclusion's predicate. Bind parameters are rejected, as in `check()`. */
  where(expression: AnyFragment): ExcludeBuilder {
    const text = fragmentDdlText(expression, `${this.#what()}.where()`)
    if (text.trim() === '')
      throw new SchemaError(`pg-prime: ${this.#what()}.where() has an empty expression.`)
    this.#where = text
    return this
  }

  deferrable(): ExcludeBuilder {
    this.#deferrable = true
    return this
  }

  /** Implies `.deferrable()`, as PostgreSQL's own grammar does. */
  initiallyDeferred(): ExcludeBuilder {
    this.#deferrable = true
    this.#initiallyDeferred = true
    return this
  }

  /**
   * `.requires(btreeGist)` — name the extension this exclusion's operator class comes from.
   *
   * The emitter checks the claim against the registry's own `pgExtension(...)` declarations
   * and refuses to emit a schema that makes one it cannot satisfy: `EXCLUDE USING gist
   * (room WITH =)` on an `integer` needs `btree_gist`, and without the `CREATE EXTENSION` in
   * front of it the failure is a `42704` naming an operator class, not the missing extension.
   * That list is the only thing that decides whether `CREATE EXTENSION` runs before the
   * table, so it is the only thing this checks: the version, and whether the DBA installed
   * it on the cluster, are deliberately not the schema's business (design/05 §3.10).
   */
  requires(extension: PgExtension | string): ExcludeBuilder {
    const name = typeof extension === 'string' ? extension : extension?.name
    checkName(name, `${this.#what()}.requires()`)
    this.#requires = name
    return this
  }

  /**
   * `.on([t.during, '&&'], [t.room, '='])` — the element/operator pairs.
   *
   * Terminal, exactly as `index(...).on(...)` and `unique(...).on(...)` are. design/05
   * §2.4's sketch writes `.on(...)` in the middle of the chain and `.where(...)` after it;
   * making that work would need the builder itself to BE the `TableExtra`, and the node's
   * fields (`using`, `where`, `deferrable`, `initiallyDeferred`) are exactly the method
   * names, so the two cannot share one object. Terminal `.on()` is the spelling every other
   * extra in this file already uses.
   */
  on(...pairs: ExcludePair[]): TableExtra {
    if (pairs.length === 0) {
      throw new SchemaError(
        `pg-prime: ${this.#what()} was given no elements. Write ` +
          `${this.#what()}.using('gist').on([t.during, '&&']).`,
      )
    }
    const items: ExcludeItem[] = pairs.map((pair, i) => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new SchemaError(
          `pg-prime: ${this.#what()} element #${String(i)} is not a [column, operator] pair.`,
        )
      }
      const [element, operator] = pair
      if (typeof operator !== 'string' || !OPERATOR.test(operator)) {
        throw new SchemaError(
          `pg-prime: ${this.#what()} element #${String(i)} has the operator ` +
            `${JSON.stringify(operator)}. An EXCLUDE operator is written in PostgreSQL's own ` +
            `operator alphabet, e.g. '&&' or '='.`,
        )
      }
      if (isFragment(element)) {
        const text = fragmentDdlText(element, `${this.#what()} element #${String(i)}`)
        if (text.trim() === '') {
          throw new SchemaError(`pg-prime: ${this.#what()} element #${String(i)} is empty.`)
        }
        return { element: `(${text})`, operator }
      }
      return { element: quoteIdentPart(refName(element, this.#what())), operator }
    })
    return {
      node: 'exclude',
      name: this.#name,
      using: this.#using,
      items,
      where: this.#where,
      deferrable: this.#deferrable,
      initiallyDeferred: this.#initiallyDeferred,
      requires: this.#requires,
    }
  }
}

/**
 * `exclude('bookings_no_overlap').using('gist').on([t.during, '&&'])` — design/01 row 49.
 *
 * The name is mandatory, for the reason `check()`'s is: PostgreSQL's own default for an
 * exclusion constraint is `<table>_<first column>_excl`, which collides the moment a table
 * declares two of them on the same leading column — and an adopted database's names are
 * data that `pull` has to be able to reproduce.
 */
export function exclude(name: string): ExcludeBuilder {
  checkName(name, `exclude("${String(name)}") constraint name`)
  return new ExcludeBuilder(name)
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
    throw new SchemaError(
      `pg-prime: partitionBy() strategy is ${JSON.stringify(strategy)}; use 'range', 'list' or 'hash'.`,
    )
  }
  if (typeof key !== 'string' || key.trim() === '') {
    throw new SchemaError(
      `pg-prime: partitionBy('${strategy}') needs a key, e.g. partitionBy('range', 'created_at').`,
    )
  }
  return { node: 'partitionBy', strategy, key }
}

/** `partitionOf('payment', "FOR VALUES FROM ('2022-01-01') TO ('2022-02-01')")`. */
export interface PartitionOfOptions {
  /** the parent's schema; `undefined` means "the same as this table's". */
  readonly schema?: string
}

export function partitionOf(
  parent: string,
  bound: string,
  options?: PartitionOfOptions,
): TableExtra {
  checkName(parent, `partitionOf("${String(parent)}") parent table`)
  if (options?.schema !== undefined)
    checkName(options.schema, `partitionOf("${parent}", { schema })`)
  if (typeof bound !== 'string' || bound.trim() === '') {
    throw new SchemaError(
      `pg-prime: partitionOf("${parent}") needs a bound, e.g. "FOR VALUES FROM (1) TO (10)" or "DEFAULT".`,
    )
  }
  return { node: 'partitionOf', parent, parentSchema: options?.schema, bound }
}
