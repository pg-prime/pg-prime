# packages/pg-prime-cron/src/sql/maintenance.ts

## Purpose
Periodic upkeep run by one instance per `maintenanceMs`: the gate, lease expiry, counter reconcile, retention and the pending-unclaimed probe. Called by `maintain()` in `cron.ts`.

## Public API
- `gate(q, t, everyMs)` — CAS on `meta.maint_at`; one row means this instance runs maintenance now.
- `expire(q, t)` — up to 500 runs past `lease_until`: `running` → `failed`, `cancelling` → `cancelled`, `error = 'lease-expired'`.
- `reconcile(db, t): Promise<number>` — recounts `running` for up to 500 schedules; returns how many changed.
- `retain(q, t)` — deletes up to 1 000 finished runs beyond `keep_runs` or older than `keep_runs_ms`.
- `unclaimed(q, t, leaseMs)` — count of `pending` runs older than `leaseMs`.

## Flow
1. `expire` (`maintenance.ts:9`) locks with `skip locked`, updates the runs, then decrements each schedule by a grouped count.
2. `reconcile` (`:28`), lock-then-count: statement 1 locks schedules with `running > 0` or an open run; statement 2, with a fresh snapshot, sets `running` to the count of open runs.
3. `retain` (`:49`) uses `runs_history` per schedule: the cutoff is the id at offset `keep_runs`.

## Gotchas
- `expire` must group by schedule: `update … from f` with two runs of one schedule would update the row once and decrement by one.
- Expiry never re-runs a tick (C-D8).
- Plan 18 §3.7 locks only `running > 0`; the code also locks schedules with an open run, so a counter that drifted low is repaired too.

## Tests
- `packages/pg-prime-cron/test/unit/sql.test.ts`: gate, expire, retain, unclaimed goldens.
- `packages/pg-prime-cron/test/pg/cron.test.ts` (SIGKILL: expiry and the freed slot), `packages/pg-prime-cron/test/live/cron.test.ts` (retention).
