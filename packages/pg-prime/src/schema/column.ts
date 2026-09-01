import { SchemaError } from '../sql/errors.js'
import { InvalidIdentifierError } from '../sql/errors.js'
import { quoteIdentPart } from '../sql/ident.js'
import type { AnyFragment } from '../sql/fragment.js'
import { checkFkAction, fragmentDdlText } from './ddl.js'
import type { CheckSpec, ForeignKeyOptions, RefLike, RefSpec, UniqueSpec } from './ddl.js'
import { META } from './symbols.js'
import type { ColMeta, DateString, OrmTypeError } from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Runtime IR — the `$` law (design/05 D4)
// ─────────────────────────────────────────────────────────────────────────────

/** A `DEFAULT` in the emitted DDL. */
export type DefaultSpec =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'expr'; readonly expr: string }

/**
 * Everything a column contributes to DDL / the migration IR.
 *
 * **The `$` law:** no `$`-prefixed builder method may ever write into this
 * record. `.default()` lands here; `.$default()` lands in {@link ColumnTsMeta}.
 */
export interface ColumnDdl {
  readonly pgType: string
  /** Explicit DB name; `undefined` → derived from the TS key by the casing strategy. */
  readonly dbName: string | undefined
  readonly notNull: boolean
  readonly default: DefaultSpec | undefined
  readonly identity: 'always' | 'byDefault' | undefined
  /**
   * `.generatedAlwaysAs(expr)` — the generation expression as DDL text, for
   * `GENERATED ALWAYS AS (<expr>) STORED` (design/05 §2.3, design/01 row 51).
   *
   * `STORED` is the only kind carried, and that is a decision rather than an omission:
   * PostgreSQL 18's `VIRTUAL` has no in-place conversion in either direction, so the diff
   * layer refuses `attgenerated` transitions outright (`diff/ddl.ts`) and a DSL that could
   * declare one would only be able to declare it for a table it also creates.
   */
  readonly generatedAs: string | undefined
  /**
   * The `(cols) => sql`…`` form of the same thing, held until `pgTable` can supply the
   * table's own column references (design/05 §2.3's late-bound spelling).
   *
   * A generation expression names its SIBLINGS, and inside `(t) => ({ … })` they do not
   * exist yet — the same problem `.references()` solves with a thunk, one level earlier.
   * `pgTable` calls this the moment the DB names are known and writes the result into
   * {@link ColumnDdl.generatedAs}, so every consumer reads one field and a table built
   * through `pgTable` never sees this one set.
   */
  readonly generatedAsFrom: ((cols: Readonly<Record<string, RefLike>>) => AnyFragment) | undefined
  readonly primaryKey: boolean
  readonly unique: boolean
  /** `.unique(name?, { nullsNotDistinct? })` — present iff {@link ColumnDdl.unique} is true. */
  readonly uniqueSpec: UniqueSpec | undefined
  readonly enumName: string | undefined
  readonly enumValues: readonly string[] | undefined
  /** Schema the enum type lives in; `undefined` → the registry's default schema. */
  readonly enumSchema: string | undefined
  readonly arrayDim: number
  /** `.references(() => other.id, opts)` — single-column FK, resolved lazily (design/11 §1.7). */
  readonly references: RefSpec | undefined
  /**
   * `.check(sql`…`, name?)`. A list rather than one slot: two independent column CHECKs are two
   * `pg_constraint` rows, and collapsing them would make the second silently replace the first.
   */
  readonly checks: readonly CheckSpec[]
  /** `.comment(text)` — `COMMENT ON COLUMN`. */
  readonly comment: string | undefined
  /** `.renamedFrom(old)` — the rename annotation of design/05 §5.1. */
  readonly renamedFrom: string | undefined
}

/** TS-only column metadata. Never reaches DDL or the migration IR. */
export interface ColumnTsMeta {
  readonly defaultFn: (() => unknown) | undefined
  readonly onUpdateFn: (() => unknown) | undefined
  /** True once `.$type<T>()` has been applied (documentation / lint only). */
  readonly narrowed: boolean
}

/** The runtime shape behind every `Col<M>`. */
export interface ColumnRuntime {
  readonly ddl: ColumnDdl
  readonly ts: ColumnTsMeta
}

// ─────────────────────────────────────────────────────────────────────────────
// The column builder (design/04 §1.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal `Any` supertype (design/04 §3.3): an interface whose members are
 * `any`, **not** `Col<any>`. `X extends AnyCol` is then an O(1) check that
 * never forces the modifier signatures to be instantiated.
 */
export interface AnyCol {
  readonly [META]: any
}

/**
 * The column's read type with `| null` removed, and the `| null` on its own.
 *
 * `Exclude`, not `NonNullable`: `NonNullable<unknown>` is `{}`, which would silently narrow every
 * `jsonb` column, while `Exclude<unknown, null>` is `unknown`. Both distribute over the union
 * exactly once, on a path (`.array()` / `.$type()`) that runs once per declared column.
 */
type NotNull<T> = Exclude<T, null>
/** `null` when the column opted into it, `never` otherwise. */
type NullPart<T> = Extract<T, null>

// NOTE: every resulting meta below is written out inline rather than behind a named alias.
// TypeScript prints a named alias **unexpanded** (`src/query/errors.ts`'s header measures the same
// trap), so one alias here would turn every column in every diagnostic in the program from
// `Col<{ t: string | null; pg: "text"; ... }>` into an opaque one-word name.

/**
 * `.nullable()` after `.primaryKey()` / `.generatedAlways()` is a contradiction the DDL cannot
 * express, so the method is replaced by design/04 §4.1's return-position sentinel: calling it
 * reports `This expression is not callable … 'OrmTypeError<"…">'`, one line, sentence included.
 * The runtime throws the same sentence for the other order (`.nullable().primaryKey()`), which no
 * type-level gate on `M['t']` could catch without a conditional on every column.
 */
type NullableFn<M extends ColMeta> = M['pk'] extends true
  ? OrmTypeError<'.nullable() after .primaryKey(): a primary key column is NOT NULL by definition'>
  : M['ro'] extends true
    ? OrmTypeError<'.nullable() after .generatedAlways()/.generatedAlwaysAs(): an identity column is never null, and a generated expression column takes .nullable() BEFORE it'>
    : () => Col<{ t: M['t'] | null; pg: M['pg']; opt: true; ro: M['ro']; pk: M['pk'] }>

/**
 * `.generatedAlwaysAs(expr, { stored: true })` — and `stored` has exactly one legal value.
 *
 * `VIRTUAL` (PostgreSQL 18) is refused at the TYPE level with the sentence in the
 * diagnostic: `{ stored: false }` reports *Type 'false' is not assignable to type 'true |
 * OrmTypeError<"…">'*, and the `OrmTypeError` carries the reason — design/04 §4.1's
 * sentinel, in parameter position rather than return position because the refusal is about
 * an argument. The reason is not squeamishness about a new PostgreSQL version:
 * `attgenerated` cannot be altered in place in either direction, so `diff/ddl.ts` refuses
 * every generated transition, and a VIRTUAL column the DSL could declare would be
 * declarable only for a table the same plan creates.
 */
export interface GeneratedAlwaysAsOptions {
  readonly stored?:
    | true
    | OrmTypeError<'{ stored: false } means VIRTUAL, which is PostgreSQL 18+ and is not emitted: a generated column cannot be converted in place, so only STORED is declarable'>
}

/** A default after `GENERATED ALWAYS` is dead code: the database always supplies the value. */
type DefaultableFn<M extends ColMeta, F> = M['ro'] extends true
  ? OrmTypeError<'a default after .generatedAlways(): the database always supplies the value'>
  : F

export interface Col<M extends ColMeta> {
  readonly [META]: M
  /** Runtime metadata. Escape hatch for the migration/compile layers. */
  readonly $: ColumnRuntime

  /** Opt in to `NULL`. Columns are `NOT NULL` by default (design/04 D4). */
  nullable: NullableFn<M>
  /** DDL `DEFAULT <literal>`. Does **not** touch `t` — a defaulted column is still non-null on read. */
  default: DefaultableFn<
    M,
    (v: M['t']) => Col<{ t: M['t']; pg: M['pg']; opt: true; ro: M['ro']; pk: M['pk'] }>
  >
  /** DDL `DEFAULT <expr>`. Seam for agent 03's `sql` tag; takes raw text for now. */
  defaultSql: DefaultableFn<
    M,
    (expr: string) => Col<{ t: M['t']; pg: M['pg']; opt: true; ro: M['ro']; pk: M['pk'] }>
  >
  /** GENERATED ALWAYS: absent from insert *and* update, present in select. */
  generatedAlways(): Col<{ t: M['t']; pg: M['pg']; opt: true; ro: true; pk: M['pk'] }>
  generatedByDefault(): Col<{ t: M['t']; pg: M['pg']; opt: true; ro: M['ro']; pk: M['pk'] }>
  /**
   * `GENERATED ALWAYS AS (<expr>) STORED` (design/05 §2.3, design/01 row 51).
   *
   * `ro: true`, exactly as `.generatedAlways()` sets it, so the key is **erased** from
   * `Insertable<T>` and `Updateable<T>` — the database computes the value and PostgreSQL
   * rejects any attempt to supply one. The runtime half is `metaOf().insertableKeys`,
   * which is what `copyFrom`'s default column list reads.
   *
   * The expression is either a fragment or a `(cols) => fragment` callback. The callback
   * exists because a generation expression names this table's OTHER columns, and inside
   * `pgTable(name, (t) => ({ … }))` they do not exist yet:
   *
   * ```ts
   * total: t.numeric().generatedAlwaysAs((c) => sql`${c.price} * ${c.quantity}`),
   * ```
   *
   * `cols` is keyed by TS key and is deliberately NOT the table's typed `[REFS]` slot: the
   * column builder runs before the table's shape is inferred, so there is no type to give
   * it. A key that does not exist is caught when the expression is rendered, not by the
   * compiler.
   *
   * `.nullable()` goes **before** this call: a stored generated column may be nullable,
   * but `ro: true` closes `.nullable()` for the same reason it closes `.default()`.
   */
  generatedAlwaysAs(
    expression: AnyFragment | ((cols: Readonly<Record<string, RefLike>>) => AnyFragment),
    options?: GeneratedAlwaysAsOptions,
  ): Col<{ t: M['t']; pg: M['pg']; opt: true; ro: true; pk: M['pk'] }>
  /** Marks the column `pk: true` so design/03 §2.3's `GROUP BY` guard can see it (04 §1.1). */
  primaryKey(): Col<{ t: M['t']; pg: M['pg']; opt: M['opt']; ro: M['ro']; pk: true }>
  /**
   * `UNIQUE` constraint (design/05 §2.3). Returns `Col<M>` — uniqueness constrains the *values* a
   * column may hold, never its TypeScript type, so not one of the five meta slots moves.
   */
  unique(name?: string, options?: { readonly nullsNotDistinct?: boolean }): Col<M>
  /**
   * Single-column `FOREIGN KEY` (design/05 §2.3, design/11 §1.7). The target is a **thunk**: the
   * referenced table is usually declared later in the same file, and a mutually-referencing pair
   * has no declaration order that works without one.
   *
   * ```ts
   * orgId: t.uuid().references(() => orgs.cols.id, { onDelete: 'cascade' })
   * ```
   *
   * Two circularity notes, both about the TYPE level (the thunk already handles the value level):
   *
   *  - a **self**-reference cannot be written here at all — `() => nodes.cols.id` inside `nodes`'s
   *    own initializer is a TS7022, because the thunk's body needs the type still being inferred.
   *    Use the `foreignKey` extra, whose callback parameter is this table's own refs:
   *    `(t) => [foreignKey({ columns: [t.parentId], references: () => [t.id] })]`.
   *  - a **mutual** pair (`orgs.ownerId → users.id` and `users.primaryOrgId → orgs.id`) needs the
   *    thunk's return type stated once, which is what stops TypeScript walking the loop:
   *    `.references((): RefLike => orgs.cols.id)`. Same device as Drizzle's `AnyPgColumn`.
   */
  references(target: () => RefLike, options?: ForeignKeyOptions): Col<M>
  /**
   * Column-scoped `CHECK`, named `<table>_<column>_check` unless given (design/05 §2.3).
   * The fragment may not carry a bind parameter — see {@link fragmentDdlText}.
   */
  check(expression: AnyFragment, name?: string): Col<M>
  /** `COMMENT ON COLUMN`. */
  comment(text: string): Col<M>
  /** Rename annotation (design/05 §5.1): fires iff `old` exists and this column does not. */
  renamedFrom(old: string): Col<M>
  /**
   * `text[]`. The element type is the column's own type **without** its `| null`: a nullable
   * `text[]` is `string[] | null`, never `(string | null)[]` — one `NOT NULL` in the DDL cannot
   * mean two different things, and `.nullable()` set the *column*, not the element.
   */
  array(): Col<{
    t: NotNull<M['t']>[] | NullPart<M['t']>
    pg: `${M['pg']}[]`
    opt: M['opt']
    ro: M['ro']
    pk: M['pk']
  }>

  // ── `$` = TS-only, never in the IR (design/05 D4) ───────────────────────────
  /**
   * Narrow-only: `T` must be a subtype of the column's own **non-null** type, and the column's
   * `| null` is re-attached afterwards. Constraining against the bare `M['t']` instead would let
   * `text().nullable().$type<'a' | 'b'>()` typecheck and then drop the `| null` the DDL still
   * carries — order-dependent, and a `NOT NULL` violation at insert time.
   */
  $type<T extends NotNull<M['t']>>(): Col<{
    t: T | NullPart<M['t']>
    pg: M['pg']
    opt: M['opt']
    ro: M['ro']
    pk: M['pk']
  }>
  /** Client-side default applied on insert. No `DEFAULT` in DDL. */
  $default: DefaultableFn<
    M,
    (fn: () => M['t']) => Col<{ t: M['t']; pg: M['pg']; opt: true; ro: M['ro']; pk: M['pk'] }>
  >
  /** Client-side value applied on update. No trigger emitted. */
  $onUpdate(fn: () => M['t']): Col<M>
}

const EMPTY_TS: ColumnTsMeta = { defaultFn: undefined, onUpdateFn: undefined, narrowed: false }

/**
 * A meta with no gate tripped, so every member of {@link Col} resolves to a function type.
 *
 * {@link Bodies} then says "the runtime class must supply a body for every one of them", and
 * `class ColumnBuilder implements ColumnRuntime, Bodies` makes that a compile error rather than a
 * `TypeError: x.foo is not a function` at the first call. This is what the old `make(): any`
 * hid — the cast below is still a cast, but it can no longer paper over a missing method.
 */
type OpenMeta = { t: unknown; pg: string; opt: false; ro: false; pk: false }
type Bodies = {
  [K in Exclude<keyof Col<OpenMeta>, typeof META | '$'>]: (...args: never[]) => unknown
}

class ColumnBuilder implements ColumnRuntime, Bodies {
  readonly ddl: ColumnDdl
  readonly ts: ColumnTsMeta

  constructor(ddl: ColumnDdl, ts: ColumnTsMeta) {
    this.ddl = ddl
    this.ts = ts
  }

  /** Every column is its own runtime metadata holder: `col.$ === col`. */
  get $(): ColumnRuntime {
    return this
  }

  #next(ddl: Partial<ColumnDdl>, ts?: Partial<ColumnTsMeta>): ColumnBuilder {
    return new ColumnBuilder({ ...this.ddl, ...ddl }, ts ? { ...this.ts, ...ts } : this.ts)
  }

  /**
   * The runtime half of the {@link NullableFn} / {@link DefaultableFn} gates.
   *
   * The type level can only see the *forward* order (`.primaryKey().nullable()`); the reverse
   * (`.nullable().primaryKey()`) would need a conditional on `M['t']` on every column, so both
   * orders are caught here instead — at declaration time, on the import of the schema file.
   */
  #reject(what: string, why: string): never {
    throw new SchemaError(`pg-prime: ${what} — ${why}. Drop one of the two.`)
  }

  nullable(): ColumnBuilder {
    if (this.ddl.primaryKey) {
      this.#reject(
        '.nullable() after .primaryKey()',
        'a primary key column is NOT NULL by definition',
      )
    }
    if (this.ddl.identity === 'always') {
      this.#reject('.nullable() after .generatedAlways()', 'a generated column is always NOT NULL')
    }
    return this.#next({ notNull: false })
  }
  default(v: unknown): ColumnBuilder {
    this.#noDefaultAfterGenerated('.default()')
    return this.#next({ default: { kind: 'value', value: v } })
  }
  defaultSql(expr: string): ColumnBuilder {
    this.#noDefaultAfterGenerated('.defaultSql()')
    return this.#next({ default: { kind: 'expr', expr } })
  }
  #noDefaultAfterGenerated(what: string): void {
    if (this.ddl.identity === 'always') {
      this.#reject(`${what} after .generatedAlways()`, 'the database always supplies the value')
    }
    if (this.ddl.generatedAs !== undefined || this.ddl.generatedAsFrom !== undefined) {
      this.#reject(`${what} after .generatedAlwaysAs()`, 'the database always supplies the value')
    }
  }
  generatedAlways(): ColumnBuilder {
    if (this.ddl.generatedAs !== undefined || this.ddl.generatedAsFrom !== undefined) {
      this.#reject(
        '.generatedAlways() after .generatedAlwaysAs()',
        'a column is an identity column or a generated one, never both',
      )
    }
    if (!this.ddl.notNull) {
      this.#reject('.generatedAlways() after .nullable()', 'a generated column is always NOT NULL')
    }
    if (this.ddl.default !== undefined || this.ts.defaultFn !== undefined) {
      this.#reject('.generatedAlways() after a default', 'the database always supplies the value')
    }
    return this.#next({ identity: 'always' })
  }
  generatedByDefault(): ColumnBuilder {
    return this.#next({ identity: 'byDefault' })
  }
  generatedAlwaysAs(
    expression: AnyFragment | ((cols: Readonly<Record<string, RefLike>>) => AnyFragment),
    options?: { readonly stored?: unknown },
  ): ColumnBuilder {
    // Not a type test that happens to be true: `stored` is `true | OrmTypeError<…>` at the
    // type level, so this only ever fires for JavaScript and for a cast.
    if (options?.stored !== undefined && options.stored !== true) {
      throw new SchemaError(
        `pg-prime: .generatedAlwaysAs(…, { stored: ${JSON.stringify(options.stored)} }) — STORED ` +
          `is the only generation kind pg-prime emits. VIRTUAL is PostgreSQL 18+ and a generated ` +
          `column cannot be converted in place in either direction, so the migration layer ` +
          `refuses the transition and a VIRTUAL column would be declarable only for a table the ` +
          `same plan creates.`,
      )
    }
    if (this.ddl.identity !== undefined) {
      this.#reject(
        '.generatedAlwaysAs() after .generatedAlways()/.generatedByDefault()',
        'a column is an identity column or a generated one, never both',
      )
    }
    if (this.ddl.default !== undefined || this.ts.defaultFn !== undefined) {
      this.#reject('.generatedAlwaysAs() after a default', 'the database always supplies the value')
    }
    if (typeof expression === 'function') {
      return this.#next({ generatedAs: undefined, generatedAsFrom: expression })
    }
    const text = fragmentDdlText(expression, '.generatedAlwaysAs()')
    if (text.trim() === '') {
      throw new SchemaError('pg-prime: .generatedAlwaysAs() was given an empty expression.')
    }
    return this.#next({ generatedAs: text, generatedAsFrom: undefined })
  }
  primaryKey(): ColumnBuilder {
    if (!this.ddl.notNull) {
      this.#reject(
        '.primaryKey() after .nullable()',
        'a primary key column is NOT NULL by definition',
      )
    }
    return this.#next({ primaryKey: true })
  }
  unique(name?: string, options?: { readonly nullsNotDistinct?: boolean }): ColumnBuilder {
    if (name !== undefined) checkName(name, `.unique("${name}") constraint name`)
    return this.#next({
      unique: true,
      uniqueSpec: { name, nullsNotDistinct: options?.nullsNotDistinct ?? false },
    })
  }
  references(target: () => RefLike, options?: ForeignKeyOptions): ColumnBuilder {
    if (typeof target !== 'function') {
      throw new SchemaError(
        'pg-prime: .references() takes a THUNK — .references(() => orgs.id), not ' +
          '.references(orgs.id). The referenced table is usually declared further down the same ' +
          'file, and a mutually-referencing pair has no declaration order that works without one.',
      )
    }
    if (options?.name !== undefined)
      checkName(options.name, `.references({ name: "${options.name}" })`)
    return this.#next({
      references: {
        target: () => [target()],
        name: options?.name,
        onDelete: checkFkAction(options?.onDelete, '.references({ onDelete })'),
        onUpdate: checkFkAction(options?.onUpdate, '.references({ onUpdate })'),
        deferrable: options?.deferrable ?? options?.initiallyDeferred ?? false,
        initiallyDeferred: options?.initiallyDeferred ?? false,
      },
    })
  }
  check(expression: AnyFragment, name?: string): ColumnBuilder {
    if (name !== undefined) checkName(name, `.check(…, "${name}") constraint name`)
    const text = fragmentDdlText(expression, '.check()')
    if (text.trim() === '') {
      throw new SchemaError('pg-prime: .check() was given an empty expression.')
    }
    return this.#next({ checks: [...this.ddl.checks, { name, expression: text }] })
  }
  comment(text: string): ColumnBuilder {
    if (typeof text !== 'string') {
      throw new SchemaError(`pg-prime: .comment() expects a string; received ${typeof text}.`)
    }
    return this.#next({ comment: text })
  }
  renamedFrom(old: string): ColumnBuilder {
    checkName(old, `.renamedFrom("${String(old)}")`)
    return this.#next({ renamedFrom: old })
  }
  array(): ColumnBuilder {
    return this.#next({ pgType: `${this.ddl.pgType}[]`, arrayDim: this.ddl.arrayDim + 1 })
  }

  // `$` methods: TS-only, so they must not write into `ddl`.
  $type(): ColumnBuilder {
    return this.#next({}, { narrowed: true })
  }
  $default(fn: () => unknown): ColumnBuilder {
    this.#noDefaultAfterGenerated('.$default()')
    return this.#next({}, { defaultFn: fn })
  }
  $onUpdate(fn: () => unknown): ColumnBuilder {
    return this.#next({}, { onUpdateFn: fn })
  }
}

function baseDdl(pgType: string, dbName: string | undefined): ColumnDdl {
  return {
    pgType,
    dbName,
    notNull: true, // NOT NULL by default — design/00 sign-off #4, design/04 D4
    default: undefined,
    identity: undefined,
    generatedAs: undefined,
    generatedAsFrom: undefined,
    primaryKey: false,
    unique: false,
    uniqueSpec: undefined,
    enumName: undefined,
    enumValues: undefined,
    enumSchema: undefined,
    arrayDim: 0,
    references: undefined,
    checks: [],
    comment: undefined,
    renamedFrom: undefined,
  }
}

/**
 * The one cast in the file, and it is now a *checked* one: `ColumnBuilder` is declared
 * `implements Bodies`, so the structural gap this cast opens can only ever be about the type
 * parameters, never about a missing method.
 */
function make<T, P extends string>(pgType: P, dbName?: string): Base<T, P> {
  return new ColumnBuilder(baseDdl(pgType, dbName), EMPTY_TS) as unknown as Base<T, P>
}

// ─────────────────────────────────────────────────────────────────────────────
// Enums (design/05 §3.2)
// ─────────────────────────────────────────────────────────────────────────────

export interface PgEnum<N extends string, V extends readonly string[]> {
  readonly kind: 'enum'
  readonly name: N
  readonly values: V
  /**
   * The schema the type lives in. `undefined` means "wherever the emitter's default schema is" —
   * NOT "the schema of whichever table happens to use it": two tables in two schemas may share one
   * enum, and letting the placement follow the first user makes the DDL order-dependent.
   */
  readonly schema: string | undefined
  /**
   * design/05 §5.1's fourth spelling. A carrier, exactly like `.renamedFrom()` on a column:
   * it says what the annotation CLAIMS, and `generate` decides whether it fires (old exists,
   * new does not) against the current IR.
   */
  readonly renamedFrom: string | undefined
  /**
   * design/05 §3.2/§5.1's `{ [newLabel]: oldLabel }` — a carrier, like `renamedFrom`.
   *
   * A LABEL rename, which PostgreSQL can do (`ALTER TYPE … RENAME VALUE`) and which the differ
   * would otherwise see as a removed label plus an added one — i.e. as EN102, the reorder it
   * refuses, or at best as a drop-and-recreate of the type and every column that uses it.
   */
  readonly renamedValues: Readonly<Record<string, string>> | undefined
  /** `COMMENT ON TYPE` (design/01 row 54: comments round-trip for tables, columns AND types). */
  readonly comment: string | undefined
}

/** `pgEnum(name, values, options?)` — design/05 §3.2. */
export interface PgEnumOptions<V extends readonly string[] = readonly string[]> {
  readonly schema?: string
  /** design/05 §5.1 — the rename annotation. Inert unless the old type exists and this one does not. */
  readonly renamedFrom?: string
  /**
   * `{ [newLabel]: oldLabel }` — design/05 §3.2's own spelling, keys first because the key is
   * the label that exists *now* and the value is the history.
   *
   * ```ts
   * pgEnum('member_role', ['owner', 'admin', 'member'], { renamedValues: { member: 'user' } })
   * ```
   *
   * The keys are the declared labels, so a typo is a compile error rather than an annotation
   * that never fires. Like every other `renamedFrom`, it is inert unless the old label exists
   * in the live type and the new one does not, which makes it safe to leave in the source.
   */
  readonly renamedValues?: { readonly [K in V[number]]?: string }
  /**
   * `COMMENT ON TYPE member_role IS '…'` — design/01 row 54's third target.
   *
   * A comment is its own fact (`05` §7.2), keyed by what it annotates, so re-wording one is
   * a catalog write with no lock and never an `ALTER TYPE`.
   */
  readonly comment?: string
}

export type AnyPgEnum = PgEnum<string, readonly string[]>

/**
 * Validate a name PostgreSQL will store in a `name` column (63 UTF-8 bytes, no NUL, non-empty)
 * and re-throw as a {@link SchemaError} that says *which* name, in *which* declaration.
 *
 * Without this the first offending identifier surfaces at the first `.compile()`, as
 * `sql.ident: part 0 rejected (too-long): …` — a sentence that names neither the table nor the
 * column (E9). `quoteIdentPart` is the single sanitizer (03 §3.4 D8); this only moves *when* it
 * runs, never what it accepts.
 */
export function checkName(value: unknown, what: string): void {
  try {
    quoteIdentPart(value)
  } catch (e) {
    if (e instanceof InvalidIdentifierError) {
      throw new SchemaError(
        `pg-prime: ${what} is not a usable PostgreSQL identifier: ${e.reason} (${e.message}).`,
      )
    }
    throw e
  }
}

export function pgEnum<N extends string, const V extends readonly [string, ...string[]]>(
  name: N,
  values: V,
  options?: PgEnumOptions<V>,
): PgEnum<N, V> {
  checkName(name, `pgEnum("${name}") type name`)
  if (options?.schema !== undefined) checkName(options.schema, `pgEnum("${name}") schema name`)
  if (options?.renamedFrom !== undefined)
    checkName(options.renamedFrom, `pgEnum("${name}", { renamedFrom })`)
  const seen = new Set<string>()
  for (const label of values) {
    // An enum LABEL is a literal, not an identifier — PostgreSQL accepts `''` — but it is still
    // stored in a `name`, so the byte limit and the NUL rule apply. Skip only the empty check.
    if (label !== '') checkName(label, `pgEnum("${name}") label "${label}"`)
    if (seen.has(label)) {
      throw new SchemaError(
        `pg-prime: pgEnum("${name}") declares the label "${label}" twice. PostgreSQL rejects a ` +
          `duplicate label in CREATE TYPE, and the TS union would silently collapse the two.`,
      )
    }
    seen.add(label)
  }
  if (options?.comment !== undefined && typeof options.comment !== 'string') {
    throw new SchemaError(
      `pg-prime: pgEnum("${name}", { comment }) expects a string; received ${typeof options.comment}.`,
    )
  }
  const renamedValues = checkRenamedValues(name, values, options?.renamedValues)
  return {
    kind: 'enum',
    name,
    values,
    schema: options?.schema,
    renamedFrom: options?.renamedFrom,
    renamedValues,
    comment: options?.comment,
  }
}

/**
 * `{ [newLabel]: oldLabel }`, checked at declaration time (design/05 §3.2).
 *
 * Three refusals, and each is an annotation that could not fire and would therefore be a silent
 * `DROP TYPE`/`CREATE TYPE` at the next `generate` instead of an `ALTER TYPE … RENAME VALUE`:
 * a key that is not a declared label (the rename names a label this type does not have), an old
 * label that is *also* declared (then both exist and the map claims one thing is two), and
 * `{ x: 'x' }` (a rename to itself, which is either a typo or a leftover).
 */
function checkRenamedValues(
  name: string,
  values: readonly string[],
  map: Readonly<Record<string, string | undefined>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (map === undefined) return undefined
  const declared = new Set(values)
  const out: Record<string, string> = {}
  for (const [to, from] of Object.entries(map)) {
    if (from === undefined) continue
    if (from !== '') checkName(from, `pgEnum("${name}", { renamedValues }) old label "${from}"`)
    if (!declared.has(to)) {
      throw new SchemaError(
        `pg-prime: pgEnum("${name}", { renamedValues: { ${JSON.stringify(to)}: ${JSON.stringify(from)} } }) ` +
          `renames a label to "${to}", which this enum does not declare. The KEY is the new label and the ` +
          `VALUE is the old one (design/05 §3.2).`,
      )
    }
    if (from === to) {
      throw new SchemaError(
        `pg-prime: pgEnum("${name}", { renamedValues }) maps "${to}" to itself, which can never fire.`,
      )
    }
    if (declared.has(from)) {
      throw new SchemaError(
        `pg-prime: pgEnum("${name}", { renamedValues }) says "${from}" was renamed to "${to}", but "${from}" ` +
          `is still declared. Both labels exist, so this is two labels rather than one renamed one — remove ` +
          `"${from}" from the values, or drop the annotation.`,
      )
    }
    out[to] = from
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** `Infer<typeof memberRole>` → `'owner' | 'admin' | 'member'`. */
export type Infer<E extends AnyPgEnum> = E['values'][number]

// ─────────────────────────────────────────────────────────────────────────────
// Column factories
// ─────────────────────────────────────────────────────────────────────────────

type Base<T, P extends string> = Col<{ t: T; pg: P; opt: false; ro: false; pk: false }>

export function uuid(name?: string): Base<string, 'uuid'> {
  return make<string, 'uuid'>('uuid', name)
}
export function text(name?: string): Base<string, 'text'> {
  return make<string, 'text'>('text', name)
}
/**
 * `varchar` — a distinct codec, not an alias for `text`.
 *
 * Added in WS4 because the AST-equivalence oracle needs the builder to reproduce
 * `test/compile/insert.test.ts`'s `$1::varchar` cast, and that cast comes from `codec.sqlName`
 * (a WS2 finding: `int4`'s is `integer`, `int8`'s is `bigint`). Without a `varchar` column builder
 * the DSL simply could not describe a table PostgreSQL is full of — `varchar(n)` is what every
 * migration from another ORM lands on — so the gap was real independently of the test.
 *
 * The length is DDL only: PostgreSQL's `varchar` and `varchar(n)` are one type (OID 1043) and the
 * limit travels in the typmod, so it changes no codec and no decoded value.
 */
export function varchar(name?: string): Base<string, 'varchar'> {
  return make<string, 'varchar'>('varchar', name)
}
export function integer(name?: string): Base<number, 'int4'> {
  return make<number, 'int4'>('int4', name)
}
export function smallint(name?: string): Base<number, 'int2'> {
  return make<number, 'int2'>('int2', name)
}
/** `int8` decodes to `bigint` (design/00 sign-off #6). */
export function bigint(name?: string): Base<bigint, 'int8'> {
  return make<bigint, 'int8'>('int8', name)
}
export function boolean(name?: string): Base<boolean, 'bool'> {
  return make<boolean, 'bool'>('bool', name)
}
/** `timestamptz` decodes to `Date` (design/00 sign-off #6). */
export function timestamptz(name?: string): Base<Date, 'timestamptz'> {
  return make<Date, 'timestamptz'>('timestamptz', name)
}
/** `date` decodes to a branded `'YYYY-MM-DD'` string — never a `Date`, no day shifts. */
export function date(name?: string): Base<DateString, 'date'> {
  return make<DateString, 'date'>('date', name)
}
/** `numeric` decodes to `string` (lossless, design/00 sign-off #6). */
export function numeric(name?: string): Base<string, 'numeric'> {
  return make<string, 'numeric'>('numeric', name)
}
/** `jsonb` is `unknown`; narrow it with `.$type<T>()` (the documented, honest cast). */
export function jsonb(name?: string): Base<unknown, 'jsonb'> {
  return make<unknown, 'jsonb'>('jsonb', name)
}
/**
 * A column of any PostgreSQL type, named as text — `t.raw('varchar(50)')`, `t.raw('xml')`,
 * `t.raw('public."Name"')`.
 *
 * The typed builders cover eleven types; PostgreSQL has hundreds, plus every domain and
 * composite a schema declares. design/05 §5.3's rule for that gap is that the escape hatch
 * lives INSIDE the model rather than outside it, or the un-modelled part becomes permanent
 * drift — and this is that rule at column grain. It is also what makes `pg-prime pull` able
 * to emit a real, round-tripping schema for a database it did not create.
 *
 * The read type is `unknown`: the type name is a string this package has no way to reason
 * about, so pretending to know what a `real` decodes to would be a lie the codec layer
 * cannot honour. Narrow it with `.$type<T>()`, which is the documented, honest cast.
 */
export function raw(pgType: string, name?: string): Base<unknown, string> {
  if (typeof pgType !== 'string' || pgType.trim() === '') {
    throw new SchemaError(
      `pg-prime: t.raw() needs a PostgreSQL type name, e.g. t.raw('varchar(50)').`,
    )
  }
  return make<unknown, string>(pgType, name)
}

export function enumColumn<E extends AnyPgEnum>(
  e: E,
  name?: string,
): Base<E['values'][number], E['name']> {
  const ddl: ColumnDdl = {
    ...baseDdl(e.name, name),
    enumName: e.name,
    enumValues: e.values,
    enumSchema: e.schema,
  }
  return new ColumnBuilder(ddl, EMPTY_TS) as unknown as Base<E['values'][number], E['name']>
}

/**
 * The column kit passed to `pgTable(name, (t) => ({ ... }))`.
 *
 * Its only job is to keep a schema file's import list at ~5 names and to give
 * extension packs one place to hang new column types.
 */
export interface ColumnKit {
  uuid: typeof uuid
  text: typeof text
  varchar: typeof varchar
  integer: typeof integer
  smallint: typeof smallint
  bigint: typeof bigint
  boolean: typeof boolean
  timestamptz: typeof timestamptz
  date: typeof date
  numeric: typeof numeric
  jsonb: typeof jsonb
  enum: typeof enumColumn
  /** Any PostgreSQL type, by name (design/05 §5.3's escape hatch, at column grain). */
  raw: typeof raw
}

export const kit: ColumnKit = {
  uuid,
  text,
  varchar,
  integer,
  smallint,
  bigint,
  boolean,
  timestamptz,
  date,
  numeric,
  jsonb,
  enum: enumColumn,
  raw,
}
