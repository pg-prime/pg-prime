# packages/pg-prime-mq/src/define.ts

## Purpose
Queue declarations: payload typing, retry policy, retention, global limits and watching, resolved
once with the family defaults. Read by `src/mq.ts` (queue upserts) and every queue module.

## Public API
- `defineQueue<T, R = void>(name, opts?)` → frozen `QueueDef<T, R>`; `ConfigError` for `watch` with
  `keep.completed: false`, bad `rate`/`concurrency`/`retry`; `UsageError` for an empty name.
- `QueueOptions<T>`, `QueueDef<T, R>`, `RetryOptions`, `RetryPolicy` (stored, no `shouldRetry`),
  `Keep`, `KeepOptions`, `PayloadOf<D>`, `ResultOf<D>`.
- `checkRetry(policy, where)` — internal; also validates per-message retry overrides.

## Flow
1. Splits `shouldRetry` off `retry` (packages/pg-prime-mq/src/define.ts:61): only the rest is stored per message.
2. Fills defaults: retry `{3, 1000, 60 000, 'full'}`, keep completed 1 day, failed 7 days (packages/pg-prime-mq/src/define.ts:69).
3. Validates and freezes.

## Gotchas
- `R` is carried by the phantom `__result` property; `ResultOf` reads it.
- `keep.failed` also governs `cancelled` messages.
- Declarations must agree across processes: claims choose S3 or S4 from the local `rate`/`concurrency`.

## Tests
- `test/unit/define.test.ts` (defaults, refusals); `test/unit/types.test.ts` (inference). `pnpm --filter @pg-prime/mq test`.
