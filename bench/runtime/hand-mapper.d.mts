// Types for the decode oracle, so tier 0 can import it (`test/compile/decode-oracle.test.ts`).
//
// The bench is JavaScript for the reason `bench/types` is — a bench that needs the build to run is
// a bench nobody runs — but the oracle equivalence belongs in `pnpm test`, and a TypeScript test
// importing an untyped `.mjs` would need the cast R12 forbids. Hand-written rather than emitted,
// because the surface is five names and this way the contract is reviewable.

/** One row of PostgreSQL wire text: 12 cells, `null` where the left join missed. */
export type RawRow = readonly (string | null)[]

/** The twelve output keys, in projection order. The contract between the mapper and the query. */
export declare const DECODE_KEYS: readonly string[]

/** `n` rows x 12 columns of PostgreSQL wire text. Deterministic; see the module for the traps. */
export declare function decodeRows(n?: number): RawRow[]

/** Oracle 1: unchecked, what a person would write by hand. */
export declare function handMapRows(rows: readonly RawRow[]): Record<string, unknown>[]

/** Oracle 2: the same conversions the codecs perform, so the ratio is dispatch alone. */
export declare function handMapRowsChecked(rows: readonly RawRow[]): Record<string, unknown>[]

/** Oracle 3: no conversion at all, for the identity-codec pair. */
export declare function handMapRowsPlain(rows: readonly RawRow[]): Record<string, unknown>[]

/** The narrower mapper for `id` / `email` / `name`. */
export declare function handMapUsers(rows: readonly RawRow[]): Record<string, unknown>[]

/** Alias kept for the end-to-end pairs. */
export declare const handMapper: typeof handMapRows
