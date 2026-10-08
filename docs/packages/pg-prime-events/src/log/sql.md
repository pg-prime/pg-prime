# packages/pg-prime-events/src/log/sql.ts

## Purpose
Every statement of the event log (plan 15 §3), built on pg-prime's `sql` tag against one schema and
labelled `events.<op>`. Called by `src/events.ts`, `src/log/topic.ts` and `src/log/subscription.ts`.

## Public API
- `statements(schema)` → `Statements`, internal. Each method takes a `Queryable` first, so it can run
  on the root `db` or inside a caller's transaction.
- Methods: `publish` (P1), `seedNow`, `upsertTopic`, `upsertSubscription`, `lease` (L1), `heartbeat`
  (L2), `release`, `read` (R1), `mark` (A1), `commit` (C1), `nack`, `park` (K1), `maintain`
  (retention), `reset`, `lag`, `parked`, `discard`, `remove`, `browse`.
- `EntryRow`, `LeaseRow`, `NewEntry` — row shapes.

## Flow
1. P1: one insert from `jsonb_to_recordset … with ordinality`, ids aggregated in order, one
   `pg_notify` referenced from the final select (`packages/pg-prime-events/src/log/sql.ts:134`).
2. L1 takes or steals an expired lease with a fresh token and returns the cursor and head marker (`:192`).
3. R1 reads `late`, `next` and `running` in one statement (`:232`).
4. A1 writes the attempt marker before a handler runs: a batch records `head_attempts = 0`, a single
   entry increments its own count (`:267`).
5. C1, nack and K1 are token-guarded; 0 rows means the lease was lost (`:281`, `:292`, `:302`).
6. `maintain` gates per topic on a `maint_at` CAS, then deletes in batches of 1000 (`:321`).

## Gotchas
- Every guarded write returns a row on success; callers turn 0 rows into `EventsLeaseLostError`.
- K1's `parked` insert is driven by the guarded update's `RETURNING`, so a stale reader parks nothing;
  `on conflict do update` re-parks after a `reset`.
- No statement modifies one table twice (asserted in tests).
- xids travel as text (`::xid8` casts both ways); arrays are bound as array literals.
- Retention keeps parked entries and, with `keepUntilConsumed`, anything above a subscription's
  position or in its pending set; it reports `behind` when it deleted unread entries.
- `nack` stores only the delay; the attempt was already counted by A1.

## Tests
- `test/unit/sql.test.ts` — golden SQL and binds snapshot, no table modified twice, notify referenced.
- `test/live/log.test.ts`, `test/pg/reader.test.ts` (stale reader cannot commit or park).
  `pnpm --filter @pg-prime/events test`.
