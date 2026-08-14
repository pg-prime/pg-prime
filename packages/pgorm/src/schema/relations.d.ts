import { COLS, NAME, RELS, SCHEMA, SEL, TABLES } from './symbols.js';
import type { AnyTable, TableRuntime } from './table.js';
import type { Defer, RelMeta, Rels, Simplify } from './types.js';
export type Tables = Record<string, AnyTable>;
/** Per-table relation records. Tables without relations simply omit the key. */
export type RelsRecord<T extends Tables> = {
    [K in keyof T]?: Rels;
};
/**
 * Runtime-only relation configuration. Carries FK columns / `through` table /
 * per-parent predicates. **It must never enter the type parameters**
 * (design/04 §7.3).
 */
export interface RelConfig {
    readonly from?: unknown;
    readonly to?: unknown;
    readonly through?: unknown;
    readonly where?: unknown;
    readonly alias?: string;
}
/**
 * Three namespaces instead of design/05's `{ optional: false }` flag: each
 * picker returns a *fixed* `opt` literal, so a declared relation costs no
 * conditional. `one` is non-nullable and `maybeOne` opts into `| null`, which
 * is design/04's `one`/`maybeOne`/`many` trio and matches NOT-NULL-by-default.
 */
export interface RelBuilders<T extends Tables> {
    readonly one: {
        readonly [K in keyof T & string]: (cfg?: RelConfig) => {
            kind: 'one';
            opt: false;
            to: K;
        };
    };
    readonly maybeOne: {
        readonly [K in keyof T & string]: (cfg?: RelConfig) => {
            kind: 'one';
            opt: true;
            to: K;
        };
    };
    readonly many: {
        readonly [K in keyof T & string]: (cfg?: RelConfig) => {
            kind: 'many';
            opt: false;
            to: K;
        };
    };
}
/** Runtime relation node — what the query compiler reads. */
export interface RelNode {
    readonly kind: 'one' | 'many';
    readonly opt: boolean;
    readonly to: string;
    readonly config: RelConfig | undefined;
}
/**
 * `defineRelations(tables, r => ({ ... }))`.
 *
 * Relations produce **zero DDL** — this is purely a query-layer artifact.
 */
export declare function defineRelations<T extends Tables, R extends {
    [K in keyof T]?: Record<string, RelMeta<keyof T & string>>;
}>(tables: T, build: (r: RelBuilders<T>) => R): R;
export interface AnySchema {
    readonly [TABLES]: any;
    readonly [RELS]: any;
}
/**
 * A table handle: two indexed accesses reach anything, and nothing is
 * structurally inlined. This is what makes a fully-cyclic relation graph
 * typecheck with no thunks and no `.d.ts` explosion.
 */
export interface Handle<Sc extends AnySchema, N extends string> {
    readonly [SCHEMA]: Sc;
    readonly [NAME]: N;
    readonly $: TableRuntime;
}
export interface AnyHandle {
    readonly [SCHEMA]: any;
    readonly [NAME]: any;
    readonly $: TableRuntime;
}
export interface Schema<T extends Tables, R extends RelsRecord<T>> {
    readonly [TABLES]: T;
    readonly [RELS]: R;
    readonly tables: T;
    readonly rels: R;
    /** Table handles, one per registry key. The one fixed O(N) cost per program. */
    readonly h: {
        readonly [K in keyof T & string]: Handle<Schema<T, R>, K>;
    };
}
export declare function defineSchema<T extends Tables, R extends RelsRecord<T> = {}>(tables: T, rels?: R): Schema<T, R>;
/** Two indexed accesses; never a conditional, never a distribution. */
export type TableOf<Sc, N extends PropertyKey> = Sc[typeof TABLES & keyof Sc][N & keyof Sc[typeof TABLES & keyof Sc]];
export type RelsAt<Sc, N extends PropertyKey> = NonNullable<Sc[typeof RELS & keyof Sc][N & keyof Sc[typeof RELS & keyof Sc]]>;
export type ColsAt<Sc, N extends PropertyKey> = TableOf<Sc, N>[typeof COLS & keyof TableOf<Sc, N>];
export type SelAt<Sc, N extends PropertyKey> = TableOf<Sc, N>[typeof SEL & keyof TableOf<Sc, N>];
/** `many` → `O[]`; optional `one` → `O | null`; required `one` → `O`. */
export type RelOut<M extends RelMeta, O> = M['kind'] extends 'many' ? O[] : M['opt'] extends true ? O | null : O;
type LoadedIn<Sc extends AnySchema, N extends string, K extends string, F extends PropertyKey> = Defer<Simplify<{
    [P in F & keyof ColsAt<Sc, N>]: ColsAt<Sc, N>[P]['t'];
} & {
    [P in K & keyof RelsAt<Sc, N>]-?: RelOut<RelsAt<Sc, N>[P], SelAt<Sc, RelsAt<Sc, N>[P]['to']>>;
}>>;
/**
 * Three parameters: the handle, the **required** relations, and the
 * **selected** columns.
 *
 * Because query results are plain object types, a result that projected all of
 * `users` plus `posts` is *assignable* to `Loaded<typeof users, 'posts'>` with
 * no cast, no runtime marker and no `Ref`/`Collection` wrapper.
 */
export type Loaded<H extends AnyHandle, K extends keyof RelsAt<H[typeof SCHEMA], H[typeof NAME]> & string = never, F extends keyof ColsAt<H[typeof SCHEMA], H[typeof NAME]> = keyof ColsAt<H[typeof SCHEMA], H[typeof NAME]>> = LoadedIn<H[typeof SCHEMA], H[typeof NAME], K, F>;
export {};
