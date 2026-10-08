# packages/pg-prime-mq/src/queue/worker.ts

## Purpose
The consumer loop: claims up to the free slots, runs handlers, heartbeats every held lease, scans
for expired leases, runs maintenance, and settles each message once.

## Public API
- `Handler<T, R>`, `WorkerOptions`, `Worker` (`running`, `close({ graceMs? })`, async dispose).
- `startWorker(core, def, handler, opts?)` — internal; `QueueHandle.work` calls it.

## Flow
1. The loop opens `waker` on `engineChannel(schema, 'q', queue)` (packages/pg-prime-mq/src/queue/worker.ts:339).
2. Each turn: promote when woken or due, expiry scan and maintenance when due, then a claim round.
3. A claim round alternates S3/S4 and S5; a path that came back empty is skipped until an outside wake, a promotion or `pollMs` passes (a busy worker never waits on the waker) (packages/pg-prime-mq/src/queue/worker.ts:258).
4. S5 goes on from the worker's cursor; `claimGroups` moves it (packages/pg-prime-mq/src/sql/claim.ts:179).
5. Full: wait for a freed slot (or a timer); else wait on the waker for at most `pollMs`, the next due time or a rate window.
6. `runOne` decodes, calls the handler, then completes, moves (deferral), or fails/retries (packages/pg-prime-mq/src/queue/worker.ts:175).
7. After `ctx.complete({ tx })`, `afterTx` re-reads: completed or gone ⇒ done; still ours ⇒ the transaction rolled back, so a failed attempt (`indeterminate-commit`) (packages/pg-prime-mq/src/queue/worker.ts:160).
8. The heartbeat extends leases in one statement; a missing id is re-read: not ours ⇒ abort with `LeaseLostError`; `cancel` ⇒ `CancelledError` (packages/pg-prime-mq/src/queue/worker.ts:98).

## Gotchas
- `waitForChildren()` refused with nothing pending releases the message (runs again); with a failed `fail` child it fails.
- A failure after `close({ graceMs })` aborted the handler is a release (no attempt), not a retry.
- An in-transaction completion is never acknowledged alone: a rollback costs one attempt and a re-run.
- Statements other than claims, heartbeats and expiry go to `db`, not `controlDb`.

## Tests
- `test/live/work.test.ts`, `test/live/groups.test.ts`, `test/pg/concurrency.test.ts`, `test/pg/indeterminate.test.ts`. `pnpm --filter @pg-prime/mq test:pg`.
