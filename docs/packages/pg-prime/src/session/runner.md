# packages/pg-prime/src/session/runner.ts

## Purpose
Where a statement meets a connection. Implements the builder's `Runner` seam
(`packages/pg-prime/src/query/builder-state.ts`) twice — `PoolRunner` (checkout per operation) and
`ConnRunner` (a `Tx`/`Session` connection) — and wraps every statement with error mapping, hooks, slow-query
logging, call-site capture, per-statement timeouts, cancellation, session-GUC setup, the dev guard and the
concurrency warning. Built by `pgPrime` (`packages/pg-prime/src/query/run.ts:367`) and
`packages/pg-prime/src/session/handles.ts:663`; reached from every builder terminal, `db.sql` via
`runRaw` (`packages/pg-prime/src/query/raw.ts:115`) and `insertMany` via `runChunked`
(`packages/pg-prime/src/query/insert.ts:330`). Calls `runOn` / `bindsToParams` in
`packages/pg-prime/src/query/executor.ts` and `mapError`.

## Public API
- `SessionState` — everything one `pgPrime(...)` shares: driver, schema, env, hooks, errors, log, pooler
  profile, `devGuard`, `connectSettings`, `sessionStatementTimeout`, `configured` (`WeakSet`), `ended`, `warn`, `startupProbe`.
- `StatementOptions` — `CallOptions` plus `params`.
- `StatementDescriptor<Row>` — `sql`, `paramCount`, `paramTypes`, `operation`, `tables`,
  `paramValues(opts)` (failure path only), `perform(conn, env, opts)`. `StatementResult<Row>` — `{ rows, rowCount }`.
- `compiledStatement(compiled)` — a lazy `StatementDescriptor` over a builder `Compiled`.
- `PoolRunner(state, defaults, handle = 'db')` — `with`, `use`, `scope`, `run`, `runRaw`, `runChunked`;
  each acquires and releases its own connection.
- `TxRuntime` — mutable per-transaction state: `txId`, `attempt`, `depth`, `doomed`, `closed`, shared
  `poison` box, `inFlight`, `warned`, `localTimeoutMs`, `baselineTimeoutMs`, `label`.
- `ConnRunner(state, defaults, conn, tx, handle = 'tx')` — same methods on one fixed connection; throws
  `TransactionClosedError` after the scope ends and `TransactionAbandonedError` after `rollbackWith`.
- `Lease` — `{ conn, waitedMs }`.
- `acquire(state, signal, route?)` — driver checkout, pool events, per-connection GUC setup, startup probe arm.
- `release(state, lease, dispose)` — emits the release event and returns the driver's release promise.
- `execute(state, lease, desc, o, handle, depth, tx)` — runs one statement with hooks, logging, timer and
  error mapping; returns the rows or throws a mapped `PgPrimeError`.

## Flow
1. `PoolRunner.runRaw` checks `state.ended` (`DbClosedError`), merges per-call options over the runner
   defaults, and runs the dev guard on the `'db'` handle (`packages/pg-prime/src/session/runner.ts:410`).
2. With `timeoutMs` and `timeoutStrategy: 'transaction'` it wraps the statement in `BEGIN`, a local
   `statement_timeout`, and `COMMIT` (`packages/pg-prime/src/session/runner.ts:324`).
3. `acquire` times the checkout only when observed, maps acquire failures, and applies `connectSettings`
   once per physical connection keyed on `conn.serverParameters` (`packages/pg-prime/src/session/runner.ts:757`).
4. `execute` emits `queryStart`, subscribes a notice sink, and starts a client-side timer for `timeoutMs`
   on non-`tx` handles unless the strategy is `'transaction'` (`packages/pg-prime/src/session/runner.ts:992`).
5. `desc.perform` runs the statement; on success `queryEnd` carries `serverMs`, `decodeMs` and
   `waitedForConnectionMs`, and `logQuery` writes slow or all-query records (`packages/pg-prime/src/session/runner.ts:873`).
6. On failure `mapStatementError` maps with SQL, params, param types, call site and `poisonedBy`; if our
   timer fired it becomes `QueryTimeoutError` (`packages/pg-prime/src/session/runner.ts:1023`).
7. A server-rejected error (5-char SQLSTATE other than `25P02`) is stored in `tx.poison` for later
   `25P02` messages (`packages/pg-prime/src/session/runner.ts:1087`).
8. `PoolRunner` releases with `dispose` when `poisons(e)`: `connectionUnusable`, SQLSTATE `08*`, `57P01`
   or `XX000` (`packages/pg-prime/src/session/runner.ts:1092`).
9. `PoolRunner.scope` (root streams) opens `BEGIN`, optionally sets `statementTimeoutMs`, yields, and
   commits only on completion, rolling back on `break`/throw (`packages/pg-prime/src/session/runner.ts:296`).
10. `PoolRunner.runChunked` runs every chunk on one connection inside one transaction
    (`packages/pg-prime/src/session/runner.ts:367`); `ConnRunner.runChunked` runs them in the open transaction.
11. `ConnRunner.runRaw` sets the transaction-local `statement_timeout` only when the wanted value differs
    from the cached `localTimeoutMs` (`packages/pg-prime/src/session/runner.ts:616`), restoring to the
    session value pg-prime installed or `NULL` (`packages/pg-prime/src/session/runner.ts:639`).

## Gotchas
- `config.signal` is composed only into `acquire` (`signalFor`, `packages/pg-prime/src/session/runner.ts:232`);
  `execute` uses the statement's own `o.signal`, so the lifecycle signal does not cancel an in-flight statement.
- Applying session GUCs never fails a query: an error un-marks the connection and emits a
  `session-guc-skipped` internal event (`packages/pg-prime/src/session/runner.ts:769`).
- `applyStreamTimeout` sends nothing unless `statementTimeoutMs` is set (`null` sends `'0'`)
  (`packages/pg-prime/src/session/runner.ts:799`), so by default a root stream keeps the 30 s session
  `statement_timeout`. `ConnRunner.scope` ignores `statementTimeoutMs` entirely.
- On a `Session` handle, `#applyLocalTimeout` issues `set_config(…, true)` outside any transaction block, where
  it lasts only for that `select`, yet caches the value in `tx.localTimeoutMs`; the client-side timer is what
  bounds session statements.
- In `#timedInTransaction`, errors from `BEGIN` / `set_config` / `COMMIT` are rethrown unmapped; only
  `execute`'s own failure is mapped (`packages/pg-prime/src/session/runner.ts:350`).
- `PoolRunner.guard` reads `outsideTransaction` from merged options for `runRaw` / `runChunked`, but `use`
  and `scope` check only the runner defaults (`packages/pg-prime/src/session/runner.ts:275`,
  `packages/pg-prime/src/session/runner.ts:298`).
- `poison` is a shared box so a savepoint's failure is visible to, and cleared for, the enclosing transaction.
- With no hook, slow-query log or all-query log, `execute` skips clocks and event objects (`observed()`,
  `NO_RUN_OPTIONS`, `NO_TIMER`); mutations of that fast path are recorded in
  `packages/pg-prime/test/session/perf-mutations.mjs`.

## Tests
- `packages/pg-prime/test/session/session.test.ts` — `:668` (non-idle connection destroyed), `:944`
  (`poisonedBy`), `:1061` (concurrency warning), `:1266` (hooks), `:1469` (signals and timeouts), `:1623`
  (pool timeout), `:1694` (call sites), `:1758` (fast path), `:1852` (`paramCount`), `:1933` (per-statement
  options). Run: `pnpm --filter pg-prime exec vitest run test/session/session.test.ts`.
- `packages/pg-prime/test/live/session.test.ts:314` (real timings, notices) and `:536` (connections returned).
- `packages/pg-prime/test/pg/session.test.ts` — `:392` timeouts both ways, `:455` abort destroys the
  connection, `:500` restore of the session timeout, `:829` CancelRequest; `packages/pg-prime/test/pg/session-pooler.test.ts:361`
  restore to `NULL` under a transaction profile (need `PG_PRIME_TEST_URL`).
- Uncovered: `statementTimeoutMs` on streams and the session-handle local-timeout caching.
