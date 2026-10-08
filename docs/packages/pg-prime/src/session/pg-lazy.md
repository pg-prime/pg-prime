# packages/pg-prime/src/session/pg-lazy.ts

## Purpose
Builds a `pg.Pool` for `pgPrime({ connection })` through a lazy, memoised `import('pg')`, so `pg` stays an
optional peer dependency and is never loaded by `pool:` / `driver:` users. `pgPrime`'s `LazyDriver` calls
`buildPool` on first connect for the main and the `directConnection` pool
(`packages/pg-prime/src/query/run.ts:266`, `packages/pg-prime/src/query/run.ts:281`); the result feeds
`pgDriver` in `packages/pg-prime/src/driver/pg-adapter.ts`.

## Public API
- `loadPg()` — resolves `{ Pool, Client }` from `pg` (named or `default` export), memoised; throws
  `ConfigError` when `pg` is missing or exports no constructors, and clears the memo so a later call retries.
- `startupOptions(settings)` — `-c name=value` string with `\` and space escaped, or `undefined` when empty.
  Unused by `buildPool`.
- `BuiltPool` — `{ pool, makeClient, host, database, port }`.
- `buildPool(connection, poolOptions, connectSettings, session, onIdleError?)` — constructs the pool
  with `POOL_DEFAULTS` filled in and an `error` listener attached; returns `BuiltPool`.

## Flow
1. `loadPg()` awaits the single cached import (`packages/pg-prime/src/session/pg-lazy.ts:33`).
2. A string `connection` becomes `{ connectionString }`; `ConnectionParams` are copied, with
   `applicationName` renamed to `application_name` (`packages/pg-prime/src/session/pg-lazy.ts:130`).
3. `session.applicationName` fills `application_name` only when the connection did not set it
   (`packages/pg-prime/src/session/pg-lazy.ts:136`).
4. `connectSettings` is ignored (`packages/pg-prime/src/session/pg-lazy.ts:141`); session GUCs are applied
   per physical connection by `applyConnectSettings` in `packages/pg-prime/src/session/runner.ts:757`.
5. Pool config is the base plus `max`, `min`, `idleTimeoutMillis`, `connectionTimeoutMillis`,
   `maxLifetimeSeconds`, `allowExitOnIdle` (defaults from `POOL_DEFAULTS`) and `maxUses` when given
   (`packages/pg-prime/src/session/pg-lazy.ts:143`).
6. If the pool has `on`, an `error` listener forwards to `onIdleError`
   (`packages/pg-prime/src/session/pg-lazy.ts:169`); `pgPrime` reports it as an `idle-connection-error`
   internal event (`packages/pg-prime/src/query/run.ts:249`).
7. `makeClient` builds an unconnected `pg.Client` from the same base config, used for cancel requests and
   the dedicated LISTEN connection (`packages/pg-prime/src/query/run.ts:292`).

## Gotchas
- The `error` listener is attached even without `onIdleError`; without any listener an idle client's
  error on the pool would be an uncaught `EventEmitter` error and crash the process.
- `pg` must never be imported statically from `src/`; `packages/pg-prime/test/session/session.test.ts:1649`
  asserts this, and the tree-shake fixture expects no `pg` module.
- Session GUCs are not sent in the startup `options`: PgBouncer rejects unknown startup parameters with
  `08P01`. Only `application_name` rides the startup packet, and only when set explicitly.
- `host` falls back to parsing `connectionString` with `URL`; `database` and `port` are only filled from
  discrete params (`packages/pg-prime/src/session/pg-lazy.ts:179`).
- `pgPrime` passes `config.connection as string` even when it is `ConnectionParams`; `buildPool` handles
  both shapes.

## Tests
- `packages/pg-prime/test/pg/pool-error.test.ts:56` — an idle pooled connection killed by the server does
  not crash the process and is reported (tier 2, needs `PG_PRIME_TEST_URL`):
  `pnpm --filter pg-prime exec vitest run test/pg/pool-error.test.ts`.
- `packages/pg-prime/test/live/session.test.ts:536` — a `connection:` handle returns connections to the
  pool (live project).
- `packages/pg-prime/test/session/session.test.ts:1649` — no static `pg` import.
- Uncovered: the missing-`pg` `ConfigError` path and `startupOptions` escaping have no test.
