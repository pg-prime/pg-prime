# packages/pg-prime-events/src/log/migrations.ts

## Purpose
Migration v1 of the events schema (default `pgprime_events`), applied by core's
`migrateOwnedSchema` from `src/events.ts:85`, or vendored with `ownedSchemaSql`.

## Public API
- `MIGRATIONS` — internal `OwnedMigration[]`; version 1 `'events log'` creates `topics`, `entries`
  (+ `entries_cursor`, `entries_age` indexes), `subscriptions` and `parked`.

## Flow
1. `up(schema)` returns one statement per element (`packages/pg-prime-events/src/log/migrations.ts:7`);
   core runs them in one transaction under the schema's advisory lock and records the checksum.

## Gotchas
- `entries.xid` defaults to `pg_current_xact_id()`: the top-level xid, assigned at the first write.
- `entries` is append-only; `entries_cursor (topic, xid, id)` serves the cursor read.
- `subscriptions` has `fillfactor = 50` so commits and heartbeats stay HOT; `lease_until` is in no index.
- `parked` rows keep their `entries` row alive (retention skips them) and cascade with the subscription.
- Any change is a new version; editing v1 changes its checksum and every existing install refuses
  to start with `SchemaVersionError`.

## Tests
- `test/live/log.test.ts` — migrate idempotence and `ownedSchemaSql` convergence.
  `pnpm --filter @pg-prime/events test:live`.
