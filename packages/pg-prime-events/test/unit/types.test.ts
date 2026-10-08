import { describe, expectTypeOf, it } from 'vitest'
import type { Db } from 'pg-prime'
import { defineChannel, defineSubscription, defineTopic, pgEvents } from '../../src/index.js'
import type {
  BatchHandler,
  ChannelHandle,
  EntryHandler,
  PayloadOf,
  StandardSchemaV1,
  SubscriptionHandle,
  TopicHandle,
} from '../../src/index.js'

const db = {} as Db
const schema = {} as StandardSchemaV1<unknown, { sku: string }>

describe('registry types', () => {
  const ping = defineChannel<{ id: string }>('ping')
  const orders = defineTopic<{ total: number }>('orders')
  const stock = defineTopic('stock', { schema })
  const billing = defineSubscription(orders, 'billing')
  const events = pgEvents({
    db,
    define: { channels: { ping }, topics: { orders, stock }, subscriptions: { billing } },
  })

  it('maps each declaration to a typed handle', () => {
    expectTypeOf(events.channels.ping).toEqualTypeOf<ChannelHandle<{ id: string }>>()
    expectTypeOf(events.topics.orders).toEqualTypeOf<TopicHandle<{ total: number }>>()
    expectTypeOf(events.topics.stock).toEqualTypeOf<TopicHandle<{ sku: string }>>()
    expectTypeOf(events.subscriptions.billing).toEqualTypeOf<
      SubscriptionHandle<{ total: number }>
    >()
    expectTypeOf<PayloadOf<typeof billing>>().toEqualTypeOf<{ total: number }>()
  })

  it('types payloads end to end and rejects unknown names', () => {
    type T = { total: number }
    expectTypeOf(events.topics.orders.publish).parameter(0).toEqualTypeOf<T>()
    expectTypeOf(events.subscriptions.billing.run)
      .parameter(0)
      .toEqualTypeOf<EntryHandler<T> | BatchHandler<T>>()
    // @ts-expect-error not declared
    void events.topics.nope
    type Ping = Parameters<typeof events.channels.ping.notify>[0]
    // @ts-expect-error wrong payload
    const bad: Ping = { id: 1 }
    void bad
  })

  it('an empty definition has empty registries', () => {
    const bare = pgEvents({ db })
    // @ts-expect-error nothing declared
    void bare.topics.orders
    expectTypeOf(bare.topic(orders)).toEqualTypeOf<TopicHandle<{ total: number }>>()
  })
})
