# packages/pg-prime-kit/src/data/

## Purpose
Batched, resumable data migrations (`-- pg-prime:batch` files): `batch.ts` re-executes one statement in its own transaction per iteration until it reports zero rows, persisting progress in the same transaction; `lag.ts` reads replica lag so iterations wait under `max-replica-lag`.
Callers: `src/runner/run.ts` (`runBatchStatement` from `runBare`, `BatchEvent`/`LagEvent` in `RunnerEvent`), `src/generate.ts` (`GUC_BATCH_SIZE`, `GUC_WATERMARK` in the `generate --data` template); all exports re-exported from `src/index.ts`.
Callees: `history/store.ts` (`dataProgressSql`, `DataProgress`), `history/schema.ts` (`HISTORY_SCHEMA`), `db/pg.ts` (`withClient`, `ConnInfo`), `runner/files.ts` (`BatchDirective` type).

## Public API
- `runBatchStatement(client, sql, statement, state, options)` (`batch.ts`) → `BatchOutcome` `{ rowsDone, iterations, watermark }`; cumulative totals across the migration. Throws `BatchStalledError` or the SQL error.
- `BatchOptions` — `migrationId`, `directive`, `replicas?`, `resumeFrom?`, `sleep?`, `onEvent?`, `onInfo?`, `lockTimeout?`, `statementTimeout?`.
- `BatchEvent` — `kind: "batch"`, per committed iteration: `migration`, `statement`, `iteration` (local), `rows`, `rowsDone`, `watermark`.
- `LagEvent` — `kind: "lag"`, `state: "waiting" | "resumed" | "absent"`, `lagMs`, `ceilingMs`, `reading`.
- `BatchStalledError` — `code = "PG_PRIME_BATCH_STALLED"`: watermark not advancing, or `max-iterations` reached.
- `GUC_BATCH_SIZE` / `GUC_WATERMARK` — `"pgprime.batch_size"` / `"pgprime.watermark"`, set per iteration for the statement to read.
- `STALL_LIMIT` — `3`.
- `readPrimaryLag(client)` (`lag.ts`) — worst `pg_stat_replication.replay_lag` in ms; `lagMs: null` when no row is visible.
- `readReplicaLag(replicas)` — connects to each `ConnInfo` and derives lag from `pg_last_xact_replay_timestamp()` when receive and replay LSNs differ; an unreachable replica yields `Infinity`.
- `LagReading` — `{ lagMs, replicas, source: "primary" | "replicas", detail }`.

## Flow
1. The runner reads `pgprime.data_progress` before the file and threads it in as `state` (`packages/pg-prime-kit/src/runner/run.ts:812-813`, `:1056`).
2. Per iteration, `waitForLag` returns immediately with no ceiling; otherwise it polls primary or replica lag every `max(pause, 100)` ms while over the ceiling (`packages/pg-prime-kit/src/data/batch.ts:152-219`).
3. `BEGIN`; `set_config(..., true)` for `lock_timeout` (when given), `statement_timeout` (default `"0"`), `pgprime.batch_size`, and `pgprime.watermark` (`""` when none) (`packages/pg-prime-kit/src/data/batch.ts:250-260`).
4. Execute the statement; read `rows_done`/`watermark` columns from a single result row, else the command-tag `rowCount` with no watermark (`packages/pg-prime-kit/src/data/batch.ts:126-140`, `:261-262`).
5. Write `dataProgressSql` with the new totals in the same transaction, then `COMMIT`; any error rolls back and rethrows (`packages/pg-prime-kit/src/data/batch.ts:264-278`).
6. After commit: update totals, emit a `batch` event; zero rows ends the statement (`packages/pg-prime-kit/src/data/batch.ts:280-302`).
7. A reported watermark equal to the previous one increments a stall counter; at `STALL_LIMIT` throw. `maxIterations > 0` bounds local iterations. Then sleep `pauseMs` (`packages/pg-prime-kit/src/data/batch.ts:304-323`).

## Gotchas
- `data_progress` is written inside the batch transaction, so a crash cannot lose or double-count a committed batch (`packages/pg-prime-kit/src/data/batch.ts:38-43`).
- A statement with no row count (DDL) reports 0 and runs exactly once (`packages/pg-prime-kit/src/data/batch.ts:137-139`).
- The stall check applies only to statements that report a watermark; others rely on their predicate and `max-iterations` (`packages/pg-prime-kit/src/data/batch.ts:304`).
- `waitForLag` never gives up: lag above the ceiling blocks until it drops or the process is killed (`packages/pg-prime-kit/src/data/batch.ts:146-151`).
- No visible replica (`lagMs: null`) is a no-op with one `absent` event and one `onInfo` line per `runBatchStatement` call (`packages/pg-prime-kit/src/data/batch.ts:169-191`), so once per batched statement.
- An unreachable configured replica counts as infinite lag and keeps the loop paused (`packages/pg-prime-kit/src/data/lag.ts:88-92`).
- `BatchOptions.resumeFrom` is declared but unused; resume state arrives through `state` (`packages/pg-prime-kit/src/data/batch.ts:99`).
- `statementTimeout` defaults to `"0"` (no limit) when the caller passes none (`packages/pg-prime-kit/src/data/batch.ts:255`).
- `DataProgress.done` is set to "this statement reported zero rows", not "the whole file is done" (`packages/pg-prime-kit/src/data/batch.ts:271`).

## Tests
- `packages/pg-prime-kit/test/data/batch.test.ts` (server for the first three suites): SIGKILL after two batches then resume from the watermark with no double write; `max-replica-lag` with no visible replica runs and says so once; a non-advancing watermark stops with the position recorded; directive parsing (no server).
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/data/batch.test.ts` (`PG_PRIME_TEST_URL` or localhost port 54329 (`packages/pg-prime-kit/test/support/db.ts:42`)).
- Uncovered: `readReplicaLag`, lag above the ceiling (`waiting`/`resumed` events), the `max-iterations` refusal.
