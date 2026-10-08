# packages/pg-prime-mq/src/queue/settle.ts

## Purpose
Settles shared by workers and manual consumers: completion, failure with retry/backoff, final
failure and cancel through the one `finish` builder, plus the fail cascade up a flow.

## Public API
- Internal: `finishMessage(core, m, to, guard, o?)`, `completeMessage(core, def, m, result, tx?)`,
  `failMessage(core, def, m, err, o?)`, `recoverExpired(core, q, queue, everyMs)`, `settleSafely(core, m, fn)`,
  `errorText(e)`.

## Flow
1. A failure that may cascade (a `fail` child, or a row not read) is one transaction (packages/pg-prime-mq/src/queue/settle.ts:51).
2. It locks the ancestor chain first, finishes the message, then each `blocked` parent it reaches (`guard: blocked`).
3. `failMessage` decides final: `final`, `NonRetryableError`, last attempt, or `shouldRetry` false (packages/pg-prime-mq/src/queue/settle.ts:92).
4. Otherwise S8r with `backoffMs(retry, attempt)`.
5. `recoverExpired` runs S9 behind its per-queue gate and fails the exhausted leases; workers and manual `claim()` call it (packages/pg-prime-mq/src/queue/settle.ts:142).
6. `settleSafely` retries a settle that errored while the row is still ours and active (packages/pg-prime-mq/src/queue/settle.ts:161).

## Gotchas
- Locking ancestors before the child's counters keeps the lock order message → group → queue.
- A throwing `shouldRetry` counts as false (final).

## Tests
- `test/live/flow.test.ts` (every `onFail`, cascade), `test/pg/concurrency.test.ts` (active parent vs failing child). `pnpm --filter @pg-prime/mq test:pg`.
