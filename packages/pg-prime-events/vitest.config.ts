import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Workspace packages resolve to source: `dist` exists only after a build. Spelled per project,
// because vitest 4 projects do not inherit the root `resolve`.
const src = (pkg: string, entry = 'index.ts') =>
  resolve(import.meta.dirname, '..', pkg, 'src', entry)
const resolveToSource = {
  alias: [
    { find: /^pg-prime$/, replacement: src('pg-prime') },
    { find: /^pg-prime\/schema$/, replacement: src('pg-prime', 'schema/index.ts') },
    { find: /^pg-prime\/sql$/, replacement: src('pg-prime', 'sql/index.ts') },
    { find: /^pg-prime\/codecs$/, replacement: src('pg-prime', 'codec/index.ts') },
    { find: /^pg-prime\/driver$/, replacement: src('pg-prime', 'entry/driver.ts') },
    { find: /^@pg-prime\/testing$/, replacement: src('pg-prime-testing') },
  ],
}
const SLOW_MS = 120_000

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        resolve: resolveToSource,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          setupFiles: ['../pg-prime/test/live/_bun.ts'],
        },
      },
      {
        resolve: resolveToSource,
        test: {
          name: 'live',
          include: ['test/live/**/*.test.ts'],
          setupFiles: ['../pg-prime/test/live/_bun.ts'],
          testTimeout: SLOW_MS,
          hookTimeout: SLOW_MS,
        },
      },
      {
        resolve: resolveToSource,
        test: {
          name: 'pg',
          include: ['test/pg/**/*.test.ts'],
          setupFiles: ['../pg-prime/test/live/_bun.ts'],
          testTimeout: SLOW_MS,
          hookTimeout: SLOW_MS,
        },
      },
    ],
  },
})
