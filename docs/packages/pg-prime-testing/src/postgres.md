# packages/pg-prime-testing/src/postgres.ts

## Purpose
Tier-2 fixtures against a real PostgreSQL: `startPostgres` runs a container via the optional peer `@testcontainers/postgresql`, and `scratchDatabase` carves a throwaway `pgprime_test_*` database out of a server you already have. Admin statements go through `pg-prime` itself (`pgPrime`, `defineSchema`, `sql` from `pg-prime`). Re-exported by `packages/pg-prime-testing/src/index.ts:57`; reuses `TestServer` from `pglite.ts`.

## Public API
- `ScratchDatabase` — `{ url, name, drop(): Promise<void> }`; `drop` is idempotent.
- `StartPostgresOptions` — `image?` (default `postgres:17`), `settings?` (extra `-c key=value`).
- `PostgresServer` — `TestServer` with `kind: 'postgres'`.
- `SCRATCH_PREFIX` — `'pgprime_test_'`, the only prefix created or dropped.
- `scratchDatabaseName(): string` — `pgprime_test_` + 12 random hex chars.
- `isScratchDatabase(name): boolean` — starts with the prefix and is longer than it.
- `scratchDatabase(adminUrl): Promise<ScratchDatabase>` — `CREATE DATABASE` a fresh name; returns its URL.
- `dropScratchDatabase(adminUrl, name): Promise<void>` — terminates its backends, then `DROP DATABASE IF EXISTS`; throws on a non-scratch name.
- `startPostgres(options?): Promise<PostgresServer>` — starts a container, probes it; throws a hinted `Error` if the peer is missing.
- `probe(url): Promise<{ versionNum; version }>` — `server_version_num` and `version()` of the server at `url`.
- `databaseUrl(url, database): string` — replaces the URL path with the URI-encoded database name.
- `dockerAvailable(): Promise<boolean>` — cached check that the peer imports and `docker version` exits 0.

## Flow
1. `scratchDatabase` picks a name and runs `create database <ident>` on a one-connection admin handle (`packages/pg-prime-testing/src/postgres.ts:83-87`).
2. It returns `databaseUrl(adminUrl, name)` and a `drop` guarded by a local `dropped` flag (`:89-98`).
3. `dropScratchDatabase` refuses non-scratch names before connecting (`:110-115`), then runs `pg_terminate_backend` over `pg_stat_activity` for that database and `drop database if exists` (`:116-121`).
4. `withAdmin` opens `pgPrime({ connection, schema: defineSchema({}), poolOptions: { max: 1 }, devGuard: false })` and always calls `db.end()` (`:188-200`).
5. `startPostgres` imports testcontainers (`:132`), builds `-c` args with `TimeZone=UTC` first, then user settings (`:134-136`).
6. It starts `PostgreSqlContainer(image).withCommand(['postgres', ...args])`, reads `getConnectionUri()`, and `probe`s it (`:138-140`); `stop()` stops the container (`:146-148`).
7. `dockerAvailable` memoises one promise (`:237-248`): import the peer, then spawn `docker version --format {{.Server.Version}}` with a 10 s `SIGKILL` timeout (`:251-270`); any error resolves `false`.

## Gotchas
- `dropScratchDatabase` kills sessions; the prefix check is the safety property, and it is mechanical so it cannot be aimed at a real database.
- `settings` can override `TimeZone` because user settings are spread after it (`:134`).
- The database segment of `adminUrl` is only used to connect; the returned URL replaces it, keeping host, credentials and query string (`:164-168`).
- `dockerAvailable` caches for the process lifetime, including a `false` (`:237-239`). Despite the comment at `:235`, it shells out to the `docker` CLI, not testcontainers' client; the peer import is checked separately.
- Error messages from `probe` redact the password (`redact`, `:171`).
- `pg-prime` is imported eagerly at module top (`:21`), so it must be installed even if only the PGlite tier is used.
- `scratchDatabaseName` uses `Math.random`, not a CSPRNG.

## Tests
- `packages/pg-prime-testing/test/pg/postgres.test.ts`: naming and refusal (always run, no server); scratch create/connect/drop, drop with an open transaction, idempotent `drop()`, `probe` (needs `PG_PRIME_TEST_URL`, guarded by `requiresRealPostgres`); `startPostgres` with `TimeZone` = UTC (needs Docker, guarded via `dockerAvailable`).
- Run: `PG_PRIME_TEST_URL=postgres://… pnpm --filter @pg-prime/testing exec vitest run --project pg`.
- Uncovered: custom `image`/`settings`, the missing-peer error, `dockerAvailable` false paths.
