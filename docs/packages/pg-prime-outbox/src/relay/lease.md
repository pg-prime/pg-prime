# packages/pg-prime-outbox/src/relay/lease.ts

## Purpose
Partition leases: the membership heartbeat, L1 (take free partitions up to the fair share) and
release.

## Public API
Internal:
- `Lease` — `{ p, token, epoch }`.
- `fairShare(P, live)` → `ceil(P / max(live, 1))` (`packages/pg-prime-outbox/src/relay/lease.ts:10`).
- `heartbeat(ctx, owner, leaseMs, held)` → `{ kept, live }` (`:17`).
- `acquire(ctx, owner, leaseMs)` → `{ leases, live }` (`:50`).
- `release(ctx, owner, leases, leave)` (`:88`).

## Flow
1. `heartbeat`: upserts this relay's `relays` row, deletes other members unseen for `10 × leaseMs`,
   extends `lease_until` of the held `(p, token)` pairs, and returns the extended `p`s plus the live
   member count (`seen_at` within `leaseMs`).
2. `acquire` (L1): counts live members and this owner's valid leases, picks
   `ceil(P / live) - mine` partitions that are free or expired (`token is null or lease_until < now()`),
   least recently served first, `for update skip locked`, and gives each a new token, `epoch + 1` and
   a lease. It always returns one row, so `live` comes back even when nothing was taken.
3. `release` clears `owner`, `token` and `lease_until` of the given pairs, deletes the membership row
   when `leave`, and NOTIFYs so waiting relays run L1 at once.

## Gotchas
- **Why a partition lease gives per-key order (X2).** A key always hashes to the same partition and
  a partition has one valid token at a time, so one relay reads a key's records, in id order. Per-row
  `SKIP LOCKED` could not do this: skipping a locked head hands out the key's next record.
- Every settle re-checks the token and `lease_until` under the partition row's lock, so a relay
  whose lease was taken over cannot mark anything; its records are redelivered with a higher epoch.
- Fairness reads unlocked counts and is advisory; correctness rests only on the per-row lock and
  token. Members that own nothing still count, so incumbents yield to a newcomer.
- The `relays` upsert and the stale-member delete touch disjoint rows (`owner = me` vs
  `owner <> me`), which the one-row-per-CTE golden test allows explicitly.

## Tests
- `packages/pg-prime-outbox/test/unit/relay-math.test.ts` — fair share counting non-owners.
- `packages/pg-prime-outbox/test/pg/relay.test.ts` — tier 2: per-key order under 4 relays, no
  concurrent delivery of a partition while relays come and go, rebalance 1 → 4 → 2.
- `packages/pg-prime-outbox/test/pg/sigkill.test.ts` — a killed relay's batch comes back with the
  same `idem` and a higher `epoch`.
