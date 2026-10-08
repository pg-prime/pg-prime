# packages/pg-prime-outbox/src/sql/admin.ts

## Purpose
The topic's operator statements: create, list parked, replay, discard, pause/resume, stats.

## Public API
Internal, behind `OutboxTopic`:
- `createTopic(ctx)` → stored partition count (`packages/pg-prime-outbox/src/sql/admin.ts:5`).
- `listParked(ctx, limit, after)` → `ParkedRecord[]` (`:22`).
- `replay(ctx, ids)`, `discard(ctx, ids)` → affected count (`:42`, `:61`).
- `setPaused(ctx, paused)` (`:79`), `stats(ctx)` → `OutboxStats` (`:89`).

## Flow
1. `createTopic` upserts `topics` (only `keep_delivered_ms` is updated on conflict) and inserts
   `partitions` rows `0..P-1` for the stored `P` with `on conflict do nothing`.
2. `replay`: parked → pending with `attempts = 0`, `next_at = -infinity`, `error = null`; deletes
   their keys' `blocked` rows; NOTIFYs when anything changed.
3. `discard`: deletes parked records and their keys' `blocked` rows; NOTIFYs.
4. `setPaused` updates `topics.paused` (read by R1); resuming NOTIFYs.
5. `stats` reads every partition with a lateral pending count and oldest `created_at`, plus the
   parked count, blocked keys (`until > now()`) and `paused`.

## Gotchas
- `replay` and `discard` touch only rows in state `parked` of this topic; other ids are ignored.
- A key's parked record is its head (later records stay pending behind the block), so deleting the
  key's `blocked` row on replay/discard is enough to unblock it.
- The parent/child inserts of `createTopic` share one statement; the foreign key is checked at its end.
- `listParked` returns the stored JSON as `payload` when the codec cannot decode it, so a record
  parked for that reason can still be listed and discarded.

## Tests
- `packages/pg-prime-outbox/test/unit/sql.test.ts` — golden SQL and the one-row-per-CTE rule.
- `packages/pg-prime-outbox/test/live/outbox.test.ts` — park/replay/discard, pause, stats.
