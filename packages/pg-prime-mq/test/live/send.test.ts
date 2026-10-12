import { describe, expect, it } from 'vitest'
import { sql } from 'pg-prime'
import type { Db } from 'pg-prime'
import {
  NotStartedError,
  PayloadError,
  SchemaVersionError,
  defineQueue,
  migrationSql,
  pgMq,
} from '../../src/index.js'
import type { Message, MqHooks, QueueHandle } from '../../src/index.js'
import { freshSchema, sleep, useServer } from '../_db.js'

const server = useServer()
const jobs = defineQueue<{ n: number }>('jobs')

function setup(hooks?: MqHooks) {
  const db = server.db()
  const schema = freshSchema()
  const mq = pgMq({ db, schema, define: { jobs }, ...(hooks === undefined ? {} : { hooks }) })
  return { db, schema, mq, q: mq.queues.jobs }
}

/** Claims everything ready, one at a time, in claim order. */
async function drain(q: QueueHandle<{ n: number }, void>) {
  const out: Message<{ n: number }>[] = []
  for (;;) {
    const [m] = await q.claim({ limit: 1 })
    if (m === undefined) return out
    out.push(m)
  }
}

describe('migrate', () => {
  it('is idempotent and reports the versions', async () => {
    const { mq } = setup()
    expect(await mq.migrate()).toStrictEqual({ from: 0, to: 1 })
    expect(await mq.migrate()).toStrictEqual({ from: 1, to: 1 })
  })

  it('converges with the vendored migrationSql files', async () => {
    const { db, schema, mq } = setup()
    for (const f of migrationSql({ schema })) {
      await db.transaction(async (tx) => {
        for (const s of f.sql.split(';\n').filter((x) => x.trim() !== '')) {
          await tx.sql`${sql.unsafeRaw(s)}`.execute()
        }
      })
    }
    expect(await mq.migrate()).toStrictEqual({ from: 1, to: 1 })
  })

  it('autoMigrate: false refuses an unmigrated schema', async () => {
    const mq = pgMq({ db: server.db(), schema: freshSchema(), autoMigrate: false })
    await expect(mq.start()).rejects.toBeInstanceOf(SchemaVersionError)
    await mq.migrate()
    await mq.start()
  })

  it('a { tx } send before start() is a NotStartedError', async () => {
    const { db, q } = setup()
    await expect(db.transaction((tx) => q.send({ n: 1 }, { tx }))).rejects.toBeInstanceOf(
      NotStartedError,
    )
  })
})

describe('send and order', () => {
  it('claims by priority, then FIFO; LIFO per message', async () => {
    const { q } = setup()
    await q.sendMany([
      { payload: { n: 1 } },
      { payload: { n: 2 }, opts: { priority: -1 } },
      { payload: { n: 3 } },
      { payload: { n: 4 }, opts: { lifo: true } },
      { payload: { n: 5 }, opts: { lifo: true } },
      { payload: { n: 6 }, opts: { priority: 5 } },
    ])
    expect((await drain(q)).map((m) => m.payload.n)).toStrictEqual([2, 5, 4, 1, 3, 6])
  })

  it('a re-queued message joins the back of its band and keeps its LIFO sign', async () => {
    const { q } = setup()
    const jobsQ = q
    await jobsQ.sendMany(
      [1, 2, 3].map((n) => ({ payload: { n }, opts: { retry: { baseDelayMs: 0 } } })),
    )
    const [first] = await jobsQ.claim()
    await jobsQ.fail(first as Message<{ n: number }>, new Error('again'))
    await jobsQ.send({ n: 4 }, { lifo: true })
    await sleep(5)
    expect((await drain(jobsQ)).map((m) => m.payload.n)).toStrictEqual([4, 2, 3, 1])
  })

  it('delayMs and runAt wait on the database clock; promote() moves one early', async () => {
    const { q } = setup()
    const a = await q.send({ n: 1 }, { delayMs: 150 })
    const b = await q.send({ n: 2 }, { runAt: new Date(Date.now() + 60_000) })
    expect((await q.get(a))?.state).toBe('delayed')
    expect(await q.claim()).toStrictEqual([])
    await sleep(200)
    expect((await q.claim()).map((m) => m.payload.n)).toStrictEqual([1])
    await q.promote(b)
    expect((await q.claim()).map((m) => m.payload.n)).toStrictEqual([2])
  })

  it('a null or undefined payload is stored as JSON null', async () => {
    const pings = defineQueue<null | undefined>('pings')
    const mq = pgMq({ db: server.db(), schema: freshSchema(), define: { pings } })
    await mq.start()
    await mq.queues.pings.send(null)
    await mq.queues.pings.send(undefined)
    expect((await mq.queues.pings.claim({ limit: 2 })).map((m) => m.payload)).toStrictEqual([
      null,
      null,
    ])
  })

  it('a send in a rolled-back transaction leaves nothing', async () => {
    const { db, mq, q } = setup()
    await mq.start()
    await db
      .transaction(async (tx) => {
        await q.send({ n: 1 }, { tx })
        tx.rollback()
      })
      .catch(() => {})
    expect((await q.counts()).ready).toBe(0)
  })

  it('refuses NUL characters with their path, oversize payloads and schema failures', async () => {
    const { mq } = setup()
    const raw = mq.queue(defineQueue<unknown>('raw'))
    const nul = await raw.send({ a: [{ b: 'x\u0000' }] }).catch((e: unknown) => e)
    expect(nul).toBeInstanceOf(PayloadError)
    expect((nul as PayloadError).path).toStrictEqual(['a', 0, 'b'])
    await expect(raw.send('x'.repeat(1024 * 1024 + 1))).rejects.toBeInstanceOf(PayloadError)
    const typed = mq.queue(
      defineQueue('typed', {
        schema: {
          '~standard': {
            version: 1,
            vendor: 'test',
            validate: (v) =>
              typeof v === 'number'
                ? { value: v }
                : { issues: [{ message: 'not a number', path: ['x'] }] },
          },
        },
      }),
    )
    await expect(typed.send('nope' as unknown as number)).rejects.toThrow(/not a number/)
    await typed.send(1)
  })

  it('onSend reports inserted ids, not deduplicated ones', async () => {
    const sent: bigint[][] = []
    const { q } = setup({ onSend: (e) => void sent.push([...e.ids]) })
    const a = await q.send({ n: 1 }, { key: 'k', dedup: 'until-done' })
    await q.send({ n: 2 }, { key: 'k', dedup: 'until-done' })
    expect(sent).toStrictEqual([[a.id]])
  })
})

describe('dedup', () => {
  it("'until-done' holds the key until the message finishes", async () => {
    const { q } = setup()
    const a = await q.send({ n: 1 }, { key: 'k', dedup: 'until-done' })
    const b = await q.send({ n: 2 }, { key: 'k', dedup: 'until-done' })
    expect(b).toStrictEqual({ queue: 'jobs', id: a.id, deduplicated: true })
    const [m] = await q.claim()
    await q.complete(m as Message<{ n: number }>, undefined)
    const c = await q.send({ n: 3 }, { key: 'k', dedup: 'until-done' })
    expect(c.deduplicated).toBe(false)
    expect(c.id).not.toBe(a.id)
  })

  it('a window throttles, then is reclaimed once it expires', async () => {
    const { db, schema, q } = setup()
    const a = await q.send({ n: 1 }, { key: 'w', dedup: { windowMs: 60_000 } })
    expect((await q.send({ n: 2 }, { key: 'w', dedup: { windowMs: 60_000 } })).id).toBe(a.id)
    await expire(db, schema)
    const c = await q.send({ n: 3 }, { key: 'w', dedup: { windowMs: 60_000 } })
    expect(c.deduplicated).toBe(false)
  })

  it('extend debounces: each duplicate pushes the window out', async () => {
    const { db, schema, q } = setup()
    const o = { key: 'd', dedup: { windowMs: 60_000, extend: true } }
    const a = await q.send({ n: 1 }, o)
    const until = async () => (await rowsOf(db, schema, 'dedup'))[0]?.['expire_at'] as Date
    let last = await until()
    for (let i = 0; i < 3; i++) {
      await sleep(5)
      expect(await q.send({ n: 2 }, o)).toStrictEqual({
        queue: 'jobs',
        id: a.id,
        deduplicated: true,
      })
      expect((await until()).getTime()).toBeGreaterThan(last.getTime())
      last = await until()
    }
    await expire(db, schema)
    expect((await q.send({ n: 3 }, o)).deduplicated).toBe(false)
  })

  it('sendMany collapses duplicate keys and mixes modes in one transaction', async () => {
    const { q } = setup()
    const refs = await q.sendMany([
      { payload: { n: 1 }, opts: { key: 'x', dedup: 'until-done' } },
      { payload: { n: 2 }, opts: { key: 'x', dedup: 'until-done' } },
      { payload: { n: 3 }, opts: { key: 'y', dedup: { windowMs: 1000, extend: true } } },
      { payload: { n: 4 } },
    ])
    expect(refs.map((r) => r.deduplicated)).toStrictEqual([false, true, false, false])
    expect(refs[1]?.id).toBe(refs[0]?.id)
    expect((await q.counts()).ready).toBe(3)
  })

  it('dedup without a key is a usage error', async () => {
    const { q } = setup()
    await expect(q.send({ n: 1 }, { dedup: 'until-done' })).rejects.toThrow(/needs a key/)
  })
})

function rowsOf(db: Db, schema: string, table: string) {
  return db.sql`select * from ${sql.ident(schema, table)}`.execute()
}

/** Ends every dedup window now. */
async function expire(db: Db, schema: string): Promise<void> {
  await db.sql`update ${sql.ident(schema, 'dedup')} set expire_at = now() - interval '1 ms'`.execute()
}
