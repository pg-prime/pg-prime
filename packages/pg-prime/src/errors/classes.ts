/**
 * The error hierarchy of design/07 §4.2, as classes.
 *
 * ## The four rules this file obeys (§4.1)
 *
 *  1. **One base class.** Everything here descends from `PgPrimeError` (`./base.ts`).
 *  2. **Branch on SQLSTATE class, leaf on SQLSTATE.** `catch (e) { if (e instanceof
 *     IntegrityConstraintError) … }` and `… instanceof UniqueViolationError` both work, with no
 *     lookup table on the caller's side.
 *  3. **An unmodelled SQLSTATE never loses information.** `./sqlstate.ts`'s lookup falls back to
 *     the class ancestor and then to `UnknownQueryError`, and `code` is always the raw SQLSTATE.
 *     Adding a leaf later is therefore not a breaking change.
 *  4. **Structured fields, never message parsing.** Nobody should ever have to read our prose.
 *
 * ## Two names deviate from `07` §4.2, and both because the name was already taken
 *
 *  - **`SchemaObjectError`**, not `SchemaError` (SQLSTATE class 42). `SchemaError` is already a
 *    public export of `src/sql/errors.ts`: it is what `defineSchema(...)` throws for a bad
 *    *declaration*, it is in `tools/api-snapshot/pg-prime.json`, and the kit imports it. Two
 *    unrelated things called `SchemaError` on one barrel is worse than one renamed leaf.
 *  - **`SqlSyntaxError`**, not `SyntaxError` (42601). Exporting a `SyntaxError` from a library
 *    barrel shadows the ECMAScript global in every file that imports `*`, and `e instanceof
 *    SyntaxError` would then silently mean two different things depending on the import list.
 *
 * Everything else is `07` §4.2 verbatim, including `IndeterminateCommitError` being a **sibling**
 * of `ConnectionError` rather than a subclass — see its docblock.
 */

import type { PgServerErrorData } from '../driver/types.js'
import type { ErrorContext, ErrorInit } from './base.js'
import { PgPrimeError, UsageError } from './base.js'
import type { ConstraintRef, ColumnRef, TableRef } from './refs.js'

// ─────────────────────────────────────────────────────────────────────────────
// QueryError — the server rejected a statement, so there is a SQLSTATE
// ─────────────────────────────────────────────────────────────────────────────

/** Everything `07` §4.3 says a `QueryError` carries, as the one constructor argument. */
export interface QueryErrorInit extends ErrorInit {
  readonly code: string
  readonly severity?: 'ERROR' | 'FATAL' | 'PANIC'
  readonly server?: PgServerErrorData
  readonly sql?: string
  readonly params?: readonly unknown[]
  readonly paramCount?: number
  readonly paramTypes?: readonly number[]
  readonly detail?: string
  readonly detailRedacted?: boolean
  readonly context: ErrorContext
}

/**
 * The server rejected a statement.
 *
 * The PG `ErrorResponse` fields are verbatim and unredacted — none of them contains a user value
 * — while `sql`, `params` and `detail` are governed by `ErrorOptions` (`07` §4.3) and are shaped
 * by `./redact.ts` before they get here.
 */
export class QueryError extends PgPrimeError {
  declare readonly code: string
  /** `'23'` for `'23505'`. The branch key of §4.1 rule 2, precomputed. */
  readonly sqlStateClass: string
  readonly severity: 'ERROR' | 'FATAL' | 'PANIC'
  declare readonly context: ErrorContext

  // ── PG ErrorResponse fields, verbatim ──
  readonly schemaName?: string
  readonly tableName?: string
  readonly columnName?: string
  readonly dataTypeName?: string
  readonly constraintName?: string
  readonly hint?: string
  readonly position?: number
  readonly internalPosition?: number
  readonly where?: string
  /** e.g. `'FetchPreparedStatement'` — what drives the self-heal table in `07` §2.4. */
  readonly routine?: string
  readonly file?: string
  readonly line?: string

  // ── redaction-governed ──
  readonly sql?: string
  readonly params?: readonly unknown[]
  readonly paramCount: number
  readonly paramTypes?: readonly number[]
  readonly detail?: string
  readonly detailRedacted: boolean

  constructor(message: string, init: QueryErrorInit) {
    super(init.code, message, init)
    this.sqlStateClass = init.code.slice(0, 2)
    this.severity = init.severity ?? 'ERROR'
    this.paramCount = init.paramCount ?? 0
    this.detailRedacted = init.detailRedacted ?? false
    const s = init.server
    if (s !== undefined) {
      if (s.schema !== undefined) this.schemaName = s.schema
      if (s.table !== undefined) this.tableName = s.table
      if (s.column !== undefined) this.columnName = s.column
      if (s.dataType !== undefined) this.dataTypeName = s.dataType
      if (s.constraint !== undefined) this.constraintName = s.constraint
      if (s.hint !== undefined) this.hint = s.hint
      if (s.position !== undefined) this.position = s.position
      if (s.internalPosition !== undefined) this.internalPosition = s.internalPosition
      if (s.where !== undefined) this.where = s.where
      if (s.routine !== undefined) this.routine = s.routine
      if (s.file !== undefined) this.file = s.file
      if (s.line !== undefined) this.line = String(s.line)
    }
    if (init.sql !== undefined) this.sql = init.sql
    if (init.params !== undefined) this.params = init.params
    if (init.paramTypes !== undefined) this.paramTypes = init.paramTypes
    if (init.detail !== undefined) this.detail = init.detail
  }
}

// ── class 23 · integrity constraints ─────────────────────────────────────────

/**
 * SQLSTATE class 23, plus the schema resolution `07` §4.4 adds on top of it.
 *
 * `constraint` / `table` / `columns` are `undefined` for a constraint the schema does not declare
 * — one created by a hand-written SQL migration or by an extension — and the message then falls
 * back to PostgreSQL's own with a hint that says so. We never guess.
 */
export class IntegrityConstraintError extends QueryError {
  readonly constraint?: ConstraintRef
  readonly table?: TableRef
  readonly columns?: readonly ColumnRef[]

  constructor(message: string, init: QueryErrorInit & { readonly resolved?: ConstraintRef }) {
    super(message, init)
    const r = init.resolved
    if (r !== undefined) {
      this.constraint = r
      this.table = r.table
      this.columns = r.columns
    }
  }
}

export class NotNullViolationError extends IntegrityConstraintError {}
export class ForeignKeyViolationError extends IntegrityConstraintError {}
export class UniqueViolationError extends IntegrityConstraintError {}
export class CheckViolationError extends IntegrityConstraintError {}
export class ExclusionViolationError extends IntegrityConstraintError {}
export class RestrictViolationError extends IntegrityConstraintError {}

// ── transactions ─────────────────────────────────────────────────────────────

export class TransactionError extends QueryError {}

/** `40001`. Retried by default at repeatable read / serializable only (`07` §3.4). */
export class SerializationFailureError extends TransactionError {}

/**
 * `40P01`. **Not** retried by default (`07` §3.4): a deadlock is nearly always a lock-ordering bug,
 * and retrying it turns a reproducible bug into an intermittent latency spike. PG's `detail` names
 * both processes and both relations, so it is deliberately kept even under the default redaction
 * — see `./redact.ts`.
 */
export class DeadlockDetectedError extends TransactionError {}

/**
 * `25P02`, carrying the error that poisoned the transaction (`07` §3.3).
 *
 * That retained error is the whole point: by the time you see a `25P02`, the statement that
 * actually failed is several awaits in the past and its message is gone. A savepoint is the only
 * way to continue, and the hint says so.
 */
export class InFailedTransactionError extends TransactionError {
  /** The earlier error that aborted this transaction, when the `Tx` was the one that saw it. */
  readonly poisonedBy?: PgPrimeError

  constructor(message: string, init: QueryErrorInit & { readonly poisonedBy?: PgPrimeError }) {
    super(message, init)
    if (init.poisonedBy !== undefined) this.poisonedBy = init.poisonedBy
  }
}

export class IdleInTransactionTimeoutError extends TransactionError {}
export class ReadOnlySqlTransactionError extends TransactionError {}

// ── class 22 · data ──────────────────────────────────────────────────────────

export class DataError extends QueryError {}
export class NumericValueOutOfRangeError extends DataError {}
export class InvalidTextRepresentationError extends DataError {}
export class StringDataRightTruncationError extends DataError {}
export class DivisionByZeroError extends DataError {}
export class InvalidDatetimeFormatError extends DataError {}

// ── access ───────────────────────────────────────────────────────────────────

export class AccessError extends QueryError {}
/** `42501` — the RLS "0 rows" versus "denied" boundary. */
export class InsufficientPrivilegeError extends AccessError {}
/** `28P01` / `28000` after startup. The pre-connect case is `AuthenticationError`. */
export class InvalidPasswordError extends AccessError {}

// ── class 42 (other) · schema objects ────────────────────────────────────────

/** `07` §4.2's `SchemaError`, renamed — see this file's header. */
export class SchemaObjectError extends QueryError {}
export class UndefinedTableError extends SchemaObjectError {}
export class UndefinedColumnError extends SchemaObjectError {}
export class UndefinedFunctionError extends SchemaObjectError {}
export class DuplicateTableError extends SchemaObjectError {}
/** `42601`. `07` §4.2's `SyntaxError`, renamed — see this file's header. */
export class SqlSyntaxError extends SchemaObjectError {}

// ── prepared statements ──────────────────────────────────────────────────────

export class PreparedStatementError extends QueryError {}
/** `26000` — a pooler lost our statement. Self-healed once (`07` §2.4). */
export class InvalidStatementNameError extends PreparedStatementError {}
/** `42P05` — our per-connection map is stale. Self-healed once. */
export class DuplicateStatementError extends PreparedStatementError {}

/** `0A000` — self-heal plus a process-wide description-cache flush; the PgBouncer-after-DDL case. */
export class CachedPlanChangedError extends QueryError {}

/** `55P03` — `NOWAIT`, or `lock_timeout` on a lock we were waiting for. */
export class LockNotAvailableError extends QueryError {}

/**
 * `57014`. **Both** a server-side `statement_timeout` and a `CancelRequest` that landed.
 *
 * `context.reason` says which (`07` §6.2): `'statement_timeout'` means the backend gave up and is
 * no longer working; `'cancel'` means we asked it to stop. A client-side timer that fired is a
 * different class entirely — {@link QueryTimeoutError} — because there the server may still be
 * burning CPU.
 */
export class QueryCanceledError extends QueryError {}

// ── class 53 · resources ─────────────────────────────────────────────────────

export class InsufficientResourcesError extends QueryError {}
export class TooManyConnectionsError extends InsufficientResourcesError {}
export class OutOfMemoryError extends InsufficientResourcesError {}
export class DiskFullError extends InsufficientResourcesError {}

/** Class 57 (other) — `57P01 admin_shutdown`, `57P03 cannot_connect_now`. */
export class OperatorInterventionError extends QueryError {}

/** Any SQLSTATE we do not model. Always carries the raw `code` (§4.1 rule 3). */
export class UnknownQueryError extends QueryError {}

// ─────────────────────────────────────────────────────────────────────────────
// ConnectionError — we could not get bytes to or from a backend
// ─────────────────────────────────────────────────────────────────────────────

export class ConnectionError extends PgPrimeError {
  declare readonly context: ErrorContext
  constructor(
    message: string,
    init: ErrorInit & { readonly context: ErrorContext; readonly code?: string },
  ) {
    super(init.code ?? '08000', message, init)
  }
}

export class ConnectionRefusedError extends ConnectionError {}
/** TCP or TLS handshake timed out. Distinct from `PoolTimeoutError`, which never reached a socket. */
export class ConnectionTimeoutError extends ConnectionError {}
export class TlsError extends ConnectionError {}
/** SCRAM/MD5 failure, or `28P01` during startup. */
export class AuthenticationError extends ConnectionError {}
/** `ECONNRESET` / `08006` / a `57P01` that arrived mid-query. */
export class ConnectionTerminatedError extends ConnectionError {}

/** `07` §1.2 — pool stats, attached to a `PoolTimeoutError` so exhaustion is alertable. */
export interface PoolStats {
  readonly total: number
  readonly idle: number
  readonly waiting: number
  readonly max: number | undefined
}

/**
 * Client-side: `connectionTimeoutMillis` elapsed while queueing for a pooled connection.
 *
 * `07` §1.2 calls `pg`'s default of `0` — wait forever — "the single worst default in the stack",
 * because it turns exhaustion into an unbounded hang with no error and no metric. This class, with
 * the stats attached, is what that becomes instead.
 */
export class PoolTimeoutError extends ConnectionError {
  readonly stats?: PoolStats
  constructor(
    message: string,
    init: ErrorInit & { readonly context: ErrorContext; readonly stats?: PoolStats },
  ) {
    super(message, init)
    if (init.stats !== undefined) this.stats = init.stats
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The one that is deliberately on its own
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `COMMIT` was written and never acknowledged. **The transaction may have committed.**
 *
 * A sibling of `ConnectionError`, never a subclass, and that is the entire point (`07` §4.2): if
 * it inherited, every `catch (e) { if (e instanceof ConnectionError) retry() }` already in the
 * wild would silently do the wrong thing — which, for a payment, is a double charge. Making it a
 * sibling forces a deliberate decision. It is also `07` §3.4's first hard retry exclusion, so
 * nothing in this library will ever re-run the callback that produced one.
 */
export class IndeterminateCommitError extends PgPrimeError {
  declare readonly context: ErrorContext
  constructor(message: string, init: ErrorInit & { readonly context: ErrorContext }) {
    super('INDETERMINATE_COMMIT', message, init)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeouts and aborts
// ─────────────────────────────────────────────────────────────────────────────

export class TimeoutError extends PgPrimeError {
  declare readonly context: ErrorContext
  constructor(message: string, init: ErrorInit & { readonly context: ErrorContext }) {
    super('TIMEOUT', message, init)
  }
}

/** Our own client-side timer fired (`07` §6.2). The server may still be running the statement. */
export class QueryTimeoutError extends TimeoutError {}
/** A `signal` from `AbortSignal.timeout(ms)` fired around a whole transaction. */
export class TransactionTimeoutError extends TimeoutError {}

/** The caller's `AbortSignal` fired. Never retried (`07` §3.4 exclusion 2). */
export class AbortError extends PgPrimeError {
  declare readonly context: ErrorContext
  constructor(message: string, init: ErrorInit & { readonly context: ErrorContext }) {
    super('ABORT', message, init)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UsageError leaves (the root itself lives in ./base.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** The outer `db` used inside a transaction callback (`07` §1.5 layer 3, dev guard only). */
export class HandleMisuseError extends UsageError {}
/** A `Tx`/`Session` handle used after its callback returned. */
export class TransactionClosedError extends UsageError {}
/** A handle used after `rollbackWith()` doomed the transaction (`07` §3.7). */
export class TransactionAbandonedError extends UsageError {}
/** A query after `db.end()`. */
export class DbClosedError extends UsageError {}
/** `LISTEN` / a session advisory lock / `db.session()` / named statements under a tx pooler. */
export class UnsupportedInPoolerModeError extends UsageError {}

/**
 * `db.rollback()`'s throw (`07` §3.7a). `db.transaction` rolls back and rethrows it.
 *
 * A `UsageError` rather than a `TransactionError`: nothing went wrong on the server, the caller
 * asked to abort. It is never retried for the same reason.
 */
export class TransactionRollback extends UsageError {}
