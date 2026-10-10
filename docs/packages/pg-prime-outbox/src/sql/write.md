# packages/pg-prime-outbox/src/sql/write.ts

## Purpose
W1: writes one or more records inside the caller's transaction in one statement, with per-key
ordering locks, idempotent inserts and a wake-up NOTIFY.

## Public API
- Internal `writeRecords(ctx, items, tx)` → `WriteResult[]` (`packages/pg-prime-outbox/src/sql/write.ts:10`),
  behind `OutboxTopic.write`/`writeMany`.
- `WriteItem<T>` — `{ payload } & Omit<WriteOptions, 'tx'>`.

## Flow
1. Each payload is validated by the topic's Standard Schema (`PayloadError` on issues) and encoded
   by its codec (`packages/pg-prime-outbox/src/sql/write.ts:87`); a missing `idempotencyKey` becomes
   `randomUUID()` client-side.
2. W1 (label `outbox.write`): `src` unpacks the JSON rows; `lk` takes
   `pg_advisory_xact_lock(hashtextextended(topic/key, 0))` for each distinct key in key order when
   `ordered`; `ins` inserts with `partition = abs(hashtextextended(key, 0) % P)` (random for unkeyed)
   and `on conflict (topic, idem) do nothing`; the final select NOTIFYs the topic channel once.
   `coalesce(payload, 'null'::jsonb)` stores a `null` or `undefined` payload as JSON `null`, since
   `jsonb_to_recordset` turns both into SQL NULL.
3. A `23502` (null `partition`: no `topics` row) becomes `NotStartedError`.
4. Inputs whose `idem` was not returned are duplicates; a second statement reads their existing ids.
   A repeated `idem` inside one batch is a duplicate of the first.
5. `onWrite` reports count and duplicates.

## Gotchas
- **Why `id` order is commit order per key (X3).** The key lock is taken before the insert assigns
  the identity value (`(select count(*) from lk)` is joined into the insert's source) and is held to
  commit. A second writer of the key waits for the first to commit, then takes a larger id. So the
  relay, reading pending rows in id order, can never see a later record of a key before an earlier
  one has committed. With `ordered: false` a later id can commit first and is delivered first.
- Keys are locked in sorted order within one call, so two batches sharing keys cannot deadlock.
  Separate `write` calls in one transaction are not sorted against each other: two transactions
  writing the same keys in opposite orders deadlock (40P01). Use one `writeMany` or a consistent
  key order.
- `abs(h % P)`, not `mod(abs(h), P)`: `abs` of the minimum bigint overflows.
- The NOTIFY sits in a scalar subquery of the final select (an unreferenced select CTE would not
  run); PostgreSQL sends it only on commit, collapsed to one per transaction.
- Under REPEATABLE READ, a conflict with a row committed after the snapshot is a serialization
  failure, which the caller's transaction retry handles.

## Tests
- `packages/pg-prime-outbox/test/unit/sql.test.ts` — golden SQL.
- `packages/pg-prime-outbox/test/live/outbox.test.ts` — rollback, duplicates, start rules, null
  payloads, codec.
- `packages/pg-prime-outbox/test/pg/ordered.test.ts` — tier 2: a held writer serializes the next
  writer of its key, and `ordered: false` shows the inversion.
