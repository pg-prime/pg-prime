import { describe, expect, it } from 'vitest'
import { sql } from 'pg-prime'
import { requiresConcurrency } from '@pg-prime/testing'
import { defineSubscription, defineTopic, pgEvents } from '../../src/index.js'
import type { Entry, Reader } from '../../src/index.js'
import { freshSchema, p95, sleep, until, useServer } from '../_db.js'

const server = useServer()
// No dev-mode startup pooler probe: it holds the pool for a few hundred ms and skews latencies.
const quiet = { devGuard: false }
const topic = defineTopic<{ id: string; at: number }>('work')

describe('the exact cursor on a real server', () => {
  requiresConcurrency(it)(
    'concurrent producers, aborts, a transaction held open 20 s and 10 reader restarts: every committed entry once',
    async () => {
      const db = server.db(12)
      const events = pgEvents({ db, schema: freshSchema() })
      const def = defineSubscription(topic, 'exact', { from: 'beginning' })
      await events.start()
      const work = events.topic(topic)
      const committed = new Map<string, number>()
      const aborted = new Set<string>()
      const delivered: { id: string; at: number }[] = []
      const handler = async (e: Entry<{ id: string; at: number }>): Promise<void> =>
        void delivered.push({ id: e.payload.id, at: Date.now() })
      const run = (): Reader => events.subscription(def).run(handler, { batchSize: 7, pollMs: 200 })

      let heldCommitAt = 0
      const held = db.transaction(async (tx) => {
        for (let k = 0; k < 3; k++) await work.publish({ id: `held:${k}`, at: 0 }, { tx })
        await sleep(20_000)
        heldCommitAt = Date.now()
      })
      const producer = async (p: number): Promise<void> => {
        for (let i = 0; i < 40; i++) {
          const ids = Array.from({ length: 1 + ((p + i) % 5) }, (_, k) => `${p}:${i}:${k}`)
          const abort = (p * 7 + i) % 9 === 0
          await db
            .transaction(async (tx) => {
              for (const id of ids) {
                await work.publish({ id, at: Date.now() }, { tx })
                await sleep(Math.random() * 15)
              }
              if (abort) tx.rollback()
            })
            .catch(() => {})
          for (const id of ids) {
            if (abort) aborted.add(id)
            else committed.set(id, Date.now())
          }
          await sleep(Math.random() * 300)
        }
      }

      let reader = run()
      const producers = Promise.all(Array.from({ length: 8 }, (_, p) => producer(p)))
      for (let r = 0; r < 10; r++) {
        await sleep(2_000)
        await reader.close()
        reader = run()
      }
      await producers
      await held
      for (let k = 0; k < 3; k++) committed.set(`held:${k}`, heldCommitAt)
      await until(() => delivered.length >= committed.size, 30_000)
      await sleep(500)
      await reader.close()

      const ids = delivered.map((d) => d.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect([...ids].sort()).toStrictEqual([...committed.keys()].sort())
      expect(ids.filter((id) => aborted.has(id))).toStrictEqual([])
      for (const d of delivered.filter((x) => x.id.startsWith('held:'))) {
        expect(d.at).toBeGreaterThanOrEqual(heldCommitAt)
      }
      // Nothing else waited for the held transaction.
      const during = delivered.filter(
        (d) => !d.id.startsWith('held:') && (committed.get(d.id) ?? 0) < heldCommitAt - 3_000,
      )
      expect(during.length).toBeGreaterThan(100)
      expect(during.every((d) => d.at < heldCommitAt)).toBe(true)
    },
    120_000,
  )

  requiresConcurrency(it)(
    'an unrelated long transaction does not delay readers',
    async () => {
      const db = server.db(4, quiet)
      const events = pgEvents({ db, schema: freshSchema() })
      const def = defineSubscription(topic, 'fast', { from: 'beginning' })
      await events.start()
      let pid = 0
      const long = db
        .transaction(async (tx) => {
          const [r] = await tx.sql`select pg_backend_pid() as pid, pg_current_xact_id()`.execute()
          pid = r?.['pid'] as number
          await tx.sql`select pg_sleep(30)`.execute()
        })
        .catch(() => {})
      await until(() => pid !== 0)
      const latency: number[] = []
      const reader = events
        .subscription(def)
        .run(async (e) => void latency.push(Date.now() - e.payload.at), { pollMs: 5_000 })
      await until(() => reader.active)
      for (let i = 0; i < 100; i++) {
        await events.topic(topic).publish({ id: String(i), at: Date.now() })
        await sleep(20)
      }
      await until(() => latency.length === 100)
      await reader.close()
      await db.sql`select pg_cancel_backend(${pid})`.execute()
      await long
      expect(p95(latency)).toBeLessThan(200)
    },
    60_000,
  )

  requiresConcurrency(it)(
    'pg_current_snapshot() is the statement snapshot at READ COMMITTED',
    async () => {
      const db = server.db(3)
      const schema = freshSchema()
      const x = sql.ident(schema, 'x')
      await db.sql`create schema ${sql.ident(schema)}`.execute()
      await db.sql`create table ${x} (n int)`.execute()
      let xid = ''
      const writer = db.transaction(async (tx) => {
        await tx.sql`insert into ${x} values (1)`.execute()
        const [r] = await tx.sql`select pg_current_xact_id()::text as xid`.execute()
        xid = r?.['xid'] as string
        await sleep(300)
      })
      await until(() => xid !== '')
      const [r] = await db.sql`select pg_sleep(0.6) as s, (select count(*) from ${x})::int as n,
        not pg_visible_in_snapshot(${xid}::xid8, pg_current_snapshot()) as hidden,
        current_setting('server_version_num') as v`.execute()
      await writer
      // The writer committed during the statement: invisible to its rows and to its snapshot.
      expect(r?.['n']).toBe(0)
      expect(r?.['hidden']).toBe(true)
      process.stderr.write(`[events] E-Q1 holds on server_version_num ${String(r?.['v'])}\n`)
    },
    30_000,
  )
})
