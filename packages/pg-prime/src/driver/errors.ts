/**
 * Normalising whatever a driver throws into `PgDriverErrorData` — design/02-driver.md §7.
 *
 * Errors cross the seam as PLAIN DATA, never as classes (D12): agent 07 owns the error class
 * hierarchy and adapters must not need to import it.
 *
 * The four traps this file absorbs, all measured live against PG 17.11:
 *  1. `position` / `internalPosition` / `line` arrive as STRINGS from pg (`position: "15"`).
 *  2. Never `instanceof`. pg's error has `name === 'error'`, PGlite's class is minified to `N`,
 *     Neon has its own `DatabaseError` *and* a separate `NeonDbError`. Detection is duck-typed.
 *  3. Absent fields are absent, not null — pg omits keys entirely.
 *  4. `57014` may arrive as an ordinary query rejection from either cancel path; it is tagged
 *     `kind: 'cancelled'` — but ONLY when it really was a cancel. The backend also raises 57014
 *     for an expired `statement_timeout`/`lock_timeout`, which IS retryable, so the tag is driven
 *     by `opts.aborted` or the backend's own "due to user request" wording.
 */

import type { PgDriverErrorData, PgErrorKind, PgServerErrorData } from './types.js'

/** Duck-typed server-error detection. NEVER `instanceof` (§7 trap 2). */
export function isServerErrorShape(e: unknown): e is Record<string, unknown> {
  if (typeof e !== 'object' || e === null) return false
  const r = e as Record<string, unknown>
  return typeof r['code'] === 'string' && typeof r['severity'] === 'string'
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** Build a `PgServerErrorData` from any pg-shaped error/notice object. Absent stays absent. */
export function toServerErrorData(raw: Record<string, unknown>): PgServerErrorData {
  const out: Record<string, unknown> = {
    severity: str(raw['severity']) ?? 'ERROR',
    sqlstate: str(raw['code']) ?? '',
    message: str(raw['message']) ?? '',
  }
  const detail = str(raw['detail'])
  if (detail !== undefined) out['detail'] = detail
  const hint = str(raw['hint'])
  if (hint !== undefined) out['hint'] = hint
  const position = num(raw['position'])
  if (position !== undefined) out['position'] = position
  const internalPosition = num(raw['internalPosition'])
  if (internalPosition !== undefined) out['internalPosition'] = internalPosition
  const internalQuery = str(raw['internalQuery'])
  if (internalQuery !== undefined) out['internalQuery'] = internalQuery
  const where = str(raw['where'])
  if (where !== undefined) out['where'] = where
  const schema = str(raw['schema'])
  if (schema !== undefined) out['schema'] = schema
  const table = str(raw['table'])
  if (table !== undefined) out['table'] = table
  const column = str(raw['column'])
  if (column !== undefined) out['column'] = column
  const dataType = str(raw['dataType'])
  if (dataType !== undefined) out['dataType'] = dataType
  const constraint = str(raw['constraint'])
  if (constraint !== undefined) out['constraint'] = constraint
  const file = str(raw['file'])
  if (file !== undefined) out['file'] = file
  const line = num(raw['line'])
  if (line !== undefined) out['line'] = line
  const routine = str(raw['routine'])
  if (routine !== undefined) out['routine'] = routine
  return out as unknown as PgServerErrorData
}

/**
 * pg's OWN client-side rejections, verbatim (`pg/lib/client.js`, `pg/lib/query.js` — pinned by
 * test/driver/errors.test.ts). Every one of them is raised BEFORE or INSTEAD OF anything reaching
 * the socket, so the connection is untouched; classifying them by regex over the word "timeout"
 * or "unexpected" is what used to poison a perfectly good connection (or, worse, report a dead
 * socket as a mere client-side deadline).
 */

/** The `query_timeout` give-up. THE only message that means "our client-side deadline elapsed". */
const PG_QUERY_READ_TIMEOUT = 'Query read timeout'

/** Client-side query validation. Nothing was written to the socket; the connection is fine. */
const PG_ADAPTER_MESSAGES: readonly string[] = [
  'Prepared statements must be unique', // query.js: name reused for different SQL
  'Query values must be an array', // query.js
  'A query must have either text or a name', // query.js
  'Client was passed a null or undefined query', // client.js
  'callback is not a function', // client.js
]

/** The socket is gone / the client refuses further work. Never a timeout, never a protocol desync. */
const PG_CONNECTION_MESSAGES: readonly string[] = [
  'Connection terminated unexpectedly', // client.js, socket died mid-query
  'Connection terminated', // client.js, .end() raced a query
  'Client has encountered a connection error and is not queryable',
  'Client was closed and is not queryable',
  'timeout exceeded when trying to connect', // pg-pool: POOL acquisition, not a query deadline
  'Cannot use a pool after calling end on the pool', // pg-pool
  'timeout expired', // client.js connectionTimeoutMillis
]

function startsWithAny(message: string, prefixes: readonly string[]): boolean {
  for (const p of prefixes) if (message.startsWith(p)) return true
  return false
}

/**
 * SQLSTATEs after which the physical connection must be thrown away.
 * `08xxx` connection_exception, `57P01/02/03` admin shutdown, `XX000` internal error.
 */
function serverErrorPoisonsConnection(sqlstate: string): boolean {
  return (
    sqlstate.startsWith('08') ||
    sqlstate === '57P01' ||
    sqlstate === '57P02' ||
    sqlstate === '57P03' ||
    sqlstate === 'XX000'
  )
}

export interface NormaliseOptions {
  readonly adapter: string
  readonly sql?: string | undefined
  /** Set when our own AbortSignal fired — forces `kind: 'cancelled'` even for a socket error. */
  readonly aborted?: boolean
  /** Set when our own client-side deadline elapsed. */
  readonly timedOut?: boolean
  /**
   * Overrides the computed `connectionUnusable`. The adapter, not this file, knows whether the
   * physical connection survived: it watches the client's `error` event and knows that a
   * `query_timeout` give-up leaves the statement still running on that socket (§5.4).
   */
  readonly connectionUnusable?: boolean
  /** Set when we tried to cancel this statement and the cancel request itself failed. */
  readonly cancelError?: string
}

/** The one entry point. Turns anything thrown by a pg-like driver into seam data. */
export function normaliseError(e: unknown, opts: NormaliseOptions): PgDriverErrorData {
  const message = e instanceof Error ? e.message : String(e)

  if (isServerErrorShape(e)) {
    const server = toServerErrorData(e)
    // 57014 is `query_canceled`, and the backend raises it for BOTH a CancelRequest AND an expired
    // `statement_timeout` / `lock_timeout`. Only the first is a user cancel that must never be
    // retried; the timeout ones are tagged 'timeout' so the runtime can back off and retry.
    const kind: PgErrorKind =
      server.sqlstate === '57014'
        ? opts.aborted || server.message.includes('due to user request')
          ? 'cancelled'
          : 'timeout'
        : 'server'
    const data: Record<string, unknown> = {
      kind,
      message: server.message || message,
      connectionUnusable: opts.connectionUnusable ?? serverErrorPoisonsConnection(server.sqlstate),
      server,
      adapter: opts.adapter,
      cause: e,
    }
    if (opts.sql !== undefined) data['sql'] = opts.sql
    if (opts.cancelError !== undefined) data['cancelError'] = opts.cancelError
    return data as unknown as PgDriverErrorData
  }

  // Not a server error: an exact-match table over pg's own client-side messages. NEVER a loose
  // regex — `/timeout/i` matched the POOL's "timeout exceeded when trying to connect" and
  // `/unexpected/` matched "Connection terminated unexpectedly", so a dead socket was reported as
  // a survivable client deadline and a pool exhaustion as a protocol desync.
  let kind: PgErrorKind = 'connection'
  let connectionUnusable = true
  if (opts.aborted) {
    kind = 'cancelled'
    connectionUnusable = false
  } else if (opts.timedOut || message === PG_QUERY_READ_TIMEOUT) {
    // pg's `query_timeout` rejects with a plain `Error: Query read timeout`. The SOCKET is fine,
    // but the statement KEEPS RUNNING on it — the caller decides (the pg adapter marks the
    // connection unusable via `connectionUnusable`, §5.4).
    kind = 'timeout'
    connectionUnusable = false
  } else if (startsWithAny(message, PG_ADAPTER_MESSAGES)) {
    kind = 'adapter'
    connectionUnusable = false
  } else if (startsWithAny(message, PG_CONNECTION_MESSAGES)) {
    kind = 'connection'
    connectionUnusable = true
  } else if (/desync|unexpected \w+ message|protocol/i.test(message)) {
    kind = 'protocol'
    connectionUnusable = true
  }

  const data: Record<string, unknown> = {
    kind,
    message,
    connectionUnusable: opts.connectionUnusable ?? connectionUnusable,
    adapter: opts.adapter,
    cause: e,
  }
  if (opts.sql !== undefined) data['sql'] = opts.sql
  if (opts.cancelError !== undefined) data['cancelError'] = opts.cancelError
  return data as unknown as PgDriverErrorData
}

/**
 * The adapter throws a real `Error` (so stacks work) carrying the seam data on `.pgPrime`.
 * Agent 07 re-wraps this into its own class hierarchy; nothing here imports that hierarchy.
 */
export class PgDriverError extends Error {
  readonly pgPrime: PgDriverErrorData
  constructor(data: PgDriverErrorData) {
    super(data.message, data.cause === undefined ? undefined : { cause: data.cause })
    this.name = 'PgDriverError'
    this.pgPrime = data
  }
}
