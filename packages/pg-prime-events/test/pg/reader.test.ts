import { describe, expect, it } from 'vitest'
import { sql } from 'pg-prime'
import { requiresConcurrency } from '@pg-prime/testing'
import { defineSubscription, defineTopic, pgEvents } from '../../src/index.js'
import type { Entry, ReadContext, Reader } from '../../src/index.js'
import { statements } from '../../src/log/sql.js'
import { freshSchema, p95, sleep, until, useServer } from '../_db.js'

const server = useServer()
// No dev-mode startup pooler probe: it holds the pool for a few hundred ms and skews latencies.
const quiet = { devGuard: false }
const topic = defineTopic<{ n: number; at: number }>('jobs')

describe('subscription readers on a real server', () => {
  requiresConcurrency(it)(
    'one reader per subscription across 3 instances, with failover after a crash',
    async () => {
      const schema = freshSchema()
      const def = defineSubscription(topic, 'single', { from: 'beginning' })
      const log: { who: number; n: number; start: number; end: number }[] = []
      const leaseMs = 600
      const instances = [0, 1, 2].map((who) => {
        const db = server.db(2)
        const events = pgEvents({ db, schema })
        const reader = events.subscription(def).run(
          async (e) => {
            const start = Date.now()
            await sleep(2)
            log.push({ who, n: e.payload.n, start, end: Date.now() })
          },
          { leaseMs, pollMs: 50, batchSize: 5 },
        )
        return { db, events, reader }
      })
      const producer = pgEvents({ db: server.db(1), schema }).topic(topic)
      for (let n = 0; n < 150; n++) {
        await producer.publish({ n, at: 0 })
        if (n % 10 === 0) await sleep(20)
      }
      await until(() => log.length === 150)

      const active = instances.findIndex((i) => i.reader.active)
      expect(instances.filter((i) => i.reader.active)).toHaveLength(1)
      // A crash: the pool goes away under the reader, which can neither commit nor release.
      const crashedAt = Date.now()
      await instances[active]?.db.end()
      for (let n = 150; n < 160; n++) await producer.publish({ n, at: 0 })
      await until(() => log.length === 160, 10_000)
      const takeover = (log.find((l) => l.n === 150)?.start ?? 0) - crashedAt
      expect(takeover).toBeLessThan(2 * leaseMs + 500)
      await Promise.all(instances.map((i) => i.reader.close()))

      expect(log.map((l) => l.n).sort((a, b) => a - b)).toStrictEqual(
        Array.from({ length: 160 }, (_, n) => n),
      )
      const ordered = [...log].sort((a, b) => a.start - b.start)
      for (const [i, cur] of ordered.entries()) {
        const prev = ordered[i - 1]
        if (prev !== undefined && prev.who !== cur.who) {
          expect(cur.start).toBeGreaterThanOrEqual(prev.end)
        }
      }
    },
    60_000,
  )

  requiresConcurrency(it)(
    'ctx.commit({ tx }) is exactly-once even when the handler transaction is killed',
    async () => {
      const db = server.db(4)
      const schema = freshSchema()
      const events = pgEvents({ db, schema })
      await events.start()
      const sink = sql.ident(schema, 'sink')
      await db.sql`create table ${sink} (n int)`.execute()
      const def = defineSubscription(topic, 'sink', {
        from: 'beginning',
        retry: { maxAttempts: 100, baseDelayMs: 1, maxDelayMs: 5 },
      })
      const killed = new Set<number>()
      const handler = async (e: Entry<{ n: number; at: number }>, ctx: ReadContext) => {
        await db.transaction(async (tx) => {
          await tx.sql`insert into ${sink} values (${e.payload.n})`.execute()
          if (e.payload.n % 7 === 3 && !killed.has(e.payload.n)) {
            killed.add(e.payload.n)
            const [r] = await tx.sql`select pg_backend_pid() as pid`.execute()
            await server.db(1).sql`select pg_terminate_backend(${r?.['pid'] as number})`.execute()
          }
          await ctx.commit({ tx })
        })
      }
      await events
        .topic(topic)
        .publishMany(Array.from({ length: 60 }, (_, n) => ({ payload: { n, at: 0 } })))
      let reader: Reader = events.subscription(def).run(handler, { pollMs: 50, batchSize: 4 })
      await sleep(300)
      await reader.close()
      reader = events.subscription(def).run(handler, { pollMs: 50, batchSize: 4 })
      await until(async () => (await events.subscription(def).lag()).entries === 0, 30_000)
      await reader.close()
      const rows = await db.sql`select n from ${sink} order by n`.execute()
      expect(rows.map((r) => r['n'])).toStrictEqual(Array.from({ length: 60 }, (_, n) => n))
      expect(killed.size).toBe(9)
    },
    60_000,
  )

  requiresConcurrency(it)(
    'a process-killing poison entry is parked after maxAttempts restarts; the rest are delivered once',
    async () => {
      const schema = freshSchema()
      const admin = server.db(2)
      const def = defineSubscription(topic, 'poison', {
        from: 'beginning',
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      })
      const setup = pgEvents({ db: admin, schema })
      await setup.start()
      const sink = sql.ident(schema, 'sink')
      await admin.sql`create table ${sink} (n int)`.execute()
      await setup
        .topic(topic)
        .publishMany(Array.from({ length: 20 }, (_, n) => ({ payload: { n, at: 0 } })))
      let restarts = 0
      for (; restarts < 20; restarts++) {
        if ((await setup.subscription(def).parked()).length === 1) break
        const db = server.db(2)
        const events = pgEvents({ db, schema })
        let crashed = false
        const reader = events.subscription(def).run(
          async (e, ctx) => {
            if (e.payload.n === 13) {
              // Dies without a word: no nack, no commit, no release.
              crashed = true
              await db.end()
              throw new Error('process exit')
            }
            await db.transaction(async (tx) => {
              await tx.sql`insert into ${sink} values (${e.payload.n})`.execute()
              await ctx.commit({ tx })
            })
          },
          { leaseMs: 300, pollMs: 20, batchSize: 5 },
        )
        await until(
          async () => crashed || (await setup.subscription(def).parked()).length === 1,
          10_000,
        )
        await reader.close()
      }
      const parked = await setup.subscription(def).parked()
      expect(parked.map((p) => [p.entry.payload.n, p.attempts])).toStrictEqual([[13, 3]])
      await until(async () => (await setup.subscription(def).lag()).entries === 0, 10_000).catch(
        () => {},
      )
      const reader = setup.subscription(def).run(
        async (e, ctx) => {
          await admin.transaction(async (tx) => {
            await tx.sql`insert into ${sink} values (${e.payload.n})`.execute()
            await ctx.commit({ tx })
          })
        },
        { leaseMs: 300, pollMs: 20 },
      )
      await until(async () => (await setup.subscription(def).lag()).entries === 0, 10_000)
      await reader.close()
      const rows = await admin.sql`select n from ${sink} order by n`.execute()
      expect(rows.map((r) => r['n'])).toStrictEqual(
        Array.from({ length: 20 }, (_, n) => n).filter((n) => n !== 13),
      )
    },
    120_000,
  )

  requiresConcurrency(it)('a stale reader cannot commit or park', async () => {
    const db = server.db(2)
    const schema = freshSchema()
    const events = pgEvents({ db, schema })
    const def = defineSubscription(topic, 'stale', { from: 'beginning' })
    await events.subscription(def).lag()
    const [{ id }] = (await events.topic(topic).publishMany([{ payload: { n: 1, at: 0 } }])) as [
      { id: bigint },
    ]
    const s = statements(schema)
    const old = await s.lease(db, 'jobs', 'stale', 60_000)
    await db.sql`update ${sql.ident(schema, 'subscriptions')} set lease_until = now() - interval '1 s'`.execute()
    const thief = await s.lease(db, 'jobs', 'stale', 60_000)
    expect(thief?.token).not.toBe(old?.token)
    const c = old?.cursor ?? { xid: 0n, id: 0n, pending: new Map() }
    expect(await s.park(db, 'jobs', 'stale', old?.token as string, c, id, 1, 'x')).toBe(false)
    expect(await s.commit(db, 'jobs', 'stale', old?.token as string, c)).toBe(false)
    expect(await s.heartbeat(db, 'jobs', 'stale', old?.token as string, 1000)).toBe(false)
    expect(await events.subscription(def).parked()).toStrictEqual([])
  })

  requiresConcurrency(it)(
    'wakes within 100 ms (p95) with pollMs: 5000',
    async () => {
      const schema = freshSchema()
      const events = pgEvents({ db: server.db(2, quiet), schema })
      const producer = pgEvents({ db: server.db(1, quiet), schema }).topic(topic)
      const def = defineSubscription(topic, 'wake', { from: 'beginning' })
      await events.start()
      const latency: number[] = []
      const reader = events
        .subscription(def)
        .run(async (e) => void latency.push(Date.now() - e.payload.at), { pollMs: 5_000 })
      await until(() => reader.active)
      await sleep(200)
      for (let n = 0; n < 50; n++) {
        const at = Date.now()
        await producer.publish({ n, at })
        await sleep(40)
      }
      await until(() => latency.length === 50)
      await reader.close()
      expect(p95(latency)).toBeLessThan(100)
    },
    60_000,
  )
})
