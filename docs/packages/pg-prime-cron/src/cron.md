# packages/pg-prime-cron/src/cron.ts

## Purpose
`pgCron`: the per-process instance. It owns start-up (migrate, sync, LISTEN), the claim loop, handler dispatch to `runner.ts`, maintenance and every admin method. It calls the statements in `src/sql/*`, the planner and ticker, and the queue target in `src/target/queue.ts`.

## Public API
- `pgCron(config: CronConfig): Cron` — builds the instance; throws `UsageError` for a schedule declared twice. Defaults: schema `pgprime_cron`, `pollMs` 10 000, `leaseMs` 30 000, `maintenanceMs` 15 000, `graceMs` 10 000.
- `Cron` methods: `start`, `close`, `create`, `update`, `remove`, `pause`, `resume`, `enable`, `disable`, `trigger`, `cancel`, `get`, `list`, `runs`, `preview`, `prune`, `[Symbol.asyncDispose]`.

## Flow
1. `ensure()` (`cron.ts:112`) runs once, retried after a failure: `migrateOwnedSchema` (apply unless `autoMigrate: false`), refuses a version below the client's with `SchemaVersionError`, reads DB `now()` and upserts each declared schedule with `source: 'code'` (`write`, `:140`).
2. `start()` (`:315`): `ensure`, `startQueues` for queue targets when an `enqueuer` exists, `waker.listen()`, then `run()`. Heartbeats belong to the runner.
3. `iterate()` (`:211`): Q1 for the executable names (`mine()`, `:101`), then `tick(row)` per due row unless `maxConcurrent` is reached; a failing tick is reported and the next row continues.
4. `tick()` (`:147`): ticker from the row, `plan()`, then `advance` (nothing to fire), `queueTick` (queue target) or K1 `claim`; reports `onMisfire`/`onTick`, and a `running` claim starts the handler.
5. T2 `pickup` takes `pending` manual runs of this instance's handler schedules, up to the free capacity (max 100).
6. Every `maintenanceMs` locally: `maintain()` (`:256`) wins the `meta` gate or returns; then expire, reconcile, retain, and `pending-unclaimed` reporting.
7. The loop sleeps until the earliest `next_at` of its schedules (from DB time), clamped to 10 ms…`pollMs`, woken early by NOTIFY, `gap`, a finished run or `trigger()`.
8. `close()` (`:286`): stop the loop, `runner.drain(graceMs)`, UNLISTEN. It returns after at most 2 × `graceMs`; a handler still running keeps heartbeating until it settles. An aborted `signal` calls it, also when already aborted at construction, so `start()` then rejects.
9. Admin: `update`/`enable` lock the row in a transaction (`lockedUpdate`, `:298`) and write through `tx`; `pause`/`resume`/`disable` are one `setFlags`; each notifies the channel. `create` (`:328`) starts a queue target's queue (`startQueues`) before it writes the row.

## Gotchas
- C-D9: an instance claims only schedules in its own `defs` — declared or `create`d here; queue targets only with an `enqueuer`.
- The channel is `cron_<fnv(schema)>`; payloads are schedule names and only wake the loop.
- `update` merges the patch shallowly into the stored definition; for a code schedule the next `start()` of its owner rewrites it from code.
- `payloadOf` calls a function payload on the claiming instance; the handler receives the stored JSON copy returned by K1/T2, so ticks and manual runs see the same shape.
- A non-forced `remove` needs `running = 0` on the locked row, so a tick or trigger it waited on makes it refuse, not cascade-delete the new run.
- `remove({ force: true })` deletes schedule then runs (cascade): the reverse of F1's run → schedule lock order, so a concurrent finish can deadlock; PostgreSQL then aborts one of the two with `40P01`.
- A one-shot `at` in the past is stored as is (`first`, `:52`) so the misfire policy decides it.
- The default instance label reads `HOSTNAME`/`COMPUTERNAME` from `globalThis.process`; the build has no Node types.

## Tests
- `packages/pg-prime-cron/test/live/cron.test.ts` (tier 1, PGlite or `PG_PRIME_TEST_URL`): sync, runs, trigger/pickup, cancel, overlap, timeout, lost lease at finish, already-aborted `signal`, misfire, grid across restarts, limit, `at`, retention, admin, hooks, per-schedule isolation.
- `packages/pg-prime-cron/test/pg/cron.test.ts` (tier 2, direct and PgBouncer): 5-instance exactly-once, overlap under 3, SIGKILL, pickup by owner, cancel under skip, a handler outliving `close()`, misfire after downtime and past `endAt`, `remove` waiting on a trigger's row lock.
- Run: `pnpm --filter @pg-prime/cron test:live`, `PG_PRIME_TEST_URL=… pnpm --filter @pg-prime/cron test:pg`.
