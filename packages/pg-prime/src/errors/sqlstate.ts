/**
 * The SQLSTATE → class mapping, shipped as data (design/07 §4.5).
 *
 * Two records and one lookup order — **exact SQLSTATE → class prefix → `UnknownQueryError`** —
 * which is precisely what makes §4.1 rule 3 true: an unmodelled state lands on its nearest
 * ancestor and still carries the raw `code`, so adding a leaf class later is not a breaking
 * change for anybody who was catching the ancestor.
 *
 * Being data rather than a `switch` is the point: `SQLSTATE_MAP` is exported, so a test can walk
 * every entry and assert the class (which `test/query/session-errors.test.ts` does), and a user
 * can read the table instead of the source.
 */

import {
  AccessError,
  CachedPlanChangedError,
  CheckViolationError,
  DataError,
  DeadlockDetectedError,
  DiskFullError,
  DivisionByZeroError,
  DuplicateStatementError,
  DuplicateTableError,
  ExclusionViolationError,
  ForeignKeyViolationError,
  IdleInTransactionTimeoutError,
  InFailedTransactionError,
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
  PreparedStatementError,
  QueryCanceledError,
  QueryError,
  ReadOnlySqlTransactionError,
  RestrictViolationError,
  SchemaObjectError,
  SerializationFailureError,
  SqlSyntaxError,
  StringDataRightTruncationError,
  TooManyConnectionsError,
  TransactionError,
  UndefinedColumnError,
  UndefinedFunctionError,
  UndefinedTableError,
  UniqueViolationError,
  UnknownQueryError,
} from './classes.js'
import type { QueryErrorInit } from './classes.js'

/** A five-character SQLSTATE. Widened to `string` so an unmodelled one is still expressible. */
export type SqlState = string

/** Every `QueryError` subclass has this constructor. */
export type QueryErrorCtor = new (message: string, init: QueryErrorInit) => QueryError

/** `07` §4.5 — the exact-SQLSTATE table. Every leaf class in §4.2 appears here. */
export const SQLSTATE_MAP: Readonly<Record<string, QueryErrorCtor>> = Object.freeze({
  // class 23 — integrity constraint violation
  '23000': IntegrityConstraintError,
  '23001': RestrictViolationError,
  '23502': NotNullViolationError,
  '23503': ForeignKeyViolationError,
  '23505': UniqueViolationError,
  '23514': CheckViolationError,
  '23P01': ExclusionViolationError,

  // transactions
  '25006': ReadOnlySqlTransactionError,
  '25P02': InFailedTransactionError,
  '25P03': IdleInTransactionTimeoutError,
  '40001': SerializationFailureError,
  '40P01': DeadlockDetectedError,

  // class 22 — data exception
  '22001': StringDataRightTruncationError,
  '22003': NumericValueOutOfRangeError,
  '22007': InvalidDatetimeFormatError,
  '22012': DivisionByZeroError,
  '22P02': InvalidTextRepresentationError,

  // access
  '42501': InsufficientPrivilegeError,
  '28000': InvalidPasswordError,
  '28P01': InvalidPasswordError,

  // class 42 (other) — schema objects
  '42601': SqlSyntaxError,
  '42703': UndefinedColumnError,
  '42883': UndefinedFunctionError,
  '42P01': UndefinedTableError,
  '42P07': DuplicateTableError,

  // prepared statements + the plan cache
  '26000': InvalidStatementNameError,
  '42P05': DuplicateStatementError,
  '0A000': CachedPlanChangedError,

  // locks and cancellation
  '55P03': LockNotAvailableError,
  '57014': QueryCanceledError,

  // class 53 — insufficient resources
  '53100': DiskFullError,
  '53200': OutOfMemoryError,
  '53300': TooManyConnectionsError,

  // class 57 — operator intervention
  '57P01': OperatorInterventionError,
  '57P02': OperatorInterventionError,
  '57P03': OperatorInterventionError,
  '57P04': OperatorInterventionError,
})

/**
 * `07` §4.5's class-prefix fallback.
 *
 * `'08'` is deliberately **absent**: a connection exception is a `ConnectionError`, not a
 * `QueryError`, and it is routed by `PgDriverErrorData.kind` before this table is consulted
 * (`./map.ts`). Putting it here as well would make the answer depend on which lookup ran first.
 */
export const SQLSTATE_CLASS_FALLBACK: Readonly<Record<string, QueryErrorCtor>> = Object.freeze({
  '22': DataError,
  '23': IntegrityConstraintError,
  '25': TransactionError,
  '26': PreparedStatementError,
  '28': AccessError,
  '40': TransactionError,
  '42': SchemaObjectError,
  '53': InsufficientResourcesError,
  '57': OperatorInterventionError,
})

/** Exact SQLSTATE → class prefix → `UnknownQueryError`. The order is §4.1 rule 3. */
export function classForSqlState(code: string | undefined): QueryErrorCtor {
  if (code === undefined || code === '') return UnknownQueryError
  return SQLSTATE_MAP[code] ?? SQLSTATE_CLASS_FALLBACK[code.slice(0, 2)] ?? UnknownQueryError
}
