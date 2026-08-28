/**
 * OpenTelemetry-compatible **without depending on OpenTelemetry** (design/07 §7.2).
 *
 * Core exports the attribute names as data and the mapping as a pure function; core imports
 * nothing. `@opentelemetry/api` is a real dependency with its own version treadmill and most users
 * do not trace, so the person who does not trace pays nothing — not even a `.d.ts`.
 *
 * Non-semconv attributes go under a `pg_prime.*` prefix so they can never collide with a future
 * semconv key.
 */

import type { QueryEndEvent, QueryErrorEvent, QueryStartEvent } from './events.js'

/**
 * Pinned to the OTel semantic conventions for database client spans, v1.34 (stable). Exported as a
 * record so a semconv bump is one edit rather than a refactor.
 */
export const SEMCONV = {
  dbSystemName: 'db.system.name',
  dbNamespace: 'db.namespace',
  dbQueryText: 'db.query.text',
  dbQuerySummary: 'db.query.summary',
  dbOperationName: 'db.operation.name',
  dbCollectionName: 'db.collection.name',
  dbResponseStatusCode: 'db.response.status_code',
  dbResponseReturnedRows: 'db.response.returned_rows',
  dbOperationBatchSize: 'db.operation.batch.size',
  serverAddress: 'server.address',
  serverPort: 'server.port',
  errorType: 'error.type',
} as const

export type SpanAttributes = Readonly<Record<string, string | number | boolean>>

/** Everything a span needs that the event itself cannot know. */
export interface SpanContext {
  /** `db.namespace` — the database name. */
  readonly namespace?: string
  readonly serverAddress?: string
  readonly serverPort?: number
  readonly poolerMode?: string
}

function isEnd(e: QueryStartEvent | QueryEndEvent | QueryErrorEvent): e is QueryEndEvent {
  return typeof (e as QueryEndEvent).rowCount === 'number'
}

function isError(e: QueryStartEvent | QueryEndEvent | QueryErrorEvent): e is QueryErrorEvent {
  return (e as QueryErrorEvent).error !== undefined
}

/** `'SELECT'` / `'INSERT'` / … — semconv wants the operation upper-cased. */
function operationName(e: QueryStartEvent): string | undefined {
  return e.operation === undefined ? undefined : e.operation.toUpperCase()
}

/** Pure. No imports beyond types. Adapt it to whatever tracer you use. */
export function spanAttributes(
  e: QueryStartEvent | QueryEndEvent | QueryErrorEvent,
  ctx: SpanContext = {},
): SpanAttributes {
  const out: Record<string, string | number | boolean> = {
    [SEMCONV.dbSystemName]: 'postgresql',
    [SEMCONV.dbQueryText]: e.sql,
    [SEMCONV.dbQuerySummary]: spanName(e),
    'pg_prime.exec_mode': e.execMode,
    'pg_prime.handle': e.handle,
    'pg_prime.attempt': e.attempt,
    'pg_prime.tx_depth': e.depth,
    'pg_prime.query_id': e.queryId,
  }
  const op = operationName(e)
  if (op !== undefined) out[SEMCONV.dbOperationName] = op
  const table = e.tables?.[0]
  if (table !== undefined) out[SEMCONV.dbCollectionName] = table
  if (ctx.namespace !== undefined) out[SEMCONV.dbNamespace] = ctx.namespace
  if (ctx.serverAddress !== undefined) out[SEMCONV.serverAddress] = ctx.serverAddress
  if (ctx.serverPort !== undefined) out[SEMCONV.serverPort] = ctx.serverPort
  if (ctx.poolerMode !== undefined) out['pg_prime.pooler_mode'] = ctx.poolerMode
  if (e.label !== undefined) out['pg_prime.label'] = e.label
  if (e.txId !== undefined) out['pg_prime.tx_id'] = e.txId

  if (isError(e)) {
    out[SEMCONV.errorType] = e.error.name
    // semconv asks for the SQLSTATE here, which is exactly what `code` is for a server error.
    if (e.error.code !== '') out[SEMCONV.dbResponseStatusCode] = e.error.code
    out['pg_prime.duration_ms'] = e.durationMs
    out['pg_prime.wait_ms'] = e.waitedForConnectionMs
  } else if (isEnd(e)) {
    out[SEMCONV.dbResponseReturnedRows] = e.rowCount
    out['pg_prime.duration_ms'] = e.durationMs
    out['pg_prime.server_ms'] = e.serverMs
    out['pg_prime.decode_ms'] = e.decodeMs
    out['pg_prime.wait_ms'] = e.waitedForConnectionMs
  }
  return Object.freeze(out)
}

/** The name OTel wants: `"<operation> <collection>"`, e.g. `"SELECT users"`. */
export function spanName(e: QueryStartEvent): string {
  const op = operationName(e) ?? 'QUERY'
  const table = e.tables?.[0]
  return table === undefined ? op : `${op} ${table}`
}
