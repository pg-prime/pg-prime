/* oxlint-disable typescript/require-await -- `end()` implements `PgLikePool`'s async seam; a
   synchronous body is what a double with nothing to await looks like. */
/**
 * A hand-built pg-like pool — design/02 §3's structural seam, taken at its word.
 *
 * Everything the adapter does that is NOT about SQL — the `error` listener it must keep on a
 * checked-out client, releasing a pool slot on an aborted acquire, aiming a cancel at the
 * statement that asked for it, disposing a connection that still has a statement running on it —
 * cannot be observed from a live server: it is about what the adapter does to the *client object*
 * and to the *pool*, on timelines a real server will not reproduce on demand.
 *
 * So this file implements `PgLikePool` / `PgLikePoolClient` directly (no `as` on the seam, R12),
 * over Node's real `EventEmitter` — which is the load-bearing part: an `error` event with no
 * listener THROWS, exactly as it does in production, so "the adapter must keep a listener" is a
 * test that fails loudly rather than a comment.
 */

import { EventEmitter } from 'node:events'
import type {
  PgLikeConnection,
  PgLikeField,
  PgLikePool,
  PgLikePoolClient,
  PgLikeQueryConfig,
  PgLikeResult,
  PgLikeSubmittable,
} from '../../src/driver/index.js'

export const TEXT_FIELD = (name: string): PgLikeField => ({
  name,
  tableID: 0,
  columnID: 0,
  dataTypeID: 25,
  dataTypeSize: -1,
  dataTypeModifier: -1,
  format: 'text',
})

/** The GUCs `loadServerParameters()` reads on every physical connection. */
export const GUC_ROWS: readonly (readonly [string, string])[] = [
  ['DateStyle', 'ISO, MDY'],
  ['IntervalStyle', 'postgres'],
  ['TimeZone', 'UTC'],
  ['standard_conforming_strings', 'on'],
  ['client_encoding', 'UTF8'],
  ['integer_datetimes', 'on'],
  ['server_version_num', '170004'],
]

export interface RecordedQuery {
  readonly text: string
  readonly values: readonly unknown[]
  readonly config: PgLikeQueryConfig
}

export function emptyResult(command = 'SELECT'): PgLikeResult {
  return { rows: [], fields: [], rowCount: 0, command }
}

export class FakeClient implements PgLikePoolClient {
  /**
   * Node's real emitter, held rather than inherited so the class states the SEAM's signatures.
   * `emit('error')` with no listener throws here exactly as it does on a pg Client.
   */
  readonly #events = new EventEmitter()
  readonly queries: RecordedQuery[] = []
  /** Submittables handed to `query()` — this fake records them, it does not drive them. */
  readonly submittables: PgLikeSubmittable[] = []
  /** One entry per `release()`, in order. */
  readonly releases: ('reuse' | 'destroy')[] = []
  processID = 4242
  activeQuery: unknown = { id: 'the-active-query' }
  txStatus: 'I' | 'T' | 'E' | null = 'I'
  /** Set to 'binary' to simulate a Pool constructed with `binary: true` (§4.4). */
  gucFieldFormat: 'text' | 'binary' = 'text'
  /** Return a promise to answer a query yourself; return undefined for the default answer. */
  respond: ((q: RecordedQuery) => Promise<PgLikeResult | PgLikeResult[]> | undefined) | undefined
  /** Absent when constructed with `reportsTransactionStatus: false` — the seam allows that. */
  getTransactionStatus?: () => 'I' | 'T' | 'E'

  constructor(options?: { readonly reportsTransactionStatus?: boolean }) {
    if (options?.reportsTransactionStatus !== false) {
      this.getTransactionStatus = (): 'I' | 'T' | 'E' => (this.txStatus ?? 'I') as 'I' | 'T' | 'E'
    }
  }

  query(config: PgLikeQueryConfig): Promise<PgLikeResult | PgLikeResult[]>
  query<T extends PgLikeSubmittable>(submittable: T): T
  query(
    arg: PgLikeQueryConfig | PgLikeSubmittable,
  ): Promise<PgLikeResult | PgLikeResult[]> | PgLikeSubmittable {
    if (typeof (arg as PgLikeSubmittable).submit === 'function') {
      this.submittables.push(arg as PgLikeSubmittable)
      throw new Error('FakeClient does not drive Submittables; use a live target for those paths')
    }
    const config = arg as PgLikeQueryConfig
    const q: RecordedQuery = { text: config.text, values: config.values ?? [], config }
    this.queries.push(q)
    const answered = this.respond?.(q)
    if (answered) return answered
    if (config.text.includes('pg_catalog.pg_settings')) {
      return Promise.resolve({
        rows: GUC_ROWS.map((r) => [...r]),
        fields: [
          { ...TEXT_FIELD('name'), format: this.gucFieldFormat },
          { ...TEXT_FIELD('setting'), format: this.gucFieldFormat },
        ],
        rowCount: GUC_ROWS.length,
        command: 'SELECT',
      })
    }
    return Promise.resolve(emptyResult())
  }

  on(event: 'notice' | 'notification' | 'error' | 'end', listener: (arg: never) => void): unknown {
    return this.#events.on(event, listener as (...args: unknown[]) => void)
  }

  removeListener(event: string, listener: (arg: never) => void): unknown {
    return this.#events.removeListener(event, listener as (...args: unknown[]) => void)
  }

  listenerCount(event: string): number {
    return this.#events.listenerCount(event)
  }

  release(err?: Error | boolean): void {
    this.releases.push(err === true || err instanceof Error ? 'destroy' : 'reuse')
  }

  /** The event pg-pool stops listening to at checkout — unhandled here means a thrown error. */
  fail(err: Error): void {
    this.#events.emit('error', err)
  }

  /** pg's `end` — the socket closed with nothing more coming, ReadyForQuery included. */
  end(): void {
    this.#events.emit('end')
  }

  notice(message: string): void {
    this.#events.emit('notice', { severity: 'NOTICE', code: '00000', message })
  }
}

export class FakePool implements PgLikePool {
  readonly clients: FakeClient[] = []
  connectCalls = 0
  ended = 0
  /** Throw from `end()`, like pg-pool does when the user already ended the pool. */
  endThrows = false
  /** When true, `connect()` stays pending until `settleConnect()` is called. */
  manual = false
  readonly options: Record<string, unknown> = { max: 4 }
  #pending: { resolve: (c: PgLikePoolClient) => void; reject: (e: unknown) => void }[] = []
  #next: (() => FakeClient) | undefined

  constructor(next?: () => FakeClient) {
    this.#next = next
  }

  connect(): Promise<PgLikePoolClient> {
    this.connectCalls += 1
    if (this.manual) {
      return new Promise<PgLikePoolClient>((resolve, reject) => {
        this.#pending.push({ resolve, reject })
      })
    }
    return Promise.resolve(this.newClient())
  }

  /** Hand out the client a pending `connect()` has been waiting for. */
  settleConnect(client: FakeClient = this.newClient()): FakeClient {
    const p = this.#pending.shift()
    if (!p) throw new Error('no pending connect() to settle')
    p.resolve(client)
    return client
  }

  failConnect(err: Error): void {
    const p = this.#pending.shift()
    if (!p) throw new Error('no pending connect() to fail')
    p.reject(err)
  }

  get pendingConnects(): number {
    return this.#pending.length
  }

  newClient(): FakeClient {
    const c = this.#next ? this.#next() : new FakeClient()
    this.clients.push(c)
    return c
  }

  async end(): Promise<void> {
    this.ended += 1
    if (this.endThrows) throw new Error('Called end on pool more than once')
  }
}

/** A settled-later promise, for driving a query's timeline by hand. */
export function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Let every already-queued microtask run. */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/**
 * A no-op protocol writer. Enough to hand a Submittable something shaped like pg's
 * `client.connection` when a test drives its message callbacks by hand.
 */
export function fakeConnection(): PgLikeConnection {
  return {
    parse: () => {},
    bind: () => {},
    describe: () => {},
    execute: () => {},
    close: () => {},
    sync: () => {},
    flush: () => {},
    sendCopyFromChunk: () => {},
    endCopyFrom: () => {},
    sendCopyFail: () => {},
    on: () => undefined,
    removeListener: () => undefined,
    parsedStatements: {},
    stream: { destroy: () => {} },
  }
}
