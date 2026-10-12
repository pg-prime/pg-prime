# @pg-prime/events

Typed LISTEN/NOTIFY channels, a durable event log with subscriptions, and tails for
[pg-prime](https://github.com/pg-prime/pg-prime). No runtime dependencies.

> **Status: pre-alpha.** The API may change before 1.0.

```ts
import { defineChannel, defineSubscription, defineTopic, pgEvents } from '@pg-prime/events'

const cacheBust = defineChannel<{ id: number }>('cache-bust')
const orders = defineTopic<{ id: string; total: number }>('orders', { keepMs: 7 * 86_400_000 })
const billing = defineSubscription(orders, 'billing', { types: ['order.paid'] })

const events = pgEvents({
  db,
  define: { channels: { cacheBust }, topics: { orders }, subscriptions: { billing } },
})
await events.start()

await events.channels.cacheBust.notify({ id: 1 })
await db.transaction(async (tx) => {
  await events.topics.orders.publish({ id: 'o-1', total: 42 }, { tx, type: 'order.paid' })
})
const reader = events.subscriptions.billing.run(async (entry, ctx) => {
  await db.transaction(async (tx) => {
    // …your writes…
    await ctx.commit({ tx })
  })
})
```

Guarantees:

- `publish({ tx })` is one insert in your transaction: the entry exists exactly when your write does.
- A subscription delivers every committed entry once per cursor, including entries of
  transactions that commit late, and is not held back by unrelated long transactions.
- One reader per subscription; acknowledgement inside your transaction is exactly-once.
- Failing entries are retried with backoff and parked after `maxAttempts`, crashes included.
- Channels are live only; a reconnect reports `gap`. Behind PgBouncer everything polls.

Docs: [Channels](https://pg-prime.github.io/pg-prime/guides/channels/),
[Event log](https://pg-prime.github.io/pg-prime/guides/event-log/),
[reference](https://pg-prime.github.io/pg-prime/reference/events/).
