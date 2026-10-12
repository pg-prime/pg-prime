# packages/pg-prime-cron/src/sql/claim.ts

## Purpose
The statements that start runs: Q1 (due select), the loop's wake-up query, K1 (the tick claim), `advance`, T1 (manual trigger) and T2 (pickup). Built on pg-prime's `sql` tag against `tables(schema)`; called by `cron.ts`, and by the queue target for K1.

## Public API
- `due(q, t, mine)` — Q1: due, enabled, unpaused schedules named in `mine`, with `now() as db_now`; no locks; 100 rows.
- `wakeIn(q, t, mine)` — milliseconds to the earliest `next_at`, or `null`.
- `claim(q, t, ClaimArgs)` — K1; returns `id, state, token, payload` of an inserted run, or no row.
- `advance(q, t, name, expect, next)` — CAS on `next_at` without a run.
- `trigger(q, t, { name, instance, payload, channel })` — T1 for handler schedules; no row for a queue target or an unknown name.
- `pickup(q, t, { mine, limit, leaseMs, instance })` — T2; `pending` → `running` with a fresh token.

## Flow
1. K1 (`claim.ts:54`): `s` locks the schedule `where next_at = $expect and enabled and not paused for update`.
2. `d` decides: `$decided` (`'missed'`, `'enqueued'`) wins; else `running = 0 or overlap = 'allow'` → `running`, otherwise `skipped`.
3. `r` inserts the run at `$fire` with token/lease only when `running`; `on conflict … do nothing`.
4. `u` always moves `next_at`; `runs += count(r)`, `running += count(r where running)`.
5. T1 (`:92`) has the same shape keyed by name with `manual = true`, state `pending` (counted) or `skipped`, and a `pg_notify` CTE referenced from the final select.

## Gotchas
- Exactly once per tick (C-D4): at READ COMMITTED a concurrent claimer that already moved `next_at` makes EvalPlanQual re-check `s` on the new row version, which fails `next_at = $expect`, so the loser matches no row. `runs_tick` refuses a duplicate tick even if `next_at` were recomputed onto an already-run tick.
- Overlap (C-D6) is read from `running` on the row `s` locked, never by counting other rows (15 §0.5 rule 3): every statement that moves `running` holds that same row lock.
- `u` is driven by `d`, not `r`: `next_at` advances even when the insert conflicted, so a loop never sticks on a tick; counters move only for an inserted run.
- `$expect` must equal the stored value exactly; `next_at` is always written from JS Dates (millisecond precision), never from `now()`.
- K1 locks the schedule row and inserts a new run; it never waits on an existing run, so it cannot deadlock with F1 (run → schedule).
- T2 joins `schedules` for `timeout_ms`/`retry` without locking it.

## Tests
- `packages/pg-prime-cron/test/unit/sql.test.ts`: goldens for Q1, K1 (handler, missed, enqueued), advance, T1, T2; no statement modifies one table twice.
- `packages/pg-prime-cron/test/pg/cron.test.ts`: "tick fires once across 5 instances", overlap, manual pickup.
