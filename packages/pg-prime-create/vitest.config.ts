import { defineConfig } from 'vitest/config'

/**
 * Two projects (design/08 §4, design/13 §3 X):
 *
 *   unit — tier 0. No I/O beyond a temp directory: template ↔ docs-block equality, the argument
 *          parser, the refusal of a non-empty directory, the scaffold's file list.
 *   pg   — tier 2. The scaffold installed from tarballs and run against a real PostgreSQL:
 *          `migrate generate` → `apply` → `status` → the program's own output, compared with the
 *          transcripts on `docs/guides/getting-started`.
 *
 * `pnpm test` = unit · `pnpm test:pg` = both. There is no tier 1: nothing here is a wire-protocol
 * claim, so PGlite would only make the same assertions slower.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/*.test.ts'],
          // `src/versions.ts` is generated and git-ignored; everything that imports the scaffolder
          // needs it to exist first.
          globalSetup: ['./test/globalSetup.ts'],
        },
      },
      {
        test: {
          name: 'pg',
          include: ['test/pg/**/*.test.ts'],
          globalSetup: ['./test/pg/globalSetup.ts'],
          // One `npm install` from tarballs, one `tsc`, and five CLI round trips against a server.
          testTimeout: 600_000,
          hookTimeout: 600_000,
        },
      },
    ],
  },
})
