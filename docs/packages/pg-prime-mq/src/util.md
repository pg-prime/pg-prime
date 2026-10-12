# packages/pg-prime-mq/src/util.ts

## Purpose
Small shared helpers: an abortable sleep, the async-dispose symbol, the family backoff formula and
the local rate limiter used by workers.

## Public API
- `ASYNC_DISPOSE` — `Symbol.asyncDispose` or its registry fallback.
- `sleep(ms, signal?)` — resolves after `ms` or on abort.
- `backoffMs(policy, attempt, random?)` — `min(maxDelayMs, baseDelayMs × 2^(attempt−1))`, jittered.
- `limiter(rate?)` → `Limiter` with `free(now?)`, `take(n, now?)`, `waitMs(now?)`; `Jitter` type.

## Flow
1. `limiter` keeps the take times of the last window and drops older ones on each `free` (packages/pg-prime-mq/src/util.ts:40).

## Gotchas
- `backoffMs` is a deliberate copy of the family formula (design/15 §0.2); `sql/lease.ts`'s
  `backoffSql` is the same formula in SQL.

## Tests
- `test/unit/sql.test.ts` (fixed vectors), `test/unit/define.test.ts` (limiter). `pnpm --filter @pg-prime/mq test`.
