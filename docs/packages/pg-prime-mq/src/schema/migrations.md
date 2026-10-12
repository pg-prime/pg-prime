# packages/pg-prime-mq/src/schema/migrations.ts

## Purpose
Schema version 1 of `pgprime_mq`, applied by `migrateOwnedSchema` and vendored by `migrationSql`.

## Public API
- `MIGRATIONS` (internal) — one `OwnedMigration`: enums `msg_state`, `dep_status`, `on_fail`; sequence
  `msg_seq`; tables `queues`, `messages`, `groups`, `deps`, `dedup` and their partial indexes.

## Flow
1. Statements run in order inside one locked transaction per version (core's runner).

## Gotchas
- `queues.watch` is beyond plan 17 §4: `[watch]` reads it, so every process emits watch events.
- No FK on `deps.child`: a retention-deleted child's result survives for its parent.
- `messages` has `fillfactor = 70`; heartbeat and counter updates touch no indexed column (HOT).

## Tests
- `test/live/send.test.ts` (idempotent migrate, vendored files converge). `pnpm --filter @pg-prime/mq test`.
