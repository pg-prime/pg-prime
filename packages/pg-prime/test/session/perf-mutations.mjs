// R10 for design/12 §4 P: fifteen mutations of the code this workstream wrote or changed, each
// applied to the working tree, run against the check that is supposed to notice, then reverted.
//
//   node packages/pg-prime/test/session/perf-mutations.mjs           all of them
//   node packages/pg-prime/test/session/perf-mutations.mjs M7        one
//
// The two families the brief asked for are the **regression-issue logic** (`tools/
// bench-regression.mjs`, whose failure mode is silence — nobody notices an issue that was never
// opened) and the **budget loader** (`bench/runtime/budget-gate.mjs`'s `_designLinked` / `_overDesign`
// gate, whose failure mode is a budget quietly drifting past its design number). The rest are the
// per-statement fast path, where the failure mode is a feature that stops working while every
// existing test still passes because the feature is optional.
//
// It edits files in place and restores them in a `finally`. Run it on a clean tree.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..', '..')
const ROOT = join(PKG, '..', '..')

const only = process.argv[2]

/** `vitest run --project unit <file>` — the tier-0 check. */
const unit = (file) => ({
  what: `tier 0 · ${file}`,
  run: () =>
    execFileSync(
      process.execPath,
      [join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--project', 'unit', file],
      { cwd: PKG, encoding: 'utf8', stdio: 'pipe' },
    ),
})

const selfTest = {
  what: 'tools/bench-regression.mjs --self-test',
  run: () =>
    execFileSync(process.execPath, [join(ROOT, 'tools', 'bench-regression.mjs'), '--self-test'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    }),
}

const compileBench = {
  what: 'pnpm bench:compile',
  run: () =>
    execFileSync(
      process.execPath,
      ['--expose-gc', join(ROOT, 'bench', 'runtime', 'run.mjs'), '--compile-only'],
      { cwd: join(ROOT, 'bench', 'runtime'), encoding: 'utf8', stdio: 'pipe' },
    ),
}

const MUTATIONS = [
  // ── the regression-issue logic ────────────────────────────────────────────
  {
    id: 'M1',
    file: 'tools/bench-regression.mjs',
    from: 'const worse = floor ? was / now - 1 : now / was - 1',
    to: 'const worse = now / was - 1',
    what: 'a throughput FLOOR is compared in the wrong direction',
    check: selfTest,
  },
  {
    id: 'M2',
    file: 'tools/bench-regression.mjs',
    from: '    if (!REPORTABLE.some((re) => re.test(c.name))) continue',
    to: '    if (false) continue',
    what: 'the allow-list is dropped, so the noisy tails become reportable',
    check: selfTest,
  },
  {
    id: 'M3',
    file: 'tools/bench-regression.mjs',
    from: "const THRESHOLD = Number(arg('--threshold') ?? 0.25)",
    to: "const THRESHOLD = Number(arg('--threshold') ?? 0.2)",
    what: "the threshold stops being design/08 §5's 25 %",
    check: selfTest,
  },
  {
    id: 'M4',
    file: 'tools/bench-regression.mjs',
    from: "return regressed.length === 0 ? '' : `perf regression: ${regressed[0].name}`",
    to: "return regressed.length === 0 ? '' : `perf regression: ${regressed.length} gates, worst ${regressed[0].worse}`",
    what: 'the issue title carries a count and a percentage, so it changes every night and the dedup never matches',
    check: selfTest,
  },
  // ── the budget loader ─────────────────────────────────────────────────────
  {
    id: 'M5',
    file: 'bench/runtime/budget.json',
    from: '"decode.ratioVsUncheckedMapperP50": "design/03 Appendix B asks',
    to: '"_deleted.decode.ratioVsUncheckedMapperP50": "design/03 Appendix B asks',
    what: 'an `_overDesign` waiver is deleted while its budget stays over design',
    check: compileBench,
  },
  {
    id: 'M6',
    file: 'bench/runtime/budget-gate.mjs',
    from: '    const justified = Object.prototype.hasOwnProperty.call(B._overDesign, metric)',
    to: '    const justified = true',
    what: 'every budget counts as waived, so `_overDesign` stops being required at all',
    check: compileBench,
    also: {
      file: 'bench/runtime/budget.json',
      from: '"decode.ratioVsUncheckedMapperP50": "design/03 Appendix B asks',
      to: '"_deleted.decode.ratioVsUncheckedMapperP50": "design/03 Appendix B asks',
    },
  },
  {
    id: 'M7',
    file: 'bench/runtime/budget-gate.mjs',
    from: "    const entries = typeof budgeted === 'object' ? Object.values(budgeted) : [budgeted]",
    to: "    const entries = [typeof budgeted === 'object' ? Object.values(budgeted)[0] : budgeted]",
    what: 'a per-case budget map is checked on its FIRST entry, so widening one of the nine e2e cases is invisible',
    check: compileBench,
    also: {
      file: 'bench/runtime/budget.json',
      from: '"relation load, two levels": 1.2\n    }',
      to: '"relation load, two levels": 99\n    }',
    },
  },
  {
    id: 'M8',
    file: 'bench/runtime/budget-gate.mjs',
    from: "export const LOWER_IS_LOOSER = new Set(['compile.simpleSelectsPerSecond'])",
    to: 'export const LOWER_IS_LOOSER = new Set([])',
    what: 'a throughput FLOOR is treated like a ceiling, so lowering it past design goes unnoticed',
    check: compileBench,
    also: {
      file: 'bench/runtime/budget.json',
      from: '"simpleSelectsPerSecond": 200000,\n    "_whySimpleSelectsPerSecond"',
      to: '"simpleSelectsPerSecond": 120000,\n    "_whySimpleSelectsPerSecond"',
    },
  },
  // ── the per-statement fast path ───────────────────────────────────────────
  {
    id: 'M9',
    file: 'packages/pg-prime/src/session/runner.ts',
    from: '  return state.hooks.enabled || log.logAllQueries || log.slowQueryMs !== null',
    to: '  return state.hooks.enabled',
    what: 'the fast-path predicate forgets the slow-query log, so a sink with no hooks loses its timing fields',
    check: unit('test/session/session.test.ts'),
  },
  {
    id: 'M10',
    file: 'packages/pg-prime/src/errors/redact.ts',
    from: '    E.prepareStackTrace = prevPrepare\n    E.stackTraceLimit = prevLimit',
    to: '    void prevPrepare\n    void prevLimit',
    what: 'the call-site capture leaves `Error.prepareStackTrace` installed for the rest of the process',
    check: unit('test/session/session.test.ts'),
  },
  {
    id: 'M11',
    file: 'packages/pg-prime/src/session/guard.ts',
    from: '  const callSite = captureSite ? captureCallSite(assertNotInsideTransaction) : undefined',
    to: '  const callSite = undefined',
    what: 'the dev guard never captures, so HandleMisuseError stops naming the statement',
    check: unit('test/session/session.test.ts'),
  },
  {
    id: 'M12',
    file: 'packages/pg-prime/src/session/runner.ts',
    from: '    return (this.#paramTypes ??= paramTypesOf(this.compiled.binds))',
    to: '    return this.#paramTypes ?? []',
    what: 'the lazy `paramTypes` accessor hands back nothing when nobody forced it',
    check: unit('test/session/session.test.ts'),
  },
  {
    id: 'M13',
    file: 'packages/pg-prime/src/session/runner.ts',
    from: '  if (state.hooks.enabled) state.hooks.pool(RELEASE_EVENT)',
    to: '  void RELEASE_EVENT',
    what: 'the release pool event stops firing',
    check: unit('test/session/session.test.ts'),
  },
  // ── the batch-insert path ─────────────────────────────────────────────────
  {
    id: 'M14',
    file: 'packages/pg-prime/src/compile/compiler.ts',
    from: '  let s = DOLLARS[n]',
    to: '  let s = DOLLARS[n - 1]',
    what: 'the `$n` table is off by one, so every parameter reference names its predecessor',
    check: unit('test/query/insert.test.ts'),
  },
  {
    id: 'M15',
    file: 'packages/pg-prime/src/query/insert.ts',
    from: '        const cells: Node[] = new Array<Node>(width)',
    to: '        const cells: Node[] = shared',
    what: 'the rewritten VALUES loop shares one cell array across rows',
    check: unit('test/query/insert.test.ts'),
    also: {
      file: 'packages/pg-prime/src/query/insert.ts',
      from: '    const out: Node[][] = new Array<Node[]>(rows.length)',
      to: '    const out: Node[][] = new Array<Node[]>(rows.length)\n    const shared: Node[] = new Array<Node>(width)',
    },
  },
]

const abs = (rel) => join(ROOT, rel)
const patch = (rel, from, to) => {
  const p = abs(rel)
  const s = readFileSync(p, 'utf8')
  if (!s.includes(from)) throw new Error(`${rel}: anchor not found:\n  ${from.slice(0, 90)}`)
  writeFileSync(p, s.replace(from, to))
}

let caught = 0
let survived = 0
for (const m of MUTATIONS) {
  if (only !== undefined && m.id !== only) continue
  const touched = [[m.file, readFileSync(abs(m.file), 'utf8')]]
  if (m.also !== undefined && m.also.file !== m.file) {
    touched.push([m.also.file, readFileSync(abs(m.also.file), 'utf8')])
  }
  try {
    if (m.also !== undefined) patch(m.also.file, m.also.from, m.also.to)
    patch(m.file, m.from, m.to)
    let ok = true
    try {
      m.check.run()
    } catch {
      ok = false
    }
    if (ok) {
      survived++
      console.log(`${m.id}  SURVIVED  ${m.what}\n         nothing failed — ${m.check.what}`)
    } else {
      caught++
      console.log(`${m.id}  caught by ${m.check.what}\n         ${m.what}`)
    }
  } finally {
    for (const [rel, original] of touched) writeFileSync(abs(rel), original)
  }
}
console.log(`\n${caught} caught, ${survived} survived`)
process.exit(survived === 0 ? 0 : 1)
