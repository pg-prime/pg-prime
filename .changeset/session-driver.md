---
'pg-prime': patch
---

Session, savepoint, LISTEN and timeout fixes.

- `Session.transaction()` now honours every `TxOptions` field (`retry`, `timeoutMs`, `lockTimeoutMs`, `localSettings`, `signal`) and emits the transaction hooks, exactly like `db.transaction()`. Before, `localSettings` was silently dropped, so an RLS tenant set this way never reached the server.
- Savepoint `timeoutMs` / `lockTimeoutMs` / `localSettings` end with the savepoint: the previous values are put back after `RELEASE SAVEPOINT` instead of leaking to the rest of the transaction, and a timeout changed inside a savepoint is restored by the parent.
- `copyFrom` / `copyTo` are exempt from the session `statement_timeout` as documented, on `db`, `Tx` and `Session` handles; a stream on a `Session` gets a transaction of its own as well.
- `BEGIN` / `COMMIT` / `SAVEPOINT` / `set_config` failures are mapped like any other statement: a deferred FK violation raised at a chunked insert's `COMMIT` is a `ForeignKeyViolationError`, a `SAVEPOINT` refused with `25P02` is an `InFailedTransactionError` naming the poison.
- A chunked batch under `timeoutStrategy: 'transaction'` sets `statement_timeout` once after `BEGIN` instead of losing the timeout.
- A transaction's `signal` composes with `pgPrime({ signal })` at checkout, and an abort landing between the last statement and `COMMIT` rolls back with `AbortError`.
- `tx.rollbackWith(v)` on the outer handle inside a savepoint resolves the transaction with `v` instead of being swallowed by the savepoint.
- `timeoutMs` must be a positive integer; `0` and non-integers are a `UsageError` on every handle (`lockTimeoutMs: 0` stays valid).
- An already-aborted `signal` combined with `timeoutMs` no longer runs the statement.
- `Session.set()` and a session advisory lock still held at exit dispose the connection so the state cannot reach the next borrower; a callback that throws on a healthy connection returns it to the pool.
- `db.listen()`: two concurrent first subscriptions attach one set of listeners (handlers fired twice per NOTIFY before); a `LISTEN` failing during reconnect closes that connection; `db.end()` during a reconnect closes the late socket; the pg adapter's `connect()` refuses after `destroy()`.
