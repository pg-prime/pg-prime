import { describe, expect, it } from 'vitest'
import { defineSubscription, defineTopic, pgEvents } from '@pg-prime/events'
import { requiresConcurrency } from '@pg-prime/testing'
import { defineQueue, pgMq } from '../../src/index.js'
import { freshSchema, sleep, until, useServer } from '../_db.js'

const server = useServer()
const orders = defineTopic<{ id: number }>('orders')
const billing = defineQueue<{ order: number }>('billing')

describe('bind exactly-once', () => {
  requiresConcurrency(it)(
    '3 binding instances, producer bursts, binders killed mid-transaction: every match once',
    async () => {
      const es = freshSchema()
      const ms = freshSchema()
      const app = `a5_binder_${process.pid}`
      const sub = defineSubscription(orders, 'billing', {
        types: ['paid'],
        from: 'beginning',
        retry: { maxAttempts: 1000, baseDelayMs: 1, maxDelayMs: 20 },
      })
      const bindings = Array.from({ length: 3 }, () => {
        const db = server.db(3, { devGuard: false, session: { applicationName: app } })
        const mq = pgMq({ db, schema: ms, events: pgEvents({ db, schema: es }) })
        return mq.bind(sub, billing, {
          map: (e) => ({ payload: { order: e.payload.id } }),
          batchSize: 25,
          leaseMs: 500,
          pollMs: 50,
        })
      })
      const admin = server.db(2, { devGuard: false })
      const topic = pgEvents({ db: admin, schema: es }).topic(orders)
      let kills = 0
      let stop = false
      const chaos = (async () => {
        while (!stop) {
          const r = await admin.sql`select pg_terminate_backend(pid) from pg_stat_activity
            where application_name = ${app} and state in ('idle in transaction', 'active')
              and query not like 'listen%'`.execute()
          kills += r.length
          await sleep(40)
        }
      })()
      let id = 0
      for (let burst = 0; burst < 20; burst++) {
        await topic.publishMany(
          Array.from({ length: 50 }, () => {
            id++
            return { payload: { id }, type: id % 3 === 0 ? 'created' : 'paid' }
          }),
        )
        await sleep(30)
      }
      const expected = Array.from({ length: id }, (_, i) => i + 1).filter((n) => n % 3 !== 0)
      const q = pgMq({ db: admin, schema: ms }).queue(billing)
      await until(async () => (await q.counts()).ready >= expected.length, 60_000)
      stop = true
      await chaos
      await sleep(500)
      await Promise.all(bindings.map((b) => b.close()))
      const got = (await q.list({ limit: 10_000 }))
        .map((m) => m.payload.order)
        .sort((a, b) => a - b)
      expect(got).toStrictEqual(expected)
      expect(kills).toBeGreaterThan(0)
    },
    120_000,
  )
})
