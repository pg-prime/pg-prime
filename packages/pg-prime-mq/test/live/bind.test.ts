import { describe, expect, it } from 'vitest'
import { defineSubscription, defineTopic, pgEvents } from '@pg-prime/events'
import { defineQueue, pgMq } from '../../src/index.js'
import { freshSchema, until, useServer } from '../_db.js'

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
})
