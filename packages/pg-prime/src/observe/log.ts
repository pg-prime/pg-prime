/**
 * The slow-query log (design/07 §7.3).
 *
 * Deliberately **no** aggregation and no sampling: that is the metrics pipeline's job, and
 * `onQueryEnd` is the seam for it. What this ships is the record — with the three-way timing split
 * and the captured call site — plus a small formatter, because the alternative is that everybody
 * writes the same twenty lines.
 *
 * `logAllQueries` refuses to enable itself in production unless explicitly forced, which is the
 * one guard rail here: it is a dev feature that will happily write a gigabyte an hour.
 */

import type { QueryEndEvent, QueryErrorEvent } from './events.js'

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug'

export interface LogOptions {
  /** Default `'warn'`. */
  readonly level?: LogLevel
  /** Default `null` (off). 500 is a good start. */
  readonly slowQueryMs?: number | null
  /** Log EVERY query. Dev only; refuses in production unless {@link LogOptions.force}. */
  readonly logAllQueries?: boolean
  /** The explicit acknowledgement that lets `logAllQueries` run in production. */
  readonly force?: boolean
  readonly sink?: (record: LogRecord) => void
  /** Default: pretty on a TTY, json otherwise. */
  readonly format?: 'pretty' | 'json'
}

export interface LogRecord {
  readonly level: Exclude<LogLevel, 'silent'>
  readonly kind: 'slow-query' | 'query' | 'query-error' | 'internal'
  readonly message: string
  readonly queryId?: string
  readonly sql?: string
  readonly paramCount?: number
  readonly durationMs?: number
  readonly serverMs?: number
  readonly decodeMs?: number
  readonly waitedForConnectionMs?: number
  readonly rowCount?: number
  readonly label?: string
  readonly callSite?: string
  readonly code?: string
}

const ORDER: Readonly<Record<LogLevel, number>> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
}

export interface ResolvedLogOptions {
  readonly level: LogLevel
  readonly slowQueryMs: number | null
  readonly logAllQueries: boolean
  readonly sink: (record: LogRecord) => void
  readonly format: 'pretty' | 'json'
}

export function resolveLogOptions(
  opts: LogOptions | undefined,
  production: boolean,
  warn: (message: string) => void,
): ResolvedLogOptions {
  let all = opts?.logAllQueries === true
  if (all && production && opts?.force !== true) {
    warn(
      'pg-prime: log.logAllQueries is ignored because NODE_ENV === "production". It writes one ' +
        'record per statement, which is a dev tool; pass log: { logAllQueries: true, force: true } ' +
        'if you really mean it (07 §7.3).',
    )
    all = false
  }
  const format = opts?.format ?? (isTty() ? 'pretty' : 'json')
  return {
    level: opts?.level ?? 'warn',
    slowQueryMs: opts?.slowQueryMs ?? null,
    logAllQueries: all,
    sink: opts?.sink ?? ((r) => defaultSink(r, format)),
    format,
  }
}

function isTty(): boolean {
  const p = (globalThis as { process?: { stdout?: { isTTY?: boolean } } }).process
  return p?.stdout?.isTTY === true
}

export function shouldLog(o: ResolvedLogOptions, level: Exclude<LogLevel, 'silent'>): boolean {
  return ORDER[o.level] >= ORDER[level]
}

/**
 * `07` §7.3's record, from a finished query.
 *
 * `serverMs` / `decodeMs` / `waitedForConnectionMs` are on it because the three answer three
 * different questions and one number answers none of them.
 */
export function slowQueryRecord(
  e: QueryEndEvent,
  callSite: string | undefined,
  kind: 'slow-query' | 'query',
): LogRecord {
  return {
    level: kind === 'slow-query' ? 'warn' : 'debug',
    kind,
    message:
      kind === 'slow-query'
        ? `slow query: ${e.durationMs.toFixed(1)} ms (server ${e.serverMs.toFixed(1)} ms, decode ${e.decodeMs.toFixed(1)} ms, waited ${e.waitedForConnectionMs.toFixed(1)} ms)`
        : `query: ${e.durationMs.toFixed(1)} ms`,
    queryId: e.queryId,
    sql: e.sql,
    paramCount: e.paramCount,
    durationMs: e.durationMs,
    serverMs: e.serverMs,
    decodeMs: e.decodeMs,
    waitedForConnectionMs: e.waitedForConnectionMs,
    rowCount: e.rowCount,
    ...(e.label === undefined ? {} : { label: e.label }),
    ...(callSite === undefined ? {} : { callSite }),
  }
}

export function queryErrorRecord(e: QueryErrorEvent): LogRecord {
  return {
    level: 'error',
    kind: 'query-error',
    message: `${e.error.name}: ${e.error.message}`,
    queryId: e.queryId,
    sql: e.sql,
    paramCount: e.paramCount,
    durationMs: e.durationMs,
    code: e.error.code,
    ...(e.label === undefined ? {} : { label: e.label }),
    ...(e.error.callSite === undefined ? {} : { callSite: e.error.callSite }),
  }
}

/** A small console formatter. Anything more opinionated belongs in the user's own `sink`. */
function defaultSink(r: LogRecord, format: 'pretty' | 'json'): void {
  const out = format === 'json' ? JSON.stringify({ logger: 'pg-prime', ...r }) : pretty(r)
  if (r.level === 'error') console.error(out)
  else if (r.level === 'warn') console.warn(out)
  else console.log(out)
}

function pretty(r: LogRecord): string {
  const head = `pg-prime [${r.level}] ${r.message}`
  const lines: string[] = [head]
  if (r.label !== undefined) lines.push(`  label: ${r.label}`)
  if (r.sql !== undefined) lines.push(`  ${r.sql}`)
  if (r.paramCount !== undefined && r.paramCount > 0) lines.push(`  ${r.paramCount} parameter(s)`)
  if (r.callSite !== undefined) lines.push(`  ${r.callSite}`)
  return lines.join('\n')
}
