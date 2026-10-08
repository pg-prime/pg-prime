# packages/pg-prime-events/src/events.ts

## Purpose
`pgEvents`: builds the typed registries and the shared `Core` the topic and subscription handles
use; owns schema ensure (migrate or check), declaration upserts and `close()`.

## Public API
- `pgEvents(config)` → `Events<D>`; `config` is `EventsConfig { db, schema? = 'pgprime_events',
  autoMigrate? = true, define?, hooks? }`.
- `Events<D>` — `channels` / `topics` / `subscriptions` registries, ad hoc `channel` / `topic` /
  `subscription`, `start()`, `migrate()`, `observe(hooks)`, `close()`, `Symbol.asyncDispose`.
- `Core` — internal: `db`, `sql`, `hooks`, `running`, `topicChannel`, `ready`, `forget`, `assertStarted`.

## Flow
1. Validate the schema name with `quoteIdentPart` (`packages/pg-prime-events/src/events.ts:74`).
2. `ensure()` memoizes `migrateOwnedSchema` (`apply` = `autoMigrate`); behind → `SchemaVersionError`,
   core `ConfigError` (checksum, `min_client`) → `SchemaVersionError` (`:83`).
3. `ready(def)` memoizes per declaration: ensure, then upsert the topic, or the topic and then the
   subscription with a cursor seeded once (`BEGINNING` or `seed(pg_current_snapshot())`) (`:110`).
4. `start()` = ensure + ready for every declared topic and subscription (`:151`).
5. `migrate()` applies regardless of `autoMigrate` and marks the schema ensured (`:156`).
6. `close()` closes every reader and tail in `running`; the `db` stays open (`:141`).

## Gotchas
- `{ tx }` publishes require `start()` (or any earlier non-tx call) to have ensured the schema;
  otherwise `NotStartedError`, never a lazy migration inside the caller's transaction.
- Channels never touch the schema; a channels-only user need not call `start()`.
- A schema that is behind points only at `events.migrate()`: events exports no vendorable SQL.
- Failed ensures and readies are forgotten so the next call retries (`:99`, `:126`).
- Topic upserts make declarations authoritative for `keep_ms` / `keep_until_consumed`.

## Tests
- `test/live/log.test.ts` — migrate idempotence, vendored `ownedSchemaSql` convergence,
  `autoMigrate: false`, `NotStartedError`. `test/unit/types.test.ts` — registry typing.
  `pnpm --filter @pg-prime/events test:live`.
