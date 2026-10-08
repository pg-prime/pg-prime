# packages/pg-prime-mq/src/sql/claim.ts

## Purpose
Claims (S3 fast path, S4 global limits, S5 groups) and promotion of due delayed messages (S2).

## Public API
- Internal: `ClaimOptions`, `GroupOptions`; `claimSql`, `claim`, `claimGroupsSql`, `claimGroups`,
  `promoteSql`, `promote`.

## Flow
1. S3: ready ungrouped rows `for update skip locked` if the queue row is open (packages/pg-prime-mq/src/sql/claim.ts:67).
2. S4: lock the queue row first (waiting), cap the limit by rate and concurrency, bump its counters.
3. S5: a recursive skip scan of `messages_ready_g` after the cursor, group rows `skip locked`, a LATERAL pick per group (packages/pg-prime-mq/src/sql/claim.ts:98).
4. `claimGroups` retries an empty partial scan once from `''` and returns the next cursor: the last group served, past a scan of busy groups, or `''` (packages/pg-prime-mq/src/sql/claim.ts:179).
5. S2 promotes up to 1 000 due rows to the back of their band and returns the next due delay (packages/pg-prime-mq/src/sql/claim.ts:204).

## Gotchas
- EvalPlanQual: a claim waiting on the queue row re-reads its counters after the holder commits.
- `coalesce(…, 0)` on the limit: a paused queue yields no `q` row and `LIMIT NULL` is unlimited.
- An unset group concurrency is bound as int max, never NULL.
- The outer reference in the LATERAL `LIMIT` and the skip scan beside DML CTEs hold on PG 15–18 (M-Q4).

## Tests
- `test/unit/sql.test.ts`; `test/live/groups.test.ts`; `test/pg/concurrency.test.ts`. `pnpm --filter @pg-prime/mq test:pg`.
