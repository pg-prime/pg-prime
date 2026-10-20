import { describe, expect, it } from 'vitest'
import { defineSubscription, defineTopic, pgEvents } from '@pg-prime/events'
import { sql } from 'pg-prime'
import { defineQueue, pgMq } from '../../src/index.js'
import { freshSchema, racing, until, useServer } from '../_db.js'

const server = useServer()
const orders = defineTopic<{ id: number; paid: boolean }>('orders')
const billing = defineQueue<{ order: number }>('billing')

describe('bind (topic → queue)', () => {
  it('moves matching entries into the queue and resumes after a restart', async () => {
    const db = server.db()
    const events = pgEvents({ db, schema: freshSchema() })
    const mq = pgMq({ db, schema: freshSchema(), events })
    const bound: number[] = []
    mq.observe({ onBind: (e) => void bound.push(e.count) })
    const sub = defineSubscription(orders, 'billing', { types: ['paid'], from: 'beginning' })
    const topic = events.topic(orders)
    const map = (e: { payload: { id: number } }) => ({
      payload: { order: e.payload.id },
      group: `o${e.payload.id % 2}`,
    })
    await topic.publishMany([
      { payload: { id: 1, paid: true }, type: 'paid' },
      { payload: { id: 2, paid: false }, type: 'created' },
      { payload: { id: 3, paid: true }, type: 'paid' },
    ])
    let b = mq.bind(sub, billing, { map, batchSize: 10 })
    const q = mq.queue(billing)
    await until(async () => (await q.counts()).ready === 2)
    await b.close()
    await topic.publish({ id: 5, paid: true }, { type: 'paid' })
    b = mq.bind(sub, billing, { map })
    await until(async () => (await q.counts()).ready === 3)
    await mq.close()
    const got = (await q.list()).map((m) => [m.payload.order, m.group])
    expect(got).toStrictEqual([
      [1, 'o1'],
      [3, 'o1'],
      [5, 'o1'],
    ])
    expect(bound.reduce((s, n) => s + n, 0)).toBe(3)
    expect(b.active).toBe(false)
  })

  it('close() between a read and its batch still delivers and commits the batch', async () => {
    const db = server.db()
    const sub = defineSubscription(orders, 'late', { from: 'beginning' })
    let closing: Promise<void> | undefined
    const events = pgEvents({
      db: racing(db, 'events.read', async (): Promise<void> => void (closing = b.close()), 'after'),
      schema: freshSchema(),
    })
    const retries: unknown[] = []
    events.observe({ onRetry: (e) => void retries.push(e) })
    await events.topic(orders).publishMany([1, 2].map((id) => ({ payload: { id, paid: true } })))
    const mq = pgMq({ db, schema: freshSchema(), events })
    const map = (e: { payload: { id: number } }) => ({ payload: { order: e.payload.id } })
    const b = mq.bind(sub, billing, { map, pollMs: 20 })
    await until(() => closing !== undefined)
    await closing
    const q = mq.queue(billing)
    expect((await q.counts()).ready).toBe(2)
    expect([retries, await events.subscription(sub).lag()]).toStrictEqual([
      [],
      { entries: 0, oldestAt: null },
    ])
  })

  it('drop() between a read and its batch keeps the entries unconsumed', async () => {
    const db = server.db()
    const sub = defineSubscription(orders, 'dropped', { from: 'beginning' })
    let dropped = false
    const events = pgEvents({
      db: racing(
        db,
        'events.read',
        (): Promise<void> => q.drop().then(() => void (dropped = true)),
        'after',
      ),
      schema: freshSchema(),
    })
    await events.topic(orders).publish({ id: 1, paid: true })
    const schema = freshSchema()
    const mq = pgMq({ db, schema, events })
    const bound: number[] = []
    mq.observe({ onBind: (e) => void bound.push(e.count) })
    const q = mq.queue(billing)
    await q.start()
    const b = mq.bind(sub, billing, { pollMs: 20 })
    await until(() => dropped)
    await until(() => !b.active)
    const queues = sql.ident(schema, 'queues')
    expect(await db.sql`select 1 from ${queues} where name = 'billing'`.execute()).toHaveLength(0)
    expect([bound, (await events.subscription(sub).lag()).entries]).toStrictEqual([[], 1])
    await b.close()
  })
})
