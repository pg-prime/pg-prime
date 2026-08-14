import { META } from './symbols.js';
import type { ColMeta, DateString } from './types.js';
/** A `DEFAULT` in the emitted DDL. */
export type DefaultSpec = {
    readonly kind: 'value';
    readonly value: unknown;
} | {
    readonly kind: 'expr';
    readonly expr: string;
};
/**
 * Everything a column contributes to DDL / the migration IR.
 *
 * **The `$` law:** no `$`-prefixed builder method may ever write into this
 * record. `.default()` lands here; `.$default()` lands in {@link ColumnTsMeta}.
 */
export interface ColumnDdl {
    readonly pgType: string;
    /** Explicit DB name; `undefined` → derived from the TS key by the casing strategy. */
    readonly dbName: string | undefined;
    readonly notNull: boolean;
    readonly default: DefaultSpec | undefined;
    readonly identity: 'always' | 'byDefault' | undefined;
    readonly primaryKey: boolean;
    readonly unique: boolean;
    readonly enumName: string | undefined;
    readonly enumValues: readonly string[] | undefined;
    readonly arrayDim: number;
}
/** TS-only column metadata. Never reaches DDL or the migration IR. */
export interface ColumnTsMeta {
    readonly defaultFn: (() => unknown) | undefined;
    readonly onUpdateFn: (() => unknown) | undefined;
    /** True once `.$type<T>()` has been applied (documentation / lint only). */
    readonly narrowed: boolean;
}
/** The runtime shape behind every `Col<M>`. */
export interface ColumnRuntime {
    readonly ddl: ColumnDdl;
    readonly ts: ColumnTsMeta;
}
/**
 * Minimal `Any` supertype (design/04 §3.3): an interface whose members are
 * `any`, **not** `Col<any>`. `X extends AnyCol` is then an O(1) check that
 * never forces the modifier signatures to be instantiated.
 */
export interface AnyCol {
    readonly [META]: any;
}
export interface Col<M extends ColMeta> {
    readonly [META]: M;
    /** Runtime metadata. Escape hatch for the migration/compile layers. */
    readonly $: ColumnRuntime;
    /** Opt in to `NULL`. Columns are `NOT NULL` by default (design/04 D4). */
    nullable(): Col<{
        t: M['t'] | null;
        pg: M['pg'];
        opt: true;
        ro: M['ro'];
    }>;
    /** DDL `DEFAULT <literal>`. Does **not** touch `t` — a defaulted column is still non-null on read. */
    default(v: M['t']): Col<{
        t: M['t'];
        pg: M['pg'];
        opt: true;
        ro: M['ro'];
    }>;
    /** DDL `DEFAULT <expr>`. Seam for agent 03's `sql` tag; takes raw text for now. */
    defaultSql(expr: string): Col<{
        t: M['t'];
        pg: M['pg'];
        opt: true;
        ro: M['ro'];
    }>;
    /** GENERATED ALWAYS: absent from insert *and* update, present in select. */
    generatedAlways(): Col<{
        t: M['t'];
        pg: M['pg'];
        opt: true;
        ro: true;
    }>;
    generatedByDefault(): Col<{
        t: M['t'];
        pg: M['pg'];
        opt: true;
        ro: M['ro'];
    }>;
    primaryKey(): Col<M>;
    unique(): Col<M>;
    array(): Col<{
        t: M['t'][];
        pg: `${M['pg']}[]`;
        opt: M['opt'];
        ro: M['ro'];
    }>;
    /** Narrow-only: `T` must be a subtype of the column's own type. */
    $type<T extends M['t']>(): Col<{
        t: T;
        pg: M['pg'];
        opt: M['opt'];
        ro: M['ro'];
    }>;
    /** Client-side default applied on insert. No `DEFAULT` in DDL. */
    $default(fn: () => M['t']): Col<{
        t: M['t'];
        pg: M['pg'];
        opt: true;
        ro: M['ro'];
    }>;
    /** Client-side value applied on update. No trigger emitted. */
    $onUpdate(fn: () => M['t']): Col<M>;
}
export interface PgEnum<N extends string, V extends readonly string[]> {
    readonly kind: 'enum';
    readonly name: N;
    readonly values: V;
}
export type AnyPgEnum = PgEnum<string, readonly string[]>;
export declare function pgEnum<N extends string, const V extends readonly [string, ...string[]]>(name: N, values: V): PgEnum<N, V>;
/** `Infer<typeof memberRole>` → `'owner' | 'admin' | 'member'`. */
export type Infer<E extends AnyPgEnum> = E['values'][number];
type Base<T, P extends string> = Col<{
    t: T;
    pg: P;
    opt: false;
    ro: false;
}>;
export declare function uuid(name?: string): Base<string, 'uuid'>;
export declare function text(name?: string): Base<string, 'text'>;
export declare function integer(name?: string): Base<number, 'int4'>;
export declare function smallint(name?: string): Base<number, 'int2'>;
/** `int8` decodes to `bigint` (design/00 sign-off #6). */
export declare function bigint(name?: string): Base<bigint, 'int8'>;
export declare function boolean(name?: string): Base<boolean, 'bool'>;
/** `timestamptz` decodes to `Date` (design/00 sign-off #6). */
export declare function timestamptz(name?: string): Base<Date, 'timestamptz'>;
/** `date` decodes to a branded `'YYYY-MM-DD'` string — never a `Date`, no day shifts. */
export declare function date(name?: string): Base<DateString, 'date'>;
/** `numeric` decodes to `string` (lossless, design/00 sign-off #6). */
export declare function numeric(name?: string): Base<string, 'numeric'>;
/** `jsonb` is `unknown`; narrow it with `.$type<T>()` (the documented, honest cast). */
export declare function jsonb(name?: string): Base<unknown, 'jsonb'>;
export declare function enumColumn<E extends AnyPgEnum>(e: E, name?: string): Base<E['values'][number], E['name']>;
/**
 * The column kit passed to `pgTable(name, (t) => ({ ... }))`.
 *
 * Its only job is to keep a schema file's import list at ~5 names and to give
 * extension packs one place to hang new column types.
 */
export interface ColumnKit {
    uuid: typeof uuid;
    text: typeof text;
    integer: typeof integer;
    smallint: typeof smallint;
    bigint: typeof bigint;
    boolean: typeof boolean;
    timestamptz: typeof timestamptz;
    date: typeof date;
    numeric: typeof numeric;
    jsonb: typeof jsonb;
    enum: typeof enumColumn;
}
export declare const kit: ColumnKit;
export {};
