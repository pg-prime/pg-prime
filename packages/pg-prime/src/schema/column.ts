import { SchemaError } from '../sql/errors.js'
import { InvalidIdentifierError } from '../sql/errors.js'
import { quoteIdentPart } from '../sql/ident.js'
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
  readonly primaryKey: boolean
  readonly unique: boolean
  readonly enumName: string | undefined
  readonly enumValues: readonly string[] | undefined
  readonly arrayDim: number
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
    ? OrmTypeError<'.nullable() after .generatedAlways(): a generated column is always NOT NULL'>
    : () => Col<{ t: M['t'] | null; pg: M['pg']; opt: true; ro: M['ro']; pk: M['pk'] }>

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
  default: DefaultableFn<M, (v: M['t']) => Col<{ t: M['t']; pg: M['pg']; opt: true; ro: M['ro']; pk: M['pk'] }>>
  /** DDL `DEFAULT <expr>`. Seam for agent 03's `sql` tag; takes raw text for now. */
  defaultSql: DefaultableFn<M, (expr: string) => Col<{ t: M['t']; pg: M['pg']; opt: true; ro: M['ro']; pk: M['pk'] }>>
  /** GENERATED ALWAYS: absent from insert *and* update, present in select. */
  generatedAlways(): Col<{ t: M['t']; pg: M['pg']; opt: true; ro: true; pk: M['pk'] }>
  generatedByDefault(): Col<{ t: M['t']; pg: M['pg']; opt: true; ro: M['ro']; pk: M['pk'] }>
  /** Marks the column `pk: true` so design/03 §2.3's `GROUP BY` guard can see it (04 §1.1). */
  primaryKey(): Col<{ t: M['t']; pg: M['pg']; opt: M['opt']; ro: M['ro']; pk: true }>
  unique(): Col<M>
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
  $default: DefaultableFn<M, (fn: () => M['t']) => Col<{ t: M['t']; pg: M['pg']; opt: true; ro: M['ro']; pk: M['pk'] }>>
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
      this.#reject('.nullable() after .primaryKey()', 'a primary key column is NOT NULL by definition')
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
  }
  generatedAlways(): ColumnBuilder {
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
  primaryKey(): ColumnBuilder {
    if (!this.ddl.notNull) {
      this.#reject('.primaryKey() after .nullable()', 'a primary key column is NOT NULL by definition')
    }
    return this.#next({ primaryKey: true })
  }
  unique(): ColumnBuilder {
    return this.#next({ unique: true })
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
    primaryKey: false,
    unique: false,
    enumName: undefined,
    enumValues: undefined,
    arrayDim: 0,
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
      throw new SchemaError(`pg-prime: ${what} is not a usable PostgreSQL identifier: ${e.reason} (${e.message}).`)
    }
    throw e
  }
}

export function pgEnum<N extends string, const V extends readonly [string, ...string[]]>(
  name: N,
  values: V,
): PgEnum<N, V> {
  checkName(name, `pgEnum("${name}") type name`)
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
  return { kind: 'enum', name, values }
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
export function enumColumn<E extends AnyPgEnum>(e: E, name?: string): Base<E['values'][number], E['name']> {
  const ddl: ColumnDdl = { ...baseDdl(e.name, name), enumName: e.name, enumValues: e.values }
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
}
