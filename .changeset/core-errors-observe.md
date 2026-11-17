---
'pg-prime': patch
---

- A backend that goes away mid-statement is a `ConnectionTerminatedError` as documented: a class `08` SQLSTATE from the server (PgBouncer's `08P01`, `08006`) or a fatal `57P01` that took the socket with it. Before, those mapped to `UnknownQueryError` and `OperatorInterventionError`, so `instanceof ConnectionError` was false for a dead backend. A `57P01` on a connection that survived is still `OperatorInterventionError`.
- A `log.sink` that throws no longer rejects the statement it was logging; it is disabled and reported once on `console.error`, the same policy hooks have.
- An `async` hook that rejects is disabled and reported instead of becoming an unhandled rejection.
- `hooks: {}` registers nothing, so statements skip the event path.
- A constraint violation resolves against the table the server named, so two tables sharing a constraint name (`email_key` on both, or a `CHECK` with the same name) no longer resolve to whichever table was declared first. `constraint.referencedTable` is now set for foreign keys.
- `errors.captureCallSite` no longer elides frames from an application whose own files live under `src/query/`, `src/session/` and the like: only pg-prime's own frames are skipped.
- `db.diagnose()` is one round trip, as documented, and `connections.inUse` counts client backends only (background workers never occupy a `max_connections` slot).
- `PgPrimeErrorCode` includes `'TIMEOUT'`, `'ABORT'` and `'INDETERMINATE_COMMIT'`, the codes `QueryTimeoutError`, `AbortError` and `IndeterminateCommitError` carry.
