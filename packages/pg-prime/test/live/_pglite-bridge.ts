/**
 * The PGlite wire-protocol bridge, re-exported from `@pg-prime/testing` (design/13 decision 2).
 *
 * The implementation moved into the package that documents it; this file stays so that
 * `_pglite.ts`, `bridge.unit.test.ts` and `tools/docs-examples.mjs`'s esbuild bundle keep the
 * specifier they already have.
 *
 * The path is **relative source**, not the `@pg-prime/testing` package specifier, and that is the
 * whole point: `@pg-prime/testing` peer-depends on `pg-prime`, so a `devDependencies` entry here
 * would be a workspace cycle. A relative import of a `.ts` file is not a dependency of anything —
 * it is one test harness reading another package's source, which is what this repository's own
 * tier-1 run is. Published `pg-prime` does not contain `test/`.
 */

export * from '../../../pg-prime-testing/src/pglite-bridge.js'
