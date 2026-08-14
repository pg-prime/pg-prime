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
 *     `kind: 'cancelled'` so the runtime's retry logic never retries a user-initiated cancel.
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
}

/** The one entry point. Turns anything thrown by a pg-like driver into seam data. */
export function normaliseError(e: unknown, opts: NormaliseOptions): PgDriverErrorData {
  const message = e instanceof Error ? e.message : String(e)

  if (isServerErrorShape(e)) {
    const server = toServerErrorData(e)
    const kind: PgErrorKind = server.sqlstate === '57014' ? 'cancelled' : 'server'
    const data: Record<string, unknown> = {
      kind,
      message: server.message || message,
      connectionUnusable: serverErrorPoisonsConnection(server.sqlstate),
      server,
      adapter: opts.adapter,
      cause: e,
    }
    if (opts.sql !== undefined) data['sql'] = opts.sql
    return data as unknown as PgDriverErrorData
  }

  let kind: PgErrorKind = 'connection'
  let connectionUnusable = true
  if (opts.aborted) {
    kind = 'cancelled'
    connectionUnusable = false
  } else if (opts.timedOut || /timeout/i.test(message)) {
    // pg's `query_timeout` rejects with a plain `Error: Query read timeout` and leaves the client
    // usable — but the query KEEPS RUNNING on the server. It is a client give-up, not a cancel.
    kind = 'timeout'
    connectionUnusable = false
  } else if (/unexpected|desync|protocol/i.test(message)) {
    kind = 'protocol'
    connectionUnusable = true
  }

  const data: Record<string, unknown> = {
    kind,
    message,
    connectionUnusable,
    adapter: opts.adapter,
    cause: e,
  }
  if (opts.sql !== undefined) data['sql'] = opts.sql
  return data as unknown as PgDriverErrorData
}

/**
 * The adapter throws a real `Error` (so stacks work) carrying the seam data on `.pgorm`.
 * Agent 07 re-wraps this into its own class hierarchy; nothing here imports that hierarchy.
 */
export class PgDriverError extends Error {
  readonly pgorm: PgDriverErrorData
  constructor(data: PgDriverErrorData) {
    super(data.message, data.cause === undefined ? undefined : { cause: data.cause })
    this.name = 'PgDriverError'
    this.pgorm = data
  }
}

export function throwNormalised(e: unknown, opts: NormaliseOptions): never {
  throw new PgDriverError(normaliseError(e, opts))
}
