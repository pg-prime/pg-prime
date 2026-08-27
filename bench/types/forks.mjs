// WS0 (design/09 §3.0) — decide the three design/03-vs-design/04 API forks by measurement.
//
//   node bench/types/forks.mjs [--quick] [--repeats N]
//
// Four arms, each a complete query surface differing from the design/04 baseline in exactly one
// fork (see packages/pg-prime/src/query/forks/*.ts):
//
//   base04    04 §2 as written — free-function operators, nest() required, relations on a 2nd param
//   f1        03 §2.9 — operators are METHODS ON REFS, gated by the column's type class
//   f2        03 §2.2 — BARE NESTED LITERALS in a projection are grouping (no nest())
//   f3        03 §2.3 — relation accessors live ON THE TABLE SCOPE, not on a second parameter
//
// All four are FROZEN minimal deltas over `base04`; that is the only way the deltas mean anything.
// A fifth row, `decided`, is the live shipped surface — informational here, and gated for real by
// run.mjs against budget.json. It started life as the F3 arm (at WS0 the two were the same file);
// WS1 split them, because five WS1 features were otherwise being charged to a WS0 fork. See
// arms/f3-scope.ts.
//
// Three query shapes, matching design/04 §3.5's three per-query budget lines one-for-one.
//
// The gated metric is run.mjs's: `(instantiations at 2U queries − at U queries) / U`, at a FIXED
// schema size over a FIXED distinct-table span, so every fixed cost — schema declaration, row
// shapes, the one-time O(tables) schema-registry materialisation, first touch of each distinct
// table — cancels exactly. See run.mjs's header for why differencing against a 0-query baseline
// does not work.
//
// Decision rule (design/09 §3 WS0): an arm is admissible only if all three per-query budgets
// (1500 / 2000 / 2750) hold at 300 tables on BOTH compilers with a 300t/25t ratio ≤ 1.15. Among
// admissible arms prefer, in order: schema-size-flat, fewer instantiations, smaller .d.ts, DX.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARMS, generate } from './gen.mjs'
import { COMPILERS, measure } from './tsc.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const argv = process.argv.slice(2)
const QUICK = argv.includes('--quick')
const REPEATS = argv.includes('--repeats') ? Number(argv[argv.indexOf('--repeats') + 1]) : 1

/** Query counts for the marginal pair. Smaller than run.mjs's 50 because a real query costs ~40× a query-shaped type usage. */
const U = 25
/** Distinct tables the queries touch — held constant across every schema size. */
const DISTINCT = 25
const SIZES = QUICK ? [25, 100] : [25, 100, 300]
const SHAPES = [1, 2, 3, 4]
const ARM_NAMES = ['base04', 'f1', 'f2', 'f3']
/** Measured and printed alongside the arms, but never part of an admissibility verdict. */
const LIVE = 'decided'

const budget = JSON.parse(readFileSync(join(HERE, 'budget.json'), 'utf8'))
// WS1 moved these three out of `budget._notGatedHere` into the gated set (design/09 §3.1), so
// they are read from the top level now. The admissibility rule they encode is unchanged.
const PER_QUERY = {
  1: budget.instantiationsPerDistinctQuerySimpleSelect,
  2: budget.instantiationsPerDistinctQueryJoinAggSqlNest,
  3: budget.instantiationsPerDistinctQueryWithRelationProjection,
  // Diagnostic shape — design/04 §3.5 has no budget line for it, so it is measured and printed
  // but never decides admissibility.
  4: null,
}
const SHAPE_LABEL = {
  1: 'simple select (4 cols, 1 where)',
  2: 'join + aggregate + sql + nest',
  3: 'select + relation projection',
  4: 'where with 6 class-specific operators  [diagnostic]',
}
const RATIO = budget.schemaSizeIndependenceRatio

// ── measure ──────────────────────────────────────────────────────────────────

const results = {}
const record = (name, scenario) => {
  const dir = generate({ name, ...scenario })
  const row = {}
  for (const [version, tsc] of Object.entries(COMPILERS)) {
    row[version] = measure(tsc, dir, scenario.repeats ?? REPEATS)
  }
  results[name] = row
  console.log(
    `${name.padEnd(18)} ` +
      Object.entries(row)
        .map(([v, r]) => `ts${v} inst=${String(r.instantiations).padStart(7)} check=${r.checkTime.toFixed(3)}s`)
        .join('  '),
  )
  return row
}

for (const arm of [...ARM_NAMES, LIVE, 'plain']) {
  for (const shape of SHAPES) {
    for (const t of SIZES) {
      for (const mult of [1, 2]) {
        record(`${arm}-s${shape}-t${t}-u${mult * U}`, {
          tables: t,
          cols: 12,
          rels: 2,
          rows: true,
          usages: 0,
          queries: { arm, shape, count: mult * U, distinct: DISTINCT },
        })
      }
    }
  }
}

// Declaration cost of the ref surface — the other half of F1's trade. Slope over table count, so
// the fixed per-program cost cancels; every column of every table is touched, because a mapped
// type's property types are computed lazily and an untouched ref record costs almost nothing.
for (const arm of ['base04', 'plain', 'f1']) {
  for (const t of [25, 100]) {
    record(`refs-${arm}-t${t}`, { tables: t, cols: 12, rels: 2, rows: false, usages: 0, refs: arm })
  }
}

// Whole-program totals. The per-query metric answers "what does one more query cost"; it does
// NOT answer "which arm makes a real codebase cheaper", because F1 trades a per-query saving for
// a per-table one-time cost and the exchange rate is the queries-per-table ratio. This is
// design/04 §3.5's headline scenario — 100 tables, all three row shapes, 200 queries — run on
// each arm, with the three shapes mixed.
// F1 trades a per-query saving against a per-TABLE one-time cost, so its verdict depends on the
// queries-per-table ratio of the codebase. Two programs, same 200 queries: `wide` spreads them
// over 100 tables (2 per table, design/04 §3.5's headline shape), `dense` over 25 (8 per table).
const PROGRAMS = {
  wide: { tables: 100, distinct: 100 },
  dense: { tables: 25, distinct: 25 },
}
for (const [program, p] of Object.entries(PROGRAMS)) {
  for (const arm of [...ARM_NAMES, LIVE, 'plain']) {
    record(`${program}-${arm}`, {
      tables: p.tables,
      cols: 12,
      rels: 2,
      rows: true,
      usages: 0,
      queries: { arm, shape: 'mix', count: 200, distinct: p.distinct },
      repeats: 3,
    })
  }
}

// Method self-check: the marginal must be the SAME between U→2U and 2U→3U. If it is not, the
// per-query cost is not linear in the query count and differencing two points does not measure
// it. Run on the most expensive shape, where a nonlinearity would show first.
record(`base04-s3-t100-u${3 * U}`, {
  tables: 100,
  cols: 12,
  rels: 2,
  rows: true,
  usages: 0,
  queries: { arm: 'base04', shape: 3, count: 3 * U, distinct: DISTINCT },
})

// ── .d.ts size, per arm ──────────────────────────────────────────────────────
// One `tsc -p` over the real package with declaration emit; the arms are separate modules, so
// their sizes fall out of a single compile.
const DTS_OUT = join(HERE, '.gen', '.dts')
rmSync(DTS_OUT, { recursive: true, force: true })
mkdirSync(DTS_OUT, { recursive: true })
execFileSync(
  process.execPath,
  [COMPILERS['5.9.3'], '-p', join(ROOT, 'packages', 'pg-prime', 'tsconfig.json'), '--outDir', DTS_OUT, '--emitDeclarationOnly', '--pretty', 'false'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
)
// The arms live in `bench/types/arms/`, outside the package, so the method-table arm needs its
// own emit to be weighed against the shipped free-function one.
execFileSync(
  process.execPath,
  [
    COMPILERS['5.9.3'], join(HERE, 'arms', 'f1-ops-methods.ts'), join(HERE, 'arms', 'f1-ops-free.ts'),
    '--declaration', '--emitDeclarationOnly', '--outDir', join(DTS_OUT, 'arms'),
    '--target', 'es2023', '--module', 'nodenext', '--moduleResolution', 'nodenext',
    '--strict', '--skipLibCheck', '--pretty', 'false',
  ],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
)
const bytes = (...p) => {
  try {
    return statSync(join(DTS_OUT, ...p)).size
  } catch {
    return null
  }
}
// Only F1 changes the published surface in a way worth counting, and the honest comparison is
// the operator vocabulary against itself: `ops-free.d.ts` and `f1-ops-methods.d.ts` hold the same
// ~60 operators in the two spellings. BOTH arms are frozen in `bench/types/arms/` as of WS3 —
// the shipped `src/query/ops.ts` has grown gates, exact result codecs and eleven more operators,
// so weighing it against the arm would stop measuring the fork. The `*-methods.d.ts` / `f2-bare.d.ts` / `f3-scope.d.ts`
// scaffolding is bench-only duplication of the query surface — in a real implementation the
// winning arm REPLACES the core — so it is reported but never differenced.
const dts = {
  querySurface: bytes('query', 'types.d.ts'),
  opsFree: bytes('arms', 'bench', 'types', 'arms', 'f1-ops-free.d.ts') ?? bytes('arms', 'f1-ops-free.d.ts'),
  opsMethods: bytes('arms', 'bench', 'types', 'arms', 'f1-ops-methods.d.ts') ?? bytes('arms', 'f1-ops-methods.d.ts'),

}

// ── derive ───────────────────────────────────────────────────────────────────

const I = (name, v) => results[name]?.[v]?.instantiations
const round = (n, d = 2) => (n === undefined || Number.isNaN(n) || !Number.isFinite(n) ? null : Number(n.toFixed(d)))

const derived = {}
for (const arm of [...ARM_NAMES, LIVE, 'plain']) {
  derived[arm] = { label: ARMS[arm].label, shapes: {} }
  for (const shape of SHAPES) {
    const per = {}
    for (const v of Object.keys(COMPILERS)) {
      const marginal = {}
      for (const t of SIZES) marginal[t] = (I(`${arm}-s${shape}-t${t}-u${2 * U}`, v) - I(`${arm}-s${shape}-t${t}-u${U}`, v)) / U
      per[v] = {
        marginal: Object.fromEntries(SIZES.map((t) => [t, round(marginal[t], 1)])),
        ratio100: round(marginal[100] / marginal[25], 3),
        ratio300: round(marginal[300] / marginal[25], 3),
        budget: PER_QUERY[shape],
        withinBudget: PER_QUERY[shape] === null || marginal[SIZES[SIZES.length - 1]] <= PER_QUERY[shape],
        flat: (marginal[300] ?? marginal[100]) / marginal[25] <= RATIO,
      }
    }
    derived[arm].shapes[shape] = per
  }
  derived[arm].admissible = SHAPES.filter((s) => PER_QUERY[s] !== null).every((s) =>
    Object.keys(COMPILERS).every((v) => derived[arm].shapes[s][v].withinBudget && derived[arm].shapes[s][v].flat),
  )
}

// Per-table cost of materialising a table's whole ref surface.
const refsPerTable = {}
for (const arm of ['base04', 'plain', 'f1']) {
  refsPerTable[arm] = {}
  for (const v of Object.keys(COMPILERS)) {
    refsPerTable[arm][v] = round((I(`refs-${arm}-t100`, v) - I(`refs-${arm}-t25`, v)) / 75, 1)
  }
}

const linearity = {}
for (const v of Object.keys(COMPILERS)) {
  const first = (I(`base04-s3-t100-u${2 * U}`, v) - I(`base04-s3-t100-u${U}`, v)) / U
  const second = (I(`base04-s3-t100-u${3 * U}`, v) - I(`base04-s3-t100-u${2 * U}`, v)) / U
  linearity[v] = { firstInterval: round(first, 1), secondInterval: round(second, 1), linear: first === second }
}

// ── print ────────────────────────────────────────────────────────────────────

console.log('\n── method self-check: is the per-query cost linear in the query count? ──────')
for (const [v, l] of Object.entries(linearity)) {
  console.log(
    `  ts${v.padEnd(8)}U→2U ${String(l.firstInterval).padStart(6)}   2U→3U ${String(l.secondInterval).padStart(6)}   ` +
      `${l.linear ? 'linear' : 'NOT LINEAR — differencing does not measure a per-query cost'}`,
  )
}

console.log('\n── marginal instantiations per distinct query ───────────────────────────────')
for (const shape of SHAPES) {
  console.log(`\nshape ${shape}: ${SHAPE_LABEL[shape]}   budget ${PER_QUERY[shape] ?? '—'}`)
  console.log(
    `  ${'arm'.padEnd(8)}${'ts'.padEnd(8)}` +
      SIZES.map((t) => `${t}t`.padStart(10)).join('') +
      `${'ratio'.padStart(10)}${'  verdict'}`,
  )
  for (const arm of [...ARM_NAMES, LIVE, 'plain']) {
    for (const v of Object.keys(COMPILERS)) {
      const d = derived[arm].shapes[shape][v]
      const ratio = d.ratio300 ?? d.ratio100
      const ok = d.withinBudget && d.flat
      console.log(
        `  ${arm.padEnd(8)}${v.padEnd(8)}` +
          SIZES.map((t) => String(d.marginal[t]).padStart(10)).join('') +
          `${String(ratio).padStart(10)}  ${PER_QUERY[shape] === null ? (d.flat ? '—' : 'NOT FLAT') : ok ? 'ok' : d.withinBudget ? 'NOT FLAT' : 'OVER BUDGET'}`,
      )
    }
  }
}

// This is NOT `instantiationsPerTableDeclaration` (that budget covers `pgTable(...)` alone, and
// run.mjs measures it at 36). It is the cost of materialising all 12 ref property types for a
// table, which is what fork F1's intersection lands on — reported as a slope, and as the delta
// between the arms, which is the only number the decision needs.
console.log('\n── cost of materialising a table\'s full ref surface (slope over table count) ──')
console.log(`  ${'ts'.padEnd(8)}${'base'.padStart(8)}${'plain'.padStart(8)}${'f1'.padStart(8)}   what the methods themselves cost`)
for (const v of Object.keys(COMPILERS)) {
  const b = refsPerTable.base04[v]
  const p = refsPerTable.plain[v]
  const f = refsPerTable.f1[v]
  console.log(
    `  ${v.padEnd(8)}${String(b).padStart(8)}${String(p).padStart(8)}${String(f).padStart(8)}   ` +
      `+${round(f - p, 1)} / table (f1 − plain); rebuilding the record alone is +${round(p - b, 1)}`,
  )
}

for (const [program, p] of Object.entries(PROGRAMS)) {
  console.log(
    `\n── whole program '${program}': ${p.tables} tables, all row shapes, 200 mixed queries ` +
      `(${(200 / p.distinct).toFixed(0)} per table) ──`,
  )
  for (const arm of [...ARM_NAMES, LIVE, 'plain']) {
    for (const v of Object.keys(COMPILERS)) {
      const r = results[`${program}-${arm}`][v]
      const base = results[`${program}-base04`][v].instantiations
      const delta = arm === 'base04' ? '' : `  ${r.instantiations > base ? '+' : ''}${round(((r.instantiations - base) / base) * 100, 1)}% vs base`
      console.log(
        `  ${arm.padEnd(8)}ts${v.padEnd(8)}inst=${String(r.instantiations).padStart(7)}  ` +
          `check=${r.checkTime.toFixed(3)}s  mem=${String(r.memoryMb).padStart(4)}MB${delta}`,
      )
    }
  }
}

console.log('\n── emitted .d.ts bytes ──────────────────────────────────────────────────────')
console.log(`  shared query surface (types.d.ts)          ${String(dts.querySurface).padStart(7)}B`)
console.log(`  F1 arm A  operators as free functions     ${String(dts.opsFree).padStart(7)}B`)
console.log(`  F1 arm B  operators as ref methods        ${String(dts.opsMethods).padStart(7)}B` +
  `   (${dts.opsMethods > dts.opsFree ? '+' : ''}${round(((dts.opsMethods - dts.opsFree) / dts.opsFree) * 100, 1)}%)`)


console.log('\n── F1 with the rebuild artifact removed: f1 − plain, per program ────────────')
const f1Corrected = {}
for (const program of Object.keys(PROGRAMS)) {
  f1Corrected[program] = {}
  for (const v of Object.keys(COMPILERS)) {
    const b = results[`${program}-base04`][v].instantiations
    const pl = results[`${program}-plain`][v].instantiations
    const f = results[`${program}-f1`][v].instantiations
    f1Corrected[program][v] = { methods: f - pl, methodsPct: round(((f - pl) / pl) * 100, 1), artifact: pl - b }
    console.log(
      `  ${program.padEnd(8)}ts${v.padEnd(8)}methods ${String(f - pl).padStart(6)} ` +
        `(${round(((f - pl) / pl) * 100, 1)}%)   rebuild artifact ${String(pl - b).padStart(6)} ` +
        `(${round(((pl - b) / b) * 100, 1)}%, not part of the fork)`,
    )
  }
}

console.log('\n── admissibility (shapes 1-3; shape 4 has no budget line) ────────────────────────────────────────────────────────────')
for (const arm of ARM_NAMES) {
  console.log(`  ${arm.padEnd(8)}${derived[arm].admissible ? 'ADMISSIBLE' : 'INADMISSIBLE'}  ${derived[arm].label}`)
}

const report = {
  node: process.version,
  compilers: Object.keys(COMPILERS),
  method: {
    marginal: '(instantiations at 2U queries − at U queries) / U, at a fixed schema size and a fixed 25-table distinct span',
    queriesPerScenario: U,
    distinctTablesTouched: DISTINCT,
    sizes: SIZES,
    oracle:
      'every generated file asserts its first query\'s result type with a strict Eq<…>; an arm whose inference degraded to `any` fails to compile rather than measuring cheap',
  },
  budgets: { perQuery: PER_QUERY, ratio: RATIO, perTableDeclaration: budget.instantiationsPerTableDeclaration },
  results,
  derived,
  refsPerTable,
  dts,
  linearity,
  f1Corrected,
}
writeFileSync(join(HERE, 'forks.report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(`\nreport → ${join(HERE, 'forks.report.json')}`)
