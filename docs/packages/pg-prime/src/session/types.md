# packages/pg-prime/src/session/types.ts

## Purpose
The session layer's type vocabulary: transaction, savepoint, pool, connection, session-GUC, per-call,
stream, LISTEN, COPY and advisory-lock option and result types. Type-only (imports are `import type`), so
`packages/pg-prime/src/query/types.ts:120` can declare `Db` / `Tx` / `Session` / `Queryable` from it without
pulling in the session runtime. Most names are re-exported publicly from `packages/pg-prime/src/index.ts:390`;
every other file in `packages/pg-prime/src/session/` consumes them.

## Public API
- `AsyncDisposeKey`, `AsyncDisposable_` — the `Symbol.asyncDispose` key inferred from the ambient lib, and
  a mapped type that is `{}` when the consumer's lib lacks it.
- `IsolationLevel` (`'read committed' | 'repeatable read' | 'serializable'`), `AccessMode`
  (`'read write' | 'read only'`), `Duration` (`string | number`, a number meaning ms).
- `RetryPolicy` — `on`, `maxAttempts`, `baseDelayMs`, `maxDelayMs`, `jitter`, `shouldRetry`, `onRetry`;
  resolved by `resolveRetry` in `packages/pg-prime/src/session/transaction.ts:205`.
- `TxOptionsBase`, `TxOptions` — `retry`, `timeoutMs`, `lockTimeoutMs`, `localSettings`, `signal`, `label`;
  `TxOptions` is a three-arm union that allows `deferrable` only with `serializable` + `read only`.
- `SavepointOptions` — `timeoutMs`, `lockTimeoutMs`, `localSettings`, `label`, `signal`; no isolation,
  access mode, deferrable or retry.
- `TransactionDefaults` — per-db `isolation`, `accessMode`, `retry`, `timeoutMs`, `lockTimeoutMs`, `label`.
- `NoHandleEscape<T>` — maps a returned `{ kind: 'tx' | 'session' }` to an error tuple; shallow, one conditional.
- `PoolOptions` — `max`, `min`, `idleTimeoutMillis`, `connectionTimeoutMillis`, `maxLifetimeSeconds`,
  `maxUses`, `allowExitOnIdle`; used only when pg-prime builds the pool.
- `ConnectionParams` — `host`, `port`, `database`, `user`, `password` (string or async getter), `ssl`,
  `applicationName`, plus any other `pg.Pool` key.
- `SessionDefaults` — `applicationName`, `statementTimeout`, `lockTimeout`,
  `idleInTransactionSessionTimeout`, `searchPath`, `timeZone`; `null` disables a default.
- `CallOptions` — `signal`, `timeoutMs`, `timeoutStrategy` (`'auto' | 'transaction' | 'client'`), `label`,
  `statement`, `outsideTransaction`. `RunCallOptions` adds `params`.
- `StreamCallOptions` — `CallOptions` plus `batchSize` and `statementTimeoutMs` (`number | null`).
- `Compilable<O>`, `Runnable<O>` — what `run` / `explain` / `stream` accept: a builder or a `Compiled`.
- `NotificationHandler`, `Subscription` (`channel`, `close()`, `on('reconnect' | 'gap' | 'error')`,
  async-disposable), `ListenOptions` (`signal`).
- `CopyOptions` — `signal`, `format` (`'text' | 'csv'`), `columns`, `highWaterMark`; `CopyResult` — `rowCount`.
- `AdvisoryLock` — `key`, `shared`, `unlock()`, async-disposable; `AdvisoryLockOptions` — `try`, `shared`.
- Re-exports the types `ExplainOptions`, `ExplainResult`, `StreamOptions` from `packages/pg-prime/src/query/executor.ts`.

## Flow
1. No runtime: the module emits nothing. `DbConfig` in `packages/pg-prime/src/session/config.ts:32` and the
   handle interfaces in `packages/pg-prime/src/query/types.ts` compose these types.
2. `AsyncDisposeKey` resolves to `never` on a lib without `Symbol.asyncDispose`
   (`packages/pg-prime/src/session/types.ts:33`), so `AsyncDisposable_` adds no member there and the shipped
   `.d.ts` still compiles; runtime objects use `ASYNC_DISPOSE` from `packages/pg-prime/src/session/guard.ts:39`.

## Gotchas
- Value imports must not be added here; the file is on the type layer's hot path and must not drag the
  session runtime into anything that names a handle type.
- Doc comments that disagree with the runtime: `SessionDefaults.timeZone` says `DateStyle` is pinned to
  `ISO, MDY` (`packages/pg-prime/src/session/types.ts:208`), but nothing sets it; `StreamCallOptions.statementTimeoutMs`
  says "Default `null`" (`packages/pg-prime/src/session/types.ts:247`), but omitting it sends nothing, so the
  session `statement_timeout` still bounds a stream (`packages/pg-prime/src/session/runner.ts:847`).
- `CopyOptions.highWaterMark` is documented as bytes; `encodeCopyRows` compares it to string length
  (`packages/pg-prime/src/session/copy.ts:194`).
- `CallOptions.timeoutStrategy` values `'auto'` and `'client'` behave identically at runtime; only
  `'transaction'` is tested for (`packages/pg-prime/src/session/runner.ts:470`).
- `NoHandleEscape` catches only a handle returned directly, not one nested in an object or array.

## Tests
- `packages/pg-prime/test/query/types/session.probe.ts` — type probes for `Tx` vs `Db`, `Queryable`,
  `NoHandleEscape`, `SavepointOptions` and the `deferrable` union; compiled by
  `packages/pg-prime/test/query/typecheck.test.ts`. Run:
  `pnpm --filter pg-prime exec vitest run test/query/typecheck.test.ts` or `pnpm --filter pg-prime typecheck`.
- Runtime behaviour behind these types is covered by the suites listed in the sibling docs.
