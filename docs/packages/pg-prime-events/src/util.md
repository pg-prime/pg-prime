# packages/pg-prime-events/src/util.ts

## Purpose
Three small internal helpers used by the reader, tails and handles.

## Public API
- `ASYNC_DISPOSE` — `Symbol.asyncDispose`, or `Symbol.for('Symbol.asyncDispose')` where absent.
- `sleep(ms, signal?)` — resolves after `ms`, or early on abort; never rejects.
- `backoffMs({ baseDelayMs, maxDelayMs, jitter }, attempt, random?)` — retry delay:
  `min(max, base * 2^(attempt-1))`, then `none` / `equal` / `full` jitter.

## Flow
1. `backoffMs` computes the ceiling (`packages/pg-prime-events/src/util.ts:23`) and applies jitter.

## Gotchas
- `backoffMs` is a deliberate copy of core's private `retryDelayMs` (plan 15 §0.2); the family's
  fixed vectors in `fixtures/backoff/vectors.json` keep the copies equal.
- `sleep` timers are not unref'd: a running reader keeps the process alive on purpose.

## Tests
- `test/unit/sql.test.ts` checks `backoffMs` against `fixtures/backoff/vectors.json`.
  `pnpm --filter @pg-prime/events test`.
