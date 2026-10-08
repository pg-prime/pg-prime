# packages/pg-prime-outbox/src/relay/relay.ts

## Purpose
The relay loop behind `OutboxTopic.relay`: lease, deliver wave by wave, settle, wait; plus the local
wake-up loop (`waker.ts`) and the family `backoffMs`.

## Public API
- Internal `startRelay(ctx, sink, opts, onClose)` → `Relay` (`packages/pg-prime-outbox/src/relay/relay.ts:39`).
- `backoffMs(policy, attempt, random?)` (`:24`) — `min(maxDelayMs, baseDelayMs · 2^(attempt-1))`
  with `'none' | 'equal' | 'full'` jitter.
- `waker(db, channel, hooks)` → `{ wait(ms), kick(), close() }` (`packages/pg-prime-outbox/src/relay/waker.ts:12`).

## Flow
1. The waker subscribes with `db.listen(channel)` and wakes on NOTIFY and `gap`; if LISTEN fails
   (transaction pooler without `directConnection`) it reports `listen-unavailable` and the relay
   only polls.
2. The loop starts the topic lazily, heartbeats once, and runs `beat` every `leaseMs / 3`: lost
   partitions abort their signal with `OutboxLeaseLostError`; an excess over the fair share kicks the
   loop; a retention `sweep` runs in the background.
3. Each iteration: `rebalance` (L1 unless above the share, then release any excess), then `round`:
   every held partition gets one R1 batch, `concurrency` partitions at a time. A round rethrows the
   first failure only after every partition's batch has settled.
4. `serve` passes each wave's decodable records to the sink, D1s the successes, and settles each
   failure: `NonRetryableSinkError` (an undecodable payload is one) or `attempt >= maxAttempts` → K1
   (`onPark`), else F1 with `backoffMs` (`onFail`). A failed key is dropped from later waves. Any
   settle that finds the lease gone stops the partition.
5. With no full batch, the loop waits for a wake, `pollMs`, or the earliest backoff it set itself.
6. `close()` stops the loop, waits up to `graceMs` for in-flight waves, stops the heartbeat timer
   and the waker, aborts the rest, releases the partitions and deletes the membership row.

## Gotchas
- Rebalancing happens between rounds, so a released partition never has a wave in flight.
- A throwing sink fails the whole wave; `{ failed }` fails only the named ids.
- Backoff wake-ups are tracked locally; a partition that moved to another relay falls back to `pollMs`.
- A sink that ignores `ctx.signal` keeps running after `close()`; its settles are refused. It holds
  no timer or LISTEN open, so it cannot keep the process alive.
- Settling every worker before rethrowing matters: a sibling still in flight when the loop starts
  the next round would be served twice at once under the same lease and epoch.
- Errors in a round are reported as `relay-failed` and retried after `pollMs`.

## Tests
- `packages/pg-prime-outbox/test/unit/waker.test.ts` — NOTIFY, gap, poll, pending wake, close.
- `packages/pg-prime-outbox/test/unit/relay-math.test.ts` — `backoffMs` against
  `fixtures/backoff/vectors.json`.
- `packages/pg-prime-outbox/test/pg/relay.test.ts` — the tier-2 table, including wake latency and
  a failing partition beside a slow one.
- `packages/pg-prime-outbox/test/pg/sigkill.test.ts` — SIGKILL redelivery; `close()` under a sink
  that ignores abort (child process).
- `packages/pg-prime-outbox/test/pg/pgbouncer.test.ts` — polling behind PgBouncer.
