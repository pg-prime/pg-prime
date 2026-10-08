# packages/pg-prime-events/src/log/cursor.ts

## Purpose
The exact cursor of plan 15 §3.3 as pure functions: a position `(xid, id)` plus `pending`, the
transactions below the position that were still running when a read stepped over them. Used by
readers (`src/log/subscription.ts`), tails (`src/log/topic.ts`) and seeding (`src/events.ts`).

## Public API
- `Cursor` — `{ xid, id, pending: Map<xid, after> }`; `after` is the last id delivered from that
  transaction (0: none). Internal, exposed only as the opaque `Entry.cursor` string.
- `ReadView` — `{ pos, late, running }`: the last unfiltered `next` row of a read (or null), the
  last unfiltered `late` row when `late` filled the read limit (or null), and the read snapshot's
  `pg_snapshot_xip`.
- `BEGINNING` — `(0, 0)`, no pending. `seed(xmax, xip)` — `from: 'now'`: `(xmax, 0)`, xip pending at 0.
- `advance(c, read, e)` — the cursor right after acknowledging `e`.
- `advanceTo(c, read)` — the cursor once the whole read is acknowledged, even if it delivered nothing.
- `encodeCursor(c)` / `decodeCursor(s)` — `xid.id[.x:a,…]`; a bad string is a `UsageError`.

## Flow
1. R1 reads `late` (pending xids, ids above their `after`, in `(xid, id)` order) and `next`
   (`(xid, id) > position`), at most n rows in all, in one statement whose snapshot also yields
   `running` (`src/log/sql.ts:234`).
2. `advance` for a late entry sets that xid's `after` (`packages/pg-prime-events/src/log/cursor.ts:33`);
   for a next entry it moves the position and adds every running xid below it to pending (`:37`).
3. `advanceTo` moves the position to `pos`, adds running xids below it, then prunes pending xids that
   are no longer running, up to where `late` was cut off (`:42`).

## Gotchas
- Why nothing is lost: a transaction visible now either has an xid above the position (read by
  `next`) or was running below it when the position crossed it, so it is pending and `late` reads
  what remains. A transaction without an xid yet gets one ≥ the snapshot's `xmax` > the position.
- Running xids ≥ `xmax` are not in `xip`, but every visible xid is below `xmax`, so the position is
  always below them and never steps over them.
- Why nothing is duplicated: `late` takes ids above `after`, `next` takes rows above the position,
  and a pending xid is always below the position, so the two sets are disjoint.
- Prune only in `advanceTo`, after the whole read is acknowledged: a finished transaction's entries
  all became visible at once and `late` reads them in `(xid, id)` order. If `late` filled the limit,
  only xids below its last row are complete: that xid keeps `after` = the last row's id, and higher
  xids keep theirs. A partial acknowledgement (failure, isolation) uses `advance` only.
- `late` is bounded by the read limit, so a large late transaction arrives in batches of n and an
  isolating reader reads one row per step instead of every remaining late row.
- `pending` is bounded by concurrent transactions: aborted or entry-less xids leave at the next prune.
- Ordering: entries are delivered once per cursor; a transaction's entries arrive in insertion
  order, but a read limit can split a transaction and a late one may arrive between its parts.
  There is no total order across concurrent transactions.
- Not delayed by unrelated long transactions, unlike an `xmin` watermark; an unrelated running xid
  only sits in `pending`.
- `Entry.cursor` is the only valid resume handle: ids follow neither xid nor commit order.

## Tests
- `test/unit/cursor.test.ts` — fast-check property over a model of PostgreSQL snapshots (lazy xids,
  one id sequence, `xmax = latestCompletedXid + 1`) with `types` filters, partial acks, per-entry
  commits, crashes, `Entry.cursor` resumes and `from: 'now'`; asserts the stepped-over-running-xid
  invariant at every cursor, plus named interleavings and encoding round trips.
- `test/pg/cursor.test.ts` — 8 producers, aborts, a 20 s open transaction and 10 reader restarts on a
  real server; E-Q1 (`pg_current_snapshot()` is the statement snapshot).
- `pnpm --filter @pg-prime/events test`; `PG_PRIME_TEST_URL=… pnpm --filter @pg-prime/events test:pg`.
