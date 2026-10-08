# packages/pg-prime-context/src/host.ts

## Purpose
`TransactionHost`: the active transaction per async context, propagation (`join`/`savepoint`/`new`),
scoped settings, strict mode, and the pinned savepoint used under `rollbackScope`.

## Public API
- `new TransactionHost(root, { propagation = 'join', strict = true, storage })`
  (`packages/pg-prime-context/src/host.ts:51`).
- Readers: `db`/`current()` (`:80`), `tx()`, `inTransaction`, `attempt`, `settings`, `pinned`,
  `outside()`.
- `run(scope, fn)` (`:120`), `request(scope, fn)` (`:130`), `setLocal(…)` (`:141`),
  `within(tx, fn)` (`:151`), `transaction(fn, opts)` (`:158`).
- Internal: `setPin(host, tx)` (`:48`), assigned in a static block so `./testing` can set the
  private `#pin`.

## Flow
1. The store is `{ tx?, base?, settings }`; `run`, `within` and every transaction callback enter a
   new one with `storage.run`, never `enterWith`. Transaction stores share the scope's `settings`
   object, which is how `host.setLocal` records into the scope.
2. `current()`: the store's `tx`; else, in strict mode, `CONTEXT_UNSCOPED_QUERY` when the scope has
   settings; else `base ?? #pin ?? root`.
3. `transaction`: with an active `tx`, `join` validates options and calls `fn(tx)`; `savepoint`
   validates and runs `tx.savepoint` through `#nest`. Otherwise, pinned → `#pinned`; unpinned →
   `root.transaction` with `localSettings = { ...scope, ...opts.localSettings }`, so core sends them
   after `BEGIN` on every attempt.
4. `#nest(on, open)`: refuses a second in-flight host savepoint on `on` (`#busy` WeakSet), else
   runs `open`.
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
- `isolation`, `deferrable` and `retry` are passed to the pinned savepoint but core ignores them.

## Tests
- `packages/pg-prime-context/test/unit/host.test.ts` — propagation, join, savepoint, retry, API,
  guard, cost.
- `packages/pg-prime-context/test/live/context.test.ts` — settings on PGlite.
- `packages/pg-prime-context/test/pg/context.test.ts` — RLS, no leak (incl. PgBouncer), 40001, `new`.
