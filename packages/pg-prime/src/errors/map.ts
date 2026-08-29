/**
 * `PgDriverErrorData` → an error class, mapped **once**, at the executor boundary (design/07 §4,
 * decision 4 of design/12 §1).
 *
 * Errors cross the driver seam as plain data (`02` §7 D12) precisely so that adapters never import
 * this hierarchy. This file is the single place that turns that data into a class, which is what
 * makes the mapping testable as a table rather than as scattered `if`s: `mapDriverError` is pure
 * except for the constraint index, and `test/query/session-errors.test.ts` walks every SQLSTATE in
 * `SQLSTATE_MAP` through it.
 *
 * Anything that is not one of ours passes through untouched. A `TypeError` from user code inside a
 * transaction callback is not a database condition and must not be dressed up as one — `07` §3.4's
 * fourth retry exclusion depends on exactly that.
 */

import type { PgDriverErrorData } from '../driver/types.js'
import type { ErrorContext } from './base.js'
import { PgPrimeError } from './base.js'
import {
  AbortError,
  AuthenticationError,
  ConnectionError,
  ConnectionRefusedError,
  ConnectionTerminatedError,
  ConnectionTimeoutError,
  InFailedTransactionError,
  IntegrityConstraintError,
  PoolTimeoutError,
  QueryError,
  QueryTimeoutError,
  TlsError,
} from './classes.js'
import type { QueryErrorInit } from './classes.js'
import { describeConstraint, resolveConstraint } from './refs.js'
import type { ConstraintRef } from './refs.js'
import { classForSqlState } from './sqlstate.js'
import { redactDetail, redactSql } from './redact.js'
import type { ResolvedErrorOptions } from './redact.js'

/** The seam data, as the pg adapter throws it: a real `Error` carrying `.pgPrime`. */
interface Carrier {
  readonly pgPrime?: PgDriverErrorData
}

export function driverDataOf(e: unknown): PgDriverErrorData | undefined {
  if (typeof e !== 'object' || e === null) return undefined
  const data = (e as Carrier).pgPrime
  if (data === undefined || typeof data !== 'object') return undefined
  if (typeof (data as { kind?: unknown }).kind === 'string') return data
  // A **partial** carrier: `{ pgPrime: { server: { sqlstate } } }` and nothing else. `02` §7 says
  // the seam's data has a `kind`, but the SQLSTATE is the routing key and a carrier that has one
  // is unambiguously a server error — so a minimal adapter, a test double or a future field
  // ordering all classify correctly instead of falling through to "not ours" and reaching the
  // caller as a bare `Error`. Widening here rather than at every read site keeps the rule in one
  // place.
  const server = (data as { server?: unknown }).server
  if (
    typeof server === 'object' &&
    server !== null &&
    typeof (server as { sqlstate?: unknown }).sqlstate === 'string'
  ) {
    return {
      kind: 'server',
      message:
        (data as { message?: string }).message ?? (server as { message?: string }).message ?? '',
      connectionUnusable: (data as { connectionUnusable?: boolean }).connectionUnusable ?? false,
      adapter: (data as { adapter?: string }).adapter ?? 'unknown',
      ...(data as object),
    } as PgDriverErrorData
  }
  return undefined
}

/** SQLSTATE of anything, whether it came through the seam or straight off `pg`. */
export function sqlStateOfError(e: unknown): string | undefined {
  const data = driverDataOf(e)
  if (data?.server !== undefined) return data.server.sqlstate
  const code = (e as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && code.length === 5 ? code : undefined
}

export interface MapOptions {
  readonly context: ErrorContext
  readonly errors: ResolvedErrorOptions
  readonly sql?: string | undefined
  /**
   * The bind values. **This is the only source of `paramCount` as well**, which is why the caller
   * passes them whatever the redaction policy says: `07` §4.3 calls `paramCount` "always
   * present", and deriving it from anything else is a second number that can disagree (it read
   * `0` for every statement until design/12 §4 F1, because the runner passed `undefined` here).
   *
   * Whether the VALUES are published is decided below, once, by `errors.includeParams`.
   */
  readonly params?: readonly unknown[] | undefined
  readonly paramTypes?: readonly number[] | undefined
  readonly callSite?: string | undefined
  /** The schema object, for `07` §4.4's constraint resolution. */
  readonly schema?: object | undefined
  /** The error that already poisoned this transaction, for a `25P02` (`07` §3.3). */
  readonly poisonedBy?: PgPrimeError | undefined
  /** Pool statistics, attached to a `PoolTimeoutError` (`07` §1.2). */
  readonly poolStats?: PoolStatsLike | undefined
}

interface PoolStatsLike {
  readonly total: number
  readonly idle: number
  readonly waiting: number
  readonly max: number | undefined
}

/**
 * The one entry point.
 *
 * Already-mapped errors pass straight through: a `Tx` re-raising the error a nested savepoint
 * produced must not re-wrap it, or the `instanceof` a caller wrote against the inner class stops
 * matching.
 */
export function mapError(e: unknown, o: MapOptions): unknown {
  if (e instanceof PgPrimeError) return e
  const data = driverDataOf(e)
  if (data === undefined) return e
  return mapDriverError(data, e, o)
}

export function mapDriverError(
  data: PgDriverErrorData,
  cause: unknown,
  o: MapOptions,
): PgPrimeError {
  const sql = redactSql(o.sql ?? data.sql, o.errors)
  const base = {
    cause,
    context: o.context,
    ...(o.callSite === undefined ? {} : { callSite: o.callSite }),
  }

  if (data.kind === 'cancelled' && data.server === undefined) {
    return new AbortError(data.message, base)
  }
  if (data.kind === 'timeout' && data.server === undefined) {
    // Our own client-side deadline. The SERVER MAY STILL BE WORKING — that is the whole reason
    // this is not a `QueryCanceledError` (`07` §6.2).
    return new QueryTimeoutError(data.message, base)
  }
  if (data.kind === 'connection' || data.kind === 'protocol' || data.kind === 'adapter') {
    return connectionError(data, base, o)
  }

  const server = data.server
  const state = server?.sqlstate ?? ''
  const Ctor = classForSqlState(state)
  // Never an empty message. The seam's `server.message` is the good one, `data.message` the next
  // best, and the underlying `Error`'s own the last resort — a mapped error that says nothing is
  // strictly worse than the raw one it replaced, and an adapter (or a test double) that fills only
  // `server.sqlstate` is a shape we accept in `driverDataOf`.
  const text = firstNonEmpty(
    server?.message,
    data.message,
    cause instanceof Error ? cause.message : '',
  )
  const { detail, detailRedacted } = redactDetail(server?.detail, state, o.errors)

  const init: QueryErrorInit = {
    ...base,
    code: state,
    ...(server === undefined ? {} : { server, severity: severityOf(server.severity ?? 'ERROR') }),
    ...(sql === undefined ? {} : { sql }),
    ...(o.errors.includeParams && o.params !== undefined ? { params: o.params } : {}),
    paramCount: o.params?.length ?? 0,
    ...(o.paramTypes === undefined ? {} : { paramTypes: o.paramTypes }),
    ...(detail === undefined ? {} : { detail }),
    detailRedacted,
    context:
      state === '57014' ? { ...o.context, reason: cancelReason(data, server?.message) } : o.context,
  }

  if (state === '25P02') {
    return new InFailedTransactionError(inFailedTransactionMessage(text, o.poisonedBy), {
      ...init,
      ...(o.poisonedBy === undefined ? {} : { poisonedBy: o.poisonedBy }),
    })
  }

  const Integrity = Ctor as unknown as typeof IntegrityConstraintError
  if (isIntegrity(Ctor)) {
    const resolved = resolveConstraint(o.schema, server?.constraint, server?.table, server?.column)
    return new Integrity(constraintMessage(text, server?.constraint, resolved), {
      ...init,
      ...(resolved === undefined ? {} : { resolved }),
    })
  }

  return new Ctor(text, init)
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string {
  for (const v of values) if (v !== undefined && v !== '') return v
  return 'pg-prime: the database reported an error with no message.'
}

function isIntegrity(Ctor: unknown): boolean {
  let c = Ctor as { prototype?: unknown } | undefined
  while (c !== undefined && c !== null) {
    if (c === IntegrityConstraintError) return true
    c = Object.getPrototypeOf(c) as { prototype?: unknown } | undefined
  }
  return false
}

function severityOf(s: string): 'ERROR' | 'FATAL' | 'PANIC' {
  return s === 'FATAL' || s === 'PANIC' ? s : 'ERROR'
}

/**
 * `07` §6.2 — the backend raises `57014` for both a `CancelRequest` and an expired
 * `statement_timeout` / `lock_timeout`. The two mean very different things operationally, and the
 * only signal is the backend's own wording plus whether we were the ones who asked.
 */
function cancelReason(
  data: PgDriverErrorData,
  message: string | undefined,
): 'statement_timeout' | 'lock_timeout' | 'cancel' {
  if (message !== undefined) {
    if (message.includes('statement timeout')) return 'statement_timeout'
    if (message.includes('lock timeout')) return 'lock_timeout'
  }
  return data.kind === 'cancelled' ? 'cancel' : 'statement_timeout'
}

/**
 * `07` §4.4's improved message, and its mandatory graceful degradation.
 *
 * With the constraint resolved: `unique constraint violated: users(email) [users_email_key]`.
 * Without it, PostgreSQL's own message plus a sentence saying the constraint is not declared in
 * the schema — never a guess.
 */
function constraintMessage(
  serverMessage: string,
  name: string | undefined,
  resolved: ConstraintRef | undefined,
): string {
  if (resolved !== undefined) {
    const label = KIND_LABEL[resolved.kind] ?? 'constraint'
    const suffix = name === undefined ? '' : ` [${name}]`
    return `${label} violated: ${describeConstraint(resolved)}${suffix}`
  }
  if (name === undefined) return serverMessage
  return (
    `${serverMessage} — constraint "${name}" is not declared in your schema; it may have been ` +
    `created by a raw SQL migration or by an extension.`
  )
}

const KIND_LABEL: Readonly<Record<string, string>> = {
  unique: 'unique constraint',
  primaryKey: 'primary key',
  foreignKey: 'foreign key constraint',
  check: 'check constraint',
  exclusion: 'exclusion constraint',
  notNull: 'not-null constraint',
}

function inFailedTransactionMessage(
  serverMessage: string | undefined,
  poisonedBy: PgPrimeError | undefined,
): string {
  const head =
    serverMessage ??
    'current transaction is aborted, commands ignored until end of transaction block'
  if (poisonedBy === undefined) return head
  return (
    `${head} — the transaction was aborted earlier by ${poisonedBy.name}: ${poisonedBy.message}. ` +
    `Wrap the statement that may fail in tx.savepoint(...) so a failure there does not poison the ` +
    `whole transaction.`
  )
}

/**
 * A non-server failure. `07` §4.2's `ConnectionError` leaves are distinguished by the OS/TLS error
 * code, which is the only thing that survives — `pg` gives us no structured field for them.
 */
function connectionError(
  data: PgDriverErrorData,
  base: { cause: unknown; context: ErrorContext; callSite?: string },
  o: MapOptions,
): PgPrimeError {
  const message = data.message
  const cause = data.cause as { code?: unknown } | undefined
  const osCode = typeof cause?.code === 'string' ? cause.code : undefined

  if (message.startsWith('timeout exceeded when trying to connect')) {
    return new PoolTimeoutError(
      `${message} — the pool had no free connection within connectionTimeoutMillis.`,
      { ...base, ...(o.poolStats === undefined ? {} : { stats: o.poolStats }) },
    )
  }
  if (osCode === 'ECONNREFUSED' || osCode === 'ENOTFOUND' || osCode === 'EHOSTUNREACH') {
    return new ConnectionRefusedError(message, base)
  }
  if (osCode === 'ETIMEDOUT' || message === 'timeout expired') {
    return new ConnectionTimeoutError(message, base)
  }
  if (
    osCode !== undefined &&
    (osCode.startsWith('ERR_TLS') || osCode.startsWith('CERT_') || osCode.startsWith('UNABLE_TO_'))
  ) {
    return new TlsError(message, base)
  }
  if (
    data.server?.sqlstate.startsWith('28') === true ||
    /password authentication failed|SASL|SCRAM/i.test(message)
  ) {
    return new AuthenticationError(message, base)
  }
  if (
    osCode === 'ECONNRESET' ||
    data.server?.sqlstate === '08006' ||
    data.server?.sqlstate === '57P01' ||
    message.startsWith('Connection terminated')
  ) {
    return new ConnectionTerminatedError(message, base)
  }
  return new ConnectionError(message, {
    ...base,
    ...(data.server === undefined ? {} : { code: data.server.sqlstate }),
  })
}

/** Re-exported so callers do not need two imports to test what they just caught. */
export { QueryError }
