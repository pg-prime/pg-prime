/**
 * How the adapter drives `createCancelClient` — design/02 §5.4; design/13 §5, E's F2.
 *
 * The end-to-end half is `test/pg/session.test.ts` ("the protocol CancelRequest"), which asserts on
 * `pg_stat_activity` that the request really stopped a backend. What a real server cannot show is
 * *which properties of the client object were touched on the way*, and that is the whole point
 * here: `pg` 8.23 deprecated `Client.activeQuery`, `Client.prototype.cancel(client, query)` reads
 * it off the target no matter what you pass, and it is gone in `pg@9`. So the adapter sends the
 * `CancelRequest` itself when the canceller is shaped like a `pg.Client`, and falls back to
 * `cancel(client, query)` when it is not.
 *
 * `FakeClient.activeQuery` is an accessor that counts reads, which turns "does not touch the
 * deprecated property" into an assertion rather than a comment.
 */

import { describe, expect, it } from 'vitest'
import { pgDriver } from '../../src/driver/index.js'
import type {
  PgLikeCancelClient,
  PgLikeClient,
  PgLikeConnection,
  PgLikeResult,
} from '../../src/driver/index.js'
import type { PgConnection } from '../../src/driver/index.js'
import { deferred, FakeClient, FakePool, fakeConnection, flush } from './_fake-pg.js'

/**
 * `PgDriver`'s `cancel` is optional (design/02 §2.2: an adapter may not be able to). The pg
 * adapter always implements it, and asserting that here is what keeps `?.()` from turning a
 * deleted method into four silently passing tests.
 */
async function cancel(conn: PgConnection): Promise<void> {
  expect(conn.cancel, 'the pg adapter implements PgConnection.cancel()').toBeTypeOf('function')
  await conn.cancel?.()
}

/** A `pg.Client`-shaped canceller, with every part `sendCancelRequest` feature-tests spied. */
class FakeCanceller implements PgLikeCancelClient {
  /** `[processID, secretKey]` per protocol CancelRequest written. */
  readonly sent: [number, number][] = []
  /** What `connect()` was called with — `(port, host)` or a unix socket path. */
  readonly connected: (readonly [number | string, string | undefined])[] = []
  /** Calls that took the DEPRECATED `cancel(client, query)` route instead. */
  readonly legacy: unknown[] = []
  // Optional, not `| undefined`: the seam is `exactOptionalPropertyTypes`, and "a shim with no
  // Connection" means the property is ABSENT — which is also what the feature test asks.
  readonly connection?: PgLikeConnection
  readonly host: string
  readonly port: number
  #listeners = new Map<string, ((...args: unknown[]) => void)[]>()

  constructor(opts?: { readonly parts?: boolean; readonly host?: string; readonly port?: number }) {
    this.host = opts?.host ?? '127.0.0.1'
    this.port = opts?.port ?? 5432
    if (opts?.parts === false) return
    const base = fakeConnection()
    const on = (event: string, listener: (...args: unknown[]) => void): unknown => {
      const list = this.#listeners.get(event) ?? []
      list.push(listener)
      this.#listeners.set(event, list)
      return undefined
    }
    this.connection = {
      ...base,
      on,
      connect: (portOrPath: number | string, host?: string): void => {
        this.connected.push([portOrPath, host])
        this.#emit('connect')
      },
      cancel: (processID: number, secretKey: number): void => {
        this.sent.push([processID, secretKey])
      },
    }
  }

  /** Whatever a real socket would emit — used to prove a failed cancel is not an uncaught event. */
  emitConnectionError(err: Error): void {
    this.#emit('error', err)
  }

  #emit(event: string, ...args: unknown[]): void {
    const list = this.#listeners.get(event) ?? []
    if (list.length === 0 && event === 'error') {
      // Node's own semantics, so a missing listener fails here the way it fails in production.
      throw err(args)
    }
    for (const l of list) l(...args)
  }

  cancel(_client: PgLikeClient, query?: unknown): void {
    this.legacy.push(query)
  }
}

function err(args: unknown[]): Error {
  const e = args[0]
  return e instanceof Error ? e : new Error(`unhandled 'error' event: ${String(e)}`)
}

/** A driver whose single connection has one statement stuck on the wire, ready to be cancelled. */
async function inFlight(canceller: FakeCanceller): Promise<{
  driver: ReturnType<typeof pgDriver>
  conn: Awaited<ReturnType<ReturnType<typeof pgDriver>['acquire']>>
  client: FakeClient
  settle: () => void
}> {
  const pool = new FakePool()
  const driver = pgDriver({ pool, createCancelClient: () => canceller })
  const conn = await driver.acquire()
  const client = pool.clients[0]!
  const stuck = deferred<PgLikeResult>()
  client.respond = (q) => (q.text === 'select pg_sleep(9)' ? stuck.promise : undefined)
  // Not awaited: it is the statement being cancelled.
  void conn.execute({ text: 'select pg_sleep(9)', params: [] }).catch(() => undefined)
  await flush()
  return {
    driver,
    conn,
    client,
    settle: () => stuck.resolve({ rows: [], fields: [], rowCount: 0, command: 'SELECT' }),
  }
}

describe('the protocol CancelRequest path (02 §5.4)', () => {
  it('writes the target backend key itself and never reads the deprecated activeQuery', async () => {
    const canceller = new FakeCanceller()
    const { driver, conn, client, settle } = await inFlight(canceller)

    await cancel(conn)

    expect(canceller.connected).toStrictEqual([[5432, '127.0.0.1']])
    expect(canceller.sent).toStrictEqual([[client.processID, client.secretKey]])
    // The two claims this file exists for.
    expect(canceller.legacy).toStrictEqual([])
    expect(client.activeQueryReads).toBe(0)

    settle()
    await driver.destroy()
  })

  it("uses pg's own unix-socket spelling when the host is a directory", async () => {
    const canceller = new FakeCanceller({ host: '/var/run/postgresql', port: 5433 })
    const { driver, conn, settle } = await inFlight(canceller)

    await cancel(conn)
    expect(canceller.connected).toStrictEqual([['/var/run/postgresql/.s.PGSQL.5433', undefined]])

    settle()
    await driver.destroy()
  })

  it('a cancel socket that fails is not an unhandled `error` event', async () => {
    const canceller = new FakeCanceller()
    const { driver, conn, settle } = await inFlight(canceller)

    await cancel(conn)
    // `pg`'s own `Client#cancel` attaches nothing here, so this line is a process exit there.
    expect(() => canceller.emitConnectionError(new Error('connect ECONNREFUSED'))).not.toThrow()

    settle()
    await driver.destroy()
  })

  it('falls back to cancel(client, query) for a canceller that is not shaped like pg.Client', async () => {
    const canceller = new FakeCanceller({ parts: false })
    const { driver, conn, client, settle } = await inFlight(canceller)

    await cancel(conn)
    expect(canceller.sent).toStrictEqual([])
    expect(canceller.legacy).toHaveLength(1)
    // The fallback is the ONE place the property is still read, and only for a non-pg drop-in
    // whose own property is not necessarily deprecated.
    expect(client.activeQueryReads).toBe(1)

    settle()
    await driver.destroy()
  })

  it('does not send anything when the statement finished while we were getting ready', async () => {
    const canceller = new FakeCanceller()
    const pool = new FakePool()
    const driver = pgDriver({ pool, createCancelClient: () => canceller })
    const conn = await driver.acquire()
    // Nothing on the wire: `cancel()` is a documented no-op (§2.2), and a CancelRequest sent now
    // would land on whatever this backend runs next.
    await cancel(conn)
    expect(canceller.sent).toStrictEqual([])
    expect(canceller.legacy).toStrictEqual([])
    await driver.destroy()
  })
})
