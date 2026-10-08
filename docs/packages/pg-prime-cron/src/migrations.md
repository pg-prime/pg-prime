# packages/pg-prime-cron/src/migrations.ts

## Purpose
Migration v1 of the cron schema, applied by core's `migrateOwnedSchema` from `ensure()` in `cron.ts`, or vendored with `ownedSchemaSql`.

## Public API
- `migrations` (internal) — `[{ version: 1, name: 'init', up }]`; `up(schema)` returns one statement per element.

## Flow
1. `run_state` enum; `schedules` (fillfactor 50, `schedules_due` partial index); `runs` (fillfactor 80) with `runs_tick` unique `(schedule, tick_at) where not manual`, `runs_open`, `runs_running` on `lease_until`, `runs_history`; `meta` with one row (`maint_at = '-infinity'`).

## Gotchas
- `runs_tick` is the exactly-once backstop: K1's `on conflict (schedule, tick_at) where not manual` must match its predicate.
- Changing any statement changes the checksum: a released version is never edited, only followed by v2.
- `every_ms` and `keep_runs_ms` are `bigint`; queries cast them to `float8` so rows decode to numbers.

## Tests
- `packages/pg-prime-cron/test/live/cron.test.ts` ("migrates once and syncs code schedules", "refuses a missing schema with autoMigrate off").
