// The @pg-prime/mq bench (design/17 §10): informational, nightly, against a real server.
//
//   PG_PRIME_TEST_URL=postgres://… node bench/mq/run.mjs [--quick]
//
// Writes report.json next to this file. Imports the BUILT packages, so `pnpm build` comes first.
import { writeFileSync } from 'node:fs'
import { defineSchema, pgPrime, sql } from '../../packages/pg-prime/dist/index.js'
import { defineQueue, pgMq } from '../../packages/pg-prime-mq/dist/index.js'

const URL = process.env.PG_PRIME_TEST_URL ?? ''
const QUICK = process.argv.includes('--quick')
const OUT = new globalThis.URL('./report.json', import.meta.url)
const N = QUICK ? 10_000 : 100_000
const RETENTION_N = QUICK ? 20_000 : 1_000_000

if (URL === '') {
  console.log('bench/mq: PG_PRIME_TEST_URL is not set; skipped')
  writeFileSync(OUT, JSON.stringify({ skipped: 'PG_PRIME_TEST_URL is not set' }, null, 2) + '\n')
  process.exit(0)
}

const open = (max) =>
  pgPrime({ connection: URL, schema: defineSchema({}), poolOptions: { max }, devGuard: false })
const db = open(4)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const report = { when: new Date().toISOString(), server: '', results: {} }
report.server = String((await db.sql`select current_setting('server_version') as v`.execute())[0].v)
const schemas = []

/** Sends `n` messages (in 1 000-message statements), then drains them with 4 workers × 25. */
async function drain(name, { notify = true, groups = 0, keep } = {}) {
  const schema = `bench_mq_${process.pid}_${schemas.length}`
  schemas.push(schema)
  const def = defineQueue('bench', keep === undefined ? {} : { keep })
  const sender = pgMq({ db, schema, notify }).queue(def)
  const sendStart = performance.now()
  const n = name.startsWith('retention') ? RETENTION_N : N
  for (let i = 0; i < n; i += 1000) {
    await sender.sendMany(
      Array.from({ length: Math.min(1000, n - i) }, (_, k) => ({
        payload: { n: i + k },
        ...(groups > 0 ? { opts: { group: `g${(i + k) % groups}` } } : {}),
      })),
    )
  }
  const sendPerSec = Math.round(n / ((performance.now() - sendStart) / 1000))
  const pools = Array.from({ length: 4 }, () => open(28))
  let done = 0
  const started = performance.now()
  const workers = pools.map((p) =>
    pgMq({ db: p, schema, notify })
      .queue(def)
      .work(async () => void done++, {
        concurrency: 25,
        pollMs: 100,
        maintenanceMs: 1000,
      }),
  )
  while (done < n) await sleep(20)
  const perSec = Math.round(n / ((performance.now() - started) / 1000))
  await Promise.all(workers.map((w) => w.close()))
  await Promise.all(pools.map((p) => p.end()))
  report.results[name] = { sendPerSec, perSec, messages: n }
  console.log(`${name.padEnd(34)} send ${sendPerSec} /s, process ${perSec} /s (${n})`)
  return schema
}

try {
  await drain('fast path, NOTIFY on')
  await drain('fast path, NOTIFY off', { notify: false })
  await drain('groups (100), NOTIFY on', { groups: 100 })
  const schema = await drain('retention, completed not kept', { keep: { completed: false } })
  await sleep(1000)
  const [s] = await db.sql`select n_dead_tup::int as dead, n_live_tup::int as live
    from pg_stat_user_tables where schemaname = ${schema} and relname = 'messages'`.execute()
  report.results['retention, completed not kept'].deadTuples = s?.dead ?? null
  report.results['retention, completed not kept'].liveTuples = s?.live ?? null
  console.log(`${'dead tuples after retention'.padEnd(34)} ${s?.dead} dead, ${s?.live} live`)
} finally {
  for (const s of schemas) await db.sql`drop schema if exists ${sql.ident(s)} cascade`.execute()
  await db.end()
}
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
