# packages/pg-prime/src/query/run.ts

## Purpose
The `pgPrime(config)` constructor and `compileOnly(schema)`: validates config, builds the `ExecEnv`, `SessionState`, `PoolRunner` and executor, and installs the db-level members (`transaction`, `session`, `listen`, `diagnose`, `end`, ...). It opens no sockets; the driver is built lazily on first use.
Called from the package barrel (`packages/pg-prime/src/index.ts:373`) and `src/query/types.ts`. Calls into `src/session/` (config checks, `PoolRunner`, handles, `ListenHub`, `buildPool`), `src/errors/`, `src/observe/`, `src/pooler/`, `makeEnv` from `src/query/executor.ts` and `makeExecutor` from `src/query/cte.ts`.

## Public API
- `PgPrimeOptions<Sc>` — alias interface extending `DbConfig<Sc>` (`driver:`, `pool:` or `connection:` plus schema, session, logging and `ExecOptions`).
- `pgPrime(config)` — returns `Db<Sc>` synchronously; throws on an invalid connection source or a statement mode the pooler profile forbids.
- `StatementStats` — `{ statement, selfHeals, downgraded, assertShape }`.
- `statementStats(db)` — reads those from the db's `ExecEnv`; throws `BuilderError` for a `compileOnly()` executor.
- `compileOnly(schema, registry?)` — a `Queryable` that compiles but whose `execute`/`run`/`stream`/... throw `BuilderError`.
- Type re-exports: `CopyFromApi`, `CopyToApi`, `DbConfig`, `RefreshMaterializedViewOptions` (from `src/session/`).

## Flow
1. `assertOneConnectionSource` picks `'driver' | 'pool' | 'connection'`; `assertStatementModeAllowed` checks `statement` against `poolerMode` (`packages/pg-prime/src/query/run.ts:198`).
2. Resolve the pooler profile, error options, `HookBus` and log options; `warn` is a no-op at log level `silent` (`packages/pg-prime/src/query/run.ts:201`).
3. Create a fresh `Registry` unless `config.registry` is given, then one `ExecEnv` via `makeEnv` shared by the db and all its transactions (`packages/pg-prime/src/query/run.ts:219`).
4. `resolveSessionSettings` drops session GUCs a transaction profile forbids, logging the `ALTER ROLE` hint at `info` and emitting `session-guc-skipped` (`packages/pg-prime/src/query/run.ts:225`).
5. `LazyDriver` wraps a factory: `driver:` as-is, `pool:` through `pgDriver({ pool })`, `connection:` through `buildPool` (plus an optional `directConnection` pool) (`packages/pg-prime/src/query/run.ts:260`).
6. `facade(lazy)` exposes it as a `PgDriver`; `capabilities` is a placeholder until the driver resolves (`packages/pg-prime/src/query/run.ts:147`).
7. `connectSettings`: `connection:` gets every setting except `application_name`; `pool:`/`driver:` get settings only if `session:` was passed (`packages/pg-prime/src/query/run.ts:323`).
8. Build `SessionState`, a root `PoolRunner`, the `BuilderCtx` seed and `TxDeps`; `makeExecutor` plus `installQueryable` produce the db (`packages/pg-prime/src/query/run.ts:329`, `packages/pg-prime/src/query/run.ts:367`).
9. `installDbMembers` adds `transaction`, `session`, `listen`, `listenBackendPid`, `stats`, `observe`, `connect`, `diagnosePooler`, `diagnose`, `end` and `Symbol.asyncDispose` (`packages/pg-prime/src/query/run.ts:393`).
10. `config.signal` aborting calls `db.end()` (`packages/pg-prime/src/query/run.ts:382`).
11. `maybeWarnAtStartup` emits a pool-size warning and arms `state.startupProbe`, which waits until the pool is idle and then runs `diagnosePooler` once (`packages/pg-prime/src/query/run.ts:523`).

## Gotchas
- `LazyDriver.get` memoises the factory promise; a rejected pool build stays rejected for the db's lifetime (`packages/pg-prime/src/query/run.ts:133`).
- `facade.destroy()` is a no-op if the driver was never resolved (`packages/pg-prime/src/query/run.ts:181`).
- `pgPrime` uses a fresh `Registry` per db; `compileOnly` defaults to the process-wide `defaultRegistry()` (`packages/pg-prime/src/query/run.ts:219`, `packages/pg-prime/src/query/run.ts:628`).
- With `directConnection`, `lazy.setPool` is called again with the main pool, so `db.stats()` reports only the main pool (`packages/pg-prime/src/query/run.ts:288`).
- `hostOfConfig` returns the whole `connection` string; it is the `host` fallback for `diagnosePooler` before the pool exists (`packages/pg-prime/src/query/run.ts:469`).
- The startup probe never runs for `driver:`, when `devGuard` is off (its default in production), when `poolStats()` is `undefined`, or after 20 busy polls 250 ms apart (`packages/pg-prime/src/query/run.ts:533`, `packages/pg-prime/src/query/run.ts:570`).
- Probe timers are `unref`'d, and probe failures are swallowed (`packages/pg-prime/src/query/run.ts:502`, `packages/pg-prime/src/query/run.ts:555`).
- `end()` is idempotent via `state.ended`; it closes `listen` first, ignoring errors (`packages/pg-prime/src/query/run.ts:459`).
- `compileOnly` installs throwing stubs for `run`, `explain`, `stream`, `streamBatches`, `notify`, `copyFrom`, `copyTo`, `refreshMaterializedView`; `withOptions` and `outsideTransaction` return the same executor (`packages/pg-prime/src/query/run.ts:641`).
- `LISTEN` under a profile with `listen: 'unsupported'` needs `directConnection`, else `listenUnsupported` is thrown (`packages/pg-prime/src/query/run.ts:407`).

## Tests
- Config validation, hooks, `streamBatches`, per-statement options (mock driver): `packages/pg-prime/test/session/session.test.ts`.
- Live (PGlite): `packages/pg-prime/test/live/session.test.ts` covers `db.diagnose()`, client defaults, and the `connection:` check-in and startup probe interaction.
- Real server: `packages/pg-prime/test/pg/session-pooler.test.ts` (startup mismatch warning), `packages/pg-prime/test/pg/executor.test.ts` (`statementStats`), plus the other `test/pg/session*.test.ts` files.
- `compileOnly` is the builder used by most unit suites under `packages/pg-prime/test/query/`; `packages/pg-prime/test/query/index.test.ts` checks the barrel exports.
- Run: `pnpm --filter pg-prime exec vitest run test/session/session.test.ts`; `... test/live/session.test.ts`; `... test/pg/session-pooler.test.ts` with `PG_PRIME_TEST_URL`.
- `directConnection` is exercised in `test/pg/session-listen.test.ts` and `test/pg/session-pooler.test.ts`; no test asserts `db.stats()` with it set, or a `LazyDriver` factory that rejects.
