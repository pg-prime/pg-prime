# packages/pg-prime-mq/src/queue/context.ts

## Purpose
The `Message` view and the `WorkContext` a handler receives: progress, spawn, child results,
transactional completion and the deferral sentinels the worker settles.

## Public API
- `Message<T, R>`, `WorkContext<T, R>`, `Deferral`, `ChildStatus`.
- Internal: `message(row, payload)`, `workContext(core, def, running)`, `isDeferral(v)`,
  `assertTxSettle(def)`, `Running`.

## Flow
1. `complete(result, { tx })` refuses a global-`concurrency` queue, marks the run `inTx` (out of the heartbeat set), then runs the completion in `tx` (packages/pg-prime-mq/src/queue/context.ts:117).
2. `transaction(fn)` is `db.transaction` with `complete` as its last statement.
3. `defer`, `rateLimit`, `waitForChildren` return frozen objects registered in a `WeakSet`.

## Gotchas
- `complete({ tx })` holds the message (and group) row until the caller commits: last statement only.
- `childResults()` keys are `'<queue>:<id>'`; values survive the child's retention.

## Tests
- `test/live/work.test.ts` (transactions, indeterminate matrix), `test/live/flow.test.ts` (spawn). `pnpm --filter @pg-prime/mq test:pg`.
