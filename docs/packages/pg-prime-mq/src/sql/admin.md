# packages/pg-prime-mq/src/sql/admin.ts

## Purpose
Admin statements: queue upsert, pause, cancel flag, retry, tree removal, purge, drop and group rows.

## Public API
- Internal: `upsertQueue`, `setPaused`, `flagCancel`, `RetrySel`, `withUnresolvedChildren`, `retrySql`,
  `retry`, `lockTree`, `deleteMessages`, `resolveRemoved`, `purgeBatch`, `activeCount`, `dropRows`,
  `GroupLimits`, `setGroup`.

## Flow
1. `upsertQueue` syncs limits, retention and `watch`; `keep: false` stores 0 ms (packages/pg-prime-mq/src/sql/admin.ts:12).
2. Retry resets finished rows and puts a `failed` dependency back to `pending` (packages/pg-prime-mq/src/sql/admin.ts:79).
3. `lockTree` walks `messages_parent` and locks without waiting (packages/pg-prime-mq/src/sql/admin.ts:120).

## Gotchas
- Retry clears `expire_at`, `cancel` and `child_failed`, so retention never deletes a re-queued row.
- Deleting messages deletes only their `until-done` dedup rows; windows expire on their own.

## Tests
- `test/live/work.test.ts`, `test/live/flow.test.ts`, `test/live/groups.test.ts`. `pnpm --filter @pg-prime/mq test:pg`.
