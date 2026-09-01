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
export const META = Symbol.for('pg-prime.META')
/** Table name literal. */
export const NAME = Symbol.for('pg-prime.NAME')
/** Table column-meta record. */
export const COLS = Symbol.for('pg-prime.COLS')
/** Pre-computed per-column reference objects. */
export const REFS = Symbol.for('pg-prime.REFS')
/** Pre-flattened select row shape. */
export const SEL = Symbol.for('pg-prime.SEL')
/** Pre-flattened insert row shape. */
export const INS = Symbol.for('pg-prime.INS')
/** Pre-flattened update row shape. */
export const UPD = Symbol.for('pg-prime.UPD')
/** Relation record. */
export const RELS = Symbol.for('pg-prime.RELS')
/** Table record of a schema registry. */
export const TABLES = Symbol.for('pg-prime.TABLES')
/** Schema back-reference on a table handle. */
export const SCHEMA = Symbol.for('pg-prime.SCHEMA')
/** Output type of anything projectable. */
export const OUT = Symbol.for('pg-prime.OUT')
/** Source alias of a column reference. */
export const SRC = Symbol.for('pg-prime.SRC')
/** Sentinel-error message carrier (design/04 §4.1). */
export const ERR = Symbol.for('pg-prime.ERR')
/**
 * "This FROM source has no write surface" — present only on a `pgView` / `pgMaterializedView`
 * handle (design/01 §3 row 58). `insertInto` / `update` / `deleteFrom` read it in return position
 * and resolve to design/04 §4.1's branded sentence instead of building a statement.
 */
export const READONLY = Symbol.for('pg-prime.READONLY')
/**
 * Reserved. Was the brand key of the schema layer's own `DateString`; `DateString` is now an alias
 * of the codec layer's `PgDateString` (one brand, `src/schema/types.ts`), so nothing reads this.
 * Kept exported because removing a `Symbol.for` key from the public surface is a breaking change
 * for anyone who wrote it into a structural type, and it costs one interned symbol.
 */
export const DATE_BRAND = Symbol.for('pg-prime.DATE_BRAND')
