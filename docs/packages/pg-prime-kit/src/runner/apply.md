# packages/pg-prime-kit/src/runner/apply.ts

## Purpose
Low-level execution primitives for migrations: per-segment transactions with timeout GUCs, the derived advisory lock key, session lock acquire/release, and transaction-pooler detection.
Callers: `src/runner/run.ts` (the `apply` run), `src/cli/commands/push.ts`, `src/prove/prove.ts`, `src/prove/temp-schema.ts`, `test/support/migrations.ts`; re-exported from `src/index.ts`. Callees: only the `CatalogClient` it is handed and `node:crypto`.

## Public API
- `applySegments(client, statements, segments, options?)` — runs each `Segment` (transactional ones in `BEGIN`/`COMMIT`); returns `ApplyReport` and never throws on SQL errors.
- `ApplyReport` — `{ status: "applied" | "failed", appliedStatements, error? }`.
- `ApplyError` — `{ statementIndex, sql, message, sqlState? }`; `sqlState` is the `pg` error `code`.
- `ApplyOptions` — `lockTimeout` (default `"3s"`), `statementTimeout` (operator override).
- `resolveStatementTimeout(planned, override)` — `"0"` when the plan says `null` (exempt), else `override ?? planned`.
- `setConfig(client, name, value, local)` — `SELECT set_config($1, $2, $3)`; the parameterised GUC write.
- `resetSessionGucs(client)` — `RESET` of `lock_timeout`, `statement_timeout`, `search_path`.
- `advisoryLockKey(database, schemas)` — signed 64-bit key from sha256 of `database:` + sorted schemas.
- `acquireSessionLock(client, database, schemas)` — `pg_try_advisory_lock`; returns `true` when taken.
- `releaseSessionLock(client, database, schemas)` — `pg_advisory_unlock`.
- `detectTransactionPooler(client)` — two `pg_backend_pid()` reads in two transactions; `true` when they differ.
- `detectTransactionPoolerStrict(client, pin, timeoutMs?)` — the cheap probe, then pins a second server connection via `pin` and re-reads; a changed pid or a timeout means pooler.
- `PinConnection` — `() => Promise<() => Promise<void>>`: hold one server connection busy, return its release.
- `POOLER_PROBE_TIMEOUT_MS` — `3000`.

## Flow
1. `applySegments` walks `segments` in order; a transactional segment opens `BEGIN` (`packages/pg-prime-kit/src/runner/apply.ts:88`).
2. It sets `lock_timeout` and `search_path = pg_catalog`, `SET LOCAL`-scoped for transactional segments and session-scoped for bare ones (`:93`, `:98`).
3. Per statement it resolves and sets `statement_timeout` (`:102-103`), executes `s.sql`, counts it.
4. Transactional segments `COMMIT`; bare segments `resetSessionGucs` (`:107-108`).
5. On error: `ROLLBACK` (or reset GUCs for bare), return `failed` with the executing index, SQL, message and SQLSTATE (`:109-122`). Earlier segments stay committed.
6. `detectTransactionPoolerStrict` returns `true` on a cheap-probe mismatch (`:184`), returns `false` if `pin()` throws (`:189-193`), then races a third pid read against `timeoutMs` (`:197-205`).

## Gotchas
- Only `options.lockTimeout` reaches `lock_timeout`; a statement's own `timeouts.lock` from the plan is not read here (`packages/pg-prime-kit/src/runner/apply.ts:86`, `:93`).
- `null` planned timeout is an exemption: `resolveStatementTimeout` returns `"0"` even when an override is given (`:52-55`).
- `search_path` is pinned to `pg_catalog` for every segment, so statement SQL must be schema-qualified (`:98`).
- `appliedStatements` counts statements executed before the failure, including ones in a rolled-back segment.
- `detectTransactionPooler` alone misses an idle transaction pool (the pooler returns the same server); use the strict form (`:150-155`).
- A strict-probe timeout issues a `ROLLBACK` on `client` to clear the half-open probe transaction (`:206-208`).
- The lock key is derived per database and schema set, so two schema sets in one database do not serialize (`:131-136`).

## Tests
- `packages/pg-prime-kit/test/ir.test.ts:140` — `advisoryLockKey` stability and order-insensitivity (no server).
- `packages/pg-prime-kit/test/runner/timeouts.test.ts` — `resolveStatementTimeout` unit cases and a live exempt-CIC run.
- `packages/pg-prime-kit/test/runner/pooler.test.ts` — cheap probe misses an idle PgBouncer pool, strict probe catches it; skipped unless `PG_PRIME_TEST_PGBOUNCER_URL` is set.
- `applySegments` is exercised indirectly by every runner test and by the fixture chains in `test/support/migrations.ts`.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/runner/timeouts.test.ts test/ir.test.ts` (live tests need `PG_PRIME_TEST_URL` or localhost port 54329 (`packages/pg-prime-kit/test/support/db.ts:42`)).
- Uncovered: the strict-probe timeout branch and the `pin()` failure fallback.
