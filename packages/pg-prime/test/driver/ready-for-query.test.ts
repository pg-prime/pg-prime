/**
 * `transactionStatus` is post-statement after an awaited `execute()`, even a rejected one
 * (design/02 §2.2 seam; design/09 §3.6 follow-up).
 *
 * The oracle is pg's own message order, read off `pg@8.23.0/lib/client.js`: `_handleErrorMessage`
 * calls the query's `handleError` — which rejects the promise — and `_handleReadyForQuery` is what
 * sets `_txStatus` and `readyForQuery = true`. Whether the caller's continuation runs between the
 * two depends on whether the two messages arrived in one TCP read. CI run 33059095233 was the
 * first time they did not. `FakeClient` replays that order with the messages deliberately split
 * across a macrotask, so the test fails on the *slow* path every time rather than once in five.
 *
 * R4: the negative control is a drop-in client without `readyForQuery`, which the adapter cannot
 * hold and does not pretend to.
 */

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { pgDriver } from '../../src/driver/index.js'
import type { PgDriverErrorData, PgLikeConnection } from '../../src/driver/index.js'
import { FakeClient, FakePool, fakeConnection } from './_fake-pg.js'

/** A server ErrorResponse as pg surfaces it: `code` + `severity` is what `isServerErrorShape` reads. */
function divisionByZero(): Error & { code: string; severity: string } {
  return Object.assign(new Error('division by zero'), { code: '22012', severity: 'ERROR' })
}

/** pg's `Client#connection` for one purpose: it emits `readyForQuery`. */
function emittingConnection(): PgLikeConnection & { emitReady(): void } {
  const events = new EventEmitter()
  return {
    ...fakeConnection(),
    on: (event, listener) => events.on(event, listener as (...args: unknown[]) => void),
    removeListener: (event, listener) =>
      events.removeListener(event, listener as (...args: unknown[]) => void),
    emitReady: () => {
      events.emit('readyForQuery', { status: 'E' })
    },
  }
}

/** `FakeClient` plus the two members pg has and the seam reads: `readyForQuery`, `connection`. */
class SequencedClient extends FakeClient {
  readyForQuery: boolean | undefined
  readonly connection = emittingConnection()

  constructor(reportsReadyForQuery: boolean) {
    super()
    this.readyForQuery = reportsReadyForQuery ? true : undefined
  }

  /** ErrorResponse now; ReadyForQuery (with the new status) on a later macrotask. */
  failThenReady(status: 'I' | 'T' | 'E'): void {
    this.respond = () => {
      if (this.readyForQuery !== undefined) this.readyForQuery = false
      setTimeout(() => {
        this.txStatus = status
        if (this.readyForQuery !== undefined) this.readyForQuery = true
        this.connection.emitReady()
      }, 0)
      return Promise.reject(divisionByZero())
    }
  }
}

async function checkout(client: SequencedClient) {
  const pool = new FakePool(() => client)
  const driver = pgDriver({ pool })
  await driver.init()
  const conn = await driver.acquire()
  return { driver, conn }
}

function seam(e: unknown): PgDriverErrorData {
  const d = (e as { pgPrime?: PgDriverErrorData }).pgPrime
  if (!d) throw new Error(`expected a PgDriverError, got ${String(e)}`)
  return d
}

describe('a server-error rejection is held until ReadyForQuery', () => {
  it("reads 'E' after `await execute().catch()`, even when ErrorResponse and ReadyForQuery are split", async () => {
    const client = new SequencedClient(true)
    client.txStatus = 'T'
    const { driver, conn } = await checkout(client)
    client.failThenReady('E')

    let caught: unknown
    await conn.execute({ text: 'select 1/0', params: [] }).catch((e: unknown) => {
      caught = e
    })
    expect(seam(caught).server?.sqlstate).toBe('22012')
    // The whole point: pg had not yet processed ReadyForQuery when it rejected, and the caller
    // still sees the post-statement status.
    expect(conn.transactionStatus).toBe('E')
    // …and the temporary listeners are gone (the checkout's own `error` listener remains).
    expect(client.listenerCount('end')).toBe(0)
    expect(client.listenerCount('error')).toBe(1)
    await driver.release(conn)
  })

  it('R4 negative control: a drop-in without `readyForQuery` is not held, and reads the stale status', async () => {
    const client = new SequencedClient(false)
    client.txStatus = 'T'
    const { driver, conn } = await checkout(client)
    client.failThenReady('E')

    await conn.execute({ text: 'select 1/0', params: [] }).catch(() => {})
    expect(conn.transactionStatus).toBe('T')
    await new Promise((r) => setTimeout(r, 1))
    expect(conn.transactionStatus).toBe('E')
    await driver.release(conn)
  })

  it('a socket that dies while held releases the rejection instead of hanging it', async () => {
    const client = new SequencedClient(true)
    client.txStatus = 'T'
    const { driver, conn } = await checkout(client)
    client.respond = () => {
      client.readyForQuery = false
      setTimeout(() => client.end(), 0)
      return Promise.reject(divisionByZero())
    }

    let caught: unknown
    await conn.execute({ text: 'select 1/0', params: [] }).catch((e: unknown) => {
      caught = e
    })
    expect(seam(caught).server?.sqlstate).toBe('22012')
    await driver.release(conn)
  })

  it('a non-server error is never held — there is no ReadyForQuery coming for it', async () => {
    const client = new SequencedClient(true)
    const { driver, conn } = await checkout(client)
    client.respond = () => {
      client.readyForQuery = false
      // No ReadyForQuery is ever emitted. If the adapter held this, the test would time out.
      return Promise.reject(new Error('read ECONNRESET'))
    }
    let caught: unknown
    await conn.execute({ text: 'select 1', params: [] }).catch((e: unknown) => {
      caught = e
    })
    expect(seam(caught).server).toBeUndefined()
    await driver.release(conn)
  })
})
