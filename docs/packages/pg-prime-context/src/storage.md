# packages/pg-prime-context/src/storage.ts

## Purpose
The structural `AsyncStorage` interface and the default `AsyncLocalStorage` factory.

## Public API
- `AsyncStorage<T>`: `getStore()` and `run(store, fn)` (`packages/pg-prime-context/src/storage.ts:4`).
- Internal: `newStorage()` (`:9`).

## Flow
1. `TransactionHost` uses `opts.storage ?? newStorage()`.

## Gotchas
- The `node:async_hooks` import is static: without `AsyncLocalStorage` the package fails at load
  instead of silently running ambient statements on the root.
- A custom `storage` (e.g. an `AsyncContext.Variable` adapter) still needs the import to resolve.

## Tests
- `packages/pg-prime-context/test/unit/host.test.ts` — "with no scope, db reads the store once;
  storage is pluggable".
