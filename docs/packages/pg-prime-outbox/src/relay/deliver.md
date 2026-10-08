# packages/pg-prime-outbox/src/relay/deliver.ts

## Purpose
Reading a leased partition (R1), splitting a read into waves, the settle statements D1/F1/K1, and
the retention sweep.

## Public API
Internal:
- `readPartition(ctx, p, limit)` → `(OutboxRecord | Undecodable)[]`
  (`packages/pg-prime-outbox/src/relay/deliver.ts:18`); `Undecodable` (`:10`) carries a
  `NonRetryableSinkError` in place of the payload.
- `waves(rows, failed)` — generator of waves (`:51`).
- `settleDelivered(ctx, lease, ids)` → count (`:69`); `settleFailed(ctx, lease, id, error, delayMs)`
  (`:93`); `settleParked(ctx, lease, id, error)` (`:116`) → 0 when the lease is gone.
- `sweep(ctx, everyMs, limit, force)` → deleted count (`:140`).

## Flow
1. R1 reads the partition's pending records with `next_at <= now()`, skipping keys with a live
   `blocked` row and everything while the topic is paused, in id order, up to `limit`. Each row is
   decoded on its own; one whose codec throws comes back `Undecodable`, so it parks instead of
   failing the whole read.
2. `waves`: wave k holds the k-th record of each key; unkeyed records join wave 0. A key added to
   `failed` is left out of every later wave.
3. Each settle locks the partition row (`for update`) only if `token` matches and the lease is
   valid; every data-modifying CTE is driven by that lock.
4. D1 marks the ids delivered (or deletes them when `keepDeliveredMs` is 0), deletes their keys'
   `blocked` rows and bumps `served_at`. F1 increments `attempts`; a keyed record upserts
   `blocked.until = now() + delay`, an unkeyed one moves its own `next_at`. K1 parks the record and
   blocks its key with `until = 'infinity'`.
5. `sweep` wins a CAS on `topics.maint_at` (or skips it with `force`) and deletes up to `limit`
   delivered records older than `keep_delivered_ms`.

## Gotchas
- R1 takes no row locks: the partition lease makes this relay its only reader, and every write
  re-checks the lease.
- A D1 count below the requested ids means the lease was lost mid-wave; the rest is redelivered.
- Data-modifying CTEs always run, so each is gated by `exists (select from l)` rather than relying
  on the final select.
- Sweeping without the CAS is only for continuing a sweep the caller already won.

## Tests
- `packages/pg-prime-outbox/test/unit/relay-math.test.ts` — wave split and exclusion.
- `packages/pg-prime-outbox/test/unit/sql.test.ts` — golden SQL for R1, both D1s, F1, K1, retention.
- `packages/pg-prime-outbox/test/pg/relay.test.ts` — "head failure keeps receiver order".
- `packages/pg-prime-outbox/test/live/outbox.test.ts` — an undecodable payload parks and blocks only
  its key.
