// Plan 16 §7's outbox bench, nightly and informational: writes/s with ordered vs unordered keys,
// and relay records/s at P = 16 with 1 and 4 relays. Uses the BUILT packages (`pnpm build` first)
// against PG_PRIME_TEST_URL, in a scratch schema it drops afterwards; writes report.json.
import { writeFileSync } from 'node:fs'
import { defineSchema, pgPrime, sql } from '../../packages/pg-prime/dist/index.js'
import { defineOutbox, functionSink, pgOutbox } from '../../packages/pg-prime-outbox/dist/index.js'

const url = process.env.PG_PRIME_TEST_URL
if (!url) throw new Error('bench/outbox: set PG_PRIME_TEST_URL')
const WRITES = Number(process.env.OUTBOX_BENCH_WRITES ?? 5_000)
const RECORDS = Number(process.env.OUTBOX_BENCH_RECORDS ?? 20_000)
const WRITERS = 8
const KEYS = 200

const schema = `pgprime_outbox_bench_${process.pid}`
const connect = (max) =>
  pgPrime({ schema: defineSchema({}), connection: url, poolOptions: { max } })
const db = connect(WRITERS + 2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function writes(ordered) {
  const outbox = pgOutbox({
    db,
    schema,
    define: { t: defineOutbox(`writes-${ordered}`, { ordered }) },
  })
  await outbox.start()
  let next = 0
  const t0 = performance.now()
  await Promise.all(
    Array.from({ length: WRITERS }, async () => {
      for (let i = next++; i < WRITES; i = next++) {
        await db.transaction((tx) => outbox.topics.t.write({ i }, { tx, key: `k${i % KEYS}` }))
      }
    }),
  )
  return Math.round(WRITES / ((performance.now() - t0) / 1000))
}

async function relay(relays) {
  const topic = `relay-${relays}`
  const outbox = pgOutbox({ db, schema, define: { t: defineOutbox(topic) } })
  await outbox.start()
  for (let i = 0; i < RECORDS; i += 1_000) {
    const items = Array.from({ length: Math.min(1_000, RECORDS - i) }, (_, j) => ({
      payload: { i: i + j },
      key: `k${(i + j) % 1_000}`,
    }))
    await outbox.topics.t.writeMany(items, { tx: db })
  }
  let delivered = 0
  const sink = functionSink((wave) => {
    delivered += wave.length
    return Promise.resolve()
  })
  const procs = Array.from({ length: relays }, () => connect(4))
  const t0 = performance.now()
  const running = procs.map((pdb) =>
    pgOutbox({ db: pdb, schema, define: { t: defineOutbox(topic) } }).topics.t.relay(sink, {
      pollMs: 50,
    }),
  )
  while (delivered < RECORDS) await sleep(5)
  const rate = Math.round(RECORDS / ((performance.now() - t0) / 1000))
  await Promise.all(running.map((r) => r.close()))
  await Promise.all(procs.map((p) => p.end()))
  return rate
}

try {
  const [v] = await db.sql`select current_setting('server_version') as v`.execute()
  const report = {
    date: new Date().toISOString(),
    server: v.v,
    writesPerSec: { ordered: await writes(true), unordered: await writes(false) },
    relayRecordsPerSec: { p16Relays1: await relay(1), p16Relays4: await relay(4) },
    params: { writes: WRITES, writers: WRITERS, keys: KEYS, records: RECORDS },
  }
  writeFileSync(new URL('./report.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`)
  console.log(report)
} finally {
  await db.sql`drop schema if exists ${sql.ident(schema)} cascade`.execute()
  await db.end()
}
