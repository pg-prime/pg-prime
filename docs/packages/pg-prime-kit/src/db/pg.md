# packages/pg-prime-kit/src/db/pg.ts

## Purpose
The kit's direct `pg` access: connection info, a scoped single-client helper, and database provisioning (`CREATE`/`DROP DATABASE`) guarded by a cluster-wide advisory lock and a name prefix that alone authorises terminating sessions.
Callers: nearly every live module — `runner/run.ts`, `runner/status.ts`, `data/batch.ts`, `data/lag.ts`, `seed/*`, `shadow/ladder.ts`, `generate.ts`, `prove/*`, `pull/pull.ts`, `schema/load.ts`, `config/*`, CLI `baseline`/`checkpoint`/`doctor`/`lint`/`push`/`unlock`/`verify`, and `test/support/db.ts`; re-exported from `src/index.ts`.
Callees: the `pg` package.

## Public API
- `ConnInfo` — `{ host, port, user, password, database }`.
- `CatalogClient` — re-exported type from `catalog/extract.ts`.
- `withDatabase(c, database)` — copy of `c` with another database.
- `connectionString(c)` — `postgresql://` URL with URI-encoded user, password and database; brackets an IPv6 host.
- `hostOf(u)` — a `URL`'s hostname without IPv6 brackets, `127.0.0.1` when empty; both URL parsers use it.
- `redactUrl(url)` — `scheme://user@host/path` rebuilt from the parsed URL (no password, query or hash); `<redacted>` for anything unparseable, anything carrying `password=`, or a parse whose path/query/hash holds `@` or `:` (an unencoded password cut the authority short). For every message that echoes a URL.
- `withClient(c, fn)` — connects one `pg.Client`, runs `fn`, always `end()`s it; returns `fn`'s result.
- `SHADOW_PREFIX` — `"pgprime_shadow_"`.
- `isShadowDatabase(name)` — true when `name` starts with the prefix and is longer than it.
- `UnsafeDatabaseNameError` — `code = "PG_PRIME_UNSAFE_DATABASE_NAME"`; carries `database`, `operation`.
- `SQLSTATE_OBJECT_IN_USE` — `"55006"`; `isObjectInUse(err)` tests an error's `code` against it.
- `terminateConnections(admin, database)` — `pg_terminate_backend` for every other session on `database`; throws `UnsafeDatabaseNameError` unless it is a shadow name.
- `dropDatabase(admin, name)` — under the provision lock: for shadow names terminate sessions and `DROP … WITH (FORCE)`; otherwise a plain `DROP DATABASE IF EXISTS`.
- `createDatabase(admin, name, template?)` — under the provision lock, `CREATE DATABASE` optionally `TEMPLATE`; never terminates sessions.
- `runSqlScript(c, sql)` — one `query(sql)` on a fresh connection (multi-statement simple query).

## Flow
1. `withClient` spreads `ConnInfo` into `new pg.Client`, connects, runs `fn` in `try`, ends in `finally` (`packages/pg-prime-kit/src/db/pg.ts:27-35`).
2. `createDatabase`/`dropDatabase` take `pg_advisory_lock(7240101119233003)` on the admin connection, run, and unlock in `finally` (`:47-56`, `:111-131`).
3. `dropDatabase` decides `ours = isShadowDatabase(name)` first; only then terminates sessions and adds `WITH (FORCE)` (`:112-118`).

## Gotchas
- The provision lock key is fixed, so every concurrent `CREATE`/`DROP DATABASE` through this module serialises cluster-wide (`packages/pg-prime-kit/src/db/pg.ts:47`).
- Session termination and `WITH (FORCE)` are gated on the `pgprime_shadow_` prefix; a non-shadow drop fails with 55006 if anyone is connected (`:115-118`).
- `createDatabase` with a busy `TEMPLATE` raises 55006; callers must fall back (the shadow ladder demotes to tier 3) (`:122-126`).
- `WITH (FORCE)` needs PostgreSQL 13 or newer.
- Identifiers are double-quoted by a local helper, not `quoteIdent`, so no length or validity check happens here (`:95`).
- `withClient` does not catch connect errors; a failed connect throws before `fn` runs.
- `shadow/ladder.ts` tier 2 issues its own `CREATE`/`DROP DATABASE` for setup, outside this provision lock (see `packages/pg-prime-kit/src/shadow/ladder.ts:348-349`).

## Tests
- `packages/pg-prime-kit/test/provisioning.test.ts` (server): a bystander stays connected through `generate()`, the template tier is used when the source is idle, a clone name it did not mint is refused, `terminateConnections` refuses non-shadow databases.
- `packages/pg-prime-kit/test/plumbing.test.ts:44` — `connectionString` IPv6 bracketing and URI encoding.
- Used as the harness of every live test via `packages/pg-prime-kit/test/support/db.ts` (`createDatabase`, `dropDatabase`, `runSqlScript`).
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/provisioning.test.ts test/plumbing.test.ts` (`PG_PRIME_TEST_URL` or localhost port 54329 (`packages/pg-prime-kit/test/support/db.ts:42`)).
- Uncovered: concurrent provision-lock contention, the non-shadow 55006 drop failure.
