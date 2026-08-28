/**
 * The adapter's obligations to the POOL and to the CLIENT OBJECT — design/02 §2.1, §2.3, §5.4, §7.
 *
 * None of this is about SQL, and none of it is reproducible on demand against a live server: it is
 * about which listeners are attached during a checkout, which pool slots come back, and what
 * happens when a cancel request loses a race with the statement it was meant to cancel. So it is
 * driven through `_fake-pg.ts`, which implements the seam over a real `EventEmitter` — an
 * unhandled `'error'` event throws there exactly as it does in production.
 */

import { describe, expect, it } from 'vitest'
import { pgDriver } from '../../src/driver/index.js'
import { describeViaSubmittable } from '../../src/driver/submittable.js'
import type {
  PgDriverErrorData,
  PgLikeClient,
  PgLikeQueryConfig,
  PgLikeResult,
  PgLikeSubmittable,
} from '../../src/driver/index.js'
import { deferred, emptyResult, FakeClient, FakePool, fakeConnection, flush } from './_fake-pg.js'

/** D12: the seam DATA, never the class. */
async function seamError(p: Promise<unknown>): Promise<PgDriverErrorData> {
  try {
    await p
  } catch (e) {
    const d = (e as { pgPrime?: PgDriverErrorData }).pgPrime
    if (!d) throw new Error(`expected a PgDriverError carrying seam data, got: ${String(e)}`)
    return d
  }
  throw new Error('expected a rejection, but it resolved')
}

async function acquired(pool: FakePool): Promise<{
  driver: ReturnType<typeof pgDriver>
  conn: Awaited<ReturnType<ReturnType<typeof pgDriver>['acquire']>>
  client: FakeClient
}> {
  const driver = pgDriver({ pool })
  const conn = await driver.acquire()
  const client = pool.clients[0]!
  return { driver, conn, client }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('a checked-out client must have an `error` listener (§2.2 `usable`)', () => {
  it('a socket error during a checkout is HANDLED, flips `usable`, and disposes on release', async () => {
    const pool = new FakePool()
    const { driver, conn, client } = await acquired(pool)

    // pg-pool removes ITS idle `error` listener at checkout and pg emits `error` unconditionally
    // on a dead socket. With nobody listening this line takes the process down.
    expect(() => client.fail(new Error('read ECONNRESET'))).not.toThrow()

    expect(conn.usable).toBe(false)
    const d = await seamError(conn.execute({ text: 'select 1', params: [] }))
    expect(d.kind).toBe('connection')
    expect(d.connectionUnusable).toBe(true)
    expect(d.message).toBe('read ECONNRESET')
    // …and nothing reached the wire after the socket died
    expect(client.queries.filter((q) => q.text === 'select 1')).toEqual([])

    await driver.release(conn)
    expect(client.releases).toEqual(['destroy'])
    // the listener is OURS only for the checkout: pg-pool's idle listener owns it again after
    expect(client.listenerCount('error')).toBe(0)
    expect(client.listenerCount('notice')).toBe(0)
  })

  it('stream() and describe() refuse to run on a dead connection too', async () => {
    const pool = new FakePool()
    const { conn, client } = await acquired(pool)
    client.fail(new Error('read ECONNRESET'))

    const iterator = conn.stream({ text: 'select 1', params: [] }, 2)[Symbol.asyncIterator]()
    expect((await seamError(iterator.next())).connectionUnusable).toBe(true)
    expect((await seamError(conn.describe!('select 1'))).connectionUnusable).toBe(true)
    expect(client.queries.filter((q) => q.text === 'begin')).toEqual([])
  })
})

describe('acquire() must never leak a pool slot (§2.1)', () => {
  it('an aborted acquire releases the client that arrives afterwards', async () => {
    const pool = new FakePool()
    pool.manual = true
    const driver = pgDriver({ pool })
    const ac = new AbortController()
    const p = driver.acquire({ signal: ac.signal })
    ac.abort()
    expect((await seamError(p)).kind).toBe('cancelled')

    // pool.connect() is NOT cancellable: the client still arrives, and it is ours to hand back.
    const late = pool.settleConnect()
    await flush(5)
    expect(late.releases).toEqual(['destroy'])
  })

  it('a failing first query releases the client and crosses the seam as data', async () => {
    const pool = new FakePool(() => {
      const c = new FakeClient()
      c.respond = () =>
        Promise.reject(
          Object.assign(new Error('permission denied for table pg_settings'), {
            code: '42501',
            severity: 'ERROR',
            message: 'permission denied for table pg_settings',
          }),
        )
      return c
    })
    const driver = pgDriver({ pool })
    const d = await seamError(driver.acquire())
    expect(d.kind).toBe('server')
    expect(d.server?.sqlstate).toBe('42501')
    expect(pool.clients[0]!.releases).toEqual(['destroy'])
  })
})

describe('§4.4 — a pool built with `binary: true` is caught on the first query', () => {
  it('acquire() fails with an adapter error naming the Pool option, and returns the client', async () => {
    const pool = new FakePool(() => {
      const c = new FakeClient()
      c.gucFieldFormat = 'binary'
      return c
    })
    const driver = pgDriver({ pool })
    const d = await seamError(driver.acquire())
    expect(d.kind).toBe('adapter')
    expect(d.message).toMatch(/binary/)
    expect(pool.clients[0]!.releases).toEqual(['destroy'])
  })
})

describe('§2.3 — a cancel belongs to ONE statement', () => {
  it('a cancel whose spare connection arrives too late is NOT sent', async () => {
    const pool = new FakePool()
    const { conn, client } = await acquired(pool)
    const statement = deferred<PgLikeResult>()
    client.respond = (q) => (q.text === 'select pg_sleep(9)' ? statement.promise : undefined)

    const ac = new AbortController()
    const p = conn.execute({ text: 'select pg_sleep(9)', params: [], signal: ac.signal })
    pool.manual = true // the pool is now exhausted: the cancel has to wait for a spare
    ac.abort()
    await flush(5)
    expect(pool.pendingConnects).toBe(1)

    // the statement finishes on its own, and the connection goes back to the pool…
    statement.resolve(emptyResult('SELECT'))
    await p
    // …and only THEN does the spare connection turn up. Sending pg_cancel_backend(pid) now would
    // kill whatever the recycled backend is running for somebody else.
    const spare = pool.settleConnect()
    await flush(10)
    expect(spare.queries).toEqual([])
    expect(spare.releases).toEqual(['reuse'])
  })

  it('a cancel that cannot be delivered fails the statement instead of hanging it', async () => {
    const pool = new FakePool()
    const { driver, conn, client } = await acquired(pool)
    const statement = deferred<PgLikeResult>()
    client.respond = (q) => (q.text === 'select pg_sleep(9)' ? statement.promise : undefined)

    const ac = new AbortController()
    const p = conn.execute({ text: 'select pg_sleep(9)', params: [], signal: ac.signal })
    pool.manual = true // …and nothing will ever settle this connect
    ac.abort()

    const d = await seamError(p) // would hang forever before: the query promise never settles
    expect(d.kind).toBe('cancelled')
    expect(d.cancelError).toMatch(/pool is exhausted/)
    expect(d.connectionUnusable).toBe(true)
    expect(conn.usable).toBe(false)
    await driver.release(conn)
    expect(client.releases).toEqual(['destroy'])
  }, 20_000)

  it('createCancelClient sends a protocol CancelRequest and borrows NO pooled connection', async () => {
    const pool = new FakePool()
    const seen: { client: unknown; query: unknown }[] = []
    const driver = pgDriver({
      pool,
      createCancelClient: () => ({
        cancel: (client, query) => void seen.push({ client, query }),
      }),
    })
    expect(driver.capabilities.cancel).toBe('protocol')

    const conn = await driver.acquire()
    const client = pool.clients[0]!
    const statement = deferred<PgLikeResult>()
    client.respond = (q) => (q.text === 'select pg_sleep(9)' ? statement.promise : undefined)

    const ac = new AbortController()
    const p = conn.execute({ text: 'select pg_sleep(9)', params: [], signal: ac.signal })
    ac.abort()
    await flush(5)

    expect(seen).toHaveLength(1)
    expect(seen[0]!.client).toBe(client)
    expect(seen[0]!.query).toBe(client.activeQuery)
    expect(pool.connectCalls).toBe(1) // the acquire, and nothing else
    statement.resolve(emptyResult())
    await p
  })

  it('cancel() with nothing in flight is a no-op (§2.2)', async () => {
    const pool = new FakePool()
    const { conn } = await acquired(pool)
    await conn.cancel!()
    expect(pool.connectCalls).toBe(1)
  })
})

describe('§5.4 — a client-side timeout leaves the statement running on that socket', () => {
  it('marks the connection unusable and reports connectionUnusable, so release() disposes it', async () => {
    const pool = new FakePool()
    const { driver, conn, client } = await acquired(pool)
    // pg's `query_timeout` give-up, verbatim (pg/lib/client.js).
    client.respond = (q) =>
      q.text === 'select pg_sleep(9)' ? Promise.reject(new Error('Query read timeout')) : undefined

    const d = await seamError(
      conn.execute({ text: 'select pg_sleep(9)', params: [], timeoutMs: 50 }),
    )
    expect(d.kind).toBe('timeout')
    expect(d.connectionUnusable).toBe(true)
    expect(conn.usable).toBe(false)

    await driver.release(conn) // no `dispose: true` from the caller — the adapter knows
    expect(client.releases).toEqual(['destroy'])
  })

  it('a SOCKET death on a query that merely HAD a timeout is not a timeout', async () => {
    const pool = new FakePool()
    const { conn, client } = await acquired(pool)
    client.respond = (q) =>
      q.text === 'select 1'
        ? Promise.reject(new Error('Connection terminated unexpectedly'))
        : undefined

    const d = await seamError(conn.execute({ text: 'select 1', params: [], timeoutMs: 5000 }))
    expect(d.kind).toBe('connection')
    expect(d.connectionUnusable).toBe(true)
  })
})

describe('release() (§2.1)', () => {
  it('disposes a connection left inside a transaction rather than lending it out', async () => {
    for (const status of ['T', 'E'] as const) {
      const pool = new FakePool()
      const { driver, conn, client } = await acquired(pool)
      client.txStatus = status
      await driver.release(conn)
      expect(client.releases).toEqual(['destroy'])
    }
  })

  it('reuses an idle one', async () => {
    const pool = new FakePool()
    const { driver, conn, client } = await acquired(pool)
    await driver.release(conn)
    expect(client.releases).toEqual(['reuse'])
  })
})

describe('inputs are validated before they reach the wire', () => {
  it('a statement name with an embedded NUL is refused (it would TRUNCATE the C-string)', async () => {
    const pool = new FakePool()
    const { conn, client } = await acquired(pool)
    const d = await seamError(
      conn.execute({
        text: 'select 1',
        params: [],
        mode: 'named',
        statementName: 'ps evil',
      }),
    )
    expect(d.kind).toBe('adapter')
    expect(client.queries.filter((q) => q.text === 'select 1')).toEqual([])
    expect((await seamError(conn.closeStatement!('ps evil'))).kind).toBe('adapter')
    // …and a legal name still works
    await conn.execute({ text: 'select 1', params: [], mode: 'named', statementName: 'ps_ok_1' })
    expect(client.queries.at(-1)!.config.name).toBe('ps_ok_1')
  })

  it('paramTypes must match params in length, or be empty (§2.3)', async () => {
    const pool = new FakePool()
    const { conn, client } = await acquired(pool)
    const d = await seamError(
      conn.execute({ text: 'select $1', params: ['a'], paramTypes: [23, 25] }),
    )
    expect(d.kind).toBe('adapter')
    expect(client.queries.filter((q) => q.text === 'select $1')).toEqual([])
    // the two legal shapes
    await conn.execute({ text: 'select $1', params: ['a'], paramTypes: [23] })
    await conn.execute({ text: 'select $1', params: ['a'] })
    expect(client.queries.filter((q) => q.text === 'select $1')).toHaveLength(2)
  })

  it('describe() honours options.signal — the Parse never leaves', async () => {
    const pool = new FakePool()
    const { conn, client } = await acquired(pool)
    const d = await seamError(conn.describe!('select 1', { signal: AbortSignal.abort() }))
    expect(d.kind).toBe('cancelled')
    expect(client.submittables).toEqual([]) // nothing was handed to the client at all
  })
})

describe('notices belong to the statement that produced them (§7)', () => {
  it('a queued second execute() does not collect the first statement’s notices', async () => {
    const pool = new FakePool()
    const { conn, client } = await acquired(pool)
    const first = deferred<PgLikeResult>()
    const second = deferred<PgLikeResult>()
    client.respond = (q) =>
      q.text === 'first' ? first.promise : q.text === 'second' ? second.promise : undefined

    const p1 = conn.execute({ text: 'first', params: [] })
    const p2 = conn.execute({ text: 'second', params: [] })
    await flush(5)

    client.notice('from the first statement')
    first.resolve(emptyResult())
    await p1
    await flush(5)
    client.notice('from the second statement')
    second.resolve(emptyResult())

    expect((await p1).notices.map((n) => n.message)).toEqual(['from the first statement'])
    expect((await p2).notices.map((n) => n.message)).toEqual(['from the second statement'])
  })

  it('an EmptyQueryResponse reports command as "" — the seam promises a string', async () => {
    const pool = new FakePool()
    const { conn, client } = await acquired(pool)
    client.respond = (q) =>
      q.text === ' '
        ? Promise.resolve({ rows: [], fields: [], rowCount: null, command: null })
        : undefined
    const r = await conn.execute({ text: ' ', params: [] })
    expect(r.command).toBe('')
    expect(r.rowCount).toBe(null)
  })
})

describe('stream() cannot manage a transaction it cannot see (§2.2, amendment ③)', () => {
  it('refuses when the client does not report transactionStatus, instead of BEGIN/COMMITting blindly', async () => {
    const pool = new FakePool(() => new FakeClient({ reportsTransactionStatus: false }))
    const { conn, client } = await acquired(pool)
    const iterator = conn.stream({ text: 'select 1', params: [] }, 2)[Symbol.asyncIterator]()
    const d = await seamError(iterator.next())
    expect(d.kind).toBe('adapter')
    expect(d.message).toMatch(/getTransactionStatus/)
    // the caller's session was NOT touched
    expect(
      client.queries.map((q) => q.text).filter((t) => t === 'begin' || t === 'commit'),
    ).toEqual([])
  })

  it('refuses a second overlapping stream on the same connection', async () => {
    const pool = new FakePool()
    const { conn, client } = await acquired(pool)
    client.respond = (q) =>
      q.text.startsWith('fetch')
        ? Promise.resolve({ rows: [['1'], ['2']], fields: [], rowCount: 2, command: 'FETCH' })
        : undefined

    const outer = conn.stream({ text: 'select 1', params: [] }, 2)[Symbol.asyncIterator]()
    await outer.next() // now mid-stream, inside our own transaction
    const inner = conn.stream({ text: 'select 2', params: [] }, 2)[Symbol.asyncIterator]()
    const d = await seamError(inner.next())
    expect(d.kind).toBe('adapter')
    expect(d.message).toMatch(/already has an open stream/)
    await outer.return!(undefined)
  })

  it('forwards signal and timeoutMs to the DECLARE and every FETCH', async () => {
    const pool = new FakePool()
    const { conn, client } = await acquired(pool)
    for await (const _chunk of conn.stream({ text: 'select 1', params: [], timeoutMs: 1234 }, 2)) {
      break
    }
    const declare = client.queries.find((q) => q.text.startsWith('declare'))!
    const fetch = client.queries.find((q) => q.text.startsWith('fetch'))!
    expect(declare.config.query_timeout).toBe(1234)
    expect(fetch.config.query_timeout).toBe(1234)
  })
})

describe('destroy() is idempotent and safe (§2.1)', () => {
  it('tolerates a pool the caller already ended', async () => {
    const pool = new FakePool()
    const driver = pgDriver({ pool })
    await driver.acquire()
    pool.endThrows = true
    await expect(driver.destroy()).resolves.toBeUndefined()
    await expect(driver.destroy()).resolves.toBeUndefined()
    expect(pool.clients[0]!.releases).toEqual(['destroy'])
    expect(pool.clients[0]!.listenerCount('error')).toBe(0)
  })
})

describe('§5.2 — a Submittable must call pg’s callback, or leak its query_timeout timer', () => {
  /** Exactly what `pg/lib/client.js` does when the client carries `query_timeout`. */
  function armPgTimeout(sub: PgLikeSubmittable): () => boolean {
    let fired = false
    const timer = setTimeout(() => {
      fired = true
    }, 5)
    const previous = sub.callback
    sub.callback = (err, res) => {
      clearTimeout(timer)
      previous?.(err, res)
    }
    return () => fired
  }

  function capturingClient(captured: PgLikeSubmittable[]): PgLikeClient {
    return {
      query: ((arg: PgLikeQueryConfig | PgLikeSubmittable) => {
        captured.push(arg as PgLikeSubmittable)
        return arg
      }) as PgLikeClient['query'],
      on: () => undefined,
      removeListener: () => undefined,
    }
  }

  it('describe() clears the timer on success and on failure', async () => {
    for (const settle of ['ok', 'error'] as const) {
      const captured: PgLikeSubmittable[] = []
      const p = describeViaSubmittable(capturingClient(captured), 'select 1')
      const sub = captured[0]!
      const fired = armPgTimeout(sub)
      const conn = fakeConnection()
      if (settle === 'ok') sub.handleReadyForQuery(conn)
      else sub.handleError(new Error('boom'), conn)
      await p.catch(() => {})
      await new Promise((r) => setTimeout(r, 20))
      expect(fired()).toBe(false)
    }
  })

  it('NEGATIVE CONTROL: a Submittable that never settles does leak the timer', async () => {
    const captured: PgLikeSubmittable[] = []
    void describeViaSubmittable(capturingClient(captured), 'select 1').catch(() => {})
    const fired = armPgTimeout(captured[0]!)
    await new Promise((r) => setTimeout(r, 20))
    expect(fired()).toBe(true)
  })
})
