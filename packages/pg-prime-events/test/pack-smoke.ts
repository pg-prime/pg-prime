// The consumer body tools/pack-smoke.mjs compiles and runs in a project holding only the
// tarballs, so every import here goes through the published export maps.
import { defineChannel, engineChannel, pgEvents } from '@pg-prime/events'
import { createMockPool } from '@pg-prime/testing'
import { defineSchema, pgPrime } from 'pg-prime'

const pool = createMockPool()
const db = pgPrime({ pool, schema: defineSchema({}) })
const ping = defineChannel<{ id: string }>('ping')
const events = pgEvents({ db, define: { channels: { ping } } })
await events.channels.ping.notify({ id: '1' })
const sent = pool.queries.at(-1)
if (
  !sent?.text.includes('pg_notify') ||
  JSON.stringify(sent.values) !== '["ping","{\\"id\\":\\"1\\"}"]'
) {
  throw new Error(`pack-smoke: notify sent ${JSON.stringify(sent)}`)
}
if (!/^ev_[0-9a-f]{24}$/.test(engineChannel('pgprime_events', 't', 'orders'))) {
  throw new Error('pack-smoke: engineChannel')
}
await db.end()
console.log('pack-smoke @pg-prime/events consumer OK')
