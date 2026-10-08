import { createMockPool } from '@pg-prime/testing'
import { pgPrime } from 'pg-prime'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { NotStartedError, defineOutbox, functionSink, pgOutbox } from '../../src/index.js'
import type { OutboxRecord, OutboxTopic, PayloadOf, WriteResult } from '../../src/index.js'
import { schema } from '../support.js'

const orders = defineOutbox<{ id: string }>('orders')
const audit = defineOutbox<number>('audit', { partitions: 1 })

describe('registry', () => {
  it('maps every declaration to a typed topic handle', async () => {
    const pool = createMockPool()
    const db = pgPrime({ pool, schema })
    const outbox = pgOutbox({ db, define: { orders, audit } })
    expectTypeOf(outbox.topics.orders).toEqualTypeOf<OutboxTopic<{ id: string }>>()
    expectTypeOf(outbox.topics.audit).toEqualTypeOf<OutboxTopic<number>>()
    expectTypeOf<PayloadOf<typeof orders>>().toEqualTypeOf<{ id: string }>()
    expectTypeOf(outbox.topics.orders.write).returns.resolves.toEqualTypeOf<WriteResult>()
    expectTypeOf(outbox.topic(defineOutbox<boolean>('x'))).toEqualTypeOf<OutboxTopic<boolean>>()
    // @ts-expect-error: the payload is typed
    void outbox.topics.audit.write('nope', { tx: db }).catch(() => {})
    // @ts-expect-error: undeclared topics are not on the registry
    void outbox.topics.missing
    expect(Object.keys(outbox.topics)).toStrictEqual(['orders', 'audit'])
    expect(outbox.topic(orders)).toBe(outbox.topics.orders)
    await db.end()
  })

  it('functionSink is typed by the topic', () => {
    const sink = functionSink<number>((wave) => {
      expectTypeOf(wave).toEqualTypeOf<readonly OutboxRecord<number>[]>()
      return Promise.resolve()
    })
    expectTypeOf(sink.deliver).parameter(0).toEqualTypeOf<readonly OutboxRecord<number>[]>()
  })
})

describe('start rule', () => {
  it('a write carrying a transaction before start() throws NotStartedError and sends nothing', async () => {
    const pool = createMockPool()
    const db = pgPrime({ pool, schema })
    const outbox = pgOutbox({ db, define: { orders } })
    await expect(
      db.transaction((tx) => outbox.topics.orders.write({ id: '1' }, { tx })),
    ).rejects.toBeInstanceOf(NotStartedError)
    expect(pool.texts.some((t) => t.includes('pgprime_outbox'))).toBe(false)
    await db.end()
  })
})
