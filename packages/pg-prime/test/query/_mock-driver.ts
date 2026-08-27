/**
 * A recording in-memory driver, for the tier-0 assertions that are about *what reaches the wire*
 * rather than about SQL text (design/09 WS4: "mock pool: chunked insert issues `BEGIN … COMMIT`
 * around chunks, and does not when the executor is already a `tx`").
 *
 * It implements the structural `PgDriver`/`PgConnection` seam (`02` §2) and nothing else — no
 * SQL is parsed and no rows are invented beyond what a test scripts. That is the point: a mock
 * that tried to be a database would be a second implementation to keep honest, and the real one
 * is one `pnpm test:live` away.
 */

import type {
  PgConnection,
  PgDriver,
  PgQuery,
  PgRawValue,
  PgResult,
  PgResultChunk,
} from '../../src/driver/index.js'

export interface Recorded {
  readonly text: string
  readonly params: readonly unknown[]
}

export interface MockDriver extends PgDriver {
  /** Every statement, in order, including `begin` / `commit` / `rollback`. */
  readonly log: Recorded[]
  /** Rows the next `execute` returns; shifted per call. Absent ⇒ no rows. */
  readonly rows: (readonly (readonly PgRawValue[])[])[]
  /** Connections handed out, so a test can prove chunks shared one. */
  acquired: number
  /** Set to make the next `execute` reject — for the rollback path. */
  failOn?: (q: PgQuery) => Error | undefined
}

export function mockDriver(): MockDriver {
  const log: Recorded[] = []
  const rows: (readonly (readonly PgRawValue[])[])[] = []

  const conn: PgConnection = {
    async execute(query: PgQuery): Promise<PgResult> {
      log.push({ text: query.text, params: query.params })
      const boom = driver.failOn?.(query)
      if (boom) throw boom
      return {
        rows: rows.shift() ?? [],
        fields: [],
        rowCount: 0,
        command: query.text.slice(0, 6).toUpperCase(),
        notices: [],
      }
    },
    stream(): AsyncIterable<PgResultChunk> {
      throw new Error('mock: stream() is WS6')
    },
    backendPid: 1,
    serverParameters: { TimeZone: 'UTC', DateStyle: 'ISO, MDY', server_version_num: '170004' },
    transactionStatus: 'I',
    usable: true,
  }

  const driver: MockDriver = {
    log,
    rows,
    acquired: 0,
    async init() {},
    async acquire() {
      driver.acquired += 1
      return conn
    },
    async release() {},
    async destroy() {},
    capabilities: {
      adapter: 'mock',
      execModes: ['unnamed', 'simple'],
      binaryResults: false,
      paramTypeOids: true,
      describe: false,
      richFieldMetadata: false,
      cursors: false,
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
