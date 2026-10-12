# packages/pg-prime-outbox/src/schema.ts

## Purpose
Migration v1 of the owned schema (default `pgprime_outbox`) and `migrationSql` for vendoring it.

## Public API
- `migrationSql(opts?)` → `OwnedSchemaFile[]` (`packages/pg-prime-outbox/src/schema.ts:68`), via
  core's `ownedSchemaSql`.
- Internal: `DEFAULT_SCHEMA`, `MIGRATIONS` (`packages/pg-prime-outbox/src/schema.ts:6`).

## Flow
1. Version 1 creates `record_state` (`pending | delivered | parked`), `topics`, `records`,
   `partitions`, `relays` and `blocked`, plus three partial indexes on `records`: `records_pending
   (topic, partition, id)`, `records_parked (topic, id)`, `records_kept (topic, delivered_at)`.
2. `pgOutbox` applies it through `migrateOwnedSchema`; `migrationSql` renders the same statements
   with the ledger insert.

## Gotchas
- `records.topic` has no foreign key (writes stay one index lookup); `partitions` and `relays`
  cascade from `topics`.
- `records` has `fillfactor = 80` and aggressive autovacuum scale factors because rows are updated
  once (delivered) and later deleted.
- `blocked` holds only currently failing keys; `until = 'infinity'` marks a parked head.
- A new version must stay transactional (no `create index concurrently`).

## Tests
- `packages/pg-prime-outbox/test/unit/define.test.ts` — `migrationSql` for a custom schema.
- `packages/pg-prime-outbox/test/live/outbox.test.ts` — "vendored migrationSql converges".
