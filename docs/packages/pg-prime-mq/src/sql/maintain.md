# packages/pg-prime-mq/src/sql/maintain.ts

## Purpose
Maintenance statements: the per-queue gate, retention by age and count (S10), expired dedup
windows, and lock-then-count counter reconciles.

## Public API
- Internal: `maintenanceGate`, `expireBatch`, `trimBatch`, `dedupBatch`, `reconcileGroups`, `reconcileQueue`.

## Flow
1. The gate is a CAS on `queues.maint_at` and returns the count limits (packages/pg-prime-mq/src/sql/maintain.ts:6).
2. Batches of ≤ 1 000 rows `for update skip locked`.
3. Reconcile: statement 1 locks the counter rows, statement 2 counts in a fresh snapshot (packages/pg-prime-mq/src/sql/maintain.ts:87).

## Gotchas
- Reconciles must run in a transaction (the worker uses `db.transaction`): the lock spans both statements.
- Age retention only deletes finished rows, whatever `expire_at` says.

## Tests
- `test/live/work.test.ts` (retention); `test/pg/concurrency.test.ts` (reconcile cannot over-book). `pnpm --filter @pg-prime/mq test:pg`.
