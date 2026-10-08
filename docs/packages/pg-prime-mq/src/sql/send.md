# packages/pg-prime-mq/src/sql/send.ts

## Purpose
S1/F1/spawn: the only insert path for messages, with dedup decided from the locked dedup row,
group rows for new groups, `deps` rows with their waiter, and the wake NOTIFY.

## Public API
- Internal: `NewRow`, `InsertOptions` (`extend`, `flow`, `parent?`), `Inserted`, `OnFail`;
  `insertSql`, `insert`, `dedupOwners(q, t, queue, keys)`.

## Flow
1. `src` assigns ids with `nextval` in batch order (packages/pg-prime-mq/src/sql/send.ts:64).
2. `par` (spawn) bumps the parent's `pending_deps`, guarded by its token; children need it.
3. `d` upserts dedup rows: reclaims an expired window, extends on debounce.
4. `ins` inserts survivors (`blocked` with children, `delayed` with a future time); `dps`, `grp`, wake, watch follow.

## Gotchas
- `ON CONFLICT DO UPDATE` cannot touch a row twice: callers collapse duplicate keys per statement.
- A dedup loser reads the winner with a later statement (fresh snapshot).

## Tests
- `test/live/send.test.ts`, `test/pg/concurrency.test.ts` (dedup under 50 sends). `pnpm --filter @pg-prime/mq test:pg`.
