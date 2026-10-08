# packages/pg-prime-cron/src/target/queue.ts

## Purpose
The seam for the `@pg-prime/mq` queue target (plan 18 §6, workstream C4). `cron.ts` calls it from `start()`, `tick()` and `trigger()`; every function currently rejects with `UsageError('queue target not implemented')`.

## Public API
- `QueueContext` — `{ db, t, enqueuer, instance }`, built when `CronConfig.enqueuer` is set.
- `startQueues(c, defs)` — rejects when `defs` (the declared queue-target schedules) is non-empty.
- `queueTick(c, def, row, plan, payload)` — rejects; will run K1 with `decided` `'enqueued'`/`'missed'` and `send` in one transaction.
- `queueTrigger(c, def, payload)` — rejects; will enqueue a manual run directly, never `pending`.

## Flow
1. `start()` → `startQueues` only when an `enqueuer` exists.
2. `tick()` routes a queue-target row here instead of K1.
3. `trigger()` routes a locally declared queue-target schedule here; elsewhere T1 matches no row and `trigger` throws `UsageError`.

## Gotchas
- Without an `enqueuer`, queue-target schedules are synced but never claimed by that instance (C-D9).
- Q1 already returns `overlap` and `payload` for the overlap mapping.

## Tests
- `packages/pg-prime-cron/test/live/cron.test.ts` ("a queue target is a seam until the mq target lands").
