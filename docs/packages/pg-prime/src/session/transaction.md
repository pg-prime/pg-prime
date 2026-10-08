# packages/pg-prime/src/session/transaction.ts

## Purpose
Pure, I/O-free helpers for transactions: the `BEGIN` text, savepoint statements, `set_config` batches,
GUC-name validation, advisory-lock keys and function names, and the retry policy and delay schedule. All
callers are in `packages/pg-prime/src/session/handles.ts:58` (`runTransaction`, `once`, `runSavepoint`,
`setLocalOn`, the advisory-lock methods).

## Public API
- `beginSql({ isolation?, accessMode?, deferrable? })` — one `begin …` statement; throws `ConfigError` for an
  unknown isolation level or `deferrable` without `serializable` + `read only`.
- `savepointName(depth)` — `"pgprime_sp_<depth>"`, always double-quoted.
- `savepointSql` / `releaseSavepointSql` / `rollbackToSavepointSql(depth)` — the three savepoint statements.
- `setConfigSql(count, local)` — `select set_config($1,$2,<local>), …` for `count` pairs.
- `assertGucName(name)` — throws `UsageError` unless `name` matches `ident` or `ident.ident`.
- `setConfigParams(settings)` — flat `[name, String(value), …]` list; asserts every name.
- `advisoryKey(key)` — `bigint` wrapped to signed 64-bit, `number` truncated, `string` hashed with
  FNV-1a 64 over UTF-8.
- `advisoryFn(scope, tryLock, shared)` — e.g. `pg_catalog.pg_try_advisory_xact_lock_shared`.
- `advisoryUnlockFn(shared)` — `pg_catalog.pg_advisory_unlock[_shared]`.
- `ResolvedRetry` — `{ on, maxAttempts, baseDelayMs, maxDelayMs, jitter, shouldRetry, onRetry }`.
- `resolveRetry(retry, isolation)` — merges a `RetryPolicy | boolean | undefined` with defaults.
- `retryDelayMs(policy, attempt, random?)` — the delay before the next attempt, in ms.

## Flow
1. `beginSql` appends `isolation level <x>`, then the access mode, then `deferrable`
   (`packages/pg-prime/src/session/transaction.ts:29`); `runTransaction` sends it once with simple protocol.
2. `setConfigSql` + `setConfigParams` carry `localSettings`, `timeoutMs` and `lockTimeoutMs` in one round
   trip after `BEGIN` or `SAVEPOINT` (`packages/pg-prime/src/session/handles.ts:487`).
3. `resolveRetry`: `retry: false` returns a frozen policy with `maxAttempts: 1`
   (`packages/pg-prime/src/session/transaction.ts:210`); otherwise `on` defaults to `['40001']` at
   repeatable read / serializable or when `retry === true`, else `[]` (`packages/pg-prime/src/session/transaction.ts:212`).
4. Defaults: `maxAttempts` 5, `baseDelayMs` 25, `maxDelayMs` 1000, `jitter` `'full'`.
5. `retryDelayMs` computes `ceiling = min(maxDelayMs, baseDelayMs * 2^(attempt-1))` and returns the ceiling
   (`'none'`), `ceiling/2 + random*ceiling/2` (`'equal'`) or `random*ceiling` (`'full'`)
   (`packages/pg-prime/src/session/transaction.ts:250`).

## Gotchas
- `'read uncommitted'` is rejected at runtime (`packages/pg-prime/src/session/transaction.ts:37`) and absent
  from `IsolationLevel`.
- `deferrable` is checked both by the `TxOptions` union and at runtime in `beginSql`
  (`packages/pg-prime/src/session/transaction.ts:47`).
- `accessMode` is interpolated without validation (`packages/pg-prime/src/session/transaction.ts:46`); only the
  type restricts it to `'read write' | 'read only'`.
- `40P01` (deadlock) is never in the default `on` list; opt in with `retry: { on: ['40001', '40P01'] }`.
- `assertGucName` is a typo catcher: names and values are bind parameters to `set_config`, so it is not the
  injection boundary.
- Savepoint names derive from depth, so sibling savepoints reuse one name. PostgreSQL resolves a duplicate
  name to the most recent savepoint, so siblings run concurrently (`Promise.all`) on one `Tx` can release or
  roll back each other's.
- A string advisory key's hash must stay stable across releases: two processes hashing differently would
  not exclude each other.

## Tests
- `packages/pg-prime/test/session/session.test.ts:150` (BEGIN text), `:220` (savepoint names), `:274`
  (`set_config` batching), `:333` (advisory locks, `advisoryKey`), `:420` (retry defaults), `:463` (retry
  loop on a fake clock). Run: `pnpm --filter pg-prime exec vitest run test/session/session.test.ts`.
- `packages/pg-prime/test/live/session.test.ts:217` — `setLocal` scope and injection safety on PGlite.
- `packages/pg-prime/test/pg/session.test.ts:99`, `:180`, `:322` — real serialization retry, deadlock not
  retried, advisory locks via `pg_locks` (needs `PG_PRIME_TEST_URL`).
- `packages/pg-prime/test/session/mutations.mjs` — recorded single-line mutations (e.g. dropping
  `accessMode` from `beginSql`) that the suites must catch; run with `node test/session/mutations.mjs`.
