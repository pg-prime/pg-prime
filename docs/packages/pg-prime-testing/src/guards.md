# packages/pg-prime-testing/src/guards.ts

## Purpose
Runner-agnostic skip guards: they take a test runner's own `it` and return either it or `it.skip`, depending on whether `PG_PRIME_TEST_URL` points at a real PostgreSQL. They exist because PGlite is one backend, so tests that need a second session pass there for the wrong reason. Re-exported by `packages/pg-prime-testing/src/index.ts:43`; used by `packages/pg-prime-testing/test/pg/postgres.test.ts`. No imports.

## Public API
- `TestDecl` — interface `(name, fn: () => unknown, timeout?) => void` with a recursive `readonly skip: TestDecl`; vitest `it`, `node:test` `test` and Jest `it` all satisfy it.
- `TEST_URL_ENV` — the constant `'PG_PRIME_TEST_URL'`.
- `onRealPostgres(): boolean` — true iff `process.env.PG_PRIME_TEST_URL` is set and non-empty.
- `requiresRealPostgres(it, reason): TestDecl` — returns `it` on a real server; otherwise writes a skip line to stderr and returns `it.skip`.
- `requiresConcurrency(it): TestDecl` — `requiresRealPostgres` with a fixed "needs a second backend session" reason.

## Flow
1. `onRealPostgres` reads the env var at call time (`packages/pg-prime-testing/src/guards.ts:48`), so a test may change it and re-ask.
2. `requiresRealPostgres` returns `it` unchanged when it is true (`:63`).
3. Otherwise it writes `[test] skip: <reason> (set PG_PRIME_TEST_URL to run it)` to `process.stderr` and returns `it.skip` (`:64-65`).
4. `requiresConcurrency` delegates with the reason `needs a second backend session; PGlite multiplexes every socket onto one` (`:73-77`).

## Gotchas
- The guard is evaluated at collection time, so the skip line is printed once per guarded call even when the test is filtered out later.
- stderr, not `console.*`: vitest drops console output during collection unless a running task owns it (`:59-60`).
- An empty string counts as unset (`:50`).
- The guards only check the env var; they never probe a server. A `PG_PRIME_TEST_URL` pointing at an unreachable host makes the tests run and fail.
- A guard can be chained because `it.skip` is itself a `TestDecl`: `requiresConcurrency(requiresRealPostgres(it, …))`.
- `requiresConcurrency` covers advisory-lock contention, `40001`/retry, deadlocks, `SKIP LOCKED`, lock waiting, `lock_timeout`, killed backends, cross-session `LISTEN`/`NOTIFY`, pool and pooler semantics (`:68-72`). The PGlite bridge enforces the same rule mechanically by dropping a second socket that runs inside another socket's transaction (`packages/pg-prime-testing/src/pglite-bridge.ts:185`).

## Tests
- `packages/pg-prime-testing/test/unit/guards.test.ts`: vitest `it` satisfies `TestDecl`, returns `it` when set, `it.skip` plus a stderr line when unset, empty string treated as unset, `requiresConcurrency`'s reason text, chaining.
- `packages/pg-prime-testing/test/pg/postgres.test.ts` uses `requiresRealPostgres` as its own skip guard.
- Run: `pnpm --filter @pg-prime/testing exec vitest run test/unit/guards.test.ts`.
- Uncovered: runners other than vitest are only checked structurally (no `node:test` or Jest run).
