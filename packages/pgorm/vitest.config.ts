import { configDefaults, defineConfig } from 'vitest/config'

/**
 * Three projects, one per tier (design/08 §4, design/09 §2.2):
 *
 *   unit — no I/O at all. Must stay under 5 s: it is what `pnpm test` runs.
 *   live — tier 1. PGlite by default (no Docker), or `PGORM_TEST_URL` if set.
 *   pg   — tier 2. Only meaningful against a real server: everything here is guarded by
 *          `requiresConcurrency()` / `requiresVersion()` and skips loudly on PGlite.
 *
 * `pnpm test` = unit · `pnpm test:live` = unit + live · `pnpm test:pg` = all three.
 */

const LIVE_GLOBAL_SETUP = ['./test/live/_globalSetup.ts']

/** Fuzz + bulk suites against a WASM server are slower than the 5 s default. */
const LIVE_TIMEOUT_MS = 120_000

/**
 * Runs before every live test file: on PGlite it boots that file its own backend (`_pglite.ts`
 * documents why per file), against `PGORM_TEST_URL` it is a no-op.
 */
const LIVE_SETUP = ['./test/live/_setup.ts']

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          // `test/live/*.unit.test.ts` is the harness's own tier-0 test: no database, no setup
          // file, so it costs nothing here and it is the only thing that pins the wire-protocol
          // rules the PGlite bridge implements.
          include: ['test/{schema,sql,compile,query}/**/*.test.ts', 'test/live/**/*.unit.test.ts'],
        },
      },
      {
        test: {
          name: 'live',
          include: ['test/{driver,codec,fuzz,live,live-query}/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'test/live/**/*.unit.test.ts'],
          globalSetup: LIVE_GLOBAL_SETUP,
          setupFiles: LIVE_SETUP,
          testTimeout: LIVE_TIMEOUT_MS,
          hookTimeout: LIVE_TIMEOUT_MS,
        },
      },
      {
        test: {
          name: 'pg',
          include: ['test/pg/**/*.test.ts'],
          globalSetup: LIVE_GLOBAL_SETUP,
          setupFiles: LIVE_SETUP,
          testTimeout: LIVE_TIMEOUT_MS,
          hookTimeout: LIVE_TIMEOUT_MS,
        },
      },
    ],
  },
})
