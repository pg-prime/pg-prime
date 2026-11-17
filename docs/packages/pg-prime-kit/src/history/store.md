# packages/pg-prime-kit/src/history/store.ts

## Purpose
Reads and writes the `pgprime` history tables: migration rows and their state transitions, the deploy lease, checkpoint and superseded records, batched data-migration progress, and repeatable checksums.
Callers: `src/runner/run.ts`, `src/runner/status.ts`, `src/data/batch.ts` (`dataProgressSql`), CLI `baseline` (`beginRow`, `markApplied`, `readMigrationRows`), `doctor`, `lint`, `push`; re-exported (in part) from `src/index.ts`.
Callees: `history/schema.ts` (`HISTORY_SCHEMA`, `MigrationStatus`), `sql/ident.ts` (`quoteLiteral`).

## Public API
- `MigrationRow` — one `pgprime.migrations` row in camelCase; timestamps are server-formatted ISO strings.
- `NewMigrationRow` — the fields a writer supplies (no timestamps, no error).
- `readMigrationRows(client)` — all rows ordered by `seq, name COLLATE "C"`, the runner's own file order (every ordered read here uses `COLLATE "C"`).
- `currentFingerprint(rows)` — `fingerprintTo` of the last `applied`/`baselined` row in `(seq, name)` order, else null.
- `recordAppliedSql(row)` — the row as one literal `INSERT … ON CONFLICT (id) DO UPDATE` string, for execution inside the migration transaction.
- `beginRow(client, row)` — upserts a `running` row, clearing finish time and error.
- `markUncertain(client, id, index)` / `markStatementApplied(client, id, index, segment)` — each in its own `BEGIN`/`COMMIT`; the latter sets `statements_applied = GREATEST(…, index + 1)` and clears `statement_uncertain`.
- `segmentAppliedSql(id, applied, segment)` — a segmented file's progress as one literal `UPDATE` for the segment's own transaction: sets `statements_applied` and `segment_applied`, and keeps `statement_uncertain = applied` until the applied record clears it.
- `markApplied(client, id, applied)` — status `applied`, finish time, duration from `started_at`.
- `markFailed(client, row, error, applied)` / `RecordedError` — upserts a `failed` row with `error` jsonb.
- `LockRow`, `readLease`, `takeLease(client, runId, holder)`, `heartbeatLease(client, runId)`, `releaseLease(client, runId)`, `breakLease(client)` — the singleton lease; `breakLease` returns whether a row was deleted.
- `recordSuperseded(client, file, engineVersion, appliedFrom)` — inserts a `superseded` row with zero statements applied; `ON CONFLICT DO NOTHING`.
- `recordCheckpoint(client, id, fingerprint)` / `readCheckpointRows(client)` / `CheckpointRow` — `pgprime.checkpoints`.
- `DataProgress`, `EMPTY_WATERMARK`, `readDataProgress(client, id)`, `readAllDataProgress(client)`, `dataProgressSql(p)` — batch progress; `dataProgressSql` is a literal upsert for use inside the batch transaction.
- `RepeatableRow`, `readRepeatableRows(client)`, `upsertRepeatable(client, path, checksum, durationMs)` — `pgprime.repeatables`.

## Flow
1. Transactional file: the runner appends `recordAppliedSql` to the file's last transactional segment, so the row commits with the DDL (`packages/pg-prime-kit/src/history/store.ts:144-167`).
2. `txmode none` file: `beginRow` → per statement `markUncertain` then `markStatementApplied` → `markApplied` (`:170`, `:203`, `:210`, `:228`).
3. Any failure: `markFailed` outside the migration transaction, upserting `status = 'failed'` with the error (`:256-290`).
4. Lease: `takeLease` overwrites the singleton, `heartbeatLease` bumps `heartbeat_at` for the matching `run_id`, `releaseLease` deletes only that `run_id` (`:312-330`).
5. Batch progress: `dataProgressSql` writes `{ formatVersion: 1, statement, iterations, values, done }` as `watermark` jsonb and `rows_done` separately (`:497-509`); `toProgress` parses it back (`:457-470`).

## Gotchas
- `recordAppliedSql` and `dataProgressSql` interpolate values with `quoteLiteral` because they run as plain statement text; every other writer is parameterised (`packages/pg-prime-kit/src/history/store.ts:1-9`).
- `recordAppliedSql` computes `duration_ms` from `transaction_timestamp()` to `clock_timestamp()`, so it only means anything inside the migration transaction (`:153-154`).
- `readLease` reports `heartbeatAgeMs` computed server-side, so client clock skew cannot mark a lease stale (`:296`).
- `markFailed` on conflict keeps the existing row's checksum, plan and fingerprints; only status, counters, finish time, duration and error change (`:268-272`).
- `recordSuperseded` never overwrites an existing row (`:367`) and stores `fingerprint_from` as NULL.
- Timestamps are rendered by `to_char(… AT TIME ZONE 'UTC', …)` with a literal `Z` suffix (`:64`).
- `DataProgress.done` is written per iteration as "this statement reported zero rows" (see `packages/pg-prime-kit/src/data/batch.ts:271`), not as "every statement finished".
- `currentFingerprint` relies on rows already sorted by `(seq, name)`, as `readMigrationRows` returns them.

## Tests
- `packages/pg-prime-kit/test/runner/history.test.ts` — lease take/release/break round-trip alongside the schema checks.
- `packages/pg-prime-kit/test/runner/failure.test.ts`, `resume.test.ts`, `lock.test.ts` — row states after failures, crash resume and lock contention via `readMigrationRows`/`readLease`.
- `packages/pg-prime-kit/test/data/batch.test.ts` — `data_progress` after a SIGKILL resume; `test/checkpoint/checkpoint.test.ts` — superseded rows and checkpoint records.
- All need a server (`PG_PRIME_TEST_URL` or localhost port 54329 (`packages/pg-prime-kit/test/support/db.ts:42`)). Run: `pnpm --filter @pg-prime/kit exec vitest run test/runner/history.test.ts`.
- Uncovered: `readCheckpointRows` has no caller in `src/` (only `packages/pg-prime-kit/test/checkpoint/checkpoint.test.ts:22`); `heartbeatLease` is covered only through `lock.test.ts`.
