import { requiresConcurrency } from '@pg-prime/testing'
import { sql } from 'pg-prime'
import type { Db } from 'pg-prime'
import { afterEach, describe, expect, it } from 'vitest'
import { defineOutbox, functionSink, pgOutbox } from '../../src/index.js'
import type { OutboxDef, OutboxSink, Relay, RelayOptions } from '../../src/index.js'
import { connectDb, dropSchema, recordingSink, scratchSchema, sleep, until } from '../support.js'

const test = requiresConcurrency(it)
const url = (): string => process.env['PG_PRIME_TEST_URL']!

interface Proc {
  db: Db
  relay(opts?: RelayOptions): Relay
}

let cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanup.reverse()) await f()
  cleanup = []
})

/** A schema of its own plus `n` relay "processes", each with its own pool and outbox. */
async function setup<T>(def: OutboxDef<T>, sink: OutboxSink<T>) {
  const schema = scratchSchema()
  const db = connectDb(url(), { poolOptions: { max: 12 } })
  const outbox = pgOutbox({ db, schema, define: { t: def } })
  await outbox.start()
  const dbs: Db[] = [db]
  cleanup.push(async () => {
    await outbox.close()
    await dropSchema(db, schema)
    for (const d of dbs) await d.end()
  })
  const proc = async (): Promise<Proc> => {
    const pdb = connectDb(url(), { poolOptions: { max: 4 } })
    dbs.push(pdb)
    const o = pgOutbox({ db: pdb, schema, define: { t: def } })
    await o.start()
    cleanup.unshift(() => o.close())
    return { db: pdb, relay: (opts) => o.topics.t.relay(sink, opts) }
  }
  return { schema, db, topic: outbox.topics.t, proc }
}

describe('relay under concurrency', () => {
  test('per-key order under 4 relays and 8 writers', async () => {
    const KEYS = 200
    const PER = 100
    const log = new Map<string, number[]>()
    const sink = functionSink<{ key: string; seq: number }>(async (wave) => {
      await sleep(0)
      for (const r of wave)
        log.set(r.payload.key, [...(log.get(r.payload.key) ?? []), r.payload.seq])
    })
    const { schema, db, topic, proc } = await setup(
      defineOutbox<{ key: string; seq: number }>('order'),
      sink,
    )
    const agg = sql.ident(schema, 'agg')
    await db.sql`create table ${agg} (key text primary key, seq int not null default 0)`.execute()
    await db.sql`insert into ${agg} (key) select 'k' || g from generate_series(1, ${KEYS}::int) g`.execute()
    const procs = await Promise.all([0, 1, 2, 3].map(() => proc()))
    procs.map((p) => p.relay({ leaseMs: 3_000, pollMs: 50 }))

    const tasks = Array.from({ length: KEYS * PER }, (_, i) => `k${(i % KEYS) + 1}`)
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        for (let key = tasks.pop(); key !== undefined; key = tasks.pop()) {
          const k = key
          await db.transaction(async (tx) => {
            const [row] =
              await tx.sql`update ${agg} set seq = seq + 1 where key = ${k} returning seq`.execute()
            await topic.write({ key: k, seq: row!['seq'] as number }, { tx, key: k })
          })
        }
      }),
    )
    await until(() => [...log.values()].reduce((n, l) => n + l.length, 0) >= KEYS * PER, 120_000)
    const expected = Array.from({ length: PER }, (_, i) => i + 1)
    for (let k = 1; k <= KEYS; k++) expect(log.get(`k${k}`)).toStrictEqual(expected)
  }, 180_000)

  test('head failure keeps receiver order', async () => {
    let failedOnce = false
    const sent: string[] = []
    const { sink, got } = recordingSink<string>((r) => {
      sent.push(r.payload)
      if (r.payload === 'K1' && !failedOnce) {
        failedOnce = true
        return new Error('receiver down')
      }
      return undefined
    })
    const { db, topic, proc } = await setup(defineOutbox<string>('head'), sink)
    await db.transaction(async (tx) => {
      await topic.writeMany(
        [
          { payload: 'K1', key: 'K' },
          { payload: 'L1', key: 'L' },
          { payload: 'K2', key: 'K' },
          { payload: 'L2', key: 'L' },
          { payload: 'K3', key: 'K' },
        ],
        { tx },
      )
    })
    const p = await proc()
    p.relay({ pollMs: 20, retry: { baseDelayMs: 100, jitter: 'none' } })
    await until(() => got.length === 5)
    const k = got.map((r) => r.payload).filter((x) => x.startsWith('K'))
    expect(k).toStrictEqual(['K1', 'K2', 'K3'])
    expect(sent.filter((x) => x.startsWith('K'))).toStrictEqual(['K1', 'K1', 'K2', 'K3'])
    // L was not held up by K's failure.
    expect(got.findIndex((r) => r.payload === 'L2')).toBeLessThan(
      got.findIndex((r) => r.payload === 'K2'),
    )
  })

  test('no concurrent delivery of one partition while relays come and go', async () => {
    const spans: { p: number; epoch: bigint; from: number; to: number }[] = []
    const sink = functionSink<number>(async (wave, ctx) => {
      const from = performance.now()
      await sleep(2 + Math.random() * 8)
      spans.push({ p: ctx.partition, epoch: ctx.epoch, from, to: performance.now() })
      void wave
    })
    const { db, topic, proc } = await setup(defineOutbox<number>('spans', { partitions: 8 }), sink)
    let writing = true
    const writer = (async () => {
      for (let i = 0; writing; i++) {
        await topic.write(i, { tx: db, key: `k${i % 50}` })
        await sleep(1)
      }
    })()
    const opts = { leaseMs: 1_500, pollMs: 20 }
    const r1 = (await proc()).relay(opts)
    const r2 = (await proc()).relay(opts)
    await sleep(700)
    const r3 = (await proc()).relay(opts)
    await sleep(700)
    await r1.close()
    const r4 = (await proc()).relay(opts)
    await sleep(700)
    await r2.close()
    await sleep(700)
    writing = false
    await writer
    await until(async () => (await topic.stats()).pending === 0)
    await Promise.all([r3.close(), r4.close()])
    expect(spans.length).toBeGreaterThan(50)
    for (let p = 0; p < 8; p++) {
      const mine = spans.filter((s) => s.p === p).sort((a, b) => a.from - b.from)
      for (let i = 1; i < mine.length; i++) {
        expect(mine[i]!.from).toBeGreaterThanOrEqual(mine[i - 1]!.to)
        expect(mine[i]!.epoch).toBeGreaterThanOrEqual(mine[i - 1]!.epoch)
      }
    }
  })

  test('rebalance 1 → 4 → 2: shares within one heartbeat, released partitions re-leased at once', async () => {
    const { sink } = recordingSink<number>()
    const { proc } = await setup(defineOutbox<number>('rebalance'), sink)
    const opts = { leaseMs: 3_000, pollMs: 5_000 }
    const r1 = (await proc()).relay(opts)
    await until(() => r1.partitions.length === 16)

    let t0 = performance.now()
    const rs = [r1, ...(await Promise.all([1, 2, 3].map(async () => (await proc()).relay(opts))))]
    await until(() => rs.every((r) => r.partitions.length === 4), 5_000)
    expect(performance.now() - t0).toBeLessThan(1_000 + 500)
    expect(new Set(rs.flatMap((r) => r.partitions)).size).toBe(16)

    t0 = performance.now()
    await Promise.all([rs[0]!.close(), rs[1]!.close()])
    await until(() => rs[2]!.partitions.length + rs[3]!.partitions.length === 16, 5_000)
    expect(performance.now() - t0).toBeLessThan(1_000)
    expect(Math.abs(rs[2]!.partitions.length - rs[3]!.partitions.length)).toBeLessThanOrEqual(1)
  })

  test('wake latency: p95 under 100 ms with pollMs 5000', async () => {
    const at = new Map<number, number>()
    const sink = functionSink<number>((wave) => {
      for (const r of wave) at.set(r.payload, performance.now())
      return Promise.resolve()
    })
    const { db, topic, proc } = await setup(defineOutbox<number>('wake'), sink)
    const relay = (await proc()).relay({ pollMs: 5_000 })
    await until(() => relay.partitions.length === 16)
    await sleep(200)
    const lat: number[] = []
    for (let i = 0; i < 40; i++) {
      await db.transaction((tx) => topic.write(i, { tx }))
      const committed = performance.now()
      await until(() => at.has(i), 6_000)
      lat.push(at.get(i)! - committed)
      await sleep(20)
    }
    lat.sort((a, b) => a - b)
    expect(lat[Math.floor(lat.length * 0.95)]).toBeLessThan(100)
  })
})
