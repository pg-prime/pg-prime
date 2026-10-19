# packages/pg-prime-kit/src/seed/db.ts

## Purpose
Builds the typed `pg-prime` `Db` handed to `.ts` seeds. It is the kit's only runtime (value) import of the `pg-prime` peer, done dynamically so the kit still loads without the peer.
Callers: `src/seed/run.ts` (`openSeedDb`, only when a `.ts` seed is in the run). Not re-exported from `src/index.ts`.
Callees: dynamic `import("pg-prime")` (`pgPrime`, `pgDriver`, `defineSchema`), `config/ts-specifiers.ts` (`enableTsSpecifiers`), `config/load.ts` (`ConfigError`, `tsSpecifierAdvice`), `db/pg.ts` (`connectionString`), `pg.Pool`.

## Public API
- `openSeedDb(conn, schemaPaths)` → `SeedDb` — imports the peer and the schema modules, builds a registry, a `max: 1` pool, a driver and a `Db`. Throws `ConfigError` when the peer is missing or lacks `pgPrime`/`pgDriver`, or when no schema is found.
- `SeedDb` — `{ db, close() }`; `close` ends the pool and swallows errors.
- `registryFrom(modules, mod)` — the first export (default first) shaped like a `defineSchema` result (`tables` and `h` objects); else wraps every table-like named export with `mod.defineSchema`, keyed by export name. Throws `ConfigError` when none.
- `describeConnection(conn)` — `redactUrl(connectionString(conn))`, for reports.

## Flow
1. `import("pg-prime")` with a literal specifier; failure becomes a `ConfigError` telling the user to install the peer or write `.sql` seeds (`packages/pg-prime-kit/src/seed/db.ts:104-111`).
2. Check `pgPrime` and `pgDriver` are functions (`:112-116`).
3. `enableTsSpecifiers()`, then import each schema path as a `file://` URL; an import failure is rethrown through `tsSpecifierAdvice` (`:119-128`).
4. `registryFrom` picks or builds the schema registry (`:129`, `:68-88`).
5. Create `new pg.Pool({ ...conn, max: 1 })`, `pgDriver({ pool })`, `pgPrime({ driver, schema })` (`:131-133`).

## Gotchas
- The `import("pg-prime")` specifier must stay a literal: `packages/pg-prime-kit/test/schema-emit/no-value-import.test.ts:51` allows exactly one dynamic import, in this file.
- The peer resolves from the project, so seeds use the user's own DSL copy; a version that lacks `pgPrime`/`pgDriver` is refused (`packages/pg-prime-kit/src/seed/db.ts:112-116`).
- The pool has one connection so a seed's `db.transaction(...)` covers all its writes (`:93-96`, `:131`).
- Bare-table registries are keyed by export name (`db.users`), not `schema.table` (`:62-66`, `:77`).
- `PgPrimeModule` is structural; a change to the peer's constructor shape (`pgPrime({ driver, schema })`) breaks this file at runtime, not at compile time (`:34-38`).
- `describeConnection` has no caller in `src/`.
- `pathHref` builds `file://` URLs by hand (`packages/pg-prime-kit/src/seed/db.ts:143-145`) and duplicates the helper in `packages/pg-prime-kit/src/seed/run.ts:213`.

## Tests
- `packages/pg-prime-kit/test/seed/seed.test.ts` (server, drives the CLI binary): a `.ts` seed uses the builder and inserts (schema via `export default defineSchema(...)`, `packages/pg-prime-kit/test/cli/_project.ts:73`); a `.ts` config and seed import a sibling schema with the `.js` specifier.
- `packages/pg-prime-kit/test/schema-emit/no-value-import.test.ts` — the single-dynamic-import guard (no server).
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/seed/seed.test.ts` (`PG_PRIME_TEST_URL` or localhost port 54329 (`packages/pg-prime-kit/test/support/db.ts:42`)).
- Uncovered: the missing-peer and empty-schema `ConfigError` paths, `registryFrom` bare-table wrapping, `describeConnection`.
