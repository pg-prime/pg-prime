/**
 * A recording in-memory driver, for the tier-0 assertions that are about *what reaches the wire*
 * rather than about SQL text (design/09 WS4: "mock pool: chunked insert issues `BEGIN … COMMIT`
 * around chunks, and does not when the executor is already a `tx`"; WS6: the stream lifecycle,
 * the named-statement name, the self-heal, `assertShape` on a scripted `dataTypeID`).
 *
 * It implements the structural `PgDriver`/`PgConnection` seam (`02` §2) and nothing else — no
 * SQL is parsed and no rows are invented beyond what a test scripts. That is the point: a mock
 * that tried to be a database would be a second implementation to keep honest, and the real one
 * is one `pnpm test:live` away.
 *
 * **What the WS6 `stream()` does and does not prove.** It mirrors the real adapter's cursor
 * protocol — `declare` / `fetch forward n` / `close`, joining an open transaction rather than
 * opening its own — so a test can assert the *executor's* lifecycle: one `begin`, one `commit`
 * (or `rollback` on `break`), one connection, released. Whether that protocol is the right one is
 * pinned against a live server by `test/driver/cursor.test.ts`, which is where the `25P01` and
 * FETCH-count findings were measured; nothing here re-litigates it.
 */

import type {
  PgConnection,
  PgDriver,
  PgField,
  PgQuery,
  PgRawValue,
  PgResult,
  PgResultChunk,
} from '../../src/driver/index.js'

export interface Recorded {
  readonly text: string
  readonly params: readonly unknown[]
  readonly mode: string
  readonly statementName: string | undefined
  readonly paramTypes: readonly number[] | undefined
}

/** A scripted result: rows, and optionally the `RowDescription` that came with them. */
export interface Scripted {
  readonly rows: readonly (readonly PgRawValue[])[]
  readonly fields?: readonly PgField[]
}

export interface MockDriver extends PgDriver {
  /** Every statement, in order, including `begin` / `commit` / `rollback` / cursor traffic. */
  readonly log: Recorded[]
  /** Just the SQL, for the readable assertions. */
  texts(): string[]
  /** Rows the next `execute` returns; shifted per call. Absent ⇒ no rows. */
  readonly rows: (readonly (readonly PgRawValue[])[])[]
  /** Field metadata the next `execute` reports; shifted per call. Absent ⇒ `[]`. */
  readonly fields: (readonly PgField[])[]
  /** Chunks the next `stream()` yields, in order. Absent ⇒ one empty terminal chunk. */
  readonly chunks: Scripted[][]
  /** Connections handed out, and given back. A leak is `acquired !== released`. */
  acquired: number
  released: number
  /** Distinct `statementName`s the driver has seen, in first-use order. */
  readonly statementNames: string[]
  /** Names passed to the protocol `Close('S', name)`. Never SQL `DEALLOCATE` (07 §2.4). */
  readonly closed: string[]
  /**
   * Set to make the next `execute` reject — for the rollback and self-heal paths.
   *
   * `| undefined` rather than `?`: `exactOptionalPropertyTypes` is on, and a test that arms the
   * hook for one statement and disarms it for the next must be able to write `= undefined`.
   */
  failOn: ((q: PgQuery, nth: number) => Error | undefined) | undefined
  /** Pin `transactionStatus`, for the `25P02` branch of the self-heal policy (07 §2.4 policy 2). */
  forceTxStatus: 'I' | 'T' | 'E' | undefined
  clear(): void
}

/** A `PgField` with everything but the OID defaulted: only `dataTypeID` drives `assertShape`. */
export function field(name: string, dataTypeID: number): PgField {
  return {
    name,
    dataTypeID,
    dataTypeModifier: -1,
    tableID: 0,
    columnID: 0,
    dataTypeSize: -1,
    format: 'text',
  }
}

/** A server error as it crosses the seam: plain data on `pgPrime.server.sqlstate` (`02` §7 D12). */
export function serverError(sqlstate: string, message = 'scripted'): Error {
  const e = new Error(`${sqlstate}: ${message}`) as Error & {
    pgPrime: { server: { sqlstate: string } }
  }
  e.pgPrime = { server: { sqlstate } }
  return e
}

export function mockDriver(): MockDriver {
  const log: Recorded[] = []
  const rows: (readonly (readonly PgRawValue[])[])[] = []
  const fields: (readonly PgField[])[] = []
  const chunks: Scripted[][] = []
  const statementNames: string[] = []
  const closed: string[] = []
  let executes = 0
  let cursorSeq = 0

  const record = (query: PgQuery): void => {
    log.push({
      text: query.text,
      params: query.params,
      mode: query.mode ?? 'unnamed',
      statementName: query.statementName,
      paramTypes: query.paramTypes,
    })
    if (query.statementName !== undefined && !statementNames.includes(query.statementName)) {
      statementNames.push(query.statementName)
    }
  }

  let txStatus: 'I' | 'T' | 'E' = 'I'

  const conn: PgConnection = {
    async execute(query: PgQuery): Promise<PgResult> {
      record(query)
      const boom = driver.failOn?.(query, executes++)
      if (boom) throw boom
      const t = query.text.trim().toLowerCase()
      if (t === 'begin') txStatus = 'T'
      else if (t === 'commit' || t === 'rollback') txStatus = 'I'
      return {
        rows: rows.shift() ?? [],
        fields: fields.shift() ?? [],
        rowCount: 0,
        command: query.text.slice(0, 6).toUpperCase(),
        notices: [],
      }
    },

    async *stream(query: PgQuery, chunkSize: number): AsyncIterable<PgResultChunk> {
      const cursor = `pgprime_c_${(cursorSeq += 1).toString(36)}`
      const joined = txStatus === 'T'
      if (!joined) {
        await conn.execute({ text: 'begin', params: [], mode: 'simple' })
      }
      let declared = false
      try {
        await conn.execute({
          text: `declare ${cursor} no scroll cursor for ${query.text}`,
          params: query.params,
          ...(query.paramTypes ? { paramTypes: query.paramTypes } : {}),
        })
        declared = true
        const script = chunks.shift() ?? [{ rows: [] }]
        for (let i = 0; i < script.length; i++) {
          const s = script[i] as Scripted
          log.push({
            text: `fetch forward ${chunkSize} from ${cursor}`,
            params: [],
            mode: 'unnamed',
            statementName: undefined,
            paramTypes: undefined,
          })
          yield { rows: s.rows, fields: s.fields ?? [], done: i === script.length - 1 }
        }
      } finally {
        if (declared) {
          await conn.execute({ text: `close ${cursor}`, params: [] }).catch(() => {})
        }
        if (!joined) {
          await conn.execute({ text: 'commit', params: [], mode: 'simple' }).catch(() => {})
        }
      }
    },

    async closeStatement(name: string): Promise<void> {
      closed.push(name)
    },

    backendPid: 1,
    serverParameters: { TimeZone: 'UTC', DateStyle: 'ISO, MDY', server_version_num: '170004' },
    get transactionStatus(): 'I' | 'T' | 'E' {
      return driver.forceTxStatus ?? txStatus
    },
    usable: true,
  }

  const driver: MockDriver = {
    log,
    rows,
    fields,
    chunks,
    statementNames,
    closed,
    acquired: 0,
    released: 0,
    failOn: undefined,
    forceTxStatus: undefined,
    texts: () => log.map((r) => r.text),
    clear() {
      log.length = 0
      statementNames.length = 0
      closed.length = 0
      executes = 0
    },
    async init() {},
    async acquire() {
      driver.acquired += 1
      return conn
    },
    async release() {
      driver.released += 1
    },
    async destroy() {},
    capabilities: {
      adapter: 'mock',
      execModes: ['unnamed', 'named', 'simple'],
      binaryResults: false,
      paramTypeOids: true,
      describe: false,
      richFieldMetadata: true,
      cursors: true,
      copyIn: false,
      copyOut: false,
      listenNotify: false,
      cancel: false,
      multipleStatementsPerSession: true,
      maxConnections: 1,
      maxParams: 65535,
      serverVersionNum: 170004,
    },
  }
  return driver
}
