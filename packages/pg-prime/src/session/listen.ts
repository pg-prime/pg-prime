/**
 * LISTEN / NOTIFY (design/07 §6.5, and decision 8 of design/12 §1).
 *
 * ## The connection is not a pool client, and that is the whole design
 *
 * A connection holding `LISTEN` is pinned for its lifetime. Taking it from the pool silently
 * shrinks `max` and eventually starves the app — with `max: 1`, which is what every serverless
 * preset sets, the *first* subscription deadlocks the process. So a `Db` owns **one dedicated
 * connection**, outside the pool, shared by every channel, reference-counted, opened on the first
 * subscription and closed when the last one goes away.
 *
 * Getting a connection the pool does not own needs a seam the driver did not have. `PgDriver.connect?`
 * is that seam — optional, so every existing adapter still satisfies `PgDriver`, and implemented in
 * the pg adapter from the pool's own configuration (or from `directConnection` under a transaction
 * profile, which is what "routed by feature, not by call site" means).
 *
 * ## `'gap'` is the correctness feature
 *
 * `LISTEN`/`NOTIFY` is at-most-once: notifications published while you were disconnected are gone
 * forever. Every implementation surveyed reconnects silently, which quietly loses events. We
 * re-`LISTEN` on every channel and then emit `'gap'` with the outage duration, so the application
 * can reconcile — re-poll the table, re-read a watermark. A `LISTEN`-based cache invalidation
 * without gap handling is incorrect, and the doc says so in bold.
 */

import type { PgConnection, PgNotification } from '../driver/types.js'
import { ConfigError, UnsupportedInPoolerModeError, UsageError, mapError } from '../errors/index.js'
import type { ResolvedErrorOptions } from '../errors/index.js'
import { ASYNC_DISPOSE } from './guard.js'
import type { Subscription } from './types.js'

/**
 * PostgreSQL's own limit, checked client-side rather than left to produce a confusing `22023`.
 *
 * **Measured on PG 17.11**, and it corrects `07` §6.5's "payload limit is 8000 bytes": the backend
 * test is `strlen(payload) >= NOTIFY_PAYLOAD_MAX_LENGTH` where that constant is
 * `BLCKSZ - NAMEDATALEN - 128` = 8000, so 8000 bytes is already `payload string too long` and 7999
 * is the largest that works. The constant below is the exclusive bound it really is.
 */
export const MAX_NOTIFY_PAYLOAD_BYTES = 8000

export function assertPayloadSize(payload: string): void {
  const bytes = new TextEncoder().encode(payload).length
  if (bytes < MAX_NOTIFY_PAYLOAD_BYTES) return
  throw new UsageError(
    `pg-prime: a NOTIFY payload must be UNDER ${MAX_NOTIFY_PAYLOAD_BYTES} bytes and this one is ` +
      `${bytes}. (PostgreSQL's own check is \`>= 8000\`, measured on 17.11, so 7999 is the largest ` +
      `that works.) Send an id, not a document — the listener can read the row (07 §6.5).`,
  )
}

type Handlers = Set<(payload: string, ctx: { channel: string; processId: number }) => void>
type Emitter = Map<'reconnect' | 'gap' | 'error', Set<(info: never) => void>>

export interface ListenerHost {
  /** Opens a connection the pool does not own (`PgDriver.connect`). */
  openDedicated(): Promise<PgConnection>
  /** Gives it back — for a dedicated connection that means closing the socket. */
  closeDedicated(conn: PgConnection): Promise<void>
  readonly errors: ResolvedErrorOptions
  readonly reconnect: { readonly baseDelayMs: number; readonly maxDelayMs: number }
  warn(message: string): void
  internal(kind: 'listen-reconnect', message: string, cause?: unknown): void
}

/**
 * One multiplexed dedicated connection per `Db`, reference-counted across channels.
 *
 * Ref-counting rather than one connection per channel because `LISTEN a` and `LISTEN b` on one
 * backend is exactly as correct as two backends and costs one connection instead of N.
 */
export class ListenHub {
  readonly #host: ListenerHost
  #conn: PgConnection | undefined
  #opening: Promise<PgConnection> | undefined
  #unsubscribe: (() => void) | undefined
  readonly #channels = new Map<string, Handlers>()
  readonly #emitters = new Map<string, Emitter>()
  #closed = false
  #reconnecting = false

  constructor(host: ListenerHost) {
    this.#host = host
  }

  get open(): boolean {
    return this.#conn !== undefined
  }

  /** @internal — the tier-2 test asserts exactly one dedicated backend in `pg_stat_activity`. */
  get backendPid(): number | undefined {
    return this.#conn?.backendPid
  }

  async subscribe(
    channel: string,
    handler: (payload: string, ctx: { channel: string; processId: number }) => void,
    signal: AbortSignal | undefined,
  ): Promise<Subscription> {
    assertChannel(channel)
    if (this.#closed) {
      throw new UsageError('pg-prime: db.listen() was called after db.end().')
    }
    const conn = await this.#connection()
    let handlers = this.#channels.get(channel)
    if (handlers === undefined) {
      handlers = new Set()
      this.#channels.set(channel, handlers)
      await conn.execute({ text: `listen ${quoteChannel(channel)}`, params: [], mode: 'simple' })
    }
    handlers.add(handler)

    const emitter: Emitter = new Map()
    this.#emitters.set(channel, emitter)
    const sub = this.#makeSubscription(channel, handler, emitter)
    if (signal !== undefined) {
      if (signal.aborted) await sub.close()
      else signal.addEventListener('abort', () => void sub.close(), { once: true })
    }
    return sub
  }

  #makeSubscription(
    channel: string,
    handler: (payload: string, ctx: { channel: string; processId: number }) => void,
    emitter: Emitter,
  ): Subscription {
    const close = async (): Promise<void> => {
      const handlers = this.#channels.get(channel)
      handlers?.delete(handler)
      if (handlers !== undefined && handlers.size === 0) {
        this.#channels.delete(channel)
        this.#emitters.delete(channel)
        const conn = this.#conn
        if (conn !== undefined) {
          await conn
            .execute({ text: `unlisten ${quoteChannel(channel)}`, params: [], mode: 'simple' })
            .catch(() => {})
        }
      }
      if (this.#channels.size === 0) await this.#drop()
    }
    const on = (event: 'reconnect' | 'gap' | 'error', h: (info: never) => void): (() => void) => {
      let set = emitter.get(event)
      if (set === undefined) {
        set = new Set()
        emitter.set(event, set)
      }
      set.add(h)
      return () => void set?.delete(h)
    }
    // See `sessionAdvisoryLock` in ./handles.ts for why the computed key needs a cast.
    return {
      channel,
      close,
      [ASYNC_DISPOSE]: close,
      on: on as Subscription['on'],
    } as unknown as Subscription
  }

  async #connection(): Promise<PgConnection> {
    if (this.#conn !== undefined) return this.#conn
    this.#opening ??= this.#host.openDedicated()
    try {
      const conn = await this.#opening
      this.#conn = conn
      this.#attach(conn)
      return conn
    } finally {
      this.#opening = undefined
    }
  }

  #attach(conn: PgConnection): void {
    // `PgConnection.on` is three optional overloads, so a bare reference resolves to the last of
    // them. One cast at the seam beats three at the call sites.
    const on = conn.on as
      | ((event: 'notice' | 'notification' | 'error', listener: (arg: never) => void) => () => void)
      | undefined
    if (on === undefined) {
      throw new ConfigError(
        'pg-prime: this driver cannot deliver asynchronous notifications (PgConnection.on is not ' +
          'implemented), so db.listen() has nothing to listen with. capabilities.listenNotify says ' +
          'so; the pg adapter implements it.',
      )
    }
    const offNotification = on.call(conn, 'notification', ((n: PgNotification) => {
      const handlers = this.#channels.get(n.channel)
      if (handlers === undefined) return
      for (const h of handlers) {
        try {
          h(n.payload, { channel: n.channel, processId: n.processId })
        } catch (e) {
          this.#emit(n.channel, 'error', e)
        }
      }
    }) as never)
    const offError = on.call(conn, 'error', ((e: unknown) => {
      void this.#reconnect(e)
    }) as never)
    this.#unsubscribe = () => {
      offNotification()
      offError()
    }
  }

  /**
   * Full-jitter backoff, then re-`LISTEN` on every channel, then `'gap'`.
   *
   * The order matters: re-subscribing *before* telling the application about the gap means a
   * reconcile started from the `'gap'` handler cannot miss a notification published between the
   * two steps.
   */
  async #reconnect(cause: unknown): Promise<void> {
    if (this.#closed || this.#reconnecting || this.#channels.size === 0) return
    this.#reconnecting = true
    const downFrom = Date.now()
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    this.#conn = undefined
    let attempt = 0
    try {
      for (;;) {
        if (this.#closed || this.#channels.size === 0) return
        attempt += 1
        const ceiling = Math.min(
          this.#host.reconnect.maxDelayMs,
          this.#host.reconnect.baseDelayMs * 2 ** (attempt - 1),
        )
        await sleep(Math.random() * ceiling)
        try {
          const conn = await this.#host.openDedicated()
          this.#conn = conn
          this.#attach(conn)
          for (const channel of this.#channels.keys()) {
            await conn.execute({ text: `listen ${quoteChannel(channel)}`, params: [], mode: 'simple' })
          }
          const downMs = Date.now() - downFrom
          this.#host.internal(
            'listen-reconnect',
            `pg-prime: the LISTEN connection was re-established after ${downMs} ms on attempt ` +
              `${attempt}. Notifications published during the outage are LOST — handle 'gap'.`,
            cause,
          )
          for (const channel of this.#channels.keys()) {
            this.#emit(channel, 'reconnect', { attempt, downMs })
            this.#emit(channel, 'gap', { downMs })
          }
          return
        } catch (e) {
          for (const channel of this.#channels.keys()) {
            this.#emit(
              channel,
              'error',
              mapError(e, { context: { handle: 'db' }, errors: this.#host.errors }),
            )
          }
        }
      }
    } finally {
      this.#reconnecting = false
    }
  }

  #emit(channel: string, event: 'reconnect' | 'gap' | 'error', info: unknown): void {
    const set = this.#emitters.get(channel)?.get(event)
    if (set === undefined) return
    for (const h of set) {
      try {
        ;(h as (i: unknown) => void)(info)
      } catch {
        // A throwing 'error' handler must not recurse into itself.
      }
    }
  }

  async #drop(): Promise<void> {
    const conn = this.#conn
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    this.#conn = undefined
    if (conn === undefined) return
    await this.#host.closeDedicated(conn)
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#channels.clear()
    this.#emitters.clear()
    await this.#drop()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms)
    ;(t as unknown as { unref?: () => void }).unref?.()
  })
}

/**
 * `LISTEN` takes an *identifier*, not a parameter, so the channel is quoted rather than bound.
 *
 * `notify` has no such problem — `pg_notify($1, $2)` is a function call and both halves are binds,
 * which is why `07` §6.5 insists on it over `NOTIFY chan, 'literal'`. Here the only safe thing is
 * to quote, and to refuse a name that cannot be quoted losslessly.
 */
function quoteChannel(channel: string): string {
  return `"${channel.replace(/"/g, '""')}"`
}

function assertChannel(channel: string): void {
  if (typeof channel !== 'string' || channel.length === 0) {
    throw new UsageError('pg-prime: db.listen(channel) needs a non-empty channel name.')
  }
  if (channel.includes('\0')) {
    throw new UsageError(
      'pg-prime: a channel name cannot contain a NUL byte — it reaches the wire as a C-string and ' +
        'would be silently truncated.',
    )
  }
  if (new TextEncoder().encode(channel).length > 63) {
    throw new UsageError(
      `pg-prime: channel names are PostgreSQL identifiers and are truncated at 63 bytes; ` +
        `${JSON.stringify(channel)} is longer, so LISTEN and NOTIFY would silently disagree.`,
    )
  }
}

/** The error a transaction profile produces, with the config key that fixes it (`07` §5.3). */
export function listenUnsupported(mode: string): UnsupportedInPoolerModeError {
  return new UnsupportedInPoolerModeError(
    `pg-prime: db.listen() cannot work under poolerMode: '${mode}'. A transaction pooler reassigns ` +
      `the server connection between transactions, so a LISTEN registered on one is delivered to ` +
      `nobody. Add directConnection: '<a URL that bypasses the pooler>' to pgPrime(config) and ` +
      `LISTEN will be routed there automatically — by feature, not by call site (07 §5.3). ` +
      `db.notify() needs none of this: the matrix is asymmetric and NOTIFY works in every mode.`,
  )
}
