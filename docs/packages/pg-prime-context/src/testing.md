# packages/pg-prime-context/src/testing.ts

## Purpose
The `@pg-prime/context/testing` entry: `rollbackScope`, the pin behind rollback-per-test.

## Public API
- `rollbackScope(host)` → `RollbackScope { tx, rollback() }`
  (`packages/pg-prime-context/src/testing.ts:14`).

## Flow
1. Opens `host.root.transaction(…, { retry: false, localSettings: {
   idle_in_transaction_session_timeout: 0 } })` whose callback resolves the handle and parks.
2. `setPin(host, tx)`: from now on the host turns root transactions into pinned savepoints.
3. `rollback()` unpins, releases the park and awaits `tx.rollbackWith(undefined)`.

## Gotchas
- A pin, not ALS: `beforeEach`, the test body and server-side requests run in different async
  contexts. Test-body code outside a request runs on `tx` itself.
- Pinned savepoints on one base run in turn: a request awaited inside a test-body
  `host.transaction` waits forever.
- A failing `BEGIN` rejects `rollbackScope` (the open races the transaction's own promise).

## Tests
- `packages/pg-prime-context/test/unit/pin.test.ts` — the protocol on a mock pool.
- `packages/pg-prime-context/test/live/context.test.ts` — the `rollbackScope` block on PGlite.
- `packages/pg-prime-context/test/pg/context.test.ts` — the pin with RLS and the dev guard.
