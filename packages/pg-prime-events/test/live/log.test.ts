import { describe, expect, it } from 'vitest'
import { TransactionRollback, ownedSchemaSql, sql } from 'pg-prime'
import {
  NotStartedError,
  PayloadError,
  SchemaVersionError,
  defineSubscription,
  defineTopic,
  pgEvents,
} from '../../src/index.js'
import type { Entry, EventsHooks } from '../../src/index.js'
import { MIGRATIONS } from '../../src/log/migrations.js'
import { freshSchema, until, useServer } from '../_db.js'

const server = useServer()
const orders = defineTopic<{ n: number }>('orders')

function setup(hooks?: EventsHooks) {
  const db = server.db()
  const schema = freshSchema()
  const events = pgEvents({ db, schema, ...(hooks === undefined ? {} : { hooks }) })
  return { db, schema, events }
}

describe('migrate', () => {
  it('is idempotent and reports the versions', async () => {
    const { events } = setup()
    expect(await events.migrate()).toStrictEqual({ from: 0, to: 1 })
    expect(await events.migrate()).toStrictEqual({ from: 1, to: 1 })
  })

  it('converges with vendored ownedSchemaSql files', async () => {
    const { db, schema, events } = setup()
    for (const f of ownedSchemaSql({ schema, migrations: MIGRATIONS })) {
      await db.transaction(async (tx) => {
        for (const s of f.sql.split(';\n').filter((x) => x.trim() !== '')) {
          await tx.sql`${sql.unsafeRaw(s)}`.execute()
        }
      })
    }
    expect(await events.migrate()).toStrictEqual({ from: 1, to: 1 })
  })

  it('autoMigrate: false refuses an unmigrated schema', async () => {
    const db = server.db()
    const events = pgEvents({ db, schema: freshSchema(), autoMigrate: false })
    const e = await events.start().catch((x: unknown) => x)
    expect(e).toBeInstanceOf(SchemaVersionError)
    expect((e as Error).message).toMatch(/needs 1\. Run events\.migrate\(\)\.$/)
    await events.migrate()
    await events.start()
  })

  it('a { tx } publish before start() is a NotStartedError', async () => {
    const { db, events } = setup()
    await expect(
      db.transaction((tx) => events.topic(orders).publish({ n: 1 }, { tx })),
    ).rejects.toBeInstanceOf(NotStartedError)
  })
})

describe('publish and subscribe', () => {
  it('delivers in order, commits, and resumes after a restart', async () => {
    const { events } = setup()
    const sub = defineSubscription(orders, 'billing', { from: 'beginning' })
    const topic = events.topic(orders)
    await topic.publishMany([1, 2, 3].map((n) => ({ payload: { n }, type: 'created' })))
    const seen: number[] = []
    let reader = events.subscription(sub).run(async (e) => void seen.push(e.payload.n), {
      pollMs: 20,
    })
    await until(() => seen.length === 3)
    await reader.close()
    await topic.publish({ n: 4 })
    reader = events.subscription(sub).run(async (e) => void seen.push(e.payload.n), {
      pollMs: 20,
    })
    await until(() => seen.length === 4)
    await reader.close()
    expect(seen).toStrictEqual([1, 2, 3, 4])
    expect(await events.subscription(sub).lag()).toStrictEqual({ entries: 0, oldestAt: null })
  })

  it('a closed reader issues no further statements and releases its lease', async () => {
    const { db, events } = setup()
    const sub = events.subscription(defineSubscription(orders, 'quiet', { from: 'beginning' }))
    await events.topic(orders).publish({ n: 1 })
    let n = 0
    const reader = sub.run(async () => void n++, { pollMs: 20 })
    await until(() => n === 1 && reader.active)
    await reader.close()
    expect(reader.active).toBe(false)
    const after: string[] = []
    const off = db.observe({ onQueryStart: (e) => void after.push(e.sql) })
    await new Promise((r) => setTimeout(r, 200))
    off()
    expect(after).toStrictEqual([])
    const second = sub.run(async () => {}, { pollMs: 20 })
    await until(() => second.active)
    await second.close()
  })

  it('a types filter advances past other types', async () => {
    const { events } = setup()
    const sub = events.subscription(
      defineSubscription(orders, 'paid', { types: ['paid'], from: 'beginning' }),
    )
    const topic = events.topic(orders)
    await topic.publishMany([
      { payload: { n: 1 }, type: 'created' },
      { payload: { n: 2 }, type: 'paid' },
      { payload: { n: 3 }, type: 'created' },
    ])
    const seen: Entry<{ n: number }>[] = []
    const reader = sub.run(
      { batch: async (es) => void seen.push(...es) },
      { pollMs: 20, batchSize: 2 },
    )
    await until(async () => seen.length === 1 && (await sub.lag()).entries === 0)
    await topic.publish({ n: 4 }, { type: 'created' })
    await until(async () => (await sub.lag()).entries === 0)
    await reader.close()
    expect(seen.map((e) => e.payload.n)).toStrictEqual([2])
    expect(seen[0]?.type).toBe('paid')
  })

  it("from: 'now' skips what was published before the subscription existed", async () => {
    const { events } = setup()
    const topic = events.topic(orders)
    await topic.publish({ n: 1 })
    const sub = events.subscription(defineSubscription(orders, 'late'))
    await events.start()
    await sub.lag()
    await topic.publish({ n: 2 })
    const seen: number[] = []
    const reader = sub.run(async (e) => void seen.push(e.payload.n), { pollMs: 20 })
    await until(() => seen.length === 1)
    await reader.close()
    expect(seen).toStrictEqual([2])
  })

  it('a publish in a rolled-back transaction leaves nothing', async () => {
    const { db, events } = setup()
    await events.start()
    const topic = events.topic(orders)
    let published: unknown
    await expect(
      db.transaction(async (tx) => {
        published = await topic.publish({ n: 1 }, { tx })
        tx.rollback()
      }),
    ).rejects.toBeInstanceOf(TransactionRollback)
    expect(published).toStrictEqual({ id: expect.any(BigInt) })
    expect(await topic.read()).toStrictEqual([])
  })

  it('ctx.commit({ tx }) commits the offset with the handler’s own writes', async () => {
    const { db, schema, events } = setup()
    await events.migrate()
    const sink = sql.ident(schema, 'sink')
    await db.sql`create table ${sink} (n int)`.execute()
    const sub = events.subscription(defineSubscription(orders, 'sink', { from: 'beginning' }))
    await events.topic(orders).publishMany([{ payload: { n: 1 } }, { payload: { n: 2 } }])
    const reader = sub.run(
      async (e, ctx) => {
        await db.transaction(async (tx) => {
          await tx.sql`insert into ${sink} values (${e.payload.n})`.execute()
          await ctx.commit({ tx })
        })
      },
      { pollMs: 20 },
    )
    await until(async () => (await sub.lag()).entries === 0)
    await reader.close()
    expect(await db.sql`select n from ${sink} order by n`.execute()).toStrictEqual([
      { n: 1 },
      { n: 2 },
    ])
  })
})

describe('retry, park, discard', () => {
  it('parks a poison entry after maxAttempts, then re-parks it after a reset', async () => {
    const parks: bigint[] = []
    const retries: number[] = []
    const { events } = setup({
      onPark: (e) => void parks.push(e.entry),
      onRetry: (e) => void retries.push(e.attempt),
    })
    const def = defineSubscription(orders, 'poison', {
      from: 'beginning',
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    })
    const sub = events.subscription(def)
    const topic = events.topic(orders)
    const [, bad] = await topic.publishMany([1, 2, 3].map((n) => ({ payload: { n } })))
    const seen: number[] = []
    const handler = async (e: Entry<{ n: number }>): Promise<void> => {
      if (e.payload.n === 2) throw new Error('boom')
      seen.push(e.payload.n)
    }
    let reader = sub.run(handler, { pollMs: 20, batchSize: 10 })
    await until(() => seen.length === 2 && parks.length === 1)
    await reader.close()
    expect(seen).toStrictEqual([1, 3])
    expect(retries).toStrictEqual([1, 2])
    const parked = await sub.parked()
    expect(parked.map((p) => [p.entry.id, p.attempts, p.error])).toStrictEqual([
      [bad?.id, 2, 'Error: boom'],
    ])

    await sub.reset('beginning')
    reader = sub.run(handler, { pollMs: 20, batchSize: 10 })
    await until(() => seen.length === 4 && parks.length === 2)
    await reader.close()
    expect((await sub.parked()).length).toBe(1)
    expect(await sub.discard([bad?.id as bigint])).toBe(1)
    expect(await sub.parked()).toStrictEqual([])
  })

  it('a failing single entry keeps its attempt count when more entries arrive', async () => {
    let retries = 0
    const { events } = setup({ onRetry: () => void retries++ })
    const def = defineSubscription(orders, 'grow', {
      from: 'beginning',
      retry: { maxAttempts: 3, baseDelayMs: 30, maxDelayMs: 30 },
    })
    const sub = events.subscription(def)
    const topic = events.topic(orders)
    await topic.publish({ n: 1 })
    const seen: number[] = []
    const reader = sub.run(
      async (e) => {
        if (e.payload.n === 1) throw new Error('poison')
        seen.push(e.payload.n)
      },
      { pollMs: 10, batchSize: 10 },
    )
    await until(() => retries === 1)
    await topic.publishMany([{ payload: { n: 2 } }, { payload: { n: 3 } }])
    await until(() => seen.length === 2)
    await reader.close()
    expect(retries).toBe(3)
    expect((await sub.parked()).map((p) => [p.entry.payload.n, p.attempts])).toStrictEqual([[1, 3]])
  })

  it('a failing batch is isolated: maxAttempts 1 never parks an innocent entry', async () => {
    const { events } = setup()
    const def = defineSubscription(orders, 'iso', {
      from: 'beginning',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    })
    const sub = events.subscription(def)
    await events.topic(orders).publishMany([1, 2, 3, 4].map((n) => ({ payload: { n } })))
    const ok: number[] = []
    const reader = sub.run(
      {
        batch: async (es) => {
          if (es.some((e) => e.payload.n === 3)) throw new Error('bad 3')
          ok.push(...es.map((e) => e.payload.n))
        },
      },
      { pollMs: 20, batchSize: 10 },
    )
    await until(async () => (await sub.lag()).entries === 0)
    await reader.close()
    expect(ok).toStrictEqual([1, 2, 4])
    expect((await sub.parked()).map((p) => p.entry.payload.n)).toStrictEqual([3])
  })
})

describe('retention, lag, tails', () => {
  it('keepMs deletes aged entries; keepUntilConsumed keeps unread ones', async () => {
    const { db, schema, events } = setup()
    const short = defineTopic<number>('short', { keepMs: 1 })
    const held = defineTopic<number>('held', { keepMs: 1, keepUntilConsumed: true })
    const heldSub = defineSubscription(held, 'r', { from: 'beginning' })
    events.subscription(heldSub)
    await events.start()
    await events.topic(short).publishMany([{ payload: 1 }, { payload: 2 }])
    await events.topic(held).publishMany([{ payload: 1 }, { payload: 2 }])
    await events.subscription(heldSub).lag()
    await new Promise((r) => setTimeout(r, 5))
    const { statements } = await import('../../src/log/sql.js')
    const sql = statements(schema)
    expect(await sql.maintain(db, 'short', 0)).toStrictEqual({ deleted: 2, behind: false })
    expect(await sql.maintain(db, 'held', 0)).toStrictEqual({ deleted: 0, behind: false })
    expect((await events.subscription(heldSub).lag()).entries).toBe(2)
  })

  it('tails from now and resumes from an Entry.cursor', async () => {
    const { events } = setup()
    const topic = events.topic(orders)
    await topic.publish({ n: 0 })
    const seen: Entry<{ n: number }>[] = []
    const tail = await topic.tail((e) => void seen.push(e), { pollMs: 20 })
    await topic.publishMany([1, 2, 3].map((n) => ({ payload: { n } })))
    await until(() => seen.length === 3)
    await tail.close()
    expect(seen.map((e) => e.payload.n)).toStrictEqual([1, 2, 3])

    const again: number[] = []
    const resumed = await topic.tail((e) => void again.push(e.payload.n), {
      from: { after: seen[0]?.cursor as string },
      pollMs: 20,
    })
    await until(() => again.length === 2)
    await resumed.close()
    expect(again).toStrictEqual([2, 3])
  })

  it('a tail with an already-aborted signal delivers nothing', async () => {
    const { events } = setup()
    const topic = events.topic(orders)
    await topic.publish({ n: 1 })
    const seen: number[] = []
    const tail = await topic.tail((e) => void seen.push(e.payload.n), {
      from: { after: '0.0' },
      signal: AbortSignal.abort(),
      pollMs: 20,
    })
    await new Promise((r) => setTimeout(r, 200))
    await tail.close()
    expect(seen).toStrictEqual([])
  })

  it('a throwing tail error observer neither escapes nor stops the others', async () => {
    const { events } = setup()
    const topic = events.topic(orders)
    const errors: unknown[] = []
    const tail = await topic.tail(
      () => {
        throw new Error('handler')
      },
      { pollMs: 20 },
    )
    tail.on('error', () => {
      throw new Error('observer')
    })
    tail.on('error', (e) => void errors.push(e))
    await topic.publishMany([{ payload: { n: 1 } }, { payload: { n: 2 } }])
    await until(() => errors.length === 2)
    await tail.close()
    expect(errors.map((e) => (e as Error).message)).toStrictEqual(['handler', 'handler'])
  })
})

describe('payloads', () => {
  it('refuses NUL characters with their path and oversize payloads', async () => {
    const { events } = setup()
    const t = events.topic(defineTopic<unknown>('raw'))
    const nul = await t.publish({ a: [{ b: 'x\u0000' }] }).catch((e: unknown) => e)
    expect(nul).toBeInstanceOf(PayloadError)
    expect((nul as PayloadError).path).toStrictEqual(['a', 0, 'b'])
    await expect(t.publish('x'.repeat(1024 * 1024 + 1))).rejects.toBeInstanceOf(PayloadError)
  })

  it('a JSON null payload round-trips', async () => {
    const { events } = setup()
    const t = events.topic(defineTopic<null>('nulls'))
    await t.publishMany([{ payload: null }, { payload: null }])
    expect((await t.read()).map((e) => e.payload)).toStrictEqual([null, null])
  })
})
