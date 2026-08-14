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
import type { PgDescribeResult, PgField } from './types.js'

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
    this.#reject(err)
  }

  handleReadyForQuery(): void {
    this.#detach()
    if (this.#settled) return
    this.#settled = true
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
    this.#reject(err)
  }

  handleReadyForQuery(): void {
    if (this.#settled) return
    this.#settled = true
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
