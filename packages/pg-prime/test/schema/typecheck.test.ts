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
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)

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
/**
 * `execFile`, not `execFileSync`, and the tests are `concurrent`.
 *
 * This file is the tier-0 CRITICAL PATH and it was invisible as one. design/12 §1 decision 11
 * caps `pnpm test` at 5 s and the merged round-A tree measured 5.3-5.6; the integration record
 * attributed that to transform and import across 48 files. Measured per file (design/12 §4 P
 * item 5), it is not: the 46 files that are not these two run in **3.18 s** with 972 of the 980
 * tests in them, and these two run in **5.49 s** with eight. Each spawns `tsc` four times -- two
 * compilers x (`--noEmit`, declaration emit) -- and `execFileSync` blocks the worker thread, so
 * the four ran end to end.
 *
 * They are four independent child processes writing to four different places, so they can
 * overlap. Nothing else about the test changes: the same four invocations, the same assertions.
 */
async function tsc(bin: string, args: readonly string[]): Promise<string[]> {
  let out: string
  try {
    const r = await run(process.execPath, [bin, '-p', PROJECT, '--pretty', 'false', ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    out = r.stdout
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
  return out.split('\n').filter((l) => /error TS\d+/.test(l))
}

describe.each(Object.entries(COMPILERS))('TypeScript %s', (version, bin) => {
  it.concurrent('typechecks the schema sources and every probe cleanly', async () => {
    // Includes `ts-expect-error.probe.ts`: an unused `@ts-expect-error` is
    // itself TS2578, so a *lost* type error fails right here.
    expect(await tsc(bin, ['--noEmit'])).toEqual([])
  }, 180_000)

  it.concurrent('emits declarations without TS2527 (no inaccessible unique symbol)', async () => {
    const out = mkdtempSync(join(tmpdir(), `pg-prime-dts-${version}-`))
    try {
      const errors = await tsc(bin, [
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
  }, 180_000)
})
