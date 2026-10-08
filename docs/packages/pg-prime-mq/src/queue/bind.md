# packages/pg-prime-mq/src/queue/bind.ts

## Purpose
`mq.bind`: an `@pg-prime/events` subscription reader whose batches become messages, sent in the
same transaction as the offset commit.

## Public API
- `BindOptions<E, T>` — `map`, `batchSize` (100), `leaseMs`, `pollMs`, `signal`.
- `Binding` — `active`, `close()`, async dispose: wraps the events `Reader`, and `close` also drops it from the set `mq.close()` closes.
- Internal: `bind(core, sub, def, handle, opts?)`.

## Flow
1. `handle.start()` once, outside any transaction.
2. Per batch: `db.transaction` → `sendMany(items, { tx })` → `ctx.commit({ tx })` (packages/pg-prime-mq/src/queue/bind.ts:49).
3. `onBind` reports the batch size.

## Gotchas
- One reader per subscription (an events lease); throughput comes from `batchSize`.
- A batch that keeps failing is retried entry by entry and parked per the subscription's retry policy.

## Tests
- `test/unit/bind.test.ts` (registry), `test/live/bind.test.ts` (resume after restart), `test/pg/bind.test.ts` (exactly-once under kills). `pnpm --filter @pg-prime/mq test:pg`.
