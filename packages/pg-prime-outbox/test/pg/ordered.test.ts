import { requiresConcurrency } from '@pg-prime/testing'
import { describe, expect, it } from 'vitest'
import { defineOutbox, pgOutbox } from '../../src/index.js'
import { connectDb, dropSchema, recordingSink, scratchSchema, sleep, until } from '../support.js'

const test = requiresConcurrency(it)

/** A writes K and holds its transaction 2 s; B writes K meanwhile. Returns the delivery order. */
async function race(
  ordered: boolean,
): Promise<{ order: string[]; ids: bigint[]; bWaited: boolean }> {
  const schema = scratchSchema()
  const db = connectDb(process.env['PG_PRIME_TEST_URL']!, { poolOptions: { max: 6 } })
  const outbox = pgOutbox({ db, schema, define: { t: defineOutbox<string>('race', { ordered }) } })
  try {
    await outbox.start()
    const topic = outbox.topics.t
    const { sink, got } = recordingSink<string>()
    topic.relay(sink, { pollMs: 20 })
    let aWrote!: () => void
    const wrote = new Promise<void>((r) => (aWrote = r))
    let aCommitted = 0
    const a = db.transaction(async (tx) => {
      const r = await topic.write('A', { tx, key: 'K' })
      aWrote()
      await sleep(2_000)
      aCommitted = performance.now()
      return r.id
    })
    await wrote
    let bDone = 0
    const b = db.transaction(async (tx) => {
      const r = await topic.write('B', { tx, key: 'K' })
      bDone = performance.now()
      return r.id
    })
    const ids = await Promise.all([a, b])
    await until(() => got.length === 2)
    return { order: got.map((r) => r.payload), ids, bWaited: bDone >= aCommitted }
  } finally {
    await outbox.close()
    await dropSchema(db, schema)
    await db.end()
  }
}

describe('ordered writes', () => {
  test('serialize one key across concurrent transactions: delivery follows commit order', async () => {
    const r = await race(true)
    expect(r.bWaited).toBe(true)
    expect(r.ids[0]!).toBeLessThan(r.ids[1]!)
    expect(r.order).toStrictEqual(['A', 'B'])
  })

  test('ordered: false lets a later id commit first and be delivered first', async () => {
    const r = await race(false)
    expect(r.bWaited).toBe(false)
    expect(r.ids[0]!).toBeLessThan(r.ids[1]!)
    expect(r.order).toStrictEqual(['B', 'A'])
  })
})
