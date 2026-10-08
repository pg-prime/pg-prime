# packages/pg-prime/src/session/owned-schema.ts

## Purpose
Versioned DDL for a schema an add-on package owns (`pgprime_events`, `pgprime_mq`, …), with a ledger
table `<schema>.migrations (version, name, min_client, checksum, applied_at)`. Two paths converge on the
same ledger rows: `migrateOwnedSchema` at runtime and `ownedSchemaSql` for vendoring as kit migrations.
Re-exported from `packages/pg-prime/src/index.ts:418`.

## Public API
- `OwnedMigration` — `{ version, name, minClient?, up(schema) }`; `up` gets the quoted schema and returns
  one statement per element; `minClient` defaults to 1.
- `OwnedSchemaOptions` — `{ schema, migrations }`.
- `OwnedSchemaFile` — `{ version, name, sql }`.
- `migrateOwnedSchema(db, { schema, migrations, apply? })` → `{ from, to }`.
- `ownedSchemaSql({ schema, migrations })` → one `OwnedSchemaFile` per version.

## Flow
1. `plan` quotes the schema with `quoteIdentPart`, checks versions are strictly increasing integers
   (`UsageError` otherwise), renders each `up`, and checksums the statements with the 64-bit FNV-1a of
   `advisoryKey` (`packages/pg-prime/src/session/owned-schema.ts:100`).
2. `migrateOwnedSchema` loops one transaction per step (`packages/pg-prime/src/session/owned-schema.ts:53`):
   `tx.advisoryLock('pgprime-owned:' + schema)` (`:62`), then `ledger` creates the schema and ledger
   when missing and `apply` is on (`:127`), then `check` (`:142`).
3. The first version missing from the ledger is applied and its row inserted; the loop ends when at most
   one was missing. `from` is the ledger's version seen by the first transaction.
4. `ownedSchemaSql` emits per version: `pg_advisory_xact_lock(<same key>)`, the bootstrap, the DDL and an
   `insert … on conflict do nothing` ledger row (`packages/pg-prime/src/session/owned-schema.ts:83`).

## Gotchas
- `check` throws `ConfigError` for a ledger checksum that differs from the client's, and for a ledger
  `min_client` above the client's latest version (`packages/pg-prime/src/session/owned-schema.ts:147`,
  `:154`). Packages wrap it in their own `SchemaVersionError`.
- The checksum covers the DDL as rendered with the schema name, so the same migration under another
  schema has another checksum; that is consistent because the ledger lives in the schema.
- With `apply: false` nothing is created; a missing ledger reads as version 0 (`:134`).
- Every version runs in a transaction, so `create index concurrently` cannot be a step.
- Vendored files converge only in one direction: applied first, `migrateOwnedSchema` then skips them.
  After the runtime applied a version its file's ledger insert is a no-op, but its DDL is not idempotent.
- The lock key is `advisoryKey('pgprime-owned:' + schema)`, so the vendored file and the runtime
  migrator serialize on the same lock.

## Tests
- `packages/pg-prime/test/session/owned-schema.test.ts` — tier 0: the vendored SQL shape, checksum
  sensitivity, schema quoting and version validation. `pnpm --filter pg-prime exec vitest run test/session`.
- `packages/pg-prime/test/live/owned-schema.test.ts` — tier 1 (PGlite): idempotence, `apply: false`,
  checksum mismatch, `min_client`, vendored-then-runtime convergence. `pnpm --filter pg-prime test:live`.
- `packages/pg-prime/test/pg/owned-schema.test.ts` — tier 2: five concurrent migrators apply each
  version once. `PG_PRIME_TEST_URL=… pnpm --filter pg-prime exec vitest run --project pg test/pg/owned-schema.test.ts`.
- `packages/pg-prime/test/session/backoff-vectors.test.ts` checks `fixtures/backoff/vectors.json` (the
  add-ons' `backoffMs` vectors) against core's `retryDelayMs`.
