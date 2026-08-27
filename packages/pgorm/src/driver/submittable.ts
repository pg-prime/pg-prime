/**
 * pg's Submittable protocol — design/02-driver.md §5.2.
 *
 * `Client.prototype.query` branches on `typeof config.submit === 'function'` and then routes every
 * backend message to that object's `handleX` methods. This is how `pg-cursor` and `pg-copy-streams`
 * work, and it is how we get the three things pg's public API does not offer:
 * `describe()`, `closeStatement()` and (later) COPY — with zero dependencies.
 *
 * ⚠️ DEVIATION from research §4.4, confirmed here: pg does NOT expose Describe-without-Execute.
 * Driving `client.connection.parse/describe/sync` directly crashes the client with
 * `Received unexpected parseComplete message from backend` because `Client._handleParseComplete`
 * requires an `activeQuery`. As a Submittable it works cleanly.
 */

import type { PgLikeClient, PgLikeConnection, PgLikeField, PgLikeSubmittable } from './pg-like.js'
import type { PgDescribeResult, PgField, PgRawValue } from './types.js'

export function toPgField(f: PgLikeField): PgField {
  return {
    name: f.name,
    dataTypeID: f.dataTypeID,
    dataTypeModifier: f.dataTypeModifier ?? -1,
    tableID: f.tableID ?? 0,
    columnID: f.columnID ?? 0,
    dataTypeSize: f.dataTypeSize ?? -1,
    format: f.format ?? 'text',
  }
}

/**
 * Parse + Describe('S') + Sync, with NO Bind and NO Execute.
 *
 * `ParameterDescription` and `NoData` are NOT in pg's `Client._attachListeners`, so this
 * Submittable subscribes to `connection.on('parameterDescription' | 'noData')` itself and
 * unsubscribes in `handleReadyForQuery`. No conflict with pg's own listeners.
 */
class DescribeSubmittable implements PgLikeSubmittable {
  readonly text: string
  /** Unnamed statement: falsy, so pg's `parsedStatements` bookkeeping stays out of it. */
  readonly name = ''
  /**
   * Set by pg (`client.js` `query()`) when the pool/client carries `query_timeout`: pg wraps our
   * callback in one that clears its own `setTimeout`. A Submittable that never CALLS the callback
   * therefore leaks one live `Timeout` per describe, and with `pipeline: true` that stray timer
   * later fires `connection.stream.destroy()` on a healthy connection. So we call it on settle.
   */
  callback?: (err: unknown, result?: unknown) => void

  #paramTypes: number[] = []
  #fields: PgField[] = []
  #settled = false
  #resolve!: (r: PgDescribeResult) => void
  #reject!: (e: unknown) => void
  #connection: PgLikeConnection | undefined
  #onParameterDescription = (msg: unknown): void => {
    const m = msg as { dataTypeIDs?: readonly number[] } | undefined
    this.#paramTypes = m?.dataTypeIDs ? [...m.dataTypeIDs] : []
  }
  #onNoData = (): void => {
    this.#fields = []
  }

  readonly promise: Promise<PgDescribeResult>

  constructor(text: string) {
    this.text = text
    this.promise = new Promise<PgDescribeResult>((res, rej) => {
      this.#resolve = res
      this.#reject = rej
    })
  }

  submit(connection: PgLikeConnection): Error | null {
    this.#connection = connection
    connection.on('parameterDescription', this.#onParameterDescription as (m: never) => void)
    connection.on('noData', this.#onNoData as (m: never) => void)
    try {
      connection.parse({ name: '', text: this.text, types: [] }, true)
      connection.describe({ type: 'S', name: '' }, true)
      connection.sync()
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
    return null
  }

  #detach(): void {
    const c = this.#connection
    if (!c) return
    c.removeListener('parameterDescription', this.#onParameterDescription as (m: never) => void)
    c.removeListener('noData', this.#onNoData as (m: never) => void)
    this.#connection = undefined
  }

  handleRowDescription(msg: { fields: readonly PgLikeField[] }): void {
    this.#fields = msg.fields.map(toPgField)
  }

  handleDataRow(): void {
    /* impossible: no Execute was sent */
  }
  handleCommandComplete(): void {
    /* impossible */
  }
  handleEmptyQuery(): void {
    this.#fields = []
  }
  handlePortalSuspended(): void {
    /* impossible */
  }
  handleCopyInResponse(): void {
    /* impossible */
  }
  handleCopyData(): void {
    /* impossible */
  }

  handleError(err: unknown): void {
    this.#detach()
    if (this.#settled) return
    this.#settled = true
    this.callback?.(err)
    this.#reject(err)
  }

  handleReadyForQuery(): void {
    this.#detach()
    if (this.#settled) return
    this.#settled = true
    this.callback?.(null, undefined)
    this.#resolve({ paramTypes: this.#paramTypes, fields: this.#fields })
  }
}

export async function describeViaSubmittable(
  client: PgLikeClient,
  sql: string,
): Promise<PgDescribeResult> {
  const sub = new DescribeSubmittable(sql)
  client.query(sub)
  return sub.promise
}

/**
 * Protocol-level `Close('S', name)` + `Sync`. NEVER SQL `DEALLOCATE` — that is the exact thing
 * that broke PHP/PDO against PgBouncer.
 *
 * Integration detail (§5.2, re-verified on pg@8.23.0): pg does NOT update its own statement
 * bookkeeping on Close, so we must delete the entries ourselves or a later Parse of the same name
 * with different SQL raises `Prepared statements must be unique`. pg 8.23 keeps TWO maps —
 * `parsedStatements` and `submittedNamedStatements` — and both must be cleared.
 */
class CloseStatementSubmittable implements PgLikeSubmittable {
  readonly text = ''
  readonly name = ''
  /** See `DescribeSubmittable.callback` — not calling it leaks pg's `query_timeout` timer. */
  callback?: (err: unknown, result?: unknown) => void
  #statement: string
  #settled = false
  #resolve!: () => void
  #reject!: (e: unknown) => void
  readonly promise: Promise<void>

  constructor(statement: string) {
    this.#statement = statement
    this.promise = new Promise<void>((res, rej) => {
      this.#resolve = res
      this.#reject = rej
    })
  }

  submit(connection: PgLikeConnection): Error | null {
    try {
      connection.close({ type: 'S', name: this.#statement }, true)
      connection.sync()
      const bookkeeping = connection as unknown as {
        parsedStatements?: Record<string, string>
        submittedNamedStatements?: Record<string, string>
      }
      if (bookkeeping.parsedStatements) delete bookkeeping.parsedStatements[this.#statement]
      if (bookkeeping.submittedNamedStatements)
        delete bookkeeping.submittedNamedStatements[this.#statement]
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
    return null
  }

  handleRowDescription(): void {}
  handleDataRow(): void {}
  handleCommandComplete(): void {}
  handleEmptyQuery(): void {}
  handlePortalSuspended(): void {}
  handleCopyInResponse(): void {}
  handleCopyData(): void {}

  handleError(err: unknown): void {
    if (this.#settled) return
    this.#settled = true
    this.callback?.(err)
    this.#reject(err)
  }

  handleReadyForQuery(): void {
    if (this.#settled) return
    this.#settled = true
    this.callback?.(null, undefined)
    this.#resolve()
  }
}

export async function closeStatementViaSubmittable(
  client: PgLikeClient,
  name: string,
): Promise<void> {
  const sub = new CloseStatementSubmittable(name)
  client.query(sub)
  return sub.promise
}

// ─────────────────────────────────────────────────────────────────────────────
// maxRows — one round trip, real CommandComplete (design/02 amendment ③, revised)
// ─────────────────────────────────────────────────────────────────────────────

/** What `PgQuery.maxRows` needs on the wire, already encoded by the codec registry. */
export interface CappedExecuteRequest {
  readonly text: string
  readonly values: readonly (string | Uint8Array | null)[]
  readonly paramTypes: readonly number[]
  /** Portal row cap, ≥ 1. `Execute(rows = 0)` means UNLIMITED in the protocol, never zero rows. */
  readonly rows: number
}

export interface CappedExecuteResult {
  readonly rows: readonly (readonly PgRawValue[])[]
  readonly fields: readonly PgField[]
  readonly command: string
  readonly rowCount: number | null
  /** True when the backend answered PortalSuspended — i.e. the cap actually truncated. */
  readonly suspended: boolean
}

/** pg's own CommandComplete tag grammar (`pg/lib/result.js`): `COMMAND [oid] [rows]`. */
const COMMAND_TAG = /^([A-Za-z]+)(?: (\d+))?(?: (\d+))?/

/**
 * Best-effort command for a TRUNCATED portal. PortalSuspended carries no tag — the backend only
 * emits CommandComplete when the statement runs to completion — so there is nothing to report but
 * the statement's own leading keyword. Fabricating `'SELECT'` (what the cursor implementation did)
 * was wrong for `INSERT … RETURNING`; the leading keyword at least never lies about the verb.
 */
function leadingKeyword(text: string): string {
  const m = /^[\s;]*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*([A-Za-z]+)/.exec(text)
  return m?.[1] ? m[1].toUpperCase() : ''
}

/**
 * `Buffer.from` if we are on Node. pg-protocol writes a parameter in BINARY format only for
 * `value instanceof Buffer` (`serializer.js` `writeValues`), and a plain `Uint8Array` is NOT a
 * Buffer — it would be written as if it were a string. pg's own path hides this behind
 * `utils.prepareValue`, which we cannot reach from a Submittable, so we do the same conversion.
 */
const bufferFrom = (globalThis as unknown as {
  Buffer?: { from(b: ArrayBufferLike, byteOffset?: number, length?: number): Uint8Array }
}).Buffer

/**
 * Parse + Bind + Describe(portal) + **Execute(rows = n)** + Close(portal) + Sync, in ONE write.
 *
 * This replaces the `BEGIN / DECLARE / FETCH / CLOSE / COMMIT` cursor that `maxRows` used to be:
 * five round trips, a fabricated `command`, a fabricated empty `notices`, and a hard failure for
 * `INSERT … RETURNING` (`DECLARE` cannot wrap DML). PortalSuspended is treated as COMPLETION —
 * the portal is closed immediately after, so the backend stops producing rows.
 */
class MaxRowsSubmittable implements PgLikeSubmittable {
  readonly text: string
  /** Unnamed statement AND unnamed portal: no server-side session state, pooler-safe. */
  readonly name = ''
  callback?: (err: unknown, result?: unknown) => void

  readonly #values: readonly (string | Uint8Array | null)[]
  readonly #paramTypes: readonly number[]
  readonly #rows: number
  #collected: (readonly PgRawValue[])[] = []
  #fields: PgField[] = []
  #command: string | undefined
  #rowCount: number | null = null
  #suspended = false
  #settled = false
  #resolve!: (r: CappedExecuteResult) => void
  #reject!: (e: unknown) => void
  readonly promise: Promise<CappedExecuteResult>

  constructor(req: CappedExecuteRequest) {
    this.text = req.text
    this.#values = req.values
    this.#paramTypes = req.paramTypes
    this.#rows = req.rows
    this.promise = new Promise<CappedExecuteResult>((res, rej) => {
      this.#resolve = res
      this.#reject = rej
    })
  }

  submit(connection: PgLikeConnection): Error | null {
    try {
      connection.stream.cork?.()
      try {
        connection.parse({ name: '', text: this.text, types: this.#paramTypes }, true)
        connection.bind(
          {
            portal: '',
            statement: '',
            values: this.#values,
            // D6/§4.4: text results always. This path is also immune to a pool built with
            // `binary: true`, because pg's `if (this.binary) query.binary = true` never sees it.
            binary: false,
            valueMapper: toWireValue,
          },
          true,
        )
        connection.describe({ type: 'P', name: '' }, true)
        connection.execute({ portal: '', rows: this.#rows }, true)
        connection.close({ type: 'P', name: '' }, true)
        connection.sync()
      } finally {
        connection.stream.uncork?.()
      }
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
    return null
  }

  handleRowDescription(msg: { fields: readonly PgLikeField[] }): void {
    this.#fields = msg.fields.map(toPgField)
  }

  handleDataRow(msg: { fields: readonly (string | null)[] }): void {
    this.#collected.push(msg.fields)
  }

  handleCommandComplete(msg: { text?: string; command?: string }): void {
    const m = COMMAND_TAG.exec(msg.text ?? msg.command ?? '')
    if (!m) return
    this.#command = m[1]
    if (m[3] !== undefined) this.#rowCount = Number.parseInt(m[3], 10)
    else if (m[2] !== undefined) this.#rowCount = Number.parseInt(m[2], 10)
  }

  handleEmptyQuery(): void {
    this.#command = ''
  }

  /** The cap bit. pg's own Query re-Executes here (that is why its `rows` option only PAGES). */
  handlePortalSuspended(): void {
    this.#suspended = true
  }

  handleCopyInResponse(): void {
    /* impossible: COPY is refused above the seam for a capped query */
  }
  handleCopyData(): void {
    /* impossible */
  }

  handleError(err: unknown): void {
    if (this.#settled) return
    this.#settled = true
    this.callback?.(err)
    this.#reject(err)
  }

  handleReadyForQuery(): void {
    if (this.#settled) return
    this.#settled = true
    this.callback?.(null, undefined)
    this.#resolve({
      rows: this.#collected,
      fields: this.#fields,
      command: this.#command ?? leadingKeyword(this.text),
      rowCount: this.#suspended ? this.#collected.length : this.#rowCount,
      suspended: this.#suspended,
    })
  }
}

/** The value mapper pg would apply for us if this went through `pg/lib/query.js`. */
function toWireValue(v: unknown): unknown {
  if (v === null || v === undefined || typeof v === 'string') return v ?? null
  if (v instanceof Uint8Array) {
    if (!bufferFrom) {
      throw new Error(
        'a Uint8Array parameter needs Node’s Buffer to be written in BINARY format, and this ' +
          'runtime has no global Buffer; send the value as text instead',
      )
    }
    return bufferFrom.from(v.buffer, v.byteOffset, v.byteLength)
  }
  return v
}

export async function executeCappedViaSubmittable(
  client: PgLikeClient,
  req: CappedExecuteRequest,
): Promise<CappedExecuteResult> {
  const sub = new MaxRowsSubmittable(req)
  client.query(sub)
  return sub.promise
}
