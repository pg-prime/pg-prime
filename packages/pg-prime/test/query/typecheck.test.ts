/**
 * The query layer's type-level gates, run as ordinary tests.
 *
 * Same mechanism and same reason as `test/schema/typecheck.test.ts`: `pnpm typecheck` only
 * compiles `src`, so nothing else would compile `query.probe.ts` — and an *unused*
 * `@ts-expect-error` is only an error if a compiler actually runs over it. Without this file the
 * probe's ten negative controls could all silently stop firing.
 *
 * It compiles `query.probe.ts` (WS0: the operator vocabulary) and every `types/*.probe.ts` (WS1:
 * one file per construct — select, join, left-join nullability, CTEs, set ops, the `GROUP BY`
 * guard, `$if`, `$call`, invariance, `InferResult`).
 *
 * What it pins:
 *  - the operator vocabulary's **type-class gate** (design/09 §3.0 F1, design/03 §2.9) — the
 *    amendment that makes the free-function decision safe, and the thing that four of seven
 *    nonsense operator/column pairings walked straight through before it existed;
 *  - relation cardinality (`many` → `T[]`, `maybeOne` → `T | null`, `one` → `T`), which the
 *    bench cannot see because it only ever projects a `many`;
 *  - every WS1 construct's positive shape and its negative controls (design/09 §3.1), including
 *    the ones a mutation proved nothing else was checking: the invariance *marker* (`Query` is
 *    invariant for a second, accidental reason as well) and whole-object left-join nullability;
 *  - every probe compiles identically on the consumer floor (TS 5.9.3) and the build compiler
 *    (TS 7.0.2), per R7;
 *  - `declaration: true` emit succeeds, which is the TS2527 canary for the exported
 *    `unique symbol` rule (design/04 §3.3) — `src/query/symbols.ts` adds three of them.
 *
 * The *text* of each branded error is a separate artifact with a separate runner:
 * `type-errors.test.ts` + `tools/type-errors/`.
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
  '5.9.3': join(ROOT, 'node_modules', 'typescript59', 'bin', 'tsc'),
  '7.0.2': join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
}

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
  it('typechecks the query sources and the type probes cleanly', () => {
    // An unused `@ts-expect-error` is itself TS2578, so a *lost* rejection — an operator that
    // stops being gated by type class, a left join that stops nulling its alias — fails here.
    expect(tsc(bin, ['--noEmit'])).toEqual([])
  })

  it('emits declarations without TS2527 (no inaccessible unique symbol)', () => {
    const out = mkdtempSync(join(tmpdir(), `pg-prime-query-dts-${version}-`))
    try {
      const errors = tsc(bin, [
        '--noEmit',
        'false',
        '--emitDeclarationOnly',
        '--declaration',
        '--outDir',
        out,
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
