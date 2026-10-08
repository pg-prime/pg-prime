# packages/pg-prime/src/session/gucs.ts

## Purpose
Resolves the session GUC defaults (`SessionDefaults` plus built-in defaults) against the pooler profile
into `[name, value]` pairs to apply per physical connection, or a list of skipped names under a transaction
pooler. Its only caller is `pgPrime` (`packages/pg-prime/src/query/run.ts:225`), which filters the result
into `SessionState.connectSettings`; `applyConnectSettings` in `packages/pg-prime/src/session/runner.ts:805`
sends it.

## Public API
- `ResolvedSessionSettings` — `{ settings: readonly [name, value][], skipped: readonly string[] }`.
- `resolveSessionSettings(session, profile)` — returns the pairs to apply, or empty `settings` with every
  wanted name in `skipped` when `profile.sessionGucsAtConnect === 'unsafe'`.

## Flow
1. Each GUC is pushed with the caller's value, else the fallback; `null` from either drops it
   (`packages/pg-prime/src/session/gucs.ts:54`).
2. Defaults: `application_name` `'pg-prime'`, `statement_timeout` `'30s'`, `lock_timeout` none,
   `idle_in_transaction_session_timeout` `'60s'`, `TimeZone` `'UTC'`
   (`packages/pg-prime/src/session/gucs.ts:59`).
3. A numeric `Duration` becomes `'<n>ms'` (`packages/pg-prime/src/session/gucs.ts:28`); strings pass through.
4. A non-empty `searchPath` is joined with `', '` into `search_path`
   (`packages/pg-prime/src/session/gucs.ts:64`).
5. Under an `'unsafe'` profile the result is `{ settings: [], skipped }`
   (`packages/pg-prime/src/session/gucs.ts:68`); `pgPrime` logs the skipped names once at `info` with an
   `ALTER ROLE` hint (`packages/pg-prime/src/query/run.ts:226`).
6. `pgPrime` then drops `application_name` for `connection:` sources and applies nothing for `pool:` /
   `driver:` unless `session:` was passed (`packages/pg-prime/src/query/run.ts:323`).

## Gotchas
- `null` disables a default; `undefined` keeps it. Every field of `SessionDefaults` is `Duration | null`
  for that reason.
- `search_path` entries are joined verbatim, not identifier-quoted (`packages/pg-prime/src/session/gucs.ts:65`).
- With `connection:`, the `'pg-prime'` `application_name` default is not applied: `pgPrime` removes it from
  the per-connection batch (`packages/pg-prime/src/query/run.ts:325`) and `buildPool` only forwards an
  explicit `session.applicationName` (`packages/pg-prime/src/session/pg-lazy.ts:136`).
- `DateStyle` is not set here, although the `SessionDefaults.timeZone` comment says it is pinned
  (`packages/pg-prime/src/session/types.ts:208`); the pg adapter checks it instead
  (`packages/pg-prime/src/driver/pg-adapter.ts:159`).
- The settings are applied by `set_config(..., false)` once per physical connection, not via the startup
  packet's `options` (see `packages/pg-prime/src/session/pg-lazy.ts:91`).

## Tests
- `packages/pg-prime/test/session/session.test.ts:1120` — skipped under a transaction profile;
  `:1134` — the default values; `:1144` — `null` vs omitted.
- `packages/pg-prime/test/pg/session.test.ts:500` — a per-statement timeout restores the session value
  pg-prime set (needs `PG_PRIME_TEST_URL`).
- Run: `pnpm --filter pg-prime exec vitest run test/session/session.test.ts`.
- Uncovered: `searchPath` and numeric `Duration` formatting have no direct unit test.
