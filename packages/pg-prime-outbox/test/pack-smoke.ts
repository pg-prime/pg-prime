// The consumer body tools/pack-smoke.mjs compiles and runs in a project holding only the
// tarballs, so every import here goes through the published export maps.
import { createMockPool } from '@pg-prime/testing'
import type { MockField, MockResult, RecordedQuery } from '@pg-prime/testing'
import { NotStartedError, defineOutbox, migrationSql, pgOutbox } from '@pg-prime/outbox'
import { defineSchema, pgPrime } from 'pg-prime'

const field = (name: string, dataTypeID: number): MockField => ({
  name,
  dataTypeID,
  tableID: 0,
  columnID: 0,
  dataTypeSize: -1,
  dataTypeModifier: -1,
  format: 'text',
})
const checksum = /'([0-9a-f]+)'\) on conflict do nothing/.exec(migrationSql()[0]!.sql)![1]!

// A server that has the outbox schema at version 1 and the topic with 16 partitions.
const answer = (q: RecordedQuery): MockResult => {
  if (q.text.includes('to_regclass')) return { rows: [['t']], fields: [field('ok', 16)] }
  if (q.text.includes('min_client, checksum')) {
    return {
      rows: [['1', '1', checksum]],
      fields: [field('version', 23), field('min_client', 23), field('checksum', 25)],
    }
  }
  if (q.text.includes('.topics (name')) return { rows: [['16']], fields: [field('partitions', 21)] }
  if (q.text.includes('jsonb_to_recordset')) {
    const [row] = JSON.parse(q.values[0] as string) as { idem: string }[]
    return {
      rows: [['1', row!.idem, null]],
      fields: [field('id', 20), field('idem', 25), field('woke', 16)],
    }
  }
  return { rows: [] }
}

const pool = createMockPool({ script: Array.from({ length: 50 }, () => answer) })
const db = pgPrime({ pool, schema: defineSchema({}) })
const outbox = pgOutbox({ db, define: { orders: defineOutbox<{ id: string }>('orders') } })

const early = await db
  .transaction((tx) => outbox.topics.orders.write({ id: '1' }, { tx }))
  .catch((e: unknown) => e)
if (!(early instanceof NotStartedError)) throw new Error('pack-smoke: write before start() ran')

await outbox.start()
const r = await db.transaction((tx) => outbox.topics.orders.write({ id: '1' }, { tx, key: 'o1' }))
if (r.id !== 1n || r.duplicate)
  throw new Error(`pack-smoke: unexpected ${JSON.stringify(String(r.id))}`)
if (!pool.texts.some((t) => t.includes('pg_advisory_xact_lock(hashtextextended'))) {
  throw new Error('pack-smoke: W1 never reached the pool')
}
await db.end()
console.log('pack-smoke @pg-prime/outbox consumer OK')
