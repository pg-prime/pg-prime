# packages/pg-prime-cron/src/sql/schedules.ts

## Purpose
Schedule-row statements for sync and the admin API, the row decoders, and (in `sql/tables.ts`) the quoted table names and SQL helpers every statement module shares.

## Public API
- `upsert(q, t, Upsert, replace)` — insert; with `replace`, update a changed definition (`spec_hash`), else `do nothing`; returns the name when written.
- `select(q, t, name?)`, `lock(q, t, name)` — rows (`lock` adds `for update` and `db_now`).
- `setFlags(q, t, name, { paused?, enabled?, next? })` — one update; no row for an unknown name.
- `remove(q, t, name, force)` — returns `deleted` and `present` counts; without `force` it needs `running = 0` and no open run.
- `prune(q, t, keep)`, `history(q, t, name, limit, before)`, `dbNow(q)`, `toInfo(row)`, `toRun(row)`.
- `tables(schema)`, `ms(n)`, `json(v)`, `OPEN` (`sql/tables.ts`).

## Flow
1. Sync (`schedules.ts:25`): `on conflict (name) do update … where x.spec_hash <> excluded.spec_hash`.
2. `anchor_at` and `next_at` change only when the timing tuple (pattern, every, at, tz, start, end, limit) changed; `next_at` stays `null` while disabled and is `null` when `runs >= limit`.
3. `paused` and `enabled` are never written by sync.

## Gotchas
- `running = 0` is rechecked against the row version committed by a tick or trigger that held its lock; the `not exists` over runs is evaluated once from the statement snapshot, so it alone would miss that run and the cascade would delete it.
- `remove` reports `present` from the statement's snapshot, so `present = 1, deleted = 0` means open runs blocked it.
- `toInfo` rebuilds `when` from whichever of pattern/every/at is set.

## Tests
- `packages/pg-prime-cron/test/unit/sql.test.ts`: sync upsert, api insert and remove goldens.
- `packages/pg-prime-cron/test/live/cron.test.ts` ("sync updates a changed definition and keeps operational flags", "admin").
