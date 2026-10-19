# packages/pg-prime-kit/src/runner/run.ts

## Purpose
`migrate apply`: applies pending migration files to one database under a session advisory lock plus a heartbeat lease, records every step in `pgprime.migrations`, then re-applies changed repeatables.
Callers: `src/cli/commands/apply.ts`, `verify.ts` (`applyPending`), `unlock.ts` and `doctor.ts` (`inspectLease`, `forceUnlock`), `src/runner/status.ts` (`inspectLease`, `NO_REPEATABLES`), the package barrel `src/index.ts`.
Callees: `runner/files.ts` (read and shape files), `runner/apply.ts` (segments, lock, pooler probe, GUCs), `history/schema.ts` + `history/store.ts` (rows, lease, progress), `checkpoint/checkpoint.ts` (jump and drift naming), `data/batch.ts` (batched files), `catalog/extract.ts` (live fingerprint).

## Public API
- `applyPending(conn, migrationsDir, options?)` — opens its own `pg.Client`, wires the strict pooler probe and a second heartbeat connection, runs `applyPendingOn`. Throws `PoolRefusedError` when `conn` has `query`/`connect`.
- `applyPendingOn(client, migrationsDir, options?)` — the same run on a caller-owned connection (caller guarantees it is dedicated and direct). Returns `ApplyPendingResult`; rethrows non-SQL errors after releasing the lock.
- `ApplyPendingOptions` — `schemas` (default `["public"]`), `to`, `dryRun`, `dev`, timeouts, lock wait/stale/heartbeat ms, `verifyFingerprint`, `repeatables`/`repeatablesDir`, `replicas`, `checkpoints: "auto" | "ignore"`, and test seams (`sleep`, `random`, `retryBaseMs`, `poolerProbe`, `heartbeatConnection`, `onEvent`).
- `ApplyPendingResult` — `status` (`RunnerStatus`), `exitCode` (via `RUNNER_EXIT`), `applied`, `pending`, `warnings`, `preflight`, `repeatables`, `lock`, `fingerprint`, `dryRun` (captured queries or null), `error`, `diagnostics`, `durationMs`.
- `AppliedMigration`, `PreflightReport`, `RepeatablesReport`, `LockReport`, `IssuedQuery` — report pieces; `AppliedMigration.batch` is non-null only for `-- pg-prime:batch` files.
- `RunnerFailure` — `code` is one of `transaction_pooler`, `pool_connection`, `missing_file`, `checksum_drift`, `fingerprint_mismatch`, `unknown_target`, `plan_invalid`, `lock_unavailable`, `sql_error`; optional SQLSTATE, statement, attempts, `drift`.
- `RunnerEvent` — `lock`, `migration` (start/done/retry/failed), `statement`, `BatchEvent`, `LagEvent`, `warning`.
- `NO_REPEATABLES` — a `RepeatablesPass` that plans nothing; the default when `options.repeatables` is absent.
- `resumeFrom(row)` — restart index for a `txmode none` file: `statementsTotal` when settled, `statementsApplied` on a clean boundary, `0` when `statementUncertain` is set.
- `backoff(attempt, base, random)` — exponential with jitter in `[0.5, 1]` of the ceiling, capped at 5000 ms.
- `inspectLease(client, staleAfterMs?)` / `LeaseInspection` — read-only lease view; `{ lease: null }` when history is absent.
- `forceUnlock(client)` — deletes the lease row (`breakLease`); `false` when history is absent. Cannot release a live session lock.
- `PoolRefusedError` — `code = "PG_PRIME_POOL_REFUSED"`.

## Flow
1. `applyPending` rejects pool/client-shaped `conn` (`packages/pg-prime-kit/src/runner/run.ts:377`) and delegates inside `withClient` (`:379`).
2. Pooler probe; a positive answer returns `refused` / `transaction_pooler` naming the server port (`:470`).
3. `ensureHistory`, or under `--dry-run` only `historyPresent` plus a warning (`:487`); `readMigrationsDir` (`:495`).
4. Lock (skipped under dry-run): poll `acquireSessionLock` every 250 ms until `lockWaitMs` (`:511-518`). The loser re-reads history and returns `up_to_date` when nothing is pending, else `locked` with stale-lease advice (`:521-542`).
5. Winner calls `takeLease` and starts a `setInterval` heartbeat on the second connection, or on the migration connection with a warning if it cannot open (`:549-568`).
6. Reconcile: a history row without a file is `missing_file` unless `leftNothing` (a `transactional` file that failed and rolled back whole); a settled row whose checksum differs is `checksum_drift` (a warning under `dev`) (`:589-620`).
7. Checkpoints: empty history + `checkpoints !== "ignore"` jumps to the newest `NNNN_checkpoint`; files before it, or unrecorded checkpoint files otherwise, are written `superseded` (`:637-664`).
8. Select pending; `--to` trims at the target or fails `unknown_target` (`:667-683`). The session gets `row_security = off` (design/20 D20) (`:686`); pre-flight `sweep` lists INVALID indexes, NOT VALID constraints and `_ccnew` leftovers (`:687`, `:1155`), and `rlsDataFiles` adds an `RL107` diagnostic plus warning for each pending data/batch file naming an RLS-enabled table when the role is neither superuser nor `BYPASSRLS` (`:691`, `:1203`).
9. Per file: `executionPlan` error → `plan_invalid`; plan sha256 ≠ file checksum → `checksum_drift`; plan `schemas` ≠ run schemas → `fingerprint_mismatch` (`:702-766`).
10. Fingerprint gate against `plan.from.fingerprint`, using the recorded fingerprint or a fresh `extractCatalog`; a mismatch calls `describeDrift` to name objects (`:769-808`). No plan → warning, no gate (`:810`).
11. `runFile` dispatch (`:820`). Transactional/segmented: the history `INSERT` (`recordAppliedSql`) is appended to the last transactional segment; segments run one at a time through `applySegments`, skipping statements below `statements_applied`, with `markSegmentApplied` after every committed segment but the last. A retry, or a rerun after a failure or a crash, starts at the first uncommitted segment (`:973-1000`).
12. `txmode none` (`runBare`, `:1014`): `beginRow`, then per statement `markUncertain` → execute (or `runBatchStatement` for batch files) → `markStatementApplied`; per-statement retries; `markApplied` at the end.
13. After each success the fingerprint advances to `plan.to` / `-- pg-prime:to`; a `-- pg-prime:checkpoint` file writes `pgprime.checkpoints` (`:849-855`).
14. `runRepeatables` plans with the pass, adds unchanged declared files that `healDeclared` finds out of line with the catalog (`:1246`), and applies changed files plus `upsertRepeatable` in one transaction (`:1235-1264`); `finish` releases lease and lock (`:571-585`).

## Gotchas
- Retry budgets count the first try: `55P03` 5, `40001` 5, `40P01` 2, `57014` 1, anything else 1 (`packages/pg-prime-kit/src/runner/run.ts:261`). Transactional files retry whole; bare files retry one statement.
- A segmented file never replays a committed segment: `statements_applied`/`segment_applied` advance after each commit, and a retry or rerun filters them out. A file with several segments writes a `running` row with `statement_uncertain` set before it starts; only the applied record clears it, so a row any multi-segment attempt touched is never withdrawable. `resumedFrom` is non-null when a rerun started past statement 0.
- A resumed `txmode none` file with `statement_uncertain` set restarts at statement 0 (`:333`); correctness relies on every statement being idempotent (TX201).
- `--dry-run` executes the real path against `CaptureClient` (`:279`), which returns no rows. It still runs the pooler probe, reads history, and may `extractCatalog` once for the gate.
- The lock deadline counts from the run start, so probe and `ensureHistory` time eat into `lockWaitMs` (`:512`).
- `runRepeatables` never calls `pass.apply`; it executes statements and records rows itself. A repeatable failure rolls the pass back and returns `status: "failed"` with a `sql_error` naming the `sql/` path and statement; `applied` still lists the migrations, which committed before it.
- `describeDrift` errors are swallowed; the message then falls back to "No checkpoint is available" (`:784`, `:799`).
- `sweep` matches findings to pending plans by substring over StableIds (`:1196`), so it can over-report.
- `row_security = off` is session-wide and never reset: RLS filtering a migration's rows becomes `42501` instead of a silent partial update. `rlsDataFiles` matches table names textually, so it can over-report.
- The doc comment at `:74-75` says the CLI binds `NO_REPEATABLES`; the CLI passes `createRepeatablesPass()` (`packages/pg-prime-kit/src/cli/commands/apply.ts:80`).
- `--to` matches id, zero-padded 4-digit seq, or name (`packages/pg-prime-kit/src/runner/run.ts:351`).

## Tests
- Live (need a server: `PG_PRIME_TEST_URL`, else localhost port 54329 per `packages/pg-prime-kit/test/support/db.ts:42`): `test/runner/apply.test.ts` (corpus chains twice, pool refusal), `dry-run.test.ts` (printed stream = executed stream), `failure.test.ts` (55P03 retries, 57014 never retried, rollback of DDL + row, segment resume on retry/rerun/crash, a failing repeatable; unit tests for `backoff`, `resumeFrom`), `fingerprint.test.ts` (gates, `--verify-fingerprint`, checksum drift, missing file, `--to`), `lock.test.ts` (loser exits 6, heartbeat during a long statement, loser exits 0), `resume.test.ts` (SIGKILL mid-CIC), `timeouts.test.ts`, `baseline.test.ts`, `row-security.test.ts` (RL107 and `42501` for a role without `BYPASSRLS`, a superuser applies; skips without `CREATE ROLE`).
- `test/runner/pooler.test.ts` skips unless `PG_PRIME_TEST_PGBOUNCER_URL` is set. Checkpoint jump/supersede: `test/checkpoint/checkpoint.test.ts`; batch resume: `test/data/batch.test.ts`; repeatables via the CLI: `test/cli/repeatables.test.ts`.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/runner`.
- Uncovered: the managed-schema-set refusal (`packages/pg-prime-kit/src/runner/run.ts:743-766`), `40001`/`40P01` budgets, the heartbeat-connection fallback warning, `touchedByPending` matching.
