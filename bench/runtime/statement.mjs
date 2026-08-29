// A diagnostic, not a gate: **where the per-statement client-side cost goes**, feature by feature.
//
//   node bench/runtime/statement.mjs                  → the decomposition table
//   node bench/runtime/statement.mjs --cpu            → the same, plus a .cpuprofile per variant
//   node bench/runtime/statement.mjs --case=insert    → decompose a different case
//
// `profile.mjs` answers "where do the bytes of one `.compile()` go" — the *offline* half. This one
// answers the other half, which design/12 §4 P item 0 needed and nothing measured: a compiled
// statement still has to be leased, timed, hooked, guarded and mapped on its way to the socket,
// and every one of those is a `07` feature with a cost. The nine e2e pairs see the SUM; this sees
// the terms.
//
// The method is the same one `e2e.mjs` uses — a raw `pg` pair through an identical pool, the same
// process, the same statement — with one `pgPrime(...)` per variant, so the difference between two
// rows is exactly the feature named in the row.
//
// Needs `PG_PRIME_TEST_URL`, for the reason `e2e.mjs` gives: PGlite's bridge dominates the
// measurement and none of these terms would be visible behind it.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BENCH_NS, loadPackage } from './cases.mjs'

const argv = process.argv.slice(2)
const CPU = argv.includes('--cpu')
const REBUILD = argv.includes('--rebuild')
const CASE = (argv.find((a) => a.startsWith('--case=')) ?? '--case=point').slice(7)
const url = process.env['PG_PRIME_TEST_URL']
if (url === undefined) {
  console.error(
    'bench/runtime/statement.mjs needs PG_PRIME_TEST_URL — the terms it separates are microseconds ' +
      'of client-side work and PGlite’s in-process bridge is larger than all of them.\n' +
      'The no-server half of the same measurement is a GATE and lives in `run.mjs`, over the null ' +
      'driver in `statement-path.mjs`.',
  )
  process.exit(2)
}

const pg = (await import('pg')).default
const { api, fixture } = await loadPackage({ rebuild: REBUILD })
// The executor's own entry point, imported past the barrel. It is the **pre-session-layer path**:
// design/12 §3 S's predecessor ran `driver.acquire()` → `runOn(conn, compiled, env)` → `release()`
// and nothing else, so a row built out of those three calls is the "before" column of item 0's
// table, measured on this machine, in this process, interleaved with the others.
const HERE = dirname(fileURLToPath(import.meta.url))
const executor = await import(
  new URL(`file://${join(HERE, '.gen', 'dist', 'src', 'query', 'executor.js').replace(/\\/g, '/')}`)
    .href
)
const fx = fixture.makeFixture(BENCH_NS)
const h = fx.schema.h
const q = api

const admin = new pg.Client({ connectionString: url })
await admin.connect()
await admin.query(fx.drop)
await admin.query(fx.ddl)
await admin.query(fx.seed)

const opts = { connectionString: url, max: 4 }
const ormPool = new pg.Pool(opts)
const rawPool = new pg.Pool(opts)
const driver = api.pgDriver({ pool: ormPool })
await driver.init()

const registry = new api.Registry()
const c0 = await driver.acquire()
registry.setServerParameters(c0.serverParameters)
await registry.resolveDynamic(c0, [
  { schema: BENCH_NS, name: 'user_role', kind: 'enum', enumLabels: ['admin', 'owner', 'member'] },
])
await driver.release(c0)

const rawTypes = []
rawTypes.getTypeParser = () => (v) => v
const rawQuery = async (text, values) =>
  // oxlint-disable-next-line typescript/await-thenable -- the `types` overload erases the Promise
  (await rawPool.query({ text, values, rowMode: 'array', types: rawTypes })).rows

const userId = BigInt(
  (await rawQuery(`select id from ${BENCH_NS}.users order by id limit 1`, []))[0][0],
)

/**
 * The workloads. `point` is the cheapest statement design/08 §5 has, which is the only place a
 * constant per-statement cost is legible; `insert` is the second cheapest and `tx` is the one that
 * runs on a `Tx` handle, where the root-handle dev guard does not apply — the difference between
 * `point` and `tx` per statement is therefore the guard's own term, measured rather than argued.
 */
const CASES = {
  point: {
    statements: 1,
    orm: (db) => () =>
      db
        .from(h.users)
        .select(({ users: u }) => ({ id: u.id, email: u.email, name: u.name }))
        .where(({ users: u }) => q.eq(u.id, userId))
        .executeTakeFirst(),
    raw: () => async () =>
      (
        await rawQuery(`select id, email, name from ${BENCH_NS}.users where id = $1`, [
          String(userId),
        ])
      )[0],
    preS: (run) => {
      const db = api.compileOnly(fx.schema)
      const one = run(() =>
        db
          .from(h.users)
          .select(({ users: u }) => ({ id: u.id, email: u.email, name: u.name }))
          .where(({ users: u }) => q.eq(u.id, userId))
          .compile(),
      )
      return async () => (await one())[0]
    },
  },
  tx: {
    // `BEGIN`, five selects and `COMMIT`: seven statements, one connection, one guard check.
    statements: 7,
    orm: (db) => () =>
      db.transaction(async (tx) => {
        let n = 0
        for (let i = 0; i < 5; i++) {
          n += (
            await tx
              .from(h.users)
              .select(({ users: u }) => ({ id: u.id }))
              .where(({ users: u }) => q.eq(u.id, userId))
              .execute()
          ).length
        }
        return n
      }),
    raw: () => async () => {
      const conn = await rawPool.connect()
      try {
        await conn.query('begin')
        let n = 0
        for (let i = 0; i < 5; i++) {
          // The `types` overload erases the Promise in the checker's eyes (see e2e.mjs's rawQuery).
          // oxlint-disable-next-line typescript/await-thenable -- at runtime it is a Promise
          const r = await conn.query({
            text: `select id from ${BENCH_NS}.users where id = $1`,
            values: [String(userId)],
            rowMode: 'array',
            types: rawTypes,
          })
          n += r.rows.length
        }
        await conn.query('commit')
        return n
      } finally {
        conn.release()
      }
    },
    // One connection, `begin`, five selects, `commit` — the pre-session `Db` had no
    // `transaction()` worth the name, but it did have `runChunked`'s begin/commit around one
    // leased connection, and comparing five bare selects with a real transaction would flatter
    // this arm by two round trips.
    preS: (_run, raw) => {
      const db = api.compileOnly(fx.schema)
      const compile = () =>
        db
          .from(h.users)
          .select(({ users: u }) => ({ id: u.id }))
          .where(({ users: u }) => q.eq(u.id, userId))
          .compile()
      return async () => {
        const conn = await driver.acquire()
        try {
          await conn.execute({ text: 'begin', params: [], mode: 'simple' })
          let n = 0
          for (let i = 0; i < 5; i++) n += (await raw(conn, compile())).length
          await conn.execute({ text: 'commit', params: [], mode: 'simple' })
          return n
        } finally {
          await driver.release(conn)
        }
      }
    },
  },
}

const spec = CASES[CASE]
if (spec === undefined) {
  console.error(`bench/runtime/statement.mjs: no case "${CASE}" — one of ${Object.keys(CASES)}`)
  process.exit(2)
}

const ITERS = CASE === 'tx' ? 8 : 30
const SAMPLES = 40

/**
 * The variants, in the order that makes each row one feature off the previous one.
 *
 * `07` §7.4's call-site capture and `07` §1.5's dev guard are both **on outside production**, so
 * the first row is what a developer measures and the last is what a deployed process pays. They
 * are separate rows because they are separate config keys and a user can turn either off alone.
 */
const VARIANTS = [
  ['raw pg + hand mapper', null],
  ['dev default — guard + call site', {}],
  ['…without call-site capture', { errors: { captureCallSite: false } }],
  ['…without the dev guard', { devGuard: false }],
  ['production (neither)', { errors: { captureCallSite: false }, devGuard: false }],
  [
    '…production + one no-op hook',
    { errors: { captureCallSite: false }, devGuard: false, hooks: { onQueryEnd() {} } },
  ],
  ['pre-S path: acquire + runOn + release', 'pre-s'],
]

/**
 * Every variant measured **round-robin, one sample each**, for the reason `sampler.mjs` gives for
 * the pairs: a laptop that throttles or a runner whose neighbour starts a build reports the drift
 * as a difference between variants. Measured sequentially, this table put "without the dev guard"
 * 7 % ABOVE the dev default that includes it — which is a statement about the machine.
 */
const preSEnv = executor.makeEnv(registry, {})
const preS = (compile) => async () => {
  const conn = await driver.acquire()
  try {
    return await executor.runOn(conn, compile(), preSEnv)
  } finally {
    await driver.release(conn)
  }
}
const thunks = VARIANTS.map(([, extra]) => {
  if (extra === null) return spec.raw()
  if (extra === 'pre-s')
    return spec.preS(preS, (conn, compiled) => executor.runOn(conn, compiled, preSEnv))
  return spec.orm(api.pgPrime({ driver, schema: fx.schema, registry, ...extra }))
})
const series = VARIANTS.map(() => [])

for (const f of thunks) for (let i = 0; i < 5 * ITERS; i++) await f()
for (let s = 0; s < SAMPLES; s++) {
  for (let v = 0; v < thunks.length; v++) {
    const t0 = performance.now()
    for (let i = 0; i < ITERS; i++) await thunks[v]()
    series[v].push((performance.now() - t0) / ITERS)
  }
}

const p50 = (xs) => {
  const ys = [...xs].sort((a, b) => a - b)
  return ys[Math.floor(ys.length / 2)]
}
const mins = series.map((xs) => Math.min(...xs))
const p50s = series.map(p50)
const raw = p50s[0]
const rawMin = mins[0]
const per = (ms) => (ms * 1000) / spec.statements

console.log(
  `\n── per-statement cost · case "${CASE}" · ${spec.statements} statement(s) per iteration ──`,
)
console.log(
  `  ${'variant'.padEnd(32)} ${'p50 µs'.padStart(8)} ${'min µs'.padStart(8)} ${'Δ/stmt p50'.padStart(11)} ${'Δ/stmt min'.padStart(11)} ${'ratio'.padStart(7)}`,
)
const rows = []
for (let v = 0; v < VARIANTS.length; v++) {
  const [name] = VARIANTS[v]
  rows.push({
    name,
    p50Us: p50s[v] * 1000,
    minUs: mins[v] * 1000,
    overheadPerStatementUs: per(p50s[v] - raw),
    ratioP50: p50s[v] / raw,
  })
  console.log(
    `  ${name.padEnd(32)} ${(p50s[v] * 1000).toFixed(1).padStart(8)} ${(mins[v] * 1000).toFixed(1).padStart(8)} ` +
      `${per(p50s[v] - raw)
        .toFixed(1)
        .padStart(11)} ${per(mins[v] - rawMin)
        .toFixed(1)
        .padStart(11)} ` +
      `${(p50s[v] / raw).toFixed(3).padStart(7)}`,
  )
}

if (CPU) {
  const db = api.pgPrime({ driver, schema: fx.schema, registry })
  const f = spec.orm(db)
  const t0 = performance.now()
  let n = 0
  while (performance.now() - t0 < 6000) {
    await f()
    n++
  }
  console.log(`\n  cpu-prof: ${n} iterations in 6 s → .cpuprofile in the cwd`)
}

console.log('')
await admin.query(fx.drop).catch(() => {})
await admin.end().catch(() => {})
await driver.destroy().catch(() => {})
await rawPool.end().catch(() => {})
