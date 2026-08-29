/** The error layer's internal barrel (design/07 §4). The public one is `src/index.ts`. */

export { ConfigError, PgPrimeError, UsageError } from './base.js'
export type {
  ErrorContext,
  ErrorInit,
  HandleKind,
  PgPrimeErrorCode,
  UsageErrorInit,
} from './base.js'

export {
  AbortError,
  AccessError,
  AuthenticationError,
  CachedPlanChangedError,
  CheckViolationError,
  ConnectionError,
  ConnectionRefusedError,
  ConnectionTerminatedError,
  ConnectionTimeoutError,
  DataError,
  DbClosedError,
  DeadlockDetectedError,
  DiskFullError,
  DivisionByZeroError,
  DuplicateStatementError,
  DuplicateTableError,
  ExclusionViolationError,
  ForeignKeyViolationError,
  HandleMisuseError,
  IdleInTransactionTimeoutError,
  InFailedTransactionError,
  IndeterminateCommitError,
  InsufficientPrivilegeError,
  InsufficientResourcesError,
  IntegrityConstraintError,
  InvalidDatetimeFormatError,
  InvalidPasswordError,
  InvalidStatementNameError,
  InvalidTextRepresentationError,
  LockNotAvailableError,
  NotNullViolationError,
  NumericValueOutOfRangeError,
  OperatorInterventionError,
  OutOfMemoryError,
  PoolTimeoutError,
  PreparedStatementError,
  QueryCanceledError,
  QueryError,
  QueryTimeoutError,
  ReadOnlySqlTransactionError,
  RestrictViolationError,
  SchemaObjectError,
  SerializationFailureError,
  SqlSyntaxError,
  StringDataRightTruncationError,
  TimeoutError,
  TlsError,
  TooManyConnectionsError,
  TransactionAbandonedError,
  TransactionClosedError,
  TransactionError,
  TransactionRollback,
  TransactionTimeoutError,
  UndefinedColumnError,
  UndefinedFunctionError,
  UndefinedTableError,
  UniqueViolationError,
  UnknownQueryError,
  UnsupportedInPoolerModeError,
} from './classes.js'
export type { PoolStats, QueryErrorInit } from './classes.js'

export { SQLSTATE_CLASS_FALLBACK, SQLSTATE_MAP, classForSqlState } from './sqlstate.js'
export type { QueryErrorCtor, SqlState } from './sqlstate.js'

export { driverDataOf, mapDriverError, mapError, sqlStateOfError } from './map.js'
export type { MapOptions } from './map.js'

export { constraintIndex, describeConstraint, resolveConstraint } from './refs.js'
export type { ColumnRef, ConstraintKind, ConstraintRef, TableRef } from './refs.js'

export {
  isCheckViolation,
  isForeignKeyViolation,
  isNotNullViolation,
  isUniqueViolation,
} from './predicates.js'

export {
  captureCallSite,
  parseDetail,
  redactDetail,
  redactSql,
  resolveErrorOptions,
} from './redact.js'
export type { ErrorOptions, ParsedDetail, ResolvedErrorOptions } from './redact.js'
