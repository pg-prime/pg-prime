import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Three projects, one per tier, the same split `packages/pg-prime/vitest.config.ts` uses:
 *
 *   unit — no I/O at all. `pnpm test`.
 *   live — tier 1: the PGlite fixture, booting a real WASM PostgreSQL. `pnpm test:live`.
 *   pg   — tier 2: `scratchDatabase` against `PG_PRIME_TEST_URL` and `startPostgres` against
 *          Docker, both skipped loudly by this package's own guards when they are absent.
 *
 * `pg-prime` resolves to its SOURCE, mirroring `tsconfig.json`'s `paths`. Without this the
 * workspace link resolves through `pg-prime`'s export map to `dist/`, which exists only after
 * `pnpm build` — and CI's `unit`, `live` and `pg` jobs all run on a fresh checkout with no build
 * in front of them. The published shape is exercised by `tools/pack-smoke.mjs`, not by these tests.
 */
const PG_PRIME_SRC = resolve(import.meta.dirname, '../pg-prime/src')

/** Booting PGlite and pulling a `postgres:17` image are both slower than the 5 s default. */
const SLOW_TIMEOUT_MS = 180_000

export default defineConfig({
  resolve: {
    alias: [
      { find: /^pg-prime$/, replacement: resolve(PG_PRIME_SRC, 'index.ts') },
      { find: /^pg-prime\/schema$/, replacement: resolve(PG_PRIME_SRC, 'schema/index.ts') },
      { find: /^pg-prime\/sql$/, replacement: resolve(PG_PRIME_SRC, 'sql/index.ts') },
      { find: /^pg-prime\/codecs$/, replacement: resolve(PG_PRIME_SRC, 'codec/index.ts') },
      { find: /^pg-prime\/driver$/, replacement: resolve(PG_PRIME_SRC, 'entry/driver.ts') },
    ],
  },
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      {
        test: {
          name: 'live',
          include: ['test/live/**/*.test.ts'],
          testTimeout: SLOW_TIMEOUT_MS,
          hookTimeout: SLOW_TIMEOUT_MS,
        },
      },
      {
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
