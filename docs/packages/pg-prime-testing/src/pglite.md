# packages/pg-prime-testing/src/pglite.ts

## Purpose
The tier-1 fixture: `startPglite` boots an in-process PGlite (PostgreSQL 18 in WASM) in UTC, probes its version, and puts the `pglite-bridge.ts` socket in front of it so tests connect with a plain `postgres://` URL. Calls `serve` (`packages/pg-prime-testing/src/pglite-bridge.ts:88`) and lazily imports the optional peer `@electric-sql/pglite`. Re-exported by `packages/pg-prime-testing/src/index.ts:51`; used by the scaffolded `packages/pg-prime-create/templates/test/setup.ts:8`. Also declares the `TestServer` shape that `postgres.ts` reuses.

## Public API
- `TestServer` — `{ url, versionNum, version, kind: 'pglite' | 'postgres', stop(): Promise<void> }`; returned by both `startPglite` and `startPostgres`.
- `PgliteServer` — `TestServer` with `kind: 'pglite'`.
- `startPglite(): Promise<PgliteServer>` — boots one PGlite behind one bridge on an ephemeral `127.0.0.1` port. Throws if the peer is missing, the probe returns no rows, or the session zone is not UTC.

## Flow
1. `importPglite` dynamically imports `@electric-sql/pglite`; failure rethrows with an install hint and `cause` (`packages/pg-prime-testing/src/pglite.ts:122-133`).
2. `process.env.TZ` is set to `UTC`, `new PGlite()` is constructed and `waitReady` awaited, then the previous `TZ` is restored or deleted (`:67-75`).
3. `probePglite` queries `server_version_num`, `version()` and the session timezone offset through PGlite's own `query` method, not over the socket (`:103-119`).
4. A non-zero offset throws before any test runs (`:111-117`).
5. `serve(db)` starts the bridge (`:83`).
6. The URL is `postgres://postgres:postgres@127.0.0.1:<port>/postgres` (`:86`); `stop()` closes the bridge, then PGlite (`:90-93`).

## Gotchas
- PGlite takes its session `TimeZone` from the host and ignores libpq startup `options`, so the env pin during boot is the only lever (`:59-62`). The JS process keeps its own zone afterwards.
- PGlite is one backend: share one instance per test file (vitest `setupFiles`, not `globalSetup`), or temp tables, `set_config`, sequences and open transactions leak between files.
- Within one instance every connection is the same session; the bridge drops a socket that works inside another's transaction. Use `requiresConcurrency()` for such tests.
- `startPglite` takes no options; for a PGlite with extensions, construct it yourself and call `serve` directly.
- `pg-prime`'s own live harness has a separate `startPglite` in `packages/pg-prime/test/live/_pglite.ts` (imports `pg`, no `kind`); only the bridge is shared.

## Tests
- `packages/pg-prime-testing/test/live/pglite.test.ts`: URL/version/kind shape, ephemeral port (not 5432), UTC pin regardless of host `TZ`, DDL/insert/select through `pg-prime` over the bridge, session usable after a SQLSTATE.
- Run: `pnpm --filter @pg-prime/testing exec vitest run test/live/pglite.test.ts` (180 s timeouts from `vitest.config.ts`).
- Uncovered: the missing-peer error path and the non-UTC probe failure.
