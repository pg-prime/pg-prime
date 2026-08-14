import { META } from './symbols.js'
import type { ColMeta, DateString } from './types.js'

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

export interface Col<M extends ColMeta> {
  readonly [META]: M
  /** Runtime metadata. Escape hatch for the migration/compile layers. */
  readonly $: ColumnRuntime

  /** Opt in to `NULL`. Columns are `NOT NULL` by default (design/04 D4). */
  nullable(): Col<{ t: M['t'] | null; pg: M['pg']; opt: true; ro: M['ro'] }>
  /** DDL `DEFAULT <literal>`. Does **not** touch `t` — a defaulted column is still non-null on read. */
  default(v: M['t']): Col<{ t: M['t']; pg: M['pg']; opt: true; ro: M['ro'] }>
  /** DDL `DEFAULT <expr>`. Seam for agent 03's `sql` tag; takes raw text for now. */
  defaultSql(expr: string): Col<{ t: M['t']; pg: M['pg']; opt: true; ro: M['ro'] }>
  /** GENERATED ALWAYS: absent from insert *and* update, present in select. */
  generatedAlways(): Col<{ t: M['t']; pg: M['pg']; opt: true; ro: true }>
  generatedByDefault(): Col<{ t: M['t']; pg: M['pg']; opt: true; ro: M['ro'] }>
  primaryKey(): Col<M>
  unique(): Col<M>
  array(): Col<{ t: M['t'][]; pg: `${M['pg']}[]`; opt: M['opt']; ro: M['ro'] }>

  // ── `$` = TS-only, never in the IR (design/05 D4) ───────────────────────────
  /** Narrow-only: `T` must be a subtype of the column's own type. */
  $type<T extends M['t']>(): Col<{ t: T; pg: M['pg']; opt: M['opt']; ro: M['ro'] }>
  /** Client-side default applied on insert. No `DEFAULT` in DDL. */
  $default(fn: () => M['t']): Col<{ t: M['t']; pg: M['pg']; opt: true; ro: M['ro'] }>
  /** Client-side value applied on update. No trigger emitted. */
  $onUpdate(fn: () => M['t']): Col<M>
}

const EMPTY_TS: ColumnTsMeta = { defaultFn: undefined, onUpdateFn: undefined, narrowed: false }

class ColumnBuilder implements ColumnRuntime {
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

  nullable(): ColumnBuilder {
    return this.#next({ notNull: false })
  }
  default(v: unknown): ColumnBuilder {
    return this.#next({ default: { kind: 'value', value: v } })
  }
  defaultSql(expr: string): ColumnBuilder {
    return this.#next({ default: { kind: 'expr', expr } })
  }
  generatedAlways(): ColumnBuilder {
    return this.#next({ identity: 'always' })
  }
  generatedByDefault(): ColumnBuilder {
    return this.#next({ identity: 'byDefault' })
  }
  primaryKey(): ColumnBuilder {
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
    return this.#next({}, { defaultFn: fn })
  }
  $onUpdate(fn: () => unknown): ColumnBuilder {
    return this.#next({}, { onUpdateFn: fn })
  }
}

function make(pgType: string, dbName?: string): any {
  return new ColumnBuilder(
    {
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
    },
    EMPTY_TS,
  )
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

export function pgEnum<N extends string, const V extends readonly [string, ...string[]]>(
  name: N,
  values: V,
): PgEnum<N, V> {
  return { kind: 'enum', name, values }
}

/** `Infer<typeof memberRole>` → `'owner' | 'admin' | 'member'`. */
export type Infer<E extends AnyPgEnum> = E['values'][number]

// ─────────────────────────────────────────────────────────────────────────────
// Column factories
// ─────────────────────────────────────────────────────────────────────────────

type Base<T, P extends string> = Col<{ t: T; pg: P; opt: false; ro: false }>

export function uuid(name?: string): Base<string, 'uuid'> {
  return make('uuid', name)
}
export function text(name?: string): Base<string, 'text'> {
  return make('text', name)
}
export function integer(name?: string): Base<number, 'int4'> {
  return make('int4', name)
}
export function smallint(name?: string): Base<number, 'int2'> {
  return make('int2', name)
}
/** `int8` decodes to `bigint` (design/00 sign-off #6). */
export function bigint(name?: string): Base<bigint, 'int8'> {
  return make('int8', name)
}
export function boolean(name?: string): Base<boolean, 'bool'> {
  return make('bool', name)
}
/** `timestamptz` decodes to `Date` (design/00 sign-off #6). */
export function timestamptz(name?: string): Base<Date, 'timestamptz'> {
  return make('timestamptz', name)
}
/** `date` decodes to a branded `'YYYY-MM-DD'` string — never a `Date`, no day shifts. */
export function date(name?: string): Base<DateString, 'date'> {
  return make('date', name)
}
/** `numeric` decodes to `string` (lossless, design/00 sign-off #6). */
export function numeric(name?: string): Base<string, 'numeric'> {
  return make('numeric', name)
}
/** `jsonb` is `unknown`; narrow it with `.$type<T>()` (the documented, honest cast). */
export function jsonb(name?: string): Base<unknown, 'jsonb'> {
  return make('jsonb', name)
}
export function enumColumn<E extends AnyPgEnum>(e: E, name?: string): Base<E['values'][number], E['name']> {
  const c = make(e.name, name) as ColumnBuilder
  return new ColumnBuilder({ ...c.ddl, enumName: e.name, enumValues: e.values }, c.ts) as any
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
