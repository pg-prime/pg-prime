# packages/pg-prime-mq/src/sql/lease.ts

## Purpose
The heartbeat (S6) and lease expiry (S9): an expired lease is a failed attempt, re-queued with the
message's own backoff or returned as exhausted.

## Public API
- Internal: `heartbeat(q, t, held, leaseMs)` → `Map<id, cancel>`; `backoffSql(retry, attempts, random?)`;
  `expiryGate`; `expireSql`; `expire` → `{ requeued, exhausted }`.

## Flow
1. S6 extends held leases `for update of m skip locked`: a row held by an open transaction is skipped (packages/pg-prime-mq/src/sql/lease.ts:6).
2. S9g, a CAS on `queues.expire_at`, lets one scanner per queue per interval through (packages/pg-prime-mq/src/sql/lease.ts:39).
3. S9 locks expired active rows `skip locked`, re-queues those with attempts left, decrements counters (packages/pg-prime-mq/src/sql/lease.ts:58).

## Gotchas
- Exhausted messages are not finished here: each goes through `finish(…, 'failed', expired)`.
- `backoffSql` equals `backoffMs` exactly for a given random value.

## Tests
- `test/live/backoff.test.ts` (vectors in SQL); `test/pg/concurrency.test.ts` (recovered once, held row). `pnpm --filter @pg-prime/mq test:pg`.
