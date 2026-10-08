# packages/pg-prime-nestjs/src/testing.ts

## Purpose
The `@pg-prime/nestjs/testing` entry: `rollbackScopeFor(app)`, rollback-per-test for a Nest app.

## Public API
- `rollbackScopeFor(app, name?)` → `Promise<RollbackScope>`
  (`packages/pg-prime-nestjs/src/testing.ts:9`); `RollbackScope` re-exported from
  `@pg-prime/context/testing`.

## Flow
1. `rollbackScope(app.get(getHostToken(name)))`: pins the app's host; the interceptor then runs
   every request in one savepoint, even with `request` unset (then without a transaction, whatever
   `@RequestTransaction` says).

## Gotchas
- One request at a time under a pin (`CONTEXT_CONCURRENT_SAVEPOINT`); test concurrency unpinned.
  A streaming route counts until its stream ends or the client hangs up.
- The pin's caveats (raw `set_config` keys, test-body statements on the pin) are context's; see
  `docs/packages/pg-prime-context/src/testing.md`.

## Tests
- `packages/pg-prime-nestjs/test/live/app.test.ts` — "rollbackScopeFor" block (incl. SSE), and the
  pinned pass-through without `request`.
- `packages/pg-prime-nestjs/test/pg/rls.test.ts` — the pin with RLS.
- `packages/pg-prime-nestjs/test/unit/nestjs.test.ts` — default and named connections.
