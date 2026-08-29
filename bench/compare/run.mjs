// design/08 §5's comparison run: the nine end-to-end cases against `drizzle-orm` and `kysely`,
// on the same PostgreSQL, through the SAME `pg` pool, in one interleaved process.
//
//   PG_PRIME_TEST_URL=postgres://… node bench/compare/run.mjs
//   …--quick   a tenth of the samples, for a local look. Never used in CI.
//
// ─── What this is, and what it deliberately is not ──────────────────────────
//
// It is NOT a gate. `08` §5 gates `bench/runtime`'s ratio against raw `pg`, because that ratio is
// a statement about *our* overhead and nothing else. This measures four libraries against each
// other, which is a statement about four libraries and about the machine they ran on — useful,
// publishable, and the wrong shape for a budget. So it prints a table into
// `$GITHUB_STEP_SUMMARY`, writes `report.json`, and always exits 0 unless it could not run at all.
//
// It reports ABSOLUTE p50 and p99 as well as ratios, because `08` §5 is explicit that "a ratio
// without absolutes is marketing".
//
// ─── About Prisma ───────────────────────────────────────────────────────────
//
// `08` §5 names `@prisma/client` too, and design/12 §4 P says to include it "only if its
// generate/engine step fits in the nightly budget — record either way". It is NOT included, and
// the measurement that decided it is in `PRISMA.md` beside this file. The short version: Prisma's
// client does not exist until `prisma generate` has run against a `schema.prisma`, that step
// downloads and links a platform-specific query engine, and the result is a build artifact that
// would have to be produced inside the nightly before the first query. Measured here, install +
// generate is minutes, not seconds, and it is the only arm that would need a network fetch at job
// time. The anti-target in `08` §5 is Prisma's published ~11x average / ~27x p99; that number
// stands in the design document with its source, and re-measuring it is not worth making the
// nightly depend on an engine download.

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BENCH_NS, loadPackage } from '../runtime/cases.mjs'
import { buildCases, checkAnswer } from './cases.mjs'
import { drizzleSchema, kyselyNames } from './schema.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const QUICK = argv.includes('--quick')

const url = process.env['PG_PRIME_TEST_URL']
if (url === undefined) {
  console.error(
    'bench/compare needs PG_PRIME_TEST_URL. It is a comparison against a real server; PGlite is a ' +
      'WASM build behind an in-process bridge and its absolute latencies are not PostgreSQL ' +
      'numbers (bench/runtime/e2e.mjs says the same thing at more length).',
  )
  process.exit(2)
}

// Production mode for the same reason `bench/runtime/run.mjs` does it: `07` §7.4's call-site
// capture and `07` §1.5's dev guard are on outside production, and comparing our development
// configuration with another library's only configuration is not a comparison.
process.env['NODE_ENV'] = 'production'

const pg = (await import('pg')).default
const { drizzle: makeDrizzle } = await import('drizzle-orm/node-postgres')
const { Kysely, PostgresDialect } = await import('kysely')

const { api, fixture } = await loadPackage({})
const fx = fixture.makeFixture(BENCH_NS)
const h = fx.schema.h

// ONE pool. Four identical pools would be four queues with four `max`es; sharing removes the last
// difference between the arms that is not the library under test.
const pool = new pg.Pool({ connectionString: url, max: 8 })

const admin = new pg.Client({ connectionString: url })
await admin.connect()
await admin.query(fx.drop)
await admin.query(fx.ddl)
await admin.query(fx.seed)
const serverVersion = (await admin.query('show server_version')).rows[0]['server_version']

const rawQuery = async (text, values) => (await pool.query({ text, values })).rows

const driver = api.pgDriver({ pool })
await driver.init()
const registry = new api.Registry()
const conn = await driver.acquire()
registry.setServerParameters(conn.serverParameters)
await registry.resolveDynamic(conn, [
  { schema: BENCH_NS, name: 'user_role', kind: 'enum', enumLabels: ['admin', 'owner', 'member'] },
])
await driver.release(conn)
const prime = api.pgPrime({ driver, schema: fx.schema, registry })

const dz = drizzleSchema(BENCH_NS)
const drizzle = makeDrizzle(pool, { schema: dz.schema })
const kn = kyselyNames(BENCH_NS)
const kysely = new Kysely({ dialect: new PostgresDialect({ pool }) })

const ARMS = ['raw', 'pg-prime', 'drizzle', 'kysely']
const percentile = (xs, p) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]

/**
 * All four arms, round-robin, one sample each.
 *
 * Not four sequential loops: a machine that slows down between the first arm and the fourth
 * reports the slowdown as "kysely is 20 % slower", which is the failure `sampler.mjs` describes
 * for the pairs and which is worse here because there are four of them.
 */
async function runCase(c, divergences) {
  const names = ARMS.filter((a) => c.arms[a] !== undefined)
  const want = await c.arms['pg-prime']()
  for (const name of names) {
    const got = await c.arms[name]()
    const [g, w] =
      c.compare === 'count'
        ? [Array.isArray(got) ? got.length : got, Array.isArray(want) ? want.length : want]
        : [got, want]
    const d = checkAnswer(c.name, name, g, w, c.knownDivergences)
    if (d !== undefined) divergences.push(d)
  }

  const iters = c.iters ?? 1
  const samples = QUICK ? Math.max(4, Math.round((c.samples ?? 60) / 10)) : (c.samples ?? 60)
  const series = Object.fromEntries(names.map((n) => [n, []]))
  for (let i = 0; i < (QUICK ? 2 : 10); i++) for (const n of names) await c.arms[n]()
  for (let s = 0; s < samples; s++) {
    for (const n of names) {
      const t0 = performance.now()
      for (let i = 0; i < iters; i++) await c.arms[n]()
      series[n].push((performance.now() - t0) / iters)
    }
  }
  const stats = {}
  for (const n of names) {
    const xs = series[n].sort((a, b) => a - b)
    stats[n] = {
      p50: percentile(xs, 50),
      p95: percentile(xs, 95),
      p99: percentile(xs, 99),
      min: xs[0],
    }
  }
  return { name: c.name, iters, samples, arms: stats }
}

const results = []
const divergences = []
try {
  const cases = await buildCases({
    ns: BENCH_NS,
    pool,
    rawQuery,
    prime,
    h,
    api,
    drizzle,
    dz,
    kysely,
    kn,
  })
  for (const c of cases) results.push(await runCase(c, divergences))
} finally {
  await kysely.destroy().catch(() => {})
  await driver.destroy().catch(() => {})
  await admin.query(fx.drop).catch(() => {})
  await admin.end().catch(() => {})
  await pool.end().catch(() => {})
}

// ── the table ────────────────────────────────────────────────────────────────
const versions = {
  node: process.version,
  'pg-prime': JSON.parse(
    readFileSync(join(HERE, '..', '..', 'packages', 'pg-prime', 'package.json'), 'utf8'),
  ).version,
  ...Object.fromEntries(
    ['drizzle-orm', 'kysely', 'pg'].map((p) => [
      p,
      JSON.parse(readFileSync(join(HERE, 'node_modules', p, 'package.json'), 'utf8')).version,
    ]),
  ),
}

const f = (n, d = 3) => (n === undefined || n === null ? '—' : n.toFixed(d))
const lines = []
const head = `| case | ${ARMS.map((a) => `${a} p50 / p99 (ms)`).join(' | ')} | ${ARMS.slice(1)
  .map((a) => `${a} ×raw`)
  .join(' | ')} |`
lines.push(head)
lines.push(`|${'---|'.repeat(1 + ARMS.length + (ARMS.length - 1))}`)
for (const r of results) {
  const cells = ARMS.map((a) =>
    r.arms[a] === undefined ? '—' : `${f(r.arms[a].p50)} / ${f(r.arms[a].p99)}`,
  )
  const ratios = ARMS.slice(1).map((a) =>
    r.arms[a] === undefined ? '—' : f(r.arms[a].p50 / r.arms['raw'].p50, 2),
  )
  lines.push(`| ${r.name} | ${cells.join(' | ')} | ${ratios.join(' | ')} |`)
}

const geomean = (xs) => Math.exp(xs.reduce((a, b) => a + Math.log(b), 0) / xs.length)
const summary = {}
for (const a of ARMS.slice(1)) {
  const rs = results
    .filter((r) => r.arms[a] !== undefined)
    .map((r) => r.arms[a].p50 / r.arms['raw'].p50)
  summary[a] = { geomeanOverRaw: geomean(rs), worstOverRaw: Math.max(...rs) }
}
lines.push('')
lines.push(
  `**Overhead over raw \`pg\`, geometric mean of the nine p50 ratios:** ` +
    ARMS.slice(1)
      .map(
        (a) => `${a} ${f(summary[a].geomeanOverRaw, 2)}× (worst ${f(summary[a].worstOverRaw, 2)}×)`,
      )
      .join(' · '),
)
if (divergences.length > 0) {
  lines.push('')
  lines.push(
    `**${divergences.length} declared answer divergence${divergences.length === 1 ? '' : 's'}.** ` +
      'Every arm\u2019s answer is compared with pg-prime\u2019s before anything is timed; a difference ' +
      'that the case does not declare aborts the run. These are declared, with the reason:',
  )
  for (const d of divergences) lines.push(`- \`${d.arm}\` on *${d.case}*: ${d.why}`)
}
lines.push('')
lines.push(
  `PostgreSQL ${serverVersion} · ${Object.entries(versions)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ')} · one shared \`pg.Pool\` · arms interleaved sample by sample · ` +
    `\`@prisma/client\` is not measured here, see \`bench/compare/PRISMA.md\`.`,
)

const table = lines.join('\n')
console.log(`\n## design/08 §5 — comparison run\n\n${table}\n`)

const report = {
  generatedAt: new Date().toISOString(),
  platform: `${process.platform}/${process.arch}`,
  serverVersion,
  versions,
  quick: QUICK,
  arms: ARMS,
  cases: results,
  summary,
  divergences,
  prisma: 'not measured — see bench/compare/PRISMA.md',
}
writeFileSync(join(HERE, 'report.json'), JSON.stringify(report, null, 2) + '\n')

const stepSummary = process.env['GITHUB_STEP_SUMMARY']
if (stepSummary !== undefined) {
  appendFileSync(stepSummary, `## design/08 §5 — comparison run\n\n${table}\n\n`)
}
console.log(`report → ${join(HERE, 'report.json')}`)
