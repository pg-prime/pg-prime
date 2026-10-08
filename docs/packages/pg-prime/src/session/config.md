# packages/pg-prime/src/session/config.ts

## Purpose
Declares the `pgPrime(config)` option shape (`DbConfig`), the public `presets`, the pool defaults, and the
eager construction-time checks. `pgPrime` in `packages/pg-prime/src/query/run.ts:197` calls every validator
here before building any state; `packages/pg-prime/src/session/pg-lazy.ts:22` reads `POOL_DEFAULTS`. Callees are
`ConfigError` and `POOLER_PROFILES` (`packages/pg-prime/src/pooler/profiles.ts`).

## Public API
- `DbConfig<Sc>` — extends `ExecOptions`; `schema`, exactly one of `connection` / `pool` / `driver`, plus
  `directConnection`, `poolerMode`, `poolOptions`, `session`, `registry`, `transaction`, `hooks`, `log`, `errors`, `devGuard`, `signal`.
- `presets` — `serverless()`, `neonPooled()`, `supabaseTransaction()`, `rdsProxy()`; each returns a fresh
  `Partial<DbConfig<never>>`. Re-exported from `packages/pg-prime/src/index.ts:389`.
- `POOL_DEFAULTS` — frozen `{ max: 10, min: 0, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000,
  maxLifetimeSeconds: 1_800, allowExitOnIdle: false }`.
- `assertOneConnectionSource(config)` — returns `'connection' | 'pool' | 'driver'`; throws `ConfigError`
  when zero or more than one is set.
- `assertStatementModeAllowed(statement, poolerMode)` — throws `ConfigError` when `statement === 'named'`
  and the profile's `namedPreparedStatements` is `'unsupported'`.
- `poolSizeWarning(max, maxConnections)` — returns a warning string when `max > 20` or `max * 4 >
  maxConnections`, else `undefined`.
- `inProduction()` — `NODE_ENV === 'production'`, memoised per process.
- `resetProductionMemo()` — `@internal`; clears the `inProduction` memo for tests.

## Flow
1. `pgPrime` calls `assertOneConnectionSource` first (`packages/pg-prime/src/query/run.ts:198`); the source
   decides how the driver is built and which session GUCs apply.
2. `assertStatementModeAllowed(config.statement, config.poolerMode)` runs next
   (`packages/pg-prime/src/query/run.ts:199`); an omitted `poolerMode` is treated as `'none'`
   (`packages/pg-prime/src/session/config.ts:165`).
3. `inProduction()` feeds the error-redaction defaults and the `devGuard` default
   (`packages/pg-prime/src/query/run.ts:203`, `packages/pg-prime/src/query/run.ts:338`).
4. `poolSizeWarning(max, undefined)` is evaluated by the dev-mode startup check
   (`packages/pg-prime/src/query/run.ts:535`); the 20-connection branch wins over the `max_connections` branch.

## Gotchas
- `pgPrime` is synchronous: nothing here opens a socket, and every check throws at construction rather than
  at the first query.
- The `assertStatementModeAllowed` docblock says `execMode: 'prepared'`, but the check is on
  `statement === 'named'` (`packages/pg-prime/src/session/config.ts:164`).
- Presets set `poolOptions` as one object, so overriding pool size means replacing `poolOptions` whole. The
  `presets` docblock example `{ ...presets.serverless(), max: 3 }` (`packages/pg-prime/src/session/config.ts:90`)
  sets a top-level `max`, which `DbConfig` does not have; pool size is `poolOptions.max`.
- `poolOptions` is only consulted when pg-prime builds the pool from `connection:`; a user `pool:` keeps its
  own settings.
- `inProduction()` caches the first answer (`packages/pg-prime/src/session/config.ts:200`); tests that flip
  `NODE_ENV` must call `resetProductionMemo()`.

## Tests
- `packages/pg-prime/test/session/session.test.ts:1161` covers the one-connection-source rule and
  `packages/pg-prime/test/session/session.test.ts:1107` the named-statement refusal, both through `pgPrime`.
- `packages/pg-prime/test/pg/session-pooler.test.ts:260` checks `statement: 'named'` is refused at
  construction against a real pooler (needs `PG_PRIME_TEST_URL`).
- Run: `pnpm --filter pg-prime exec vitest run test/session/session.test.ts`.
- Uncovered: no test imports `presets` or `poolSizeWarning` directly.
