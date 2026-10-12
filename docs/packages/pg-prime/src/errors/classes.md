# packages/pg-prime/src/errors/classes.ts

## Purpose
The runtime error hierarchy as classes: `QueryError` and its SQLSTATE-class branches and leaves,
`ConnectionError` and leaves, `IndeterminateCommitError`, timeouts, aborts, and `UsageError` leaves.
`errors/sqlstate.ts` maps SQLSTATEs to these constructors and `errors/map.ts` instantiates the query and
connection classes; `session/handles.ts`, `session/runner.ts`, `session/guard.ts` and `session/listen.ts`
throw the usage, commit and timeout classes directly. Re-exported by `src/index.ts`.

## Public API
- `QueryError(message, init: QueryErrorInit)` — server rejected a statement; `code`, `sqlStateClass`,
  `severity`, verbatim `ErrorResponse` fields, and redaction-governed `sql`/`params`/`paramCount`/`detail`.
- `QueryErrorInit` — `code`, `severity?`, `server?`, `sql?`, `params?`, `paramCount?`, `paramTypes?`,
  `detail?`, `detailRedacted?`, required `context`.
- `IntegrityConstraintError` — class 23; optional `constraint`, `table`, `columns` from `init.resolved`.
- Integrity leaves — `NotNullViolationError`, `ForeignKeyViolationError`, `UniqueViolationError`,
  `CheckViolationError`, `ExclusionViolationError`, `RestrictViolationError`.
- `TransactionError` — leaves `SerializationFailureError`, `DeadlockDetectedError`,
  `InFailedTransactionError` (`poisonedBy?`), `IdleInTransactionTimeoutError`, `ReadOnlySqlTransactionError`.
- `DataError` — leaves `NumericValueOutOfRangeError`, `InvalidTextRepresentationError`,
  `StringDataRightTruncationError`, `DivisionByZeroError`, `InvalidDatetimeFormatError`.
- `AccessError` — leaves `InsufficientPrivilegeError`, `InvalidPasswordError`.
- `SchemaObjectError` — leaves `UndefinedTableError`, `UndefinedColumnError`, `UndefinedFunctionError`,
  `DuplicateTableError`, `SqlSyntaxError`.
- `PreparedStatementError` — leaves `InvalidStatementNameError` (`26000`), `DuplicateStatementError` (`42P05`).
- `CachedPlanChangedError`, `LockNotAvailableError`, `QueryCanceledError`, `OperatorInterventionError`,
  `UnknownQueryError` — direct `QueryError` subclasses.
- `InsufficientResourcesError` — leaves `TooManyConnectionsError`, `OutOfMemoryError`, `DiskFullError`.
- `ConnectionError(message, init)` — `code` is `init.code ?? '08000'`. Leaves `ConnectionRefusedError`,
  `ConnectionTimeoutError`, `TlsError`, `AuthenticationError`, `ConnectionTerminatedError`, `PoolTimeoutError`.
- `PoolTimeoutError` — adds `stats?: PoolStats`; `PoolStats` is `{ total, idle, waiting, max }`.
- `IndeterminateCommitError` — `code 'INDETERMINATE_COMMIT'`; a direct `PgPrimeError` subclass.
- `TimeoutError` (`code 'TIMEOUT'`) — leaves `QueryTimeoutError`, `TransactionTimeoutError`.
- `AbortError` — `code 'ABORT'`.
- `VersionConflictError(message, init)` — `code 'VERSION_CONFLICT'`; `table`, `context`, and `expected` only
  when passed (the runner passes it under `errors.includeParams`). A direct `PgPrimeError` subclass.
- `UsageError` leaves — `HandleMisuseError`, `TransactionClosedError`, `TransactionAbandonedError`,
  `DbClosedError`, `UnsupportedInPoolerModeError`, `TransactionRollback`.

## Flow
1. `QueryError` passes `init.code` to `PgPrimeError` and derives `sqlStateClass` from its first two chars
   (`packages/pg-prime/src/errors/classes.ts:91`).
2. `severity` defaults to `'ERROR'`, `paramCount` to `0`, `detailRedacted` to `false`
   (`packages/pg-prime/src/errors/classes.ts:92`).
3. Each defined field of `init.server` is copied onto the matching property (`schema` → `schemaName`,
   `line` stringified) (`packages/pg-prime/src/errors/classes.ts:95`).
4. `sql`, `params`, `paramTypes`, `detail` are copied only when defined (`packages/pg-prime/src/errors/classes.ts:110`).
5. `IntegrityConstraintError` copies `resolved` into `constraint`, `table`, `columns`
   (`packages/pg-prime/src/errors/classes.ts:131`).

## Gotchas
- `IndeterminateCommitError` is deliberately not a `ConnectionError`, so `instanceof ConnectionError`
  retry logic does not catch it (`packages/pg-prime/src/errors/classes.ts:316`).
- `QueryCanceledError` (`57014`) covers both `statement_timeout` and a delivered cancel, distinguished by
  `context.reason`; `QueryTimeoutError` is the client-side timer (`packages/pg-prime/src/errors/classes.ts:237`).
- `TransactionRollback` is a `UsageError`, not a `TransactionError` (`packages/pg-prime/src/errors/classes.ts:394`).
- Names deviating from the design: `SchemaObjectError` (because `SchemaError` is the `sql/errors.ts` schema
  declaration error) and `SqlSyntaxError` (to avoid shadowing the global `SyntaxError`).
- Literal `code` types are only declared on `UniqueViolationError` (`'23505'`), `InFailedTransactionError`
  (`'25P02'`) and `QueryCanceledError` (`'57014'`); constructors do not enforce them.
- `params` exists on `QueryError` only when the mapper was told to include them; `paramCount` is always set.
- No code in `packages/pg-prime/src` constructs `TransactionTimeoutError`; only `errors/map.ts` and
  `session/runner.ts` construct `QueryTimeoutError`.
- `VersionConflictError` is thrown only by `execute()` in `session/runner.ts`; its 16-char `code` means it
  never poisons a transaction. It is not retried by default, but `retry.on` naming it or a `shouldRetry`
  predicate returning `true` retries it (`packages/pg-prime/src/session/handles.ts:609`).
- The `ErrorResponse` fields are copied unredacted; redaction applies only to `sql`, `params`, `detail`.

## Tests
- `packages/pg-prime/test/session/session.test.ts` (unit): SQLSTATE → class at line 700,
  `IndeterminateCommitError` at line 624, `InFailedTransactionError` at line 944, `PoolTimeoutError` stats at
  line 1623, `paramCount`/`params` at line 1852, `TlsError` export at line 1899.
- `packages/pg-prime/test/live/session.test.ts` and `packages/pg-prime/test/pg/session.test.ts` assert classes
  against a real backend.
- Run: `pnpm --filter pg-prime exec vitest run test/session/session.test.ts`.
- `packages/pg-prime/test/query/version.test.ts` — `VersionConflictError` shape and `expected` redaction.
- Uncovered: `TransactionTimeoutError` is never thrown, so nothing exercises it.
