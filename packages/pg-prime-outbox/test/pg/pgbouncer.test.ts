import { expect, it } from 'vitest'
import { defineOutbox, pgOutbox } from '../../src/index.js'
import type { InternalKind } from '../../src/index.js'
import { connectDb, dropSchema, recordingSink, scratchSchema, until } from '../support.js'

const BOUNCER = process.env['PG_PRIME_TEST_PGBOUNCER_URL']
const test = BOUNCER === undefined || BOUNCER === '' ? it.skip : it
if (test === it.skip) {
  process.stderr.write(
    '[pg] skip: PG_PRIME_TEST_PGBOUNCER_URL is unset, so the outbox behind a transaction pooler ' +
      'is UNVERIFIED in this run.\n',
  )
}

test('PgBouncer transaction mode: migrate, writes and a polling relay deliver everything', async () => {
  const schema = scratchSchema()
  const db = connectDb(BOUNCER!, { poolerMode: 'pgbouncer-transaction' })
  const internal: InternalKind[] = []
  const outbox = pgOutbox({
    db,
    schema,
    define: { t: defineOutbox<number>('bouncer') },
    hooks: { onInternal: (e) => internal.push(e.kind) },
  })
  try {
    await outbox.start()
    const topic = outbox.topics.t
    const { sink, got } = recordingSink<number>()
    topic.relay(sink, { pollMs: 50 })
    for (let i = 0; i < 50; i++) {
      await db.transaction((tx) => topic.write(i, { tx, key: `k${i % 7}` }))
    }
    await until(() => got.length === 50)
    expect(new Set(got.map((r) => r.payload)).size).toBe(50)
    expect(internal).toContain('listen-unavailable')
  } finally {
    await outbox.close()
    await dropSchema(db, schema)
    await db.end()
  }
})
