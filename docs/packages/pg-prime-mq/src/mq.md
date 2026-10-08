# packages/pg-prime-mq/src/mq.ts

## Purpose
`pgMq`: the instance that owns the schema, the declared queue handles, flows, bindings and the
shared `Core` every handle and worker closes over.

## Public API
- `pgMq(config)` → `Mq<D>`; `MqConfig` (`db`, `schema`, `autoMigrate`, `events`, `define`, `hooks`, `notify`).
- `Mq` — `queues`, `queue`, `flow`, `bind`, `start`, `migrate`, `observe`, `close`, async dispose.
- `migrationSql({ schema? })` → `OwnedSchemaFile[]` for vendoring into kit.
- `Core` (internal) — `db`, `t`, `hooks`, `running`, `ready`, `forget`, `assertStarted`, `events`.

## Flow
1. `ensure` runs `migrateOwnedSchema` once (`apply` per `autoMigrate`) and maps `ConfigError` to `SchemaVersionError` (packages/pg-prime-mq/src/mq.ts:83).
2. `core.ready(def)` ensures the schema, then upserts the queue row once per name (packages/pg-prime-mq/src/mq.ts:109).
3. `start()` ensures, readies every declared queue, then starts `events` if any (packages/pg-prime-mq/src/mq.ts:135).
4. `close()` closes every worker and binding in `running`.

## Gotchas
- `{ tx }` calls check `assertStarted` and never migrate inside the caller's transaction.
- `events` is created lazily with its default schema when `config.events` is absent.

## Tests
- `test/live/send.test.ts` (migrate, vendoring, `autoMigrate: false`, `NotStartedError`). `pnpm --filter @pg-prime/mq test`.
