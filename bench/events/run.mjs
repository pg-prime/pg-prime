// The @pg-prime/events bench (design/15 §7): informational, nightly, against a real server.
//
//   PG_PRIME_TEST_URL=postgres://… node bench/events/run.mjs [--quick]
//
// Writes report.json next to this file. Imports the BUILT packages, so `pnpm build` comes first.
import { writeFileSync } from 'node:fs'
import { defineSchema, pgPrime, sql } from '../../packages/pg-prime/dist/index.js'
import {
  defineSubscription,
  defineTopic,
  pgEvents,
} from '../../packages/pg-prime-events/dist/index.js'

const URL = process.env.PG_PRIME_TEST_URL ?? ''
const QUICK = process.argv.includes('--quick')
const OUT = new globalThis.URL('./report.json', import.meta.url)
const schema = `bench_events_${process.pid}`
const topic = defineTopic('bench')

if (URL === '') {
  console.log('bench/events: PG_PRIME_TEST_URL is not set; skipped')
  writeFileSync(OUT, JSON.stringify({ skipped: 'PG_PRIME_TEST_URL is not set' }, null, 2) + '\n')
  process.exit(0)
}

const db = pgPrime({
  connection: URL,
  schema: defineSchema({}),
  poolOptions: { max: 50 },
  devGuard: false,
})
const events = pgEvents({ db, schema })
await events.start()
const t = events.topic(topic)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const report = { when: new Date().toISOString(), server: '', results: {} }
report.server = String((await db.sql`select current_setting('server_version') as v`.execute())[0].v)

async function rate(name, seconds, step) {
  let n = 0
  const end = performance.now() + seconds * 1000
  const start = performance.now()
  while (performance.now() < end) n += await step()
  const perSec = Math.round(n / ((performance.now() - start) / 1000))
  report.results[name] = { perSec }
  console.log(`${name.padEnd(28)} ${perSec} /s`)
}

try {
  const secs = QUICK ? 1 : 5
  await rate('publish, 1 per statement', secs, async () => (await t.publish({ n: 1 }), 1))
  const hundred = Array.from({ length: 100 }, (_, n) => ({ payload: { n } }))
  await rate('publish, 100 per transaction', secs, async () => {
    await db.transaction((tx) => t.publishMany(hundred, { tx }))
    return 100
  })

  const backlog = (
    await events.subscription(defineSubscription(topic, 'count', { from: 'beginning' })).lag()
  ).entries
  let read = 0
  const started = performance.now()
  const reader = events
    .subscription(defineSubscription(topic, 'drain', { from: 'beginning' }))
    .run({ batch: async (es) => void (read += es.length) }, { batchSize: 1000, pollMs: 100 })
  while (read < backlog) await sleep(5)
  await reader.close()
  const perSec = Math.round(read / ((performance.now() - started) / 1000))
  report.results['reader, batch 1000'] = { perSec, entries: read }
  console.log(`${'reader, batch 1000'.padEnd(28)} ${perSec} /s (${read} entries)`)

  // 200 producers over a 40-connection pool, each holding its transaction open 0–20 ms.
  const pdb = pgPrime({
    connection: URL,
    schema: defineSchema({}),
    poolOptions: { max: 40 },
    devGuard: false,
  })
  const producers = pgEvents({ db: pdb, schema })
  await producers.start()
  const pt = producers.topic(topic)
  const tail = events
    .subscription(defineSubscription(topic, 'pending', { from: 'now' }))
    .run(async () => {}, { batchSize: 100, pollMs: 50 })
  const subs = sql.ident(schema, 'subscriptions')
  let maxPending = 0
  let stop = false
  const sampler = (async () => {
    while (!stop) {
      const [r] =
        await db.sql`select cardinality(pending) as p from ${subs} where name = 'pending'`.execute()
      maxPending = Math.max(maxPending, Number(r?.p ?? 0))
      await sleep(10)
    }
  })()
  const until = performance.now() + secs * 1000
  await Promise.all(
    Array.from({ length: 200 }, async () => {
      while (performance.now() < until) {
        await pdb.transaction(async (tx) => {
          await pt.publish({ n: 1 }, { tx })
          await sleep(Math.random() * 20)
        })
      }
    }),
  )
  await sleep(500)
  stop = true
  await sampler
  await tail.close()
  await pdb.end()
  report.results['cursor pending, 200 producers'] = { maxPending }
  console.log(`${'cursor pending, 200 producers'.padEnd(28)} max ${maxPending}`)
} finally {
  await events.close()
  await db.sql`drop schema if exists ${sql.ident(schema)} cascade`.execute()
  await db.end()
}
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
