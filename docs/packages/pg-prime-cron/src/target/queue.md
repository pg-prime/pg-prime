# packages/pg-prime-cron/src/target/queue.ts

## Purpose
The `@pg-prime/mq` queue target (plan 18 §6): a queue-target tick or manual run claims its run and sends its message in one short transaction. It talks to mq only through the structural `CronEnqueuer`, so `dist` never names `@pg-prime/mq`.

## Public API
- `QueueContext` — `{ db, t, enqueuer, instance }`, built when `CronConfig.enqueuer` is set.
- `startQueues(c, defs)` — awaits `enqueuer.queue(def).start?.()` for each declared queue-target schedule, so `{ tx }` sends are allowed.
- `queueTick(c, def, row, plan, payload)` — K1 with `decided: plan.decided ?? 'enqueued'`, then `send`; returns `{ runId, state }`, or `undefined` when another instance won the claim.
- `queueTrigger(c, def, payload)` — inserts a manual run (`enqueued`, never `pending`), then `send`; returns `{ runId, state }`.

## Flow
1. `cron.start()` → `startQueues` when an `enqueuer` exists.
2. `tick()` routes a queue-target row to `queueTick`: K1 inside `db.transaction`. A `missed` run (misfire `skip`) is returned without sending.
3. Otherwise `send(storedPayload, { tx, key })` on the schedule's own declared queue. Keys: `overlap: 'skip'` → `cron:<name>` with `dedup: 'until-done'`; `'allow'` → `cron:<name>:<tick ms>` or `cron:<name>:manual:<run id>`.
4. The run gets `message_id` and `finished_at`; a deduplicated send makes it `skipped` (the holder's id is recorded).
5. `trigger()` routes a locally declared queue-target schedule to `queueTrigger`; the payload is the caller's, else the stored one.

## Gotchas
- Claim and send commit together: a crash before COMMIT leaves neither, and the tick is claimed again on a later loop (within `misfireGraceMs`).
- Without an `enqueuer`, queue-target schedules are synced but never claimed by that instance (C-D9), and `trigger()` throws `UsageError`.
- `running` never moves for a queue target: overlap is mq's dedup, decided on mq's locked dedup row.
- mq rejects a `null` payload (its `messages.payload` is `not null`), so a queue-target schedule needs a payload.

## Tests
- `packages/pg-prime-cron/test/unit/queue-target.test.ts` — `pgMq(...)` satisfies `CronEnqueuer`.
- `packages/pg-prime-cron/test/live/queue-target.test.ts` (PGlite or `PG_PRIME_TEST_URL`) — `start()` starts a bare `pgMq`, one message per tick, overlap `skip` dedup, misfire `skip` sends nothing, manual trigger, instances without the queue or an enqueuer.
- `packages/pg-prime-cron/test/pg/queue-target.test.ts` (tier 2) — one message per tick across 3 instances with transactions failing after the send; direct and PgBouncer transaction mode.
