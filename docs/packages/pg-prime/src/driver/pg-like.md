# packages/pg-prime/src/driver/pg-like.ts

## Purpose
Structural re-declaration of the subset of node-postgres (`pg`) the adapter touches, plus the
`PgDriverConfig` constructor input. Type-only. Used by `src/driver/pg-adapter.ts`,
`src/driver/submittable.ts` and `src/driver/copy.ts`; `src/query/run.ts`, `src/session/config.ts`
and `src/session/pg-lazy.ts` use the pool/client shapes when building a driver from a connection
string or a user pool. Imports nothing.

## Public API
- `PgLikePool` — `connect()`, `end()`, optional `options` (only `max` is read), counters.
- `PgLikePoolClient` — `PgLikeClient` plus `release(err?)`.
- `PgLikeClient` — overloaded `query(config | submittable)`, `on`, `removeListener`, optional
  `getTransactionStatus`, `processID`, `secretKey`, `activeQuery`, `connection`, `readyForQuery`.
- `PgLikeCancelClient` — unconnected client for a protocol CancelRequest: `cancel(client, query?)`,
  optional `end`, `connection`, `host`, `port`.
- `PgLikeQueryConfig` — `{ text, values?, name?, rowMode?, queryMode?, binary?, rows?, query_timeout?, types? }`.
- `PgLikeTypeSource` — `ReadonlyArray<number>` that also has `getTypeParser`.
- `PgLikeResult`, `PgLikeField` — pg's result and field shapes; `command` may be `null`.
- `PgLikeSubmittable` — `submit` plus the `handleX` callbacks pg routes backend messages to.
- `PgLikeConnection` — protocol writer: `parse`, `bind`, `describe`, `execute`, `close`, `sync`,
  `flush`, optional COPY writers, `query`, `connect`, `cancel`, and `stream`.
- `PgLikeDedicatedClient` — `PgLikeClient` plus `connect()`/`end()`; an unpooled client for `LISTEN`.
- `PgDriverConfig` — `{ pool, directPool?, createCancelClient?, createDedicatedClient? }`.

## Flow
1. Callers pass a `pg.Pool`-shaped object as `PgDriverConfig.pool` to `pgDriver`
   (`packages/pg-prime/src/driver/pg-like.ts:240`).
2. `packages/pg-prime/src/query/run.ts:289` builds the config itself for `pgPrime({ connection })`, supplying
   `createCancelClient` and `createDedicatedClient`; a user `pool:` gets only `{ pool }`
   (`packages/pg-prime/src/query/run.ts:264`).
3. The adapter speaks to clients through `query(config)` and, for protocol features pg's public
   API lacks, `query(submittable)` (`packages/pg-prime/src/driver/pg-like.ts:35`).

## Gotchas
- Never `import type` from `pg`: `@neondatabase/serverless` inlines its own declarations, so only
  structural typing accepts both (`packages/pg-prime/src/driver/pg-like.ts:4`).
- `on`/`removeListener` listeners are `(...args: any[]) => void`; a `never` parameter makes
  `pg.PoolClient` non-assignable (`packages/pg-prime/src/driver/pg-like.ts:39`).
- `pg.Pool` is still not assignable to `PgLikePool` as a whole: `@types/pg` types
  `QueryParse.types` as `string[]`, so `pgDriver({ pool })` needs `as unknown as PgLikePool`
  (pinned by `packages/pg-prime/test/driver/pg-types.probe.ts`).
- `getTransactionStatus()` returns `null` before the first ReadyForQuery; the adapter maps it to
  `undefined` (`packages/pg-prime/src/driver/pg-like.ts:70`).
- `removeListener` is required: the adapter must take its `error` listener off at release
  (`packages/pg-prime/src/driver/pg-like.ts:55`).
- COPY writers are `sendCopyFromChunk`/`endCopyFrom`/`sendCopyFail`, optional because `@types/pg`
  omits them; `src/driver/copy.ts` checks for them at submit (`packages/pg-prime/src/driver/pg-like.ts:205`).
- `PgLikeQueryConfig.types` is read by pg both as Parse OIDs and as a parser table
  (`packages/pg-prime/src/driver/pg-like.ts:123`); see `typeSource` in `src/driver/pg-adapter.ts`.
- `rows` on a pg query pages, it does not truncate (`packages/pg-prime/src/driver/pg-like.ts:120`).
- Without `readyForQuery`, a drop-in client loses the post-statement `transactionStatus` guarantee
  (`packages/pg-prime/src/driver/pg-like.ts:81`).
- `activeQuery` is deprecated in pg 8.23 and read only by the non-pg cancel fallback.

## Tests
- `packages/pg-prime/test/driver/pg-types.probe.ts` — compile-only probe of which members `@types/pg`
  satisfies (compiled by `packages/pg-prime/test/live/tsconfig.json`; nothing runs).
- `packages/pg-prime/test/driver/_fake-pg.ts` implements `PgLikePool`/`PgLikePoolClient` over a real
  `EventEmitter` for `packages/pg-prime/test/driver/adapter-lifecycle.test.ts`.
- Run: `pnpm --filter pg-prime exec vitest run test/driver/adapter-lifecycle.test.ts`.
- Not covered: Neon's `Pool` against these declarations.
