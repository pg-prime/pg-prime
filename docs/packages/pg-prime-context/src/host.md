# packages/pg-prime-context/src/host.ts

## Purpose
`TransactionHost`: the active transaction per async context, propagation (`join`/`savepoint`/`new`),
scoped settings, strict mode, and the pinned savepoint used under `rollbackScope`.

## Public API
- `new TransactionHost(root, { propagation = 'join', strict = true, storage })`
  (`packages/pg-prime-context/src/host.ts:53`).
- Readers: `db`/`current()` (`:82`), `tx()`, `inTransaction`, `attempt`, `settings`, `pinned`,
  `outside()`.
- `run(scope, fn)` (`:122`), `request(scope, fn)` (`:132`), `setLocal(…)` (`:143`),
  `within(tx, fn)` (`:153`), `transaction(fn, opts)` (`:160`).
- Internal: `setPin(host, tx)` (`:50`), assigned in a static block so `./testing` can set the
  private `#pin`.

## Flow
1. The store is `{ tx?, base?, mode?, settings }`, `mode` being the options `tx` was opened with;
   `run`, `within` and every transaction callback enter a new one with `storage.run`, never
   `enterWith`. Transaction stores share the scope's `settings`
   object, which is how `host.setLocal` records into the scope.
2. `current()`: the store's `tx`; else, in strict mode, `CONTEXT_UNSCOPED_QUERY` when the scope has
   settings; else `base ?? #pin ?? root`.
3. `transaction`: with an active `tx`, `join` checks the options against `mode` (isolation,
   access mode, deferrable) and calls `fn(tx)`; `savepoint` validates, captures the keys its
   `localSettings`/timeouts set, and runs `tx.savepoint` through `#nest`, restoring them before
   `RELEASE`. Otherwise, pinned → `#pinned`; unpinned → `root.transaction` with
   `localSettings = { ...scope, ...opts.localSettings }`, so core sends them after `BEGIN` on every
   attempt; a retry resets the scope's settings to the ones sent.
4. `#nest(on, open, wait)`: `#busy` maps a `Tx` to its last queued host savepoint. A pinned one
   (`wait`) runs after it; any other is refused with `CONTEXT_CONCURRENT_SAVEPOINT`.
5. `#pinned(base, …)`: inside `inTransactionFrame(pin, …)` and `#nest(base, …)`, captures settings
   on `base`, then `base.savepoint` with the scope settings and timeouts; inside it optionally sets
   `transaction_read_only`, runs `fn` with `tx: R` (or `base: R` for a tx-less request), then
   either `rollbackWith(v)` (read only) or `restore` before `RELEASE`.

## Gotchas
- A join returns the real outer `Tx`, so `rollbackWith` there ends the outer transaction.
- `#keys` collects every setting name the host has applied (scope, `localSettings`, `setLocal`); the
  pin restores only those plus `pg_settings` built-ins. Names are validated by core when sent, not
  at `run()`.
- `'new'` under a pin nests on the current transaction instead of opening a connection.
- `isolation`, `deferrable` and `retry` are passed to the pinned savepoint but core ignores them;
  joins compare against `mode`, since the savepoint's `Tx` reports the pin's isolation.
- Pinned savepoints queue, so a request awaited inside a test-body `host.transaction` never starts.

## Tests
- `packages/pg-prime-context/test/unit/host.test.ts` — propagation, join, savepoint, retry, API,
  guard, cost.
- `packages/pg-prime-context/test/live/context.test.ts` — settings on PGlite.
- `packages/pg-prime-context/test/pg/context.test.ts` — RLS, no leak (incl. PgBouncer), 40001, `new`.
