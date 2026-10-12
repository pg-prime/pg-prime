import { describe, expect, it } from 'vitest'
import { UnsupportedInPoolerModeError } from 'pg-prime'
import { requiresConcurrency } from '@pg-prime/testing'
import { defineChannel, defineSubscription, defineTopic, pgEvents } from '../../src/index.js'
import { freshSchema, until, useServer } from '../_db.js'

const server = useServer()
const BOUNCER = process.env['PG_PRIME_TEST_PGBOUNCER_URL'] ?? ''
const viaBouncer = (it: Parameters<typeof requiresConcurrency>[0]) => {
  if (BOUNCER !== '') return requiresConcurrency(it)
  process.stderr.write(
    '[test] skip: set PG_PRIME_TEST_PGBOUNCER_URL to a transaction-mode PgBouncer\n',
  )
  return it.skip
}

describe('behind PgBouncer in transaction mode', () => {
  viaBouncer(it)(
    'publish, subscribe and notify work by polling; channel.listen is refused',
    async () => {
      const db = server.db(4, { connection: BOUNCER, poolerMode: 'pgbouncer-transaction' })
      const internal: string[] = []
      const ping = defineChannel<{ n: number }>('ev_bouncer_ping')
      const orders = defineTopic<{ n: number }>('orders')
      const events = pgEvents({
        db,
        schema: freshSchema(),
        define: { channels: { ping } },
        hooks: { onInternal: (e) => void internal.push(e.kind) },
      })
      await events.start()
      const seen: number[] = []
      const reader = events
        .subscription(defineSubscription(orders, 'billing', { from: 'beginning' }))
        .run(async (e) => void seen.push(e.payload.n), { pollMs: 50 })
      await db.transaction(async (tx) => {
        await events
          .topic(orders)
          .publishMany([{ payload: { n: 1 } }, { payload: { n: 2 } }], { tx })
      })
      await until(() => seen.length === 2)
      await reader.close()
      expect(seen).toStrictEqual([1, 2])
      expect(internal).toContain('listen-unavailable')
      await events.channels.ping.notify({ n: 1 })
      await expect(events.channels.ping.listen(() => {})).rejects.toBeInstanceOf(
        UnsupportedInPoolerModeError,
      )
    },
    60_000,
  )
})
