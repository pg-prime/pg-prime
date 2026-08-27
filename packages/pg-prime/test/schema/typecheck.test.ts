/**
 * The type-level gates, run as ordinary tests.
 *
 * `pnpm --filter pg-prime typecheck` only covers `src` (its tsconfig `include` is
 * frozen), so nothing else would ever compile `ts-expect-error.probe.ts` — and
 * an *unused* `@ts-expect-error` is only an error if someone actually runs the
 * compiler over it. These tests close that hole and pin design/04 §3.6's PR
 * gates that are in scope for the type-core spike:
 *
 *  - the probe suite compiles identically on the consumer floor (TS 5.9.3) and
 *    the build compiler (TS 7.0.2);
 *  - a `declaration: true` emit succeeds, which is the TS2527 canary for the
 *    exported-`unique symbol` rule (design/04 §3.3).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..', '..')
const PROJECT = join(HERE, 'tsconfig.json')

const COMPILERS = {
  // The consumer floor (design/00 sign-off #2).
  '5.9.3': join(ROOT, 'node_modules', 'typescript59', 'bin', 'tsc'),
  // The build compiler (tsgo).
  '7.0.2': join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
}

/** Runs `tsc` and returns its diagnostic lines (empty === clean). */
function tsc(bin: string, args: readonly string[]): string[] {
  let out: string
  try {
    out = execFileSync(process.execPath, [bin, '-p', PROJECT, '--pretty', 'false', ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
  return out.split('\n').filter((l) => /error TS\d+/.test(l))
}

describe.each(Object.entries(COMPILERS))('TypeScript %s', (version, bin) => {
  it('typechecks the schema sources and every probe cleanly', () => {
    // Includes `ts-expect-error.probe.ts`: an unused `@ts-expect-error` is
    // itself TS2578, so a *lost* type error fails right here.
    expect(tsc(bin, ['--noEmit'])).toEqual([])
  })

  it('emits declarations without TS2527 (no inaccessible unique symbol)', () => {
    const out = mkdtempSync(join(tmpdir(), `pg-prime-dts-${version}-`))
    try {
      const errors = tsc(bin, [
        '--noEmit',
        'false',
        '--emitDeclarationOnly',
        '--declaration',
        '--outDir',
        out,
        // The probe files live above the project dir; the layout warning is not
        // what this test is about.
        '--rootDir',
        join(ROOT, 'packages', 'pg-prime'),
      ])
      expect(errors.filter((l) => /TS2527/.test(l))).toEqual([])
      expect(errors).toEqual([])
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })
})
