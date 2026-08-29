import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Three projects, one per tier, the same split `packages/pg-prime/vitest.config.ts` uses:
 *
 *   unit — no I/O at all. `pnpm test`.
 *   live — tier 1: the PGlite fixture, booting a real WASM PostgreSQL. `pnpm test:live`.
 *   pg   — tier 2: `scratchDatabase` against `PG_PRIME_TEST_URL` and `startPostgres` against
 *          Docker, both skipped loudly by this package's own guards when they are absent.
 */

/**
 * `pg-prime` resolves to its SOURCE, mirroring `tsconfig.json`'s `paths`. Without this the
 * workspace link resolves through `pg-prime`'s export map to `dist/`, which exists only after
 * `pnpm build` — and CI's `unit`, `live` and `pg` jobs all run on a fresh checkout with no build in
 * front of them. Worse than merely absent: `pnpm -r test:pg` runs this package and `@pg-prime/kit`
 * **concurrently**, and the kit's `globalSetup` rebuilds `packages/pg-prime/dist` from scratch
 * (`rm -rf` first), so a run that resolved through the export map would import a tree that is being
 * deleted underneath it. Measured: `Cannot find module …/dist/query/window.js`, in four files.
 *
 * The published shape is exercised by `tools/pack-smoke.mjs`, not by these tests.
 *
 * It is spelled **per project** rather than once at the top level because vitest 4's `projects`
 * do not inherit the root config's `resolve` — an alias written up there is silently ignored by
 * every project, which is exactly the failure above.
 */
const PG_PRIME_SRC = resolve(import.meta.dirname, '../pg-prime/src')

const resolvePgPrimeToSource = {
  alias: [
    { find: /^pg-prime$/, replacement: resolve(PG_PRIME_SRC, 'index.ts') },
    { find: /^pg-prime\/schema$/, replacement: resolve(PG_PRIME_SRC, 'schema/index.ts') },
    { find: /^pg-prime\/sql$/, replacement: resolve(PG_PRIME_SRC, 'sql/index.ts') },
    { find: /^pg-prime\/codecs$/, replacement: resolve(PG_PRIME_SRC, 'codec/index.ts') },
    { find: /^pg-prime\/driver$/, replacement: resolve(PG_PRIME_SRC, 'entry/driver.ts') },
  ],
}

/** Booting PGlite and pulling a `postgres:17` image are both slower than the 5 s default. */
const SLOW_TIMEOUT_MS = 180_000

export default defineConfig({
  resolve: resolvePgPrimeToSource,
  test: {
    projects: [
      {
        resolve: resolvePgPrimeToSource,
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'] },
      },
      {
        resolve: resolvePgPrimeToSource,
        test: {
          name: 'live',
          include: ['test/live/**/*.test.ts'],
          testTimeout: SLOW_TIMEOUT_MS,
          hookTimeout: SLOW_TIMEOUT_MS,
        },
      },
      {
        resolve: resolvePgPrimeToSource,
        test: {
          name: 'pg',
          include: ['test/pg/**/*.test.ts'],
          testTimeout: SLOW_TIMEOUT_MS,
          hookTimeout: SLOW_TIMEOUT_MS,
        },
      },
    ],
  },
})
