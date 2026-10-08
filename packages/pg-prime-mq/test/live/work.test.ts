import { describe, expect, it } from 'vitest'
import { ConfigError, IndeterminateCommitError, UsageError, sql } from 'pg-prime'
import type { Db } from 'pg-prime'
import {
  CancelledError,
  LeaseLostError,
  MessageFailedError,
  NonRetryableError,
  defineQueue,
  pgMq,
} from '../../src/index.js'
import type { Message, MqHooks, QueueDef, SettleOutcome } from '../../src/index.js'
import { freshSchema, racing, sleep, until, useServer } from '../_db.js'

const server = useServer()
type P = { n: number }
const fast = { pollMs: 20, expireScanMs: 20, maintenanceMs: 20 }
const quick = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 }

function setup<R = number>(opts: Parameters<typeof defineQueue<P, R>>[1] = {}, hooks?: MqHooks) {
  const db = server.db()
  const schema = freshSchema()
  const jobs: QueueDef<P, R> = defineQueue<P, R>('jobs', { retry: quick, ...opts })
  const outcomes: SettleOutcome[] = []
  const mq = pgMq({ db, schema, define: { jobs }, ...(hooks === undefined ? {} : { hooks }) })
  mq.observe({ onSettle: (e) => void outcomes.push(e.outcome) })
  return { db, schema, mq, q: mq.queues.jobs, outcomes }
}

const row = async (db: Db, schema: string, id: bigint) =>
  (await db.sql`select * from ${sql.ident(schema, 'messages')} where id = ${id}`.execute())[0]

describe('settle paths', () => {
  it('a resolved handler completes with its result (T5)', async () => {
    const { q, outcomes } = setup()
    const ref = await q.send({ n: 2 })
    const w = q.work(async (m, ctx) => {
      expect(ctx.attempt).toBe(1)
      return m.payload.n * 10
    }, fast)
    await until(async () => (await q.get(ref))?.state === 'completed')
    await w.close()
    const m = await q.get(ref)
    expect([m?.result, m?.attempts, m?.claims, outcomes]).toStrictEqual([20, 1, 1, ['completed']])
  })

  it('a throw retries with backoff, then completes (T6)', async () => {
    const { q, outcomes } = setup()
    const ref = await q.send({ n: 1 })
    const w = q.work(async (_m, ctx) => {
      if (ctx.attempt < 3) throw new Error(`boom ${ctx.attempt}`)
      return 1
    }, fast)
    await until(async () => (await q.get(ref))?.state === 'completed')
    await w.close()
    expect(outcomes).toStrictEqual(['retry', 'retry', 'completed'])
    expect((await q.get(ref))?.attempts).toBe(3)
  })

  it('the last attempt, a NonRetryableError or shouldRetry false fails it (T7)', async () => {
    const { q } = setup({ retry: { ...quick, shouldRetry: (e) => !String(e).includes('stop') } })
    const a = await q.send({ n: 1 })
    const b = await q.send({ n: 2 })
    const c = await q.send({ n: 3 })
    const runs = new Map<number, number>()
    const w = q.work(async (m) => {
      runs.set(m.payload.n, (runs.get(m.payload.n) ?? 0) + 1)
      if (m.payload.n === 2) throw new NonRetryableError('no')
      throw new Error(m.payload.n === 3 ? 'stop' : 'again')
    }, fast)
    await until(async () => (await q.counts()).failed === 3)
    await w.close()
    expect([...runs.entries()].sort()).toStrictEqual([
      [1, 3],
      [2, 1],
      [3, 1],
    ])
    expect((await q.get(a))?.error).toBe('again')
    expect((await q.get(b))?.error).toBe('no')
    expect((await q.get(c))?.attempts).toBe(1)
  })

  it('defer and rateLimit move the message without counting an attempt (T8, T9)', async () => {
    const { db, schema, q, outcomes } = setup()
    const ref = await q.send({ n: 1 })
    let runs = 0
    const w = q.work(async (_m, ctx) => {
      runs++
      if (runs === 1) return ctx.defer({ delayMs: 30 })
      if (runs === 2) return ctx.rateLimit(100)
      return runs
    }, fast)
    await until(async () => (await q.get(ref))?.state === 'completed')
    await w.close()
    expect(outcomes).toStrictEqual(['deferred', 'deferred', 'completed'])
    const m = await q.get(ref)
    expect([m?.attempts, m?.claims, m?.result]).toStrictEqual([1, 1, 3])
    const [qr] = await db.sql`select limited_until from ${sql.ident(schema, 'queues')}`.execute()
    expect(qr?.['limited_until']).toBeInstanceOf(Date)
  })

  it('a decode failure fails the message at once', async () => {
    const { mq } = setup()
    const strict = defineQueue<number>('strict', {
      schema: {
        '~standard': {
          version: 1,
          vendor: 't',
          validate: (v) =>
            typeof v === 'number' ? { value: v } : { issues: [{ message: 'nan' }] },
        },
      },
    })
    const loose = mq.queue(defineQueue<unknown>('strict'))
    const ref = await loose.send('text')
    const w = mq.queue(strict).work(async () => {}, fast)
    await until(async () => (await loose.get(ref))?.state === 'failed')
    await w.close()
    expect((await loose.get(ref))?.error).toMatch(/nan/)
  })
})

describe('leases', () => {
  it('an expired lease is a failed attempt; the old token is rejected (T11)', async () => {
    const expired: bigint[][] = []
    const { q } = setup({}, { onLeaseExpired: (e) => void expired.push([...e.ids]) })
    const ref = await q.send({ n: 1 })
    const [m] = await q.claim({ leaseMs: 30 })
    await sleep(50)
    const seen: number[] = []
    const w = q.work(async (x, ctx) => (seen.push(ctx.attempt), x.payload.n), fast)
    await until(async () => (await q.get(ref))?.state === 'completed')
    await w.close()
    expect(seen).toStrictEqual([2])
    expect(expired).toStrictEqual([[ref.id]])
    await expect(q.complete(m as Message<P>, 1)).rejects.toBeInstanceOf(LeaseLostError)
  })

  it('an expired final attempt fails with lease-expired and releases its dedup key', async () => {
    const { q } = setup({ retry: { maxAttempts: 1 } })
    const ref = await q.send({ n: 1 }, { key: 'k', dedup: 'until-done' })
    await q.claim({ leaseMs: 20 })
    await sleep(40)
    const w = q.work(async () => 0, fast)
    await until(async () => (await q.get(ref))?.state === 'failed')
    await w.close()
    expect((await q.get(ref))?.error).toBe('lease-expired')
    expect((await q.send({ n: 2 }, { key: 'k', dedup: 'until-done' })).deduplicated).toBe(false)
  })

  it('manual claim, extend, fail and complete', async () => {
    const { q } = setup({ retry: { baseDelayMs: 0 } })
    const ref = await q.send({ n: 1 })
    const [m] = (await q.claim({ leaseMs: 1000, token: 'mine' })) as [Message<P>]
    expect(m.token).toBe('mine')
    await q.extend(m, 5000)
    await q.fail(m, new Error('first'))
    expect((await q.get(ref))?.state).toBe('ready')
    const [again] = (await q.claim()) as [Message<P>]
    await q.complete(again, 7)
    expect((await q.get(ref))?.result).toBe(7)
    await expect(q.fail(again, new Error('late'))).rejects.toBeInstanceOf(LeaseLostError)
  })

  it('a manual claim recovers expired leases first', async () => {
    const { db, schema, q } = setup({ retry: { baseDelayMs: 0 } })
    const ref = await q.send({ n: 1 })
    await q.claim({ leaseMs: 20 })
    await sleep(40)
    // As if the last scan were long ago.
    await db.sql`update ${sql.ident(schema, 'queues')} set expire_at = '-infinity'`.execute()
    const [m] = await q.claim()
    expect([m?.id, m?.attempts]).toStrictEqual([ref.id, 1])
  })

  it('progress is stored while the lease is held', async () => {
    const { q } = setup()
    const ref = await q.send({ n: 1 })
    const w = q.work(async (_m, ctx) => {
      await ctx.progress({ pct: 50 })
      return 1
    }, fast)
    await until(async () => (await q.get(ref))?.state === 'completed')
    await w.close()
    expect((await q.get(ref))?.progress).toStrictEqual({ pct: 50 })
  })
})

describe('transactions', () => {
  async function sink(db: Db, schema: string) {
    const t = sql.ident(schema, 'sink')
    await db.sql`create table ${t} (n int)`.execute()
    return {
      t,
      rows: async () => (await db.sql`select n from ${t} order by n`.execute()).map((r) => r['n']),
    }
  }

  it('ctx.transaction commits the handler’s writes with the completion', async () => {
    const { db, schema, mq, q } = setup()
    await mq.start()
    const s = await sink(db, schema)
    const ref = await q.send({ n: 5 })
    let first = true
    const w = q.work(
      (m, ctx) =>
        ctx.transaction(async (tx) => {
          await tx.sql`insert into ${s.t} values (${m.payload.n})`.execute()
          if (first) {
            first = false
            throw new Error('rolled back')
          }
          return m.payload.n
        }),
      fast,
    )
    await until(async () => (await q.get(ref))?.state === 'completed')
    await w.close()
    expect(await s.rows()).toStrictEqual([5])
    expect((await q.get(ref))?.attempts).toBe(2)
  })

  it('a stale token inside the transaction rolls back the app row', async () => {
    const { db, schema, mq, q } = setup()
    await mq.start()
    const s = await sink(db, schema)
    await q.send({ n: 1 })
    const [m] = (await q.claim()) as [Message<P>]
    await db.sql`update ${sql.ident(schema, 'messages')} set token = 'thief'`.execute()
    await expect(
      db.transaction(async (tx) => {
        await tx.sql`insert into ${s.t} values (1)`.execute()
        await q.complete(m, 1, { tx })
      }),
    ).rejects.toBeInstanceOf(LeaseLostError)
    expect(await s.rows()).toStrictEqual([])
  })

  it('a transactional settle is refused on a queue with a global concurrency', async () => {
    const { db, mq } = setup()
    const capped = mq.queue(defineQueue<P>('capped', { concurrency: 2 }))
    await capped.start()
    await capped.sendMany([{ payload: { n: 1 } }, { payload: { n: 2 } }])
    const [m] = (await capped.claim()) as [Message<P>]
    await expect(
      db.transaction((tx) => capped.complete(m, undefined, { tx })),
    ).rejects.toBeInstanceOf(UsageError)
    await expect(
      db.transaction((tx) => capped.fail(m, new Error('x'), { tx })),
    ).rejects.toBeInstanceOf(UsageError)
    expect((await capped.get(m.id))?.state).toBe('active')
    let caught: unknown
    const w = capped.work(async (_x, ctx) => {
      try {
        await db.transaction((tx) => ctx.complete(undefined, { tx }))
      } catch (e) {
        caught = e
      }
    }, fast)
    await until(() => caught !== undefined, 5000)
    await w.close()
    expect(caught).toBeInstanceOf(UsageError)
  })

  it('an indeterminate in-tx completion is re-read: committed is done, rolled back is a failed attempt', async () => {
    const errors: string[] = []
    const { db, schema, mq, q, outcomes } = setup(
      {},
      {
        onSettle: (e) => void (e.outcome === 'retry' && errors.push(String(e.error))),
      },
    )
    await mq.start()
    const s = await sink(db, schema)
    const committed = await q.send({ n: 1 })
    const rolledBack = await q.send({ n: 2 })
    const lie = () => new IndeterminateCommitError('lost during COMMIT', { context: {} })
    const runs: number[] = []
    const w = q.work(async (m, ctx) => {
      runs.push(m.payload.n)
      if (m.payload.n === 1) {
        await ctx.transaction(
          async (tx) => (await tx.sql`insert into ${s.t} values (1)`.execute(), 1),
        )
        throw lie()
      }
      if (runs.filter((n) => n === 2).length === 1) {
        await db
          .transaction(async (tx) => {
            await tx.sql`insert into ${s.t} values (2)`.execute()
            await ctx.complete(2, { tx })
            tx.rollback()
          })
          .catch(() => {})
        throw lie()
      }
      return ctx.transaction(
        async (tx) => (await tx.sql`insert into ${s.t} values (2)`.execute(), 2),
      )
    }, fast)
    await until(async () => (await q.counts()).completed === 2)
    await w.close()
    expect(runs.sort()).toStrictEqual([1, 2, 2])
    expect(await s.rows()).toStrictEqual([1, 2])
    expect((await q.get(committed))?.attempts).toBe(1)
    expect((await q.get(rolledBack))?.attempts).toBe(2)
    expect(outcomes.sort()).toStrictEqual(['completed', 'completed', 'retry'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/COMMIT/)
  })
})

describe('admin', () => {
  it('cancel: an idle message at once, an active one through its signal (T14)', async () => {
    const { q } = setup()
    const idle = await q.send({ n: 1 }, { delayMs: 60_000, key: 'k', dedup: 'until-done' })
    await q.cancel(idle, 'not needed')
    expect((await q.get(idle))?.state).toBe('cancelled')
    expect((await q.send({ n: 9 }, { key: 'k', dedup: 'until-done' })).deduplicated).toBe(false)
    await q.cancel(await q.send({ n: 9 }, { delayMs: 60_000 })).catch(() => {})

    const active = await q.send({ n: 2 })
    let reason: unknown
    const w = q.work(
      (m, ctx) =>
        new Promise((resolve, reject) => {
          if (m.payload.n !== 2) return resolve(0)
          ctx.signal.addEventListener('abort', () => reject((reason = ctx.signal.reason)))
        }),
      { ...fast, heartbeatMs: 20 },
    )
    await until(async () => (await q.get(active))?.state === 'active')
    await q.cancel(active)
    await until(async () => (await q.get(active))?.state === 'cancelled')
    await w.close()
    expect(reason).toBeInstanceOf(CancelledError)
  })

  it('a cancel flagged during a short attempt holds when it fails or defers', async () => {
    const { q } = setup()
    const failing = await q.send({ n: 1 })
    const deferring = await q.send({ n: 2 })
    let open = (): void => {}
    const flagged = new Promise<void>((r) => (open = r))
    let runs = 0
    const w = q.work(
      async (m, ctx) => {
        runs++
        await flagged
        if (m.payload.n === 1) throw new Error('boom')
        return ctx.defer({ delayMs: 0 })
      },
      { ...fast, concurrency: 2 },
    )
    await until(async () => (await q.counts()).active === 2)
    await q.cancel(failing)
    await q.cancel(deferring)
    open()
    await until(async () => (await q.counts()).cancelled === 2)
    await w.close()
    expect(runs).toBe(2)
  })

  it('cancel catches a message that left active before it was flagged', async () => {
    const { db, schema, q } = setup({ retry: { baseDelayMs: 0 } })
    const ref = await q.send({ n: 1 })
    const [m] = (await q.claim()) as [Message<P>]
    const jobs = defineQueue<P>('jobs', { retry: { baseDelayMs: 0 } })
    const late = pgMq({ db: racing(db, 'mq.cancel', () => q.fail(m, 'x'), 'before'), schema })
    await late.queue(jobs).cancel(ref)
    expect((await q.get(ref))?.state).toBe('cancelled')
  })

  it('cancel never reaches a message of another queue', async () => {
    const { mq, q } = setup()
    const other = mq.queue(defineQueue<P>('other'))
    const ref = await other.send({ n: 1 })
    await q.cancel(ref.id)
    expect((await other.get(ref))?.state).toBe('ready')
  })

  it('retry: finished → ready, clearing expire_at, error and cancel (T15)', async () => {
    const { q } = setup({ retry: { maxAttempts: 1 } })
    const a = await q.send({ n: 1 })
    const b = await q.send({ n: 2 })
    const w = q.work(async () => {
      throw new Error('x')
    }, fast)
    await until(async () => (await q.counts()).failed === 2)
    await w.close()
    await q.cancel(await q.send({ n: 3 }))
    expect(await q.retry({ ids: [a.id] })).toBe(1)
    expect(await q.retry({ state: 'failed' })).toBe(1)
    expect(await q.retry({ state: 'cancelled' })).toBe(1)
    const m = await q.get(b)
    expect([m?.state, m?.attempts, m?.error, m?.finishedAt]).toStrictEqual(['ready', 0, null, null])
    let aborted = false
    const w2 = q.work(async (_m, ctx) => ((aborted ||= ctx.signal.aborted), 1), {
      ...fast,
      heartbeatMs: 10,
    })
    await until(async () => (await q.counts()).completed === 3)
    await w2.close()
    expect(aborted).toBe(false)
  })

  it('remove, purge and drop (T16)', async () => {
    const { q, mq } = setup()
    const a = await q.send({ n: 1 })
    await q.send({ n: 2 })
    expect(await q.remove(a)).toBe(true)
    expect(await q.remove(a)).toBe(false)
    const [m] = (await q.claim()) as [Message<P>]
    await expect(q.remove(m.id)).rejects.toBeInstanceOf(UsageError)
    await expect(q.drop()).rejects.toBeInstanceOf(UsageError)
    await expect(q.purge({ states: ['active'] })).rejects.toBeInstanceOf(UsageError)
    await q.complete(m, 1)
    await q.send({ n: 3 })
    expect(await q.purge({ states: ['ready'] })).toBe(1)
    expect(await q.purge({ states: ['completed'], olderThanMs: 60_000 })).toBe(0)
    await q.drop()
    expect(await mq.queues.jobs.counts()).toMatchObject({ completed: 0, ready: 0 })
  })

  it('pause stops claims until resume', async () => {
    const { q } = setup()
    await q.send({ n: 1 })
    await q.pause()
    expect(await q.claim()).toStrictEqual([])
    await q.resume()
    expect(await q.claim()).toHaveLength(1)
  })

  it('list and counts', async () => {
    const { q } = setup()
    const refs = await q.sendMany([1, 2, 3].map((n) => ({ payload: { n } })))
    await q.claim()
    expect((await q.list({ state: 'ready' })).map((m) => m.payload.n)).toStrictEqual([2, 3])
    expect((await q.list({ after: refs[1]?.id as bigint })).map((m) => m.payload.n)).toStrictEqual([
      3,
    ])
    expect(await q.counts()).toMatchObject({ ready: 2, active: 1, failed: 0 })
  })
})

describe('retention', () => {
  it('by age, by count, and completed: false deletes at completion', async () => {
    const { db, schema, mq } = setup()
    const aged = mq.queue(
      defineQueue<P, number>('aged', { keep: { completed: { ageMs: 1 }, failed: false } }),
    )
    const counted = mq.queue(
      defineQueue<P, number>('counted', { keep: { completed: { count: 2 } } }),
    )
    const gone = mq.queue(defineQueue<P, number>('gone', { keep: { completed: false } }))
    for (const q of [aged, counted, gone]) {
      await q.sendMany([1, 2, 3, 4].map((n) => ({ payload: { n } })))
      const w = q.work(
        async (m) => {
          if (q === aged && m.payload.n === 4) throw new NonRetryableError('x')
          return m.payload.n
        },
        { ...fast, concurrency: 4 },
      )
      await until(async () => (await q.counts()).ready + (await q.counts()).active === 0)
      await sleep(60)
      await w.close()
    }
    expect(await aged.counts()).toMatchObject({ completed: 0, failed: 0 })
    expect(
      (await counted.list({ state: 'completed' })).map((m) => m.payload.n).sort(),
    ).toHaveLength(2)
    expect((await gone.counts()).completed).toBe(0)
    const [{ n } = { n: -1 }] =
      await db.sql`select count(*)::int as n from ${sql.ident(schema, 'messages')}`.execute()
    expect(n).toBe(2)
  })

  it('a failed count also trims cancelled messages', async () => {
    const { mq } = setup()
    const q = mq.queue(defineQueue<P>('few', { keep: { failed: { count: 1 } } }))
    for (const n of [1, 2, 3]) await q.cancel(await q.send({ n }))
    const w = q.work(async () => {}, fast)
    await until(async () => (await q.counts()).cancelled === 1)
    await w.close()
    expect((await q.list({ state: 'cancelled' })).map((m) => m.payload.n)).toStrictEqual([3])
  })

  it('retry clears expire_at, so retention never deletes a re-queued message', async () => {
    const { db, schema, mq } = setup()
    const q = mq.queue(
      defineQueue<P>('short', { keep: { failed: { ageMs: 60_000 } }, retry: { maxAttempts: 1 } }),
    )
    const ref = await q.send({ n: 1 })
    const [m] = (await q.claim()) as [Message<P>]
    await q.fail(m, new Error('x'))
    expect((await row(db, schema, ref.id))?.['expire_at']).toBeInstanceOf(Date)
    await q.retry({ ids: [ref.id] })
    expect((await row(db, schema, ref.id))?.['expire_at']).toBeNull()
  })
})

describe('watch and result', () => {
  it('result() resolves with the result and rejects a failed message (polling)', async () => {
    const { mq } = setup()
    const q = mq.queue(
      defineQueue<P, number>('watched', { watch: true, retry: { maxAttempts: 1 } }),
    )
    const ok = await q.send({ n: 3 })
    const bad = await q.send({ n: -1 })
    const w = q.work(async (m) => {
      if (m.payload.n < 0) throw new Error('negative')
      return m.payload.n * 2
    }, fast)
    expect(await q.result(ok, { pollMs: 20 })).toBe(6)
    const err = await q.result(bad, { pollMs: 20 }).catch((e: unknown) => e)
    await w.close()
    expect(err).toBeInstanceOf(MessageFailedError)
    expect((err as MessageFailedError).state).toBe('failed')
    await expect(q.result(await q.send({ n: 1 }), { pollMs: 20, timeoutMs: 50 })).rejects.toThrow(
      /timed out/,
    )
    const reason = new Error('stopped')
    const signal = AbortSignal.abort(reason)
    const pending = await q.send({ n: 1 })
    const t0 = Date.now()
    await expect(q.result(pending, { pollMs: 20, timeoutMs: 2000, signal })).rejects.toBe(reason)
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('watch()/result() need watch: true, which needs completed messages kept', async () => {
    const { q } = setup()
    await expect(q.result(await q.send({ n: 1 }))).rejects.toThrow(/watch: true/)
    await expect(q.watch(() => {})).rejects.toThrow(/watch: true/)
    expect(() => defineQueue('x', { watch: true, keep: { completed: false } })).toThrow(ConfigError)
  })
})

describe('worker lifecycle and hooks', () => {
  it('close({ graceMs }) aborts a slow handler and releases it without an attempt', async () => {
    const { q } = setup()
    const ref = await q.send({ n: 1 })
    let started = false
    const w = q.work(
      (_m, ctx) =>
        new Promise((_resolve, reject) => {
          started = true
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason))
        }),
      fast,
    )
    await until(() => started)
    await w.close({ graceMs: 30 })
    const m = await q.get(ref)
    expect([m?.state, m?.attempts, m?.claims]).toStrictEqual(['ready', 0, 0])
  })

  it('a throwing hook is disabled for that call and reported as hook-failed', async () => {
    const internal: string[] = []
    const { q } = setup(
      {},
      {
        onSend: () => {
          throw new Error('bad hook')
        },
        onInternal: (e) => void internal.push(e.kind),
      },
    )
    await q.send({ n: 1 })
    expect(internal).toStrictEqual(['hook-failed'])
  })

  it('an abort signal closes the worker, also one aborted before work()', async () => {
    const { q } = setup()
    const stop = new AbortController()
    const w = q.work(async () => 1, { ...fast, signal: stop.signal })
    await sleep(40)
    stop.abort()
    const early = q.work(async () => 1, { ...fast, signal: AbortSignal.abort() })
    await sleep(40)
    await q.send({ n: 1 })
    await sleep(60)
    expect([(await q.counts()).ready, w.running, early.running]).toStrictEqual([1, 0, 0])
    await Promise.all([w.close(), early.close()])
  })
})
