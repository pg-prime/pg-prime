/**
 * Query-layer phantom slot keys.
 *
 * MANDATORY (design/04 §3.3): every `unique symbol` in a public type position must be *exported*,
 * or a downstream build with `declaration: true` fails with TS2527. `Symbol.for`, so duplicate
 * copies of the package in one dependency tree still agree at runtime.
 */

/** Invariance marker on `Query<S, O>` — `(o: O) => O` is both co- and contravariant in `O`. */
export const INV = Symbol.for('pg-prime.INV')
/** The row type a query yields. `RowOf<Q>` is one indexed access into this. */
export const ROW = Symbol.for('pg-prime.ROW')
/** The projection record a sub-select carries, so a relation picker can infer `P` from it. */
export const PRJ = Symbol.for('pg-prime.PRJ')
