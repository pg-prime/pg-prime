// The runtime perf gates (design/09 WS7; design/03 Appendix B rows 4 and 5; design/08 §5).
//
//   node bench/runtime/run.mjs [--compile-only] [--quick] [--no-gate] [--rebuild]
//
//   pnpm bench:compile   → --compile-only. Deterministic, no database. This is the PR gate.
//   pnpm bench:runtime   → everything, including the end-to-end pairs when PG_PRIME_TEST_URL is
//                          set. Nightly on a fixed runner, and on a PR labelled `perf`.
//   pnpm bench:profile   → `profile.mjs`, which is NOT a gate: it walks the same builder chain one
//                          method at a time and prints the marginal bytes and microseconds of each
//                          step (`--cpu` adds a `.cpuprofile`). This file says whether the compile
//                          path regressed; that one says where the bytes are, which is what an
//                          optimisation needs and what design/09 §3.7's follow-up was aimed with.
//
// ─── What it measures, and against what ─────────────────────────────────────
//
//   compile   design/03 §1.1's case — a 12-column select with two joins and one nested relation
//             projection — built through the public API and compiled, plus design/08 §5's simple
//             select throughput, plus the two STRUCTURAL claims of §1.1 (one `join('')`, one binds
//             array) checked by `structure.mjs` rather than asserted in a comment.
//   decode    10 000 rows x 12 columns through `buildDecoder`, paired against the hand-written
//             positional mapper in `hand-mapper.mjs`, which is asserted to produce identical values
//             before either side is timed. BOTH builders are measured and gated — the default
//             closure tree and the opt-in `{ decoder: 'codegen' }` one (design/03 §1.3 AS BUILT) —
//             because the flag only earns its existence if the number beside it is published.
//   e2e       design/08 §5's nine pairs against a real server. Skipped without PG_PRIME_TEST_URL,
//             and deliberately never run against PGlite (see `e2e.mjs`).
//
// ─── R9: the three-way print ────────────────────────────────────────────────
//
// Every gated line prints as `design / measured / budget`, the shape `bench/types/run.mjs`
// established, so a number that drifts away from the design document is visible in the log even
// while it is still inside its budget. A breach exits non-zero unless `--no-gate`.
//
// ─── R9, and the part that is easy to get wrong: which budgets are absolute ─
//
// `08` §5 is explicit that gating PR CI on shared-runner wall-clock is a mistake, and its answer
// for the DB cases is to gate ratios. The same logic applies here, so:
//
//   · the emitter's own p50 is gated ABSOLUTELY against design/03's 25 µs, because it measures
//     ~4.5 µs on the reference machine and therefore has ~5x headroom — enough that no runner can
//     flake it;
//   · everything tighter is gated as a RATIO to `sampler.mjs`'s fixed reference workload, measured
//     in the same process, so the gate keeps its sensitivity on a machine half the speed;
//   · allocation (bytes/op) is gated tightly because it is machine-independent, and design/08 §5
//     names it as the number where ORM overhead actually hides;
//   · the structural counts are exact integers and are gated as such.
//
// `report.json` carries the absolute microseconds regardless, because a ratio without absolutes is
// marketing (`08` §5's own words about the README table).

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeQuery, heavyQuery, loadPackage, simpleQuery, BENCH_NS } from './cases.mjs'
import {
  DECODE_KEYS,
  decodeRows,
  handMapRows,
  handMapRowsChecked,
  handMapRowsPlain,
} from './hand-mapper.mjs'
import { bytesPerOp, calibrate, sample, samplePaired } from './sampler.mjs'
import { probeEmitterStructure } from './structure.mjs'
import { sameValue } from './e2e.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const COMPILE_ONLY = argv.includes('--compile-only')
const QUICK = argv.includes('--quick')
// `--quick` shrinks every sample and the decode fixture from 10 000 rows to 1 000, which moves
// the ratios enough that a gate on them would be measuring the flag rather than the code. It is a
// local iteration loop, so it never gates.
const GATE = !argv.includes('--no-gate') && !argv.includes('--quick')
const REBUILD = argv.includes('--rebuild')

const budget = JSON.parse(readFileSync(join(HERE, 'budget.json'), 'utf8'))

/**
 * A calibration with the nursery emptied first. Without the `gc()` the third call runs on a heap
 * full of 10 000-row decode results and reads ~50 % slow, which is a statement about the bench's
 * own garbage rather than about the machine.
 */
const calibrateNow = () => {
  globalThis.gc?.()
  return calibrate()
}
const design = budget._design

/** `--quick` trades precision for a ~5x faster local loop. Never used in CI. */
const S = QUICK ? { samples: 15, iters: 500, warmup: 1000 } : { samples: 60, iters: 2000, warmup: 5000 }

const { api, compiler, decode, fixture } = await loadPackage({ rebuild: REBUILD })
const fx = fixture.makeFixture(BENCH_NS)
const h = fx.schema.h
const compileDb = api.compileOnly(fx.schema)

// ── 0. calibration ───────────────────────────────────────────────────────────
// The machine-speed reference every `…RefRatio` budget is divided by. Taken three times — before,
// between and after the measured sections — and the smallest of the three minima wins, because the
// minimum is the only statistic here that a busy machine cannot inflate. The spread between the
// three is reported: a machine that changed speed mid-run makes every ratio worth less, and saying
// so is better than a silently wrong FAIL.
const calibs = [calibrateNow()]

// ── 1. compile ───────────────────────────────────────────────────────────────
const heavy = heavyQuery(compileDb, h, api)
const simple = simpleQuery(compileDb, h, api)

/** The emitter alone: a pre-built AST in, `{sql, binds}` out. design/03 §1.1's 25 µs, absolute. */
const heavyAsts = Array.from({ length: 256 }, () => heavy().toAst())
let astCursor = 0
const emitOnce = () => compiler.compile(heavyAsts[astCursor++ & 255])

const compileResults = {
  heavyBuildAndCompile: sample(() => heavy().compile(), S),
  heavyEmit: sample(emitOnce, S),
  simpleBuildAndCompile: sample(() => simple().compile(), { ...S, iters: S.iters * 2 }),
}

/**
 * A sink the optimiser cannot see through.
 *
 * `bytesPerOp` calls its thunk for the allocation, not for the answer, and an answer nothing reads
 * is an answer escape analysis is allowed to not allocate. It moves the four numbers below by ~1 %,
 * because a compiled statement escapes into a memo anyway; it moves `profile.mjs`'s early per-stage
 * numbers — whose whole result is a short-lived builder — by enough to make a stage read *cheaper*
 * than the stage before it, which is what that file's own docblock records. Both files keep it.
 */
let allocSink = null
const keep = (f) => () => {
  allocSink = f()
}

const compileAlloc = {
  heavyBuildAndCompile: bytesPerOp(keep(() => heavy().compile()), { warmup: QUICK ? 2000 : 20000 }),
  // Not gated — the third point that makes the other two a decomposition rather than two numbers.
  // `toAst()` is the builder chain with nothing planned and nothing emitted, so
  // chain / (compile − emit − chain) / emit splits a compile into "the user's method calls", "the
  // LATERAL planner" and "the emitter", which is the table an optimisation is aimed with.
  heavyToAst: bytesPerOp(keep(() => heavy().toAst()), { warmup: QUICK ? 2000 : 20000 }),
  heavyEmit: bytesPerOp(keep(emitOnce), { warmup: QUICK ? 2000 : 20000 }),
  simpleBuildAndCompile: bytesPerOp(keep(() => simple().compile()), { warmup: QUICK ? 2000 : 20000 }),
}

/**
 * Bytes per compile **by source** (design/09 §3.7 follow-up).
 *
 * Subtraction, not instrumentation: counters inside the compiler would be on every user's hot
 * path, and a second instrumented copy of it would be free to drift. The planner line is what is
 * left over, so it carries the error of both measurements — which is why it is reported and never
 * gated.
 */
const allocBySource = {
  builderChain: compileAlloc.heavyToAst.median,
  planner: compileAlloc.heavyBuildAndCompile.median - compileAlloc.heavyToAst.median - compileAlloc.heavyEmit.median,
  emitter: compileAlloc.heavyEmit.median,
  total: compileAlloc.heavyBuildAndCompile.median,
}
if (allocSink === null) throw new Error('bench/runtime: the allocation sink was never written to')

const structure = {
  heavy: probeEmitterStructure(() => heavy().compile()),
  simple: probeEmitterStructure(() => simple().compile()),
}

// ── 2. decode ────────────────────────────────────────────────────────────────
// The oracle check comes before the clock: two sides that disagree are not a ratio, they are two
// different jobs. `hand-mapper.mjs` explains why there are three oracles rather than one.
const decodeCompiled = decodeQuery(compileDb, h, api).compile()
const shapeKeys = decodeCompiled.shape.fields.map((f) => f.key)
if (shapeKeys.join(',') !== DECODE_KEYS.join(',')) {
  throw new Error(
    `bench/runtime: the decode projection drifted from hand-mapper.mjs's fixed column order.\n` +
      `  compiled: ${shapeKeys.join(', ')}\n  mapper:   ${DECODE_KEYS.join(', ')}`,
  )
}
const rows = decodeRows(QUICK ? 1000 : 10_000)
const decoder = decode.buildDecoder(decodeCompiled.shape)
const codegenDecoder = decode.buildDecoder(decodeCompiled.shape, undefined, 'codegen')

/** The identity-codec twin of the same shape: every column decodes as `text`, i.e. not at all. */
const plainShape = {
  k: 'row',
  fields: DECODE_KEYS.map((key, idx) => ({ k: 'col', key, idx, codec: api.textCodec })),
}
const plainDecoder = decode.buildDecoder(plainShape)
const plainCodegenDecoder = decode.buildDecoder(plainShape, undefined, 'codegen')

function assertOracle(label, ours, theirs) {
  if (sameValue(ours, theirs)) return
  const bad = ours.findIndex((r, i) => !sameValue(r, theirs[i]))
  const show = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x))
  throw new Error(
    `bench/runtime: the "${label}" hand mapper is not an oracle — it disagrees with buildDecoder ` +
      `at row ${bad}.\n  decoder: ${show(ours[bad])}\n  mapper:  ${show(theirs[bad])}`,
  )
}
assertOracle('unchecked', decoder(rows), handMapRows(rows))
assertOracle('checked', decoder(rows), handMapRowsChecked(rows))
assertOracle('plain', plainDecoder(rows), handMapRowsPlain(rows))
// The generated decoder is held to the same oracle AND to the closure tree, because "faster" is
// only interesting if it is the same answer. `test/compile/decode-oracle.test.ts` pins this in
// tier 0 as well; here it also guards the bench from timing two different jobs.
assertOracle('codegen vs unchecked', codegenDecoder(rows), handMapRows(rows))
assertOracle('codegen vs closure tree', codegenDecoder(rows), decoder(rows))
assertOracle('codegen plain', plainCodegenDecoder(rows), handMapRowsPlain(rows))

const DS = { iters: 1, samples: QUICK ? 15 : 60, warmup: 5 }
const decodePairs = {
  vsUnchecked: samplePaired(() => decoder(rows), () => handMapRows(rows), DS),
  vsChecked: samplePaired(() => decoder(rows), () => handMapRowsChecked(rows), DS),
  dispatchOnly: samplePaired(() => plainDecoder(rows), () => handMapRowsPlain(rows), DS),
  codegenVsUnchecked: samplePaired(() => codegenDecoder(rows), () => handMapRows(rows), DS),
  codegenVsChecked: samplePaired(() => codegenDecoder(rows), () => handMapRowsChecked(rows), DS),
  codegenDispatchOnly: samplePaired(
    () => plainCodegenDecoder(rows),
    () => handMapRowsPlain(rows),
    DS,
  ),
}
calibs.push(calibrateNow())

// ── 3. end-to-end (design/08 §5's nine pairs) ────────────────────────────────
let e2e = null
let e2eSkipped = null
if (COMPILE_ONLY) {
  e2eSkipped = '--compile-only'
} else if (!process.env['PG_PRIME_TEST_URL']) {
  // PGlite is the tier-1 default everywhere else in this repo, and it is the wrong perf target:
  // it is a WASM build behind an in-process bridge, so neither its absolute latency nor its
  // raw/orm ratio is a statement about PostgreSQL. Skipping loudly beats reporting a number that
  // means nothing (design/09 §2.2's "skips are logged with a count").
  e2eSkipped = 'PG_PRIME_TEST_URL is unset — the end-to-end pairs need a real server, not PGlite'
} else {
  e2e = await runE2E()
}

async function runE2E() {
  const pg = (await import('pg')).default
  const { buildCases, runCase } = await import('./e2e.mjs')
  const url = process.env['PG_PRIME_TEST_URL']
  const opts = { connectionString: url, max: 4 }
  // Two pools, identical options: one under the driver, one raw. Same database, same settings,
  // one process (design/08 §5).
  const ormPool = new pg.Pool(opts)
  const rawPool = new pg.Pool(opts)
  const driver = api.pgDriver({ pool: ormPool })
  await driver.init()

  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  await admin.query(fx.drop)
  await admin.query(fx.ddl)
  await admin.query(fx.seed)

  const registry = new api.Registry()
  const conn = await driver.acquire()
  registry.setServerParameters(conn.serverParameters)
  await registry.resolveDynamic(conn, [
    { schema: BENCH_NS, name: 'user_role', kind: 'enum', enumLabels: ['admin', 'owner', 'member'] },
  ])
  await driver.release(conn)

  const db = api.pgPrime({ driver, schema: fx.schema, registry })
  /**
   * The raw side, configured exactly as the driver configures itself.
   *
   * `pg` runs its own type parsers by default even in `rowMode: 'array'` — `timestamptz` arrives as
   * a `Date`, `bool` as a boolean — so an unconfigured raw pool and our driver would be doing
   * *different* jobs and the ratio would be measuring pg's parser rather than our overhead. The
   * driver neutralises them per query with a `types` value carrying `getTypeParser: () => identity`
   * (`src/driver/pg-adapter.ts` §5.1); the same trick here is what makes the pair a pair, and it is
   * what a hand-written near-raw client that wanted its own mapping would do.
   */
  const rawTypes = []
  rawTypes.getTypeParser = () => (v) => v
  // `types: rawTypes` (an array carrying a getTypeParser, which is what pg wants) picks pg's
  // callback overload in the checker's eyes, so it reads the return as void. At runtime it is a
  // Promise.
  const rawQuery = async (text, values) =>
    // oxlint-disable-next-line typescript/await-thenable -- the overload above erased the Promise
    (await rawPool.query({ text, values, rowMode: 'array', types: rawTypes })).rows

  const version = (await rawQuery('show server_version', []))[0][0]
  const out = []
  try {
    const cases = await buildCases({ db, api, pool: rawPool, rawQuery, rawTypes, ns: BENCH_NS, h })
    for (const c of cases) out.push(await runCase(QUICK ? { ...c, samples: 10, warmup: 3 } : c))
  } finally {
    await admin.query(fx.drop).catch(() => {})
    await admin.end().catch(() => {})
    await driver.destroy().catch(() => {})
    await rawPool.end().catch(() => {})
  }
  return { serverVersion: version, url: url.replace(/:[^:@/]*@/, ':***@'), cases: out }
}

calibs.push(calibrateNow())
const refUs = Math.min(...calibs.map((c) => c.min))
const calibDrift = Math.max(...calibs.map((c) => c.min)) / refUs - 1

// ── gates ────────────────────────────────────────────────────────────────────
const checks = []
const check = (name, measured, limit, { mode = 'max', unit = '', skipped = false } = {}) => {
  if (skipped || measured === null || measured === undefined || Number.isNaN(measured)) {
    checks.push({ name, measured: null, limit, unit, ok: true, skipped: true })
    return
  }
  checks.push({ name, measured, limit, unit, mode, ok: mode === 'min' ? measured >= limit : measured <= limit })
}

const B = budget
const ratio = (us) => us / refUs

// design/03 §1.1, absolute: the emitter has 5x headroom, so it is safe to gate on a clock.
check('compile · emitter p50 (design/03 §1.1)', round(compileResults.heavyEmit.p50, 3), B.compile.emitP50Us, { unit: 'µs' })
// …and the same numbers as ratios, which is what actually keeps 30 % sensitivity on a runner.
check('compile · emitter / reference', round(ratio(compileResults.heavyEmit.p50), 2), B.compile.emitRefRatio)
check('compile · build+compile / reference', round(ratio(compileResults.heavyBuildAndCompile.p50), 2), B.compile.buildAndCompileRefRatio)
check('compile · simple select / reference', round(ratio(compileResults.simpleBuildAndCompile.p50), 2), B.compile.simpleRefRatio)
// design/08 §5: ≥ 200 000 simple selects/sec, scaled by the machine factor for the same reason.
//
// ─── Which statistic, and why it is not the p50 ─────────────────────────────
//
// Both are computed and both are reported; the GATE is on the best-case one, and that is a
// deliberate, measured choice rather than a convenient one.
//
// This is the only *throughput floor* in the file, and a floor is asymmetric in a way a ceiling is
// not: every source of interference on the machine pushes the number down, towards failing, and
// nothing pushes it up. The operation is 4 µs long, so a single scheduler stall inside a 4 000-call
// sample moves that sample by more than the whole budget's headroom. Measured across thirteen runs
// on the reference machine: the p50-derived figure ranged **199 772 – 306 147** — the low end taken
// while `tsc` was rebuilding the package in the same process tree — and the min-derived figure
// ranged **263 548 – 350 116**, with its own low end at load average 24. One of those is a
// measurement of this library and the other is partly a measurement of what else the machine was
// doing.
//
// The minimum is the standard estimator for "how fast can this code go", it is what `calibrate()`
// already uses for the machine reference two sections above and for the same stated reason, and
// more samples do not fix the p50: the 199 772 reading was a *sustained* stall, not an outlier that
// a bigger sample would median away. So the floor is on the min, the p50 stays in the print and in
// `report.json` — both clear design/08 §5's 200 000 on every run but one — and the *regression*
// detectors for this path remain `simpleBytes` and `simpleRefRatio`, which are machine-independent
// and gated tightly. design/09 §3.7's follow-up records this as a deviation.
const simplePerSec = 1e6 / compileResults.simpleBuildAndCompile.p50
const simplePerSecNorm = simplePerSec * (refUs / B._referenceUsOnDesignMachine)
const simplePerSecBest = 1e6 / compileResults.simpleBuildAndCompile.min
const simplePerSecBestNorm = simplePerSecBest * (refUs / B._referenceUsOnDesignMachine)
check('compile · simple selects/sec (machine-normalised, best-case)', Math.round(simplePerSecBestNorm), B.compile.simpleSelectsPerSecond, { mode: 'min', unit: '/s' })

// Machine-independent, so gated tightly (design/08 §5: allocation is where ORM overhead hides).
check('compile · bytes/op, build+compile', compileAlloc.heavyBuildAndCompile.median, B.compile.buildAndCompileBytes, { unit: 'B' })
check('compile · bytes/op, emitter', compileAlloc.heavyEmit.median, B.compile.emitBytes, { unit: 'B' })
check('compile · bytes/op, simple', compileAlloc.simpleBuildAndCompile.median, B.compile.simpleBytes, { unit: 'B' })

// design/03 §1.1's two structural claims, as exact integers.
for (const [which, s] of Object.entries(structure)) {
  check(`structure · ${which}: intermediate SQL strings`, s.intermediateSqlStrings, 0)
  check(`structure · ${which}: joins producing the SQL`, s.joinsProducingTheSql, 1)
  check(`structure · ${which}: binds arrays`, s.bindArrays, 1)
  check(`structure · ${which}: binds array is the one pushed into`, s.bindsArrayIsTheOnePushedInto ? 0 : 1, 0)
}

// design/03 Appendix B: "within 15 % of a hand-written positional mapper". Three oracles, because
// measuring against one turned out to answer a different question — see `hand-mapper.mjs` and
// design/09 §3.7. All three are gated; none is at 1.15, and `budget.json` says why in writing.
check('decode · vs unchecked hand mapper (p50)', round(decodePairs.vsUnchecked.ratioP50, 3), B.decode.ratioVsUncheckedMapperP50)
check('decode · vs same-checks hand mapper (p50)', round(decodePairs.vsChecked.ratioP50, 3), B.decode.ratioVsCheckedMapperP50)
check('decode · rows/sec (machine-normalised)', Math.round((rows.length / (decodePairs.vsUnchecked.a.p50 / 1e6)) * (refUs / B._referenceUsOnDesignMachine)), B.decode.rowsPerSecond, { mode: 'min', unit: '/s' })
// The opt-in builder is gated too. An opt-in fast path with no budget is a fast path that rots.
check('decode · codegen vs unchecked hand mapper (p50)', round(decodePairs.codegenVsUnchecked.ratioP50, 3), B.decode.codegen.ratioVsUncheckedMapperP50)
check('decode · codegen vs same-checks hand mapper (p50)', round(decodePairs.codegenVsChecked.ratioP50, 3), B.decode.codegen.ratioVsCheckedMapperP50)
check('decode · codegen rows/sec (machine-normalised)', Math.round((rows.length / (decodePairs.codegenVsUnchecked.a.p50 / 1e6)) * (refUs / B._referenceUsOnDesignMachine)), B.decode.codegen.rowsPerSecond, { mode: 'min', unit: '/s' })
// …and it must stay FASTER than the default, or the flag is a liability rather than a choice.
check('decode · codegen is faster than the closure tree', round(decodePairs.codegenVsUnchecked.a.p50 / decodePairs.vsUnchecked.a.p50, 3), B.decode.codegen.fractionOfClosureTree)

if (e2e) {
  // Per case, not one line for all nine: the overhead is a roughly constant amount of client-side
  // work per statement, so it is 1.2x of a point select and 1.01x of a relation load, and a single
  // budget would be either meaningless for the cheap cases or red for the expensive ones. Every
  // line still prints design/08 §5's 1.15 / 1.30 beside it.
  for (const c of e2e.cases) {
    const p50 = B.e2e.overheadP50[c.name]
    const p95 = B.e2e.overheadP95[c.name]
    const p99 = B.e2e.overheadP99[c.name]
    if (p50 === undefined || p95 === undefined || p99 === undefined) {
      throw new Error(`bench/runtime: no budget for e2e case "${c.name}" — add one to budget.json`)
    }
    check(`e2e · ${c.name} · p50 orm/raw`, round(c.ratioP50, 3), p50)
    check(`e2e · ${c.name} · p95 orm/raw`, round(c.ratioP95, 3), p95)
    check(`e2e · ${c.name} · p99 orm/raw`, round(c.ratioP99, 3), p99)
  }
}

// ── R9's other half: a budget may not drift past its design number in silence ─
//
// Every gate above compares a MEASUREMENT with a budget. Nothing there notices the other way a
// perf gate dies: someone edits `budget.json`, the run goes green, and the design number quietly
// stops being the target. `_designLinked` names which budget corresponds to which design figure,
// and a budget looser than its design figure has to be listed in `_overDesign` with a reason. That
// makes "loosening a budget is a reviewed change to the JSON with a reason" a gate rather than a
// convention — and the entries that exist today are exactly WS7's two honest misses.
const at = (obj, path) => path.split('.').reduce((o, k) => (o === undefined ? undefined : o[k]), obj)
/** `min` metrics are looser when SMALLER; everything else is looser when larger. */
const LOWER_IS_LOOSER = new Set(['compile.simpleSelectsPerSecond'])
for (const [metric, designKey] of Object.entries(B._designLinked)) {
  if (metric.startsWith('_')) continue
  const budgeted = at(B, metric)
  const designed = design[designKey]
  if (budgeted === undefined || designed === undefined) {
    checks.push({ name: `budget · ${metric} is linked to a design number`, measured: null, limit: designKey, ok: false })
    continue
  }
  // A per-case map (the e2e budgets) is checked entry by entry against the same design figure, so
  // widening one of the nine is as visible as widening a scalar.
  const entries = typeof budgeted === 'object' ? Object.entries(budgeted) : [[metric, budgeted]]
  const justified = Object.prototype.hasOwnProperty.call(B._overDesign, metric)
  const worst = entries.reduce(
    (acc, [, v]) => (LOWER_IS_LOOSER.has(metric) ? Math.min(acc, v) : Math.max(acc, v)),
    LOWER_IS_LOOSER.has(metric) ? Infinity : -Infinity,
  )
  const looser = LOWER_IS_LOOSER.has(metric) ? worst < designed : worst > designed
  checks.push({
    name: `budget · ${metric} vs design (${designed})`,
    measured: worst,
    limit: justified ? `${designed} — waived in _overDesign` : designed,
    ok: !looser || justified,
  })
}

// ── print ────────────────────────────────────────────────────────────────────
function medianOf(xs) {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
function round(n, d = 2) {
  return Number.isFinite(n) ? Number(n.toFixed(d)) : n
}
const fmt = (n, d = 2) => (n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toFixed(d))

console.log(`\npg-prime runtime bench — node ${process.version}, ${process.platform}/${process.arch}`)
console.log(
  `reference workload: ${fmt(refUs, 4)} µs/call (reference machine ${B._referenceUsOnDesignMachine} µs; ` +
    `this machine is ${fmt(refUs / B._referenceUsOnDesignMachine, 2)}x its speed), ` +
    `spread across the three calibrations ${fmt(calibDrift * 100, 1)} %`,
)
if (compileAlloc.heavyEmit.exact !== true) {
  console.log('NOTE  run with `node --expose-gc` for exact allocation numbers; these are batch medians.')
}
// `bytesPerOp` sizes its batch from a probe and re-measures at a quarter of it; a disagreement
// means a scavenge ran inside the batch and the number is a floor rather than a measurement.
// Printing that is what stops a floor being read as a measurement (see sampler.mjs).
const GATED_ALLOC = new Set(['heavyBuildAndCompile', 'heavyEmit', 'simpleBuildAndCompile'])
for (const [k, a] of Object.entries(compileAlloc)) {
  if (a.stable !== true) {
    console.log(
      `NOTE  bytes/op for \`${k}\` did not reproduce at a quarter batch — treat it as a floor` +
        `${GATED_ALLOC.has(k) ? '' : ' (reported, not gated)'}.`,
    )
  }
}

console.log('\n── compile ──────────────────────────────────────────────────────────────')
for (const [k, r] of Object.entries(compileResults)) {
  console.log(
    `  ${k.padEnd(24)} p50 ${fmt(r.p50, 3).padStart(9)} µs   p95 ${fmt(r.p95, 3).padStart(9)}   ` +
      `p99 ${fmt(r.p99, 3).padStart(9)}   min ${fmt(r.min, 3).padStart(9)}   ` +
      `(${r.samples}x${r.iters})   ${String(compileAlloc[k].median).padStart(6)} B/op`,
  )
}
console.log(
  `  simple selects/sec       ${Math.round(simplePerSecBestNorm).toLocaleString('en-US')} best-case, machine-normalised ` +
    `(gated, budget ${B.compile.simpleSelectsPerSecond.toLocaleString('en-US')}) · ` +
    `${Math.round(simplePerSecNorm).toLocaleString('en-US')} from the p50 · ` +
    `${Math.round(simplePerSec).toLocaleString('en-US')} raw p50`,
)
console.log('  bytes per compile, by source (reported, never gated — see `allocBySource`)')
for (const [k, v] of [
  ['builder chain (`.toAst()`)', allocBySource.builderChain],
  ['LATERAL planner (by difference)', allocBySource.planner],
  ['emitter (`compile(ast)`)', allocBySource.emitter],
]) {
  console.log(
    `    ${k.padEnd(34)} ${String(v).padStart(7)} B   ${fmt((v / allocBySource.total) * 100, 1).padStart(5)} %`,
  )
}

console.log('\n── structure (design/03 §1.1) ───────────────────────────────────────────')
for (const [which, s] of Object.entries(structure)) {
  console.log(
    `  ${which.padEnd(8)} chunks ${String(s.chunkCount).padStart(5)} → 1 join('')   ` +
      `binds ${String(s.binds).padStart(3)} in ${s.bindArrays} array, identity ${s.bindsArrayIsTheOnePushedInto ? 'held' : 'LOST'}   ` +
      `intermediate SQL strings ${s.intermediateSqlStrings}   (all joins: ${JSON.stringify(s.joinsBySeparator)})`,
  )
  if (s.intermediateSqlStrings > 0) console.log(`           ${JSON.stringify(s.intermediateSample)}`)
}

console.log(`\n── decode (${rows.length.toLocaleString('en-US')} rows x ${DECODE_KEYS.length} cols) ─────────────────────────────────`)
const DECODE_LABELS = {
  vsUnchecked: 'closure · vs hand mapper, unchecked  (Appendix B)',
  vsChecked: 'closure · vs hand mapper, same checks (dispatch)',
  dispatchOnly: 'closure · vs literal-object copy, identity (row loop)',
  codegenVsUnchecked: 'codegen · vs hand mapper, unchecked  (Appendix B)',
  codegenVsChecked: 'codegen · vs hand mapper, same checks (dispatch)',
  codegenDispatchOnly: 'codegen · vs literal-object copy, identity (row loop)',
}
console.log(`  ${'pair'.padEnd(50)} ${'decoder'.padStart(9)} ${'mapper'.padStart(9)} ${'p50 ×'.padStart(7)} ${'p95 ×'.padStart(7)}`)
for (const [k, r] of Object.entries(decodePairs)) {
  console.log(
    `  ${DECODE_LABELS[k].padEnd(50)} ${fmt(r.a.p50, 2).padStart(9)} ${fmt(r.b.p50, 2).padStart(9)} ` +
      `${fmt(r.ratioP50, 3).padStart(7)} ${fmt(r.a.p95 / r.b.p95, 3).padStart(7)}   (µs)`,
  )
}
const perSec = (us) => (rows.length / (us / 1e6)).toLocaleString('en-US', { maximumFractionDigits: 0 })
const cellsPerSec = (us) =>
  ((rows.length * DECODE_KEYS.length) / (us / 1e6)).toLocaleString('en-US', { maximumFractionDigits: 0 })
console.log(
  `  closure ${perSec(decodePairs.vsUnchecked.a.p50)} rows/sec · ${cellsPerSec(decodePairs.vsUnchecked.a.p50)} cells/sec` +
    `   codegen ${perSec(decodePairs.codegenVsUnchecked.a.p50)} rows/sec · ${cellsPerSec(decodePairs.codegenVsUnchecked.a.p50)} cells/sec`,
)

console.log('\n── end-to-end vs raw pg (design/08 §5) ──────────────────────────────────')
if (e2e === null) {
  console.log(`  SKIPPED — ${e2eSkipped}`)
} else {
  console.log(`  server ${e2e.serverVersion} at ${e2e.url}`)
  console.log(
    `  ${'case'.padEnd(36)} ${'orm p50'.padStart(9)} ${'raw p50'.padStart(9)} ${'p50 ×'.padStart(7)} ` +
      `${'p95 ×'.padStart(7)} ${'p99 ×'.padStart(7)} ${'Δ p50'.padStart(8)}`,
  )
  for (const c of e2e.cases) {
    console.log(
      `  ${c.name.padEnd(36)} ${fmt(c.a.p50, 3).padStart(9)} ${fmt(c.b.p50, 3).padStart(9)} ` +
        `${fmt(c.ratioP50, 3).padStart(7)} ${fmt(c.ratioP95, 3).padStart(7)} ${fmt(c.ratioP99, 3).padStart(7)} ` +
        `${`+${fmt(c.a.p50 - c.b.p50, 3)}`.padStart(8)}   (ms)`,
    )
  }
}

// ── the three-way print (R9): design / measured / budget ─────────────────────
const threeWay = [
  ['compile, 12-col + 2 joins + 1 relation (emitter)', `${design.compileUs} µs`, `${fmt(compileResults.heavyEmit.p50, 2)} µs`, `${B.compile.emitP50Us} µs`],
  ['compile, the same, from the builder chain', `${design.compileUs} µs`, `${fmt(compileResults.heavyBuildAndCompile.p50, 2)} µs`, `${fmt(B.compile.buildAndCompileRefRatio * refUs, 1)} µs @ ${fmt(refUs, 3)}`],
  ['simple selects / sec (best-case, gated)', `${design.simpleSelectsPerSecond.toLocaleString('en-US')}`, Math.round(simplePerSecBestNorm).toLocaleString('en-US'), B.compile.simpleSelectsPerSecond.toLocaleString('en-US')],
  ['simple selects / sec (from the p50)', `${design.simpleSelectsPerSecond.toLocaleString('en-US')}`, Math.round(simplePerSecNorm).toLocaleString('en-US'), 'reported'],
  ['intermediate SQL strings', String(design.intermediateSqlStrings), String(structure.heavy.intermediateSqlStrings), '0'],
  ['params array allocations', String(design.bindsArrays), String(structure.heavy.bindArrays), '1'],
  ['decode 10k x 12 / hand mapper, unchecked', `${design.decodeRatio}`, fmt(decodePairs.vsUnchecked.ratioP50, 3), `${B.decode.ratioVsUncheckedMapperP50}`],
  ['decode 10k x 12 / hand mapper, same checks', `${design.decodeRatio}`, fmt(decodePairs.vsChecked.ratioP50, 3), `${B.decode.ratioVsCheckedMapperP50}`],
  ['decode row loop / literal-object copy', `${design.decodeRatio}`, fmt(decodePairs.dispatchOnly.ratioP50, 3), 'reported'],
  ['  …codegen / hand mapper, unchecked', `${design.decodeRatio}`, fmt(decodePairs.codegenVsUnchecked.ratioP50, 3), `${B.decode.codegen.ratioVsUncheckedMapperP50}`],
  ['  …codegen / hand mapper, same checks', `${design.decodeRatio}`, fmt(decodePairs.codegenVsChecked.ratioP50, 3), `${B.decode.codegen.ratioVsCheckedMapperP50}`],
  ['  …codegen row loop / literal-object copy', `${design.decodeRatio}`, fmt(decodePairs.codegenDispatchOnly.ratioP50, 3), 'reported'],
  ['e2e overhead p50 (nine cases, worst)', `${design.e2eP50}`, e2e ? fmt(Math.max(...e2e.cases.map((c) => c.ratioP50)), 3) : 'skipped', 'per case'],
  ['e2e overhead p50 (nine cases, median)', `${design.e2eP50}`, e2e ? fmt(medianOf(e2e.cases.map((c) => c.ratioP50)), 3) : 'skipped', 'per case'],
  ['e2e overhead p95 (nine cases, worst)', `${design.e2eP99}`, e2e ? fmt(Math.max(...e2e.cases.map((c) => c.ratioP95)), 3) : 'skipped', 'per case'],
  ['e2e overhead p99 (nine cases, worst)', `${design.e2eP99}`, e2e ? fmt(Math.max(...e2e.cases.map((c) => c.ratioP99)), 3) : 'skipped', 'per case'],
]
console.log('\n  metric                                                 design      here      budget')
for (const [name, d, here, lim] of threeWay) {
  console.log(`  ${name.padEnd(50)} ${String(d).padStart(10)} ${String(here).padStart(9)} ${String(lim).padStart(11)}`)
}

console.log('')
for (const c of checks) {
  console.log(
    `${c.skipped ? 'SKIP' : c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(52)} ` +
      `${String(c.measured ?? '—').padStart(11)}${c.unit ?? ''}  ${c.mode === 'min' ? 'floor' : 'budget'} ${c.limit}`,
  )
}

const CAVEATS = [...(B._caveats ?? [])]
if (e2e === null) CAVEATS.push(`end-to-end skipped: ${e2eSkipped}`)
if (QUICK) CAVEATS.push('--quick: 1 000 decode rows and a quarter of the samples. Numbers are indicative and NOTHING is gated.')
// Only the MINIMUM of the three calibrations is used, so an ordinary spread (the last one runs on
// a heap that held 10 000 decoded rows a moment ago, and reads ~50 % slow even after a `gc()`) is
// not a problem and must not cry wolf. A spread this large means something took the CPU away for a
// while, which is worth saying only when it is big enough to have plausibly touched the minimum too.
if (calibDrift > 1.0) {
  CAVEATS.push(
    `the three calibrations spread by ${fmt(calibDrift * 100, 0)} % (fastest ${fmt(refUs, 3)} µs) — something ` +
      'else was using this machine; re-run on an idle one before trusting a FAIL on a ratio line.',
  )
}
for (const c of CAVEATS) console.log(`\nNOTE  ${c}`)

const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  quick: QUICK,
  compileOnly: COMPILE_ONLY,
  calibration: { samples: calibs, referenceUs: refUs, driftFraction: calibDrift },
  compile: {
    timing: compileResults,
    allocation: compileAlloc,
    allocBySource,
    simplePerSec,
    simplePerSecNorm,
    simplePerSecBest,
    simplePerSecBestNorm,
  },
  structure,
  decode: { rows: rows.length, columns: DECODE_KEYS.length, pairs: decodePairs },
  e2e: e2e ?? { skipped: e2eSkipped },
  budget,
  checks,
  caveats: CAVEATS,
  ok: checks.every((c) => c.ok),
}
writeFileSync(join(HERE, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(`\n${report.ok ? 'OK' : 'BUDGET BREACH'} — report → ${join(HERE, 'report.json')}`)

if (GATE && !report.ok) process.exit(1)
