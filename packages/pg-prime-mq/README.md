# @pg-prime/mq

Work queues on PostgreSQL for [pg-prime](https://github.com/pg-prime/pg-prime): competing
consumers with a lease and a token, retries with backoff, delay, priority, dedup, groups, global
limits, flows, a dead-letter state, and topic → queue bindings.

> **Status: pre-alpha.** The API may change before 1.0.

```ts
import { defineQueue, pgMq } from '@pg-prime/mq'

const emails = defineQueue<{ to: string }>('emails')
const mq = pgMq({ db, define: { emails } })
await mq.start()

await db.transaction(async (tx) => {
  // …your writes…
  await mq.queues.emails.send({ to: 'ada@example.com' }, { tx })
})

mq.queues.emails.work(async (m) => sendEmail(m.payload.to), { concurrency: 10 })
```

- **Transactional.** A send joins your transaction; `ctx.transaction(fn)` commits your writes and
  the completion together.
- **Safe under concurrency.** Claims use `SKIP LOCKED`; every consumer write is guarded by its
  token; an expired lease is one failed attempt, recovered once.
- **One dependency.** `@pg-prime/events` provides wake-ups and bindings; `pg-prime` is the peer.
- **PostgreSQL 15–18**, PgBouncer transaction mode (by polling), Node and Bun.

Docs: [guide](https://pg-prime.github.io/pg-prime/guides/queues/) ·
[concepts](https://pg-prime.github.io/pg-prime/concepts/work-queues/) ·
[operations](https://pg-prime.github.io/pg-prime/operations/queues/) ·
[reference](https://pg-prime.github.io/pg-prime/reference/mq/).
