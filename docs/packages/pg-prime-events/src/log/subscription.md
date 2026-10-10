# packages/pg-prime-events/src/log/subscription.ts

## Purpose
Subscription handles: the leased reader that delivers entries with retry, isolation and parking,
plus `reset`, `lag`, `parked`, `discard` and `remove`. Built by `pgEvents`; `@pg-prime/mq`'s
`bind()` runs a batch reader with `ctx.commit({ tx })`.

## Public API
- `SubscriptionHandle<T>` — `run(handler, opts?)` → `Reader`; `reset('beginning' | 'now' | { after })`;
  `lag()` → `{ entries, oldestAt }`; `parked({ limit? })`; `discard(ids)` → count; `remove()`.
- `EntryHandler<T>` — `(entry, ctx)`, sequential. `BatchHandler<T>` — `{ batch(entries, ctx) }`.
- `ReadContext` — `signal` (aborted on close or lease loss), `attempt`, `commit({ tx })`.
- `Reader` — `active` (holds the lease), `close()`, `Symbol.asyncDispose`.
- `RunOptions` — `batchSize = 100`, `leaseMs = 30 000`, `pollMs = 5 000`, `signal`.

## Flow
1. The loop ensures the subscription, then L1; without the lease it retries every `leaseMs / 2`
   (`packages/pg-prime-events/src/log/subscription.ts:293`).
2. Holding it, a heartbeat runs every `leaseMs / 3`; 0 rows aborts the handler signal, and an
   entry handler gets no further entry of the batch (`:134`, `:196`).
3. Every 60 s the reader runs retention for its topic (`:255`).
4. R1 reads `batchSize` entries (1 while isolating); an empty read commits `advanceTo` if the cursor
   moved, else waits on the waker (`:266`).
5. `attempt` writes the A1 marker, computes per-entry cursors, parks instead of invoking when a single
   entry's count exceeds `maxAttempts` (`:164`).
6. Success commits the cursor after the last acknowledged entry (skipped if `ctx.commit` already did).
7. A multi-entry failure isolates the rest; a single-entry failure nacks with `backoffMs` (`:229`).
8. `close()` stops the loop, lets the running batch finish and releases the lease (`:280`).

## Gotchas
- A failure is never charged to a batch: the batch's entries are re-run one by one, and only
  single-entry attempts count, so `maxAttempts: 1` never parks an innocent entry unseen.
- A marker still set at takeover (crash or nack) isolates `head_size` entries, whatever the size
  (`:128`); a failed single entry keeps the reader isolated until it succeeds or is parked (`:237`),
  otherwise a larger batch would re-mark and reset its count.
- The marker is written before the handler, so a process-killing entry is still counted and parked
  after `maxAttempts` restarts.
- `ctx.commit({ tx })` runs C1 in the caller's transaction (exactly-once for same-database sinks) and
  clears the marker; a crash later in the same batch is then found one round later.
- A failure after `ctx.commit` (a later throw, a rollback, `IndeterminateCommitError`) reads the
  stored cursor (`:209`), which waits for the handler's transaction to end. Entries up to it count as
  acknowledged: never redelivered, never rewound, and a failure on them is not retried.
- One reader per subscription: guarded writes after a takeover fail with `EventsLeaseLostError`, and
  the old reader goes back to standby. `reset` clears the token so a running reader loses its lease.
- The old reader learns of a takeover at its next heartbeat or guarded write; until then a handler
  can still get entries the new owner also delivers. `ctx.commit({ tx })` keeps a sink exactly-once.
- At-least-once otherwise: a crash before C1 redelivers the batch.
- `parked` entries omit `cursor`; re-processing is user code (`read` + `discard`).
- Statement errors report `reader-failed` and retry after `pollMs`.

## Tests
- `test/live/log.test.ts` — resume, `types`, close quiets the reader, `ctx.commit`, retry/park/reset/
  discard, isolation, a single failure under new arrivals, retention, lag.
- `test/pg/reader.test.ts` — one reader across 3 instances with crash failover, exactly-once sink
  under killed transactions, a throw after (or inside) a `ctx.commit` transaction, process-killing
  poison entry, a lease lost mid-batch, stale reader, wake p95 < 100 ms.
- `test/pg/cursor.test.ts` — restarts under concurrent producers, a late transaction larger than
  `batchSize`, unrelated long transaction.
- `pnpm --filter @pg-prime/events test:live`; `PG_PRIME_TEST_URL=… pnpm --filter @pg-prime/events test:pg`.
