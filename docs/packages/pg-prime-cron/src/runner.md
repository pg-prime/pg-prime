# packages/pg-prime-cron/src/runner.ts

## Purpose
Executes claimed handler runs in-process: one `AbortController` per run, timeout, in-process retry with the family `backoffMs` (`src/backoff.ts`), batched heartbeats, F1 on settle, and the shutdown drain. Created by `pgCron`; started from `tick()` and T2 pickup.

## Public API
- `runner(db, t, leaseMs, emit, onEnd): Runner` (internal).
- `Runner.start(run, handler)` — tracks and runs; `onEnd` fires when it settles (wakes the loop).
- `Runner.drain(graceMs)` — waits, aborts the rest with reason `close`, waits again.
- `backoffMs(policy, attempt, random?)` (`backoff.ts:7`) — the family's 15 fixed vectors.

## Flow
1. `start` (`runner.ts:160`) starts the heartbeat timer if none runs, emits `onRunStart`, arms `timeoutMs`, calls the handler with `RunContext`.
2. A throw retries after `backoffMs` until `retry.maxAttempts` (default 1), unless the run was aborted.
3. `abort` (`:46`) is idempotent: it aborts the signal, and for `timeout`/`close` marks the run `cancelling` with a token-guarded update.
4. On settle: `cancel`/`close` → `cancelled`; `timeout` → `failed`/`'timeout'`; else `succeeded` (JSON result) or `failed` (message); F1 frees the slot; `onRunEnd` only when F1 returned a row. F1 matching nothing (maintenance expired the run first) reports `onInternal('heartbeat-failed')` with `CronLeaseLostError` instead. The last run to settle stops the heartbeat timer.
5. `renew` (`:133`), every `leaseMs / 3` while any run is active: one statement for all of them. A run missing from the result lost its lease (`abort('lost')`, no F1, `onInternal('heartbeat-failed')` with `CronLeaseLostError`); state `cancelling` aborts with `cancel`.

## Gotchas
- Abort is not finish: the slot stays taken until the handler's promise settles, so a handler that ignores its signal still blocks `overlap: 'skip'` — while its heartbeats land within `leaseMs`.
- `drain` is bounded: a handler still running after it keeps heartbeating; the heartbeat and timeout timers are unref'd, so it holds its lease but not the process. With `db` ended, heartbeats and F1 fail into `onInternal('heartbeat-failed')` and maintenance expires the run.
- A non-JSON result is stored as `null`.
- A failing F1 is reported without `onRunEnd`, and the run is later expired by maintenance as `lease-expired`.
- Durations and timeouts use client timers; due times never do.

## Tests
- `packages/pg-prime-cron/test/live/cron.test.ts`: timeout with a signal-ignoring handler, cancel of a running run, results, F1 matching nothing.
- `packages/pg-prime-cron/test/pg/cron.test.ts`: SIGKILL (lease expiry), cancel under skip (the slot stays taken until the cancelled handler settles, then a successor runs), a handler that outlives `close()`, a never-settling handler with `timeoutMs` does not keep a closed process alive.
- `packages/pg-prime-cron/test/unit/package.test.ts`: backoff vectors.
