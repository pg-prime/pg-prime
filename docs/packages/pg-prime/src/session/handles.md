# packages/pg-prime/src/session/handles.ts

## Purpose
Builds the runtime `Db` / `Tx` / `Session` handles: each is an `ExecutorImpl` from
`packages/pg-prime/src/query/cte.ts` with session methods installed as non-enumerable properties. Owns the
transaction lifecycle (retry loop, `BEGIN`/`COMMIT`/`ROLLBACK`, savepoints, indeterminate commit), sessions,
advisory locks, `notify`, COPY and `refreshMaterializedView`. `pgPrime` installs the root members
(`packages/pg-prime/src/query/run.ts:379`, `packages/pg-prime/src/query/run.ts:400`); handle types in
`packages/pg-prime/src/query/types.ts:121` import its API types. Callees: `./runner.ts`, `./transaction.ts`,
`./copy.ts`, `./guard.ts`, `explainWith`, `streamOn` / `streamBatchesOn`.

## Public API
- `install(target, name, value)` / `installGetter(target, name, get)` — non-enumerable, configurable
  method / getter definitions.
- `installQueryable(handle, state, runner, kind)` — installs `kind`, `schema`, `run`, `explain`, `stream`,
  `streamBatches`, `notify`, `copyFrom`, `copyTo`, `refreshMaterializedView`; plus `withOptions` / `outsideTransaction` for `'db'`.
- `attachDeps(runner, deps)` — stores `TxDeps` on a runner under a private symbol for scoped clones.
- `TxDeps` — `{ state, ctxSeed, handles }`, the seeds every handle is built from.
- `runTransaction(deps, parentDepth, a, b)` — `db.transaction(fn, opts?)` / `(opts, fn)` with retry;
  resolves the callback's value, or the `rollbackWith` value.
- `makeTxHandle(deps, conn, tx, shape, extra?)` — a `Tx` handle on a held connection.
- `runSession(deps, fn)` — `db.session(fn)`; throws `UnsupportedInPoolerModeError` under a transaction profile.
- `RefreshMaterializedViewOptions` — `{ concurrently? }`, overriding the view's `.refreshable()` setting.
- `refreshSql(view, opts?)` — `refresh materialized view [concurrently] "schema"."name"`; throws `UsageError`
  for anything but a `pgMaterializedView`.
- `CopyFromApi` — `copyFrom(table, rows, opts?)` and `copyFrom.raw(sql, bytes, opts?)`, both resolving `CopyResult`.
- `CopyRows` — sync or async iterable of row records. `CopyToApi` — `copyTo(sql, opts?)` bytes and `.lines()`.
- `isTransactionPooled` — re-exported from `packages/pg-prime/src/pooler/profiles.ts:101`.

## Flow
1. `runTransaction` resolves isolation, access mode, label, retry, `timeoutMs`, `lockTimeoutMs` from options
   over `state.transaction` defaults, builds `BEGIN`, and loads the guard store when `devGuard` is on
   (`packages/pg-prime/src/session/handles.ts:343`).
2. Each attempt emits `transactionStart`, runs `once`, and emits `transactionEnd` in `finally`
   (`packages/pg-prime/src/session/handles.ts:377`).
3. `once` acquires a connection, sends `BEGIN`, then one `set_config(…, true)` batch for `localSettings` and
   the two timeouts (`packages/pg-prime/src/session/handles.ts:485`).
4. The callback runs inside `withFrame` with a `Tx` handle (`packages/pg-prime/src/session/handles.ts:508`).
   `rollbackWith(v)` throws a private sentinel caught here; it and a doomed `tx` end in `ROLLBACK`.
5. Otherwise `commitWritten` is set around `COMMIT` (`packages/pg-prime/src/session/handles.ts:523`); a lost
   connection while it is set raises `IndeterminateCommitError` and disposes the connection.
6. Other failures are mapped, `ROLLBACK` is attempted, and a failed rollback disposes the connection
   (`packages/pg-prime/src/session/handles.ts:559`).
7. `finally` disposes a connection whose `transactionStatus` is `'T'` or `'E'` (with a warning) or that is
   not `usable` (`packages/pg-prime/src/session/handles.ts:570`).
8. `shouldRetry` refuses `IndeterminateCommitError`, `AbortError` and `UsageError`, then retries listed
   SQLSTATEs, subject to the user's `shouldRetry` (`packages/pg-prime/src/session/handles.ts:593`).
9. A retry warns on the first attempt only, emits the `retry` hook and `onRetry`, and sleeps an unref'd
   timer (`packages/pg-prime/src/session/handles.ts:412`).
10. `tx.savepoint` / `tx.transaction` issue `SAVEPOINT "pgprime_sp_<depth>"`, optional `set_config`, then
    `RELEASE`, or `ROLLBACK TO` + `RELEASE` on error or `rollbackWith`, clearing `poison`
    (`packages/pg-prime/src/session/handles.ts:737`).
11. `runSession` pins one connection, runs the callback inside `withoutFrames`, and offers `set`,
    session `advisoryLock`, `backendPid` and `transaction` (`packages/pg-prime/src/session/handles.ts:964`).
12. `s.transaction` sends `BEGIN` on the pinned connection and commits or rolls back without retry
    (`packages/pg-prime/src/session/handles.ts:1037`).
13. COPY: `copyFrom` resolves columns, encodes rows and calls `conn.copyIn` via `runner.use`; `copyTo` streams
    `conn.copyOut` through `runner.scope` (`packages/pg-prime/src/session/handles.ts:899`).

## Gotchas
- A user `shouldRetry` returning `true` makes a SQLSTATE outside `retry.on` (or an error with none, reported
  as `'unknown'`) retryable (`packages/pg-prime/src/session/handles.ts:610`); the three exclusions still win.
- `tx.rollback()` throws `TransactionRollback`, a `UsageError`, so it is never retried.
- `once` acquires with `a.signal ?? state.signal` (`packages/pg-prime/src/session/handles.ts:468`): a
  per-transaction signal replaces the db lifecycle signal for the checkout.
- Any error escaping a `db.session()` callback disposes the pinned connection
  (`packages/pg-prime/src/session/handles.ts:1021`), even a plain application error.
- `s.transaction()` ignores `state.transaction` defaults, `retry`, `timeoutMs`, `lockTimeoutMs` and
  `localSettings`, and does not map errors itself; it copies the session `TxRuntime`, including its cached
  `localTimeoutMs` (`packages/pg-prime/src/session/handles.ts:1054`).
- `runSavepoint` updates only the child's `localTimeoutMs` (`packages/pg-prime/src/session/handles.ts:764`);
  `RELEASE SAVEPOINT` keeps a `SET LOCAL` value server-side, so the parent's cached timeout can then be stale.
- Savepoints do not push a guard frame and are not retried; a `40001` aborts the whole transaction.
- `withOptions` on a `Tx` / `Session` rebuilds the same handle kind; on the root it is a plain scoped
  `Queryable` (`packages/pg-prime/src/session/handles.ts:215`).
- `notify` uses `pg_notify($1,$2)` and works inside a transaction (delivered on commit) and in every pooler mode.
- `stream` / `streamBatches` forward only `signal`, `label`, `statementTimeoutMs` to the runner and
  `batchSize`, `signal`, `statement` to the cursor (`packages/pg-prime/src/session/handles.ts:223`);
  `timeoutMs` and `outsideTransaction` on a stream call are not applied.
- Session advisory locks are refused when `profile.sessionAdvisoryLocks === 'unsupported'`; `Tx.advisoryLock`
  uses the `_xact_` family and resolves `true` unless `try` was asked.

## Tests
- `packages/pg-prime/test/session/session.test.ts` — `:333` advisory locks, `:367` rollback/rollbackWith,
  `:420`/`:463` retry, `:624` IndeterminateCommitError, `:668` non-idle connection destroyed, `:1161`
  handles/`withOptions` kinds, `:1425` streamBatches. Run:
  `pnpm --filter pg-prime exec vitest run test/session/session.test.ts`.
- `packages/pg-prime/test/live/session.test.ts` — savepoints (`:129`), rollback (`:191`), `setLocal`
  (`:217`), streams (`:272`), transaction hooks (`:362`), COPY (`:387`); live project.
- `packages/pg-prime/test/pg/session.test.ts` — retry (`:99`), deadlock (`:180`), indeterminate commit
  (`:234`), advisory locks incl. a session lock surviving `s.transaction()` (`:322`); need `PG_PRIME_TEST_URL`.
- `refreshMaterializedView`: `packages/pg-prime/test/live-query/views.test.ts:124` (live) and
  `packages/pg-prime/test/pg/views.test.ts:108` (pg).
- Uncovered: `s.transaction()` rollback/error paths and savepoint timeout caching after `RELEASE`.
