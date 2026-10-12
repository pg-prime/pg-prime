---
'pg-prime': minor
---

**`migrateOwnedSchema()` and `ownedSchemaSql()`: versioned DDL for a schema a package owns.**

`migrateOwnedSchema(db, { schema, migrations })` applies each missing version in its own
transaction under `pg_advisory_xact_lock`, so concurrent migrators and transaction poolers are
safe. It keeps a ledger in `<schema>.migrations` and refuses a checksum mismatch or a schema whose
`min_client` is newer than the client. It returns `{ from, to }`; `apply: false` only reads and
checks. `ownedSchemaSql()` emits the same versions as SQL files, ending in an idempotent ledger
insert, for vendoring into kit migrations. The `@pg-prime/*` add-ons build their schemas on it.

**`db.listen()`: every subscription gets its own `gap`, `reconnect` and `error`.** Before this
release a second subscription on the same channel replaced the first one's handlers, so only the
latest subscriber heard about a reconnect. Each subscription now has its own handlers, a throwing
notification handler reports to its own subscription's `error`, and closing one subscription
removes only its handlers.
