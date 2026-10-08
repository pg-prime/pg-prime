import { describe, expect, it } from 'vitest'
import { defineSubscription, defineTopic, pgEvents } from '@pg-prime/events'
import { requiresConcurrency } from '@pg-prime/testing'
import { defineQueue, pgMq } from '../../src/index.js'
import { freshSchema, until, useServer } from '../_db.js'

const server = useServer()
const BOUNCER = process.env['PG_PRIME_TEST_PGBOUNCER_URL'] ?? ''
const viaBouncer = (decl: Parameters<typeof requiresConcurrency>[0]) => {
  if (BOUNCER !== '') return requiresConcurrency(decl)
  process.stderr.write(
    '[test] skip: set PG_PRIME_TEST_PGBOUNCER_URL to a transaction-mode PgBouncer\n',
  )
  return decl.skip
}

describe('behind PgBouncer in transaction mode', () => {
  viaBouncer(it)(
    'a queue, a flow and a binding all run by polling',
    async () => {
      const db = server.db(6, { connection: BOUNCER, poolerMode: 'pgbouncer-transaction' })
      const internal: string[] = []
      const hooks = { onInternal: (e: { kind: string }) => void internal.push(e.kind) }
      const events = pgEvents({ db, schema: freshSchema() })
      const mq = pgMq({ db, schema: freshSchema(), events, hooks })
      const jobs = defineQueue<{ n: number }, number>('jobs', { watch: true })
      const parent = defineQueue<{ n: number }, number>('parent')
      await mq.start()
      const q = mq.queue(jobs)
      const seen: number[] = []
      const workers = [
        q.work(async (m) => (seen.push(m.payload.n), m.payload.n), { pollMs: 50 }),
        mq.queue(parent).work(async (_m, ctx) => Object.keys(await ctx.childResults()).length, {
          pollMs: 50,
        }),
      ]
      await db.transaction((tx) =>
        q.sendMany([{ payload: { n: 1 } }, { payload: { n: 2 } }], { tx }),
      )
      const root = await mq.flow({
        queue: parent,
        payload: { n: 0 },
        children: [{ queue: jobs, payload: { n: 3 } }],
      })
      expect(
        await q.result(
          { queue: 'jobs', id: (await q.send({ n: 4 })).id, deduplicated: false },
          { pollMs: 50 },
        ),
      ).toBe(4)
      const orders = defineTopic<{ id: number }>('orders')
      const binding = mq.bind(defineSubscription(orders, 'jobs', { from: 'beginning' }), jobs, {
        map: (e) => ({ payload: { n: e.payload.id } }),
        pollMs: 50,
      })
      await events.topic(orders).publish({ id: 5 })
      await until(
        async () => (await mq.queue(parent).get(root))?.state === 'completed' && seen.length === 5,
      )
      await Promise.all([...workers.map((w) => w.close()), binding.close()])
      expect(seen.sort()).toStrictEqual([1, 2, 3, 4, 5])
      expect((await mq.queue(parent).get(root))?.result).toBe(1)
      expect(internal).toContain('listen-unavailable')
    },
    60_000,
  )
})
