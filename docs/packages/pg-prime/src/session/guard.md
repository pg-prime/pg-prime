# packages/pg-prime/src/session/guard.ts

## Purpose
The dev-mode misuse guard: an `AsyncLocalStorage` stack of open-transaction frames, so a statement on the
root `Db` handle inside a transaction callback throws `HandleMisuseError`. Also owns `ASYNC_DISPOSE` and the
concurrent-statements warning text. Used by `packages/pg-prime/src/session/handles.ts:55` (frames, store
loading), `packages/pg-prime/src/session/runner.ts:47` (the check and the warning),
`packages/pg-prime/src/session/listen.ts:29` and `packages/pg-prime/src/query/run.ts:60` (`ASYNC_DISPOSE`).

## Public API
- `ASYNC_DISPOSE` — `Symbol.asyncDispose`, or `Symbol.for('Symbol.asyncDispose')` when the runtime lacks it.
- `GuardFrame` — `{ txId, label, openedAt, depth }`, one per open transaction on the async context.
- `ensureGuardStore()` — lazily imports `node:async_hooks` once and returns the store, or `undefined` when
  unavailable.
- `currentFrames()` — frames on the current async context, or `undefined` before the store exists.
- `withFrame(frame, fn)` — runs `fn` with `frame` pushed; plain call when there is no store.
- `withoutFrames(fn)` — runs `fn` with an empty frame stack; plain call when there is no store.
- `inTransactionFrame(tx, fn)` — public: runs `fn` with `tx`'s frame pushed, so a captured root `Db` throws `HandleMisuseError` as inside `db.transaction`; plain call without a store; throws `UsageError` if `tx` is not a `Tx` handle.
- `txFrames` — `WeakMap` from each `Tx` handle to its frame, filled by `makeTxHandle` (`packages/pg-prime/src/session/handles.ts:668`).
- `assertNotInsideTransaction(captureSite)` — throws `HandleMisuseError` when any frame is open; captures a
  call site only on the throwing path and only when `captureSite` is true.
- `concurrentStatementsWarning(count)` — the warning string for overlapping statements on one transaction.
- `resetGuardForTests()` — `@internal`; clears the store, pending import and unavailable flag.

## Flow
1. `runTransaction` awaits `ensureGuardStore()` when `state.devGuard` is on
   (`packages/pg-prime/src/session/handles.ts:371`); the first call starts `import('node:async_hooks')`
   (`packages/pg-prime/src/session/guard.ts:76`).
2. A failed import or missing `AsyncLocalStorage` sets `unavailable`, and every later call returns
   `undefined` without retrying (`packages/pg-prime/src/session/guard.ts:70`).
3. The transaction callback runs inside `withFrame` (`packages/pg-prime/src/session/handles.ts:508`);
   `db.session()` runs its callback inside `withoutFrames` (`packages/pg-prime/src/session/handles.ts:1019`).
4. Each root-handle statement calls `PoolRunner.guard`, which skips when the dev guard is off, the handle
   is not `'db'`, or `outsideTransaction` is set (`packages/pg-prime/src/session/runner.ts:486`).
5. Otherwise `assertNotInsideTransaction` reads `store.getStore()` and throws naming the top frame's
   `txId`, `label` and `openedAt` (`packages/pg-prime/src/session/guard.ts:119`).
6. `ConnRunner.#enter` emits `concurrentStatementsWarning` once per transaction when more than one
   statement is in flight (`packages/pg-prime/src/session/runner.ts:646`).

## Gotchas
- The guard is inert until the first `transaction()` with `devGuard` on has loaded the store; a
  `db.session()` alone never loads it.
- `node:async_hooks` must stay a dynamic import: `packages/pg-prime/test/session/session.test.ts:1649`
  asserts `src/**` never imports it statically.
- `withoutFrames` resets the stack, so a nested `rootDb.transaction(...)` inside a `db.session()` callback is
  not flagged; the session's own nested `s.transaction()` pushes a frame again
  (`packages/pg-prime/src/session/handles.ts:1069`).
- `ensureGuardStore` is called only from `runTransaction`, although its docblock also names `session()`;
  `currentFrames` has no caller in `src/`.
- Savepoints do not push a frame (`runSavepoint` calls `fn(handle)` directly,
  `packages/pg-prime/src/session/handles.ts:772`).
- `devGuard` defaults to `!inProduction()` (`packages/pg-prime/src/query/run.ts:338`).

## Tests
- `packages/pg-prime/test/session/session.test.ts:1012` — the misuse guard, `outsideTransaction` opt-out,
  `devGuard: false`, savepoints not flagged.
- `packages/pg-prime/test/session/session.test.ts:1061` — the once-per-transaction concurrency warning.
- `packages/pg-prime/test/session/session.test.ts:1730` — call site captured only on the throwing path.
- `packages/pg-prime/test/session/session.test.ts:1649` — no static `node:async_hooks` import.
- Run: `pnpm --filter pg-prime exec vitest run test/session/session.test.ts`.
- Uncovered: the runtime-without-`AsyncLocalStorage` fallback is not exercised by a test.
- `packages/pg-prime/test/session/frame.test.ts` — `inTransactionFrame`: root `Db` throws inside the frame, not outside; non-`Tx` refused.
