/**
 * Generate `src/versions.ts` once per run.
 *
 * It is git-ignored (design/13 decision 6), so a fresh checkout does not have it and every import
 * of `src/scaffold.ts` would fail. `build` and `typecheck` generate it too; this is the third
 * caller, because `pnpm test` runs neither of them first.
 *
 * In `globalSetup` rather than in a setup file: vitest runs test files in separate workers, and two
 * workers writing the same file race.
 */

import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const PKG_DIR: string = resolve(here, '..')

export function generateVersions(): void {
  execFileSync(process.execPath, [join(PKG_DIR, 'scripts', 'versions.mjs')], {
    stdio: ['ignore', 'inherit', 'inherit'],
  })
}

export default function setup(): void {
  generateVersions()
}
