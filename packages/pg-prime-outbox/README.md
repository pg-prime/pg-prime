# @pg-prime/outbox

Transactional outbox for [pg-prime](https://github.com/pg-prime/pg-prime): write a message in your
transaction, and a relay delivers it at least once, in order per key.

> **Status: pre-alpha.** The API may change before 1.0.

```sh
pnpm add @pg-prime/outbox
```

```ts
import { defineOutbox, functionSink, pgOutbox } from '@pg-prime/outbox'

const orderPlaced = defineOutbox<{ orderId: string }>('order-placed')
const outbox = pgOutbox({ db, define: { orderPlaced } })
await outbox.start() // once at boot: migrates the `pgprime_outbox` schema

await db.transaction(async (tx) => {
  // …insert the order with tx…
  await outbox.topics.orderPlaced.write({ orderId: '42' }, { tx, key: 'order:42' })
})

// In any number of processes:
const relay = outbox.topics.orderPlaced.relay(
  functionSink(async (wave, { epoch }) => {
    for (const r of wave) await publish(r.payload, { idempotencyKey: r.idem, epoch })
  }),
)
```

- **Atomic:** the record commits or rolls back with your data.
- **Ordered per key:** same-key writers serialize until commit; relays lease whole partitions, so a
  key is never delivered by two relays at once, and a failing key blocks only itself.
- **Safe to redeliver:** every record has a stable idempotency key and every delivery a fencing epoch.
- **Operable:** retries with backoff, parking with `replay`/`discard`, `pause`, `stats`, retention.
- **Built-in sinks:** `functionSink` and `webhookSink` (signed JSON over `fetch`).
- Works behind PgBouncer transaction mode (by polling) and on Bun. No runtime dependencies.

Docs: [guide](https://pg-prime.github.io/pg-prime/guides/outbox/) ·
[operations](https://pg-prime.github.io/pg-prime/operations/outbox/) ·
[reference](https://pg-prime.github.io/pg-prime/reference/outbox/).
