import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `setupFiles`, not `globalSetup`: PGlite is ONE PostgreSQL backend, so a shared instance lets
    // every file see every other file's temp tables, sequences and session state. One instance per
    // test file costs about a second and restores real isolation.
    setupFiles: ['./test/setup.ts'],
    // `npm run build` compiles test/ into dist/ as well, and Vitest 4 no longer excludes dist/ by
    // default — without this line every test runs twice, the second copy against dist/db.js.
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
