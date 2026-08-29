import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `setupFiles`, not `globalSetup`: PGlite is ONE PostgreSQL backend, so a shared instance lets
    // every file see every other file's temp tables, sequences and session state. One instance per
    // test file costs about a second and restores real isolation.
    setupFiles: ['./test/setup.ts'],
  },
})
