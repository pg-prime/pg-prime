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
export const META = Symbol.for('pgorm.META')
/** Table name literal. */
export const NAME = Symbol.for('pgorm.NAME')
/** Table column-meta record. */
export const COLS = Symbol.for('pgorm.COLS')
/** Pre-computed per-column reference objects. */
export const REFS = Symbol.for('pgorm.REFS')
/** Pre-flattened select row shape. */
export const SEL = Symbol.for('pgorm.SEL')
/** Pre-flattened insert row shape. */
export const INS = Symbol.for('pgorm.INS')
/** Pre-flattened update row shape. */
export const UPD = Symbol.for('pgorm.UPD')
/** Relation record. */
export const RELS = Symbol.for('pgorm.RELS')
/** Table record of a schema registry. */
export const TABLES = Symbol.for('pgorm.TABLES')
/** Schema back-reference on a table handle. */
export const SCHEMA = Symbol.for('pgorm.SCHEMA')
/** Output type of anything projectable. */
export const OUT = Symbol.for('pgorm.OUT')
/** Source alias of a column reference. */
export const SRC = Symbol.for('pgorm.SRC')
/** Sentinel-error message carrier (design/04 §4.1). */
export const ERR = Symbol.for('pgorm.ERR')
/** Brand key for the `date` codec's `'YYYY-MM-DD'` string. */
export const DATE_BRAND = Symbol.for('pgorm.DATE_BRAND')
