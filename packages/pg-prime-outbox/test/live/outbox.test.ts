import { startPglite } from '@pg-prime/testing'
import type { PgliteServer } from '@pg-prime/testing'
import { ConfigError, sql } from 'pg-prime'
import type { Db } from 'pg-prime'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  NonRetryableSinkError,
  NotStartedError,
  PayloadError,
  SchemaVersionError,
  defineOutbox,
  migrationSql,
  pgOutbox,
} from '../../src/index.js'
import type { OutboxDef, OutboxHooks, Relay, StandardSchemaV1 } from '../../src/index.js'
import { connectDb, dropSchema, recordingSink, scratchSchema, sleep, until } from '../support.js'

// PGlite is one backend: one pooled connection, and no LISTEN (the relay polls).
let server: PgliteServer
let db: Db
beforeAll(async () => {
  server = await startPglite()
  db = connectDb(server.url, { poolOptions: { max: 1 }, poolerMode: 'transaction' })
})
afterAll(async () => {
  await db.end()
  await server.stop()
})

let schema: string
let relays: Relay[] = []
afterEach(async () => {
  await Promise.all(relays.map((r) => r.close()))
  relays = []
  await dropSchema(db, schema)
})

function outboxOf<D extends Record<string, OutboxDef<any>>>(define: D, hooks?: OutboxHooks) {
  schema = scratchSchema()
  return pgOutbox({ db, schema, define, ...(hooks === undefined ? {} : { hooks }) })
}

const count = async (where = sql`true`): Promise<number> => {
  const [r] =
    await db.sql`select count(*) as n from ${sql.ident(schema, 'records')} where ${where}`.execute()
  return Number(r!['n'])
}

const fast = { pollMs: 10, retry: { baseDelayMs: 20, jitter: 'none' as const } }

describe('schema', () => {
  it('migrates once and is idempotent', async () => {
    const outbox = outboxOf({})
    await outbox.start()
    await outbox.start()
    expect(await outbox.migrate()).toStrictEqual({ from: 1, to: 1 })
  })

  it('autoMigrate: false refuses an unmigrated schema, then works after migrate()', async () => {
    schema = scratchSchema()
    const outbox = pgOutbox({ db, schema, autoMigrate: false, define: { t: defineOutbox('t') } })
    await expect(outbox.start()).rejects.toBeInstanceOf(SchemaVersionError)
    expect(await outbox.migrate()).toStrictEqual({ from: 0, to: 1 })
    await outbox.start()
  })

  it('vendored migrationSql converges with the runtime migrator', async () => {
    schema = scratchSchema()
    for (const f of migrationSql({ schema })) {
      for (const stmt of f.sql.split(';\n').filter((x) => x.trim() !== '')) {
        await db.sql`${sql.unsafeRaw(stmt)}`.execute()
      }
    }
    const outbox = pgOutbox({ db, schema, define: { t: defineOutbox('t') } })
    expect(await outbox.migrate()).toStrictEqual({ from: 1, to: 1 })
    await outbox.start()
  })

  it('start() refuses a declaration whose partitions differ', async () => {
    await outboxOf({ t: defineOutbox('t', { partitions: 4 }) }).start()
    const again = pgOutbox({ db, schema, define: { t: defineOutbox('t', { partitions: 8 }) } })
    await expect(again.start()).rejects.toBeInstanceOf(ConfigError)
  })
})

describe('write', () => {
  it('a rolled-back transaction leaves nothing', async () => {
    const outbox = outboxOf({ t: defineOutbox<number>('t') })
    await outbox.start()
    await db
      .transaction(async (tx) => {
        await outbox.topics.t.write(1, { tx })
        tx.rollback()
      })
      .catch(() => {})
    expect(await count()).toBe(0)
  })

  it('a duplicate idempotency key is a no-op that returns the first id', async () => {
    const outbox = outboxOf({ t: defineOutbox<number>('t') })
    await outbox.start()
    const a = await outbox.topics.t.write(1, { tx: db, idempotencyKey: 'x' })
    const [b, c] = await db.transaction((tx) =>
      outbox.topics.t.writeMany(
        [
          { payload: 2, idempotencyKey: 'x' },
          { payload: 3, idempotencyKey: 'y' },
        ],
        { tx },
      ),
    )
    expect(a.duplicate).toBe(false)
    expect(b).toStrictEqual({ id: a.id, idem: 'x', duplicate: true })
    expect(c!.duplicate).toBe(false)
    expect(await count()).toBe(2)
  })

  it('write before start() in a transaction throws NotStartedError and rolls the caller back', async () => {
    const outbox = outboxOf({ t: defineOutbox<number>('t') })
    await outbox.migrate()
    const app = sql.ident(schema, 'app')
    await db.sql`create table ${app} (id int)`.execute()
    const adhoc = outbox.topic(defineOutbox<number>('adhoc'))
    await expect(
      db.transaction(async (tx) => {
        await tx.sql`insert into ${app} values (1)`.execute()
        await adhoc.write(1, { tx })
      }),
    ).rejects.toBeInstanceOf(NotStartedError)
    expect((await db.sql`select * from ${app}`.execute()).length).toBe(0)
    await adhoc.start()
    await db.transaction((tx) => adhoc.write(1, { tx }))
    expect(await count()).toBe(1)
  })

  it('write with the root handle starts lazily', async () => {
    const outbox = outboxOf({ t: defineOutbox<number>('t') })
    await outbox.topics.t.write(1, { tx: db })
    expect(await count()).toBe(1)
  })

  it('a topic whose row is gone is NotStartedError, not a silent no-op', async () => {
    const outbox = outboxOf({ t: defineOutbox<number>('t') })
    await outbox.start()
    await db.sql`delete from ${sql.ident(schema, 'topics')}`.execute()
    await expect(db.transaction((tx) => outbox.topics.t.write(1, { tx }))).rejects.toBeInstanceOf(
      NotStartedError,
    )
  })

  it('a null or undefined payload is stored as JSON null', async () => {
    const outbox = outboxOf({ t: defineOutbox<null | undefined>('t') })
    await outbox.start()
    await outbox.topics.t.writeMany([{ payload: null }, { payload: undefined }], { tx: db })
    expect(await count(sql`payload = 'null'::jsonb`)).toBe(2)
  })

  it('schema and codec run on write and read', async () => {
    const positive: StandardSchemaV1<unknown, number> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (v) =>
          typeof v === 'number' && v > 0 ? { value: v } : { issues: [{ message: 'must be > 0' }] },
      },
    }
    const t = defineOutbox<number>('t', {
      schema: positive,
      codec: { encode: (v) => ({ n: v }), decode: (v) => (v as { n: number }).n },
    })
    const outbox = outboxOf({ t })
    await outbox.start()
    await expect(outbox.topics.t.write(-1, { tx: db })).rejects.toBeInstanceOf(PayloadError)
    await outbox.topics.t.write(5, { tx: db, headers: { h: 'v' } })
    const [row] = await db.sql`select payload from ${sql.ident(schema, 'records')}`.execute()
    expect(row!['payload']).toStrictEqual({ n: 5 })
    const { sink, got } = recordingSink<number>()
    relays.push(outbox.topics.t.relay(sink, fast))
    await until(() => got.length === 1)
    expect(got[0]!.payload).toBe(5)
    expect(got[0]!.headers).toStrictEqual({ h: 'v' })
  })
})

describe('relay', () => {
  it('delivers each key in id order and a failing key does not hold up the others', async () => {
    const outbox = outboxOf({ t: defineOutbox<string>('t', { partitions: 2 }) })
    await outbox.start()
    const items = ['a', 'b', 'c'].flatMap((k) =>
      [1, 2, 3].map((i) => ({ payload: `${k}${i}`, key: k })),
    )
    await db.transaction((tx) => outbox.topics.t.writeMany(items, { tx }))
    let bDown = true
    const { sink, got } = recordingSink<string>((r) =>
      r.key === 'b' && bDown ? new Error('down') : undefined,
    )
    relays.push(outbox.topics.t.relay(sink, fast))
    await until(() => got.length === 6)
    expect(
      got
        .map((r) => r.payload)
        .filter((p) => p[0] !== 'b')
        .sort(),
    ).toStrictEqual(['a1', 'a2', 'a3', 'c1', 'c2', 'c3'])
    expect((await outbox.topics.t.stats()).blockedKeys).toBe(1)
    bDown = false
    await until(() => got.length === 9)
    for (const k of ['a', 'b', 'c']) {
      expect(got.filter((r) => r.key === k).map((r) => r.payload)).toStrictEqual([
        `${k}1`,
        `${k}2`,
        `${k}3`,
      ])
    }
  })

  it('parks after maxAttempts, blocks the key, and replay resumes it in order', async () => {
    const parks: bigint[] = []
    const outbox = outboxOf({ t: defineOutbox<string>('t') }, { onPark: (e) => parks.push(e.id) })
    await outbox.start()
    const topic = outbox.topics.t
    await db.transaction((tx) =>
      topic.writeMany(
        [
          { payload: 'k1', key: 'k' },
          { payload: 'k2', key: 'k' },
        ],
        { tx },
      ),
    )
    let down = true
    const { sink, got } = recordingSink<string>(() => (down ? new Error('nope') : undefined))
    relays.push(topic.relay(sink, { ...fast, retry: { ...fast.retry, maxAttempts: 2 } }))
    await until(() => parks.length === 1)
    await sleep(100)
    expect(got).toStrictEqual([])
    const parked = await topic.parked()
    expect(parked.map((r) => [r.payload, r.attempts, r.error])).toStrictEqual([['k1', 2, 'nope']])
    expect((await topic.stats()).parked).toBe(1)
    down = false
    expect(await topic.replay(parked.map((r) => r.id))).toBe(1)
    await until(() => got.length === 2)
    expect(got.map((r) => r.payload)).toStrictEqual(['k1', 'k2'])
  })

  it('a non-retryable error parks at once; discard releases the key', async () => {
    const outbox = outboxOf({ t: defineOutbox<string>('t') })
    await outbox.start()
    const topic = outbox.topics.t
    await db.transaction((tx) =>
      topic.writeMany(
        [
          { payload: 'poison', key: 'k' },
          { payload: 'next', key: 'k' },
        ],
        { tx },
      ),
    )
    const { sink, got } = recordingSink<string>((r) =>
      r.payload === 'poison' ? new NonRetryableSinkError('bad payload') : undefined,
    )
    relays.push(topic.relay(sink, fast))
    await until(async () => (await topic.stats()).parked === 1)
    expect((await topic.parked())[0]!.attempts).toBe(1)
    expect(got).toStrictEqual([])
    expect(await topic.discard((await topic.parked()).map((r) => r.id))).toBe(1)
    await until(() => got.length === 1)
    expect(got[0]!.payload).toBe('next')
  })

  it('a payload that no longer decodes parks at once and blocks only its key', async () => {
    const parks: unknown[] = []
    const t = defineOutbox<number>('t', {
      codec: {
        encode: (n) => n,
        decode: (v) => {
          if (v === 2) throw new Error('old shape')
          return v as number
        },
      },
    })
    const outbox = outboxOf({ t }, { onPark: (e) => parks.push(e.error) })
    await outbox.start()
    const topic = outbox.topics.t
    const items = [1, 2, 3].map((payload) => ({ payload, key: 'k' }))
    await topic.writeMany([...items, { payload: 4, key: 'j' }], { tx: db })
    const { sink, got } = recordingSink<number>()
    relays.push(topic.relay(sink, fast))
    await until(() => parks.length === 1 && got.length === 2)
    await sleep(100)
    expect(got.map((r) => r.payload).sort()).toStrictEqual([1, 4])
    const parked = await topic.parked()
    expect(parked.map((r) => [r.payload, r.attempts, r.decoded])).toStrictEqual([[2, 1, false]])
    expect(parked[0]!.error).toMatch(/old shape/)
    expect(await topic.discard([parked[0]!.id])).toBe(1)
    await until(() => got.length === 3)
    expect(got[2]!.payload).toBe(3)
  })

  it('pause stops delivery and resume restarts it', async () => {
    const outbox = outboxOf({ t: defineOutbox<number>('t') })
    await outbox.start()
    const topic = outbox.topics.t
    await topic.pause()
    expect((await topic.stats()).paused).toBe(true)
    await topic.write(1, { tx: db })
    const { sink, got } = recordingSink<number>()
    relays.push(topic.relay(sink, fast))
    await sleep(150)
    expect(got.length).toBe(0)
    await topic.resume()
    await until(() => got.length === 1)
  })

  it('keeps delivered records for keepDeliveredMs, so a duplicate stays a no-op, then sweeps them', async () => {
    const outbox = outboxOf({ t: defineOutbox<number>('t', { keepDeliveredMs: 300 }) })
    await outbox.start()
    const topic = outbox.topics.t
    await topic.write(1, { tx: db, idempotencyKey: 'once' })
    const { sink, got } = recordingSink<number>()
    relays.push(topic.relay(sink, { ...fast, leaseMs: 150 }))
    await until(() => got.length === 1)
    expect((await topic.write(1, { tx: db, idempotencyKey: 'once' })).duplicate).toBe(true)
    expect(await count(sql`state = 'delivered'`)).toBe(1)
    await until(async () => (await count()) === 0, 5_000)
    expect(got.length).toBe(1)
  })

  it('keepDeliveredMs: 0 deletes on delivery and forgets the idempotency key', async () => {
    const outbox = outboxOf({ t: defineOutbox<number>('t', { keepDeliveredMs: 0 }) })
    await outbox.start()
    const topic = outbox.topics.t
    await topic.write(1, { tx: db, idempotencyKey: 'once' })
    const { sink, got } = recordingSink<number>()
    relays.push(topic.relay(sink, fast))
    await until(() => got.length === 1)
    expect(await count()).toBe(0)
    expect((await topic.write(1, { tx: db, idempotencyKey: 'once' })).duplicate).toBe(false)
  })

  it('reports leases, deliveries, failures and writes through hooks', async () => {
    const seen: string[] = []
    const outbox = outboxOf(
      { t: defineOutbox<number>('t', { partitions: 1 }) },
      {
        onWrite: (e) => seen.push(`write:${e.count}:${e.duplicates}`),
        onLease: (e) => seen.push(`lease:${e.acquired.join()}:${e.released.join()}`),
        onDeliver: (e) => seen.push(`deliver:${e.count}`),
        onFail: (e) => seen.push(`fail:${e.attempt}`),
      },
    )
    await outbox.start()
    await outbox.topics.t.write(1, { tx: db })
    let fail = true
    const { sink, got } = recordingSink<number>(() =>
      fail ? ((fail = false), new Error('x')) : undefined,
    )
    const relay = outbox.topics.t.relay(sink, fast)
    await until(() => got.length === 1)
    expect(relay.partitions).toStrictEqual([0])
    await relay.close()
    expect(relay.partitions).toStrictEqual([])
    expect(seen).toStrictEqual(['write:1:0', 'lease:0:', 'fail:1', 'deliver:1'])
    expect((await outbox.topics.t.stats()).partitions[0]!.owner).toBeNull()
  })
})
