/**
 * Phantom slot keys.
 *
 * MANDATORY (design/04 §3.3): every `unique symbol` used in a public type
 * position must be *exported*, or downstream builds with `declaration: true`
 * fail with TS2527 "The inferred type ... references an inaccessible
 * 'unique symbol'". `Symbol.for` (not `Symbol`) so that duplicate copies of the
 * package in a dependency tree still agree at runtime.
 */
/** Column metadata payload (`ColMeta`) carrier. */
export declare const META: unique symbol;
/** Table name literal. */
export declare const NAME: unique symbol;
/** Table column-meta record. */
export declare const COLS: unique symbol;
/** Pre-computed per-column reference objects. */
export declare const REFS: unique symbol;
/** Pre-flattened select row shape. */
export declare const SEL: unique symbol;
/** Pre-flattened insert row shape. */
export declare const INS: unique symbol;
/** Pre-flattened update row shape. */
export declare const UPD: unique symbol;
/** Relation record. */
export declare const RELS: unique symbol;
/** Table record of a schema registry. */
export declare const TABLES: unique symbol;
/** Schema back-reference on a table handle. */
export declare const SCHEMA: unique symbol;
/** Output type of anything projectable. */
export declare const OUT: unique symbol;
/** Source alias of a column reference. */
export declare const SRC: unique symbol;
/** Sentinel-error message carrier (design/04 §4.1). */
export declare const ERR: unique symbol;
/** Brand key for the `date` codec's `'YYYY-MM-DD'` string. */
export declare const DATE_BRAND: unique symbol;
