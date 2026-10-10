import { requiresConcurrency } from '@pg-prime/testing'
import { sql } from 'pg-prime'
import type { AnyFragment, Db } from 'pg-prime'
import { afterEach, describe, expect, it } from 'vitest'
import { defineOutbox, functionSink, pgOutbox } from '../../src/index.js'
import type { OutboxDef, OutboxSink, Relay, RelayOptions } from '../../src/index.js'
import { connectDb, dropSchema, recordingSink, scratchSchema, sleep, until } from '../support.js'

const test = requiresConcurrency(it)
const url = (): string => process.env['PG_PRIME_TEST_URL']!

interface Proc {
  db: Db
  relay(opts?: RelayOptions): Relay
}

let cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanup) await f()
  cleanup = []
})

/** A schema of its own plus `n` relay "processes", each with its own pool and outbox. */
async function setup<T>(def: OutboxDef<T>, sink: OutboxSink<T>) {
  const schema = scratchSchema()
  const db = connectDb(url(), { poolOptions: { max: 12 } })
  const outbox = pgOutbox({ db, schema, define: { t: def } })
  await outbox.start()
  const dbs: Db[] = [db]
  cleanup.push(async () => {
    await outbox.close()
    // No relay connection may hold a lock while DROP SCHEMA runs.
    for (const d of dbs.slice(1)) await d.end()
    await dropSchema(db, schema)
    await db.end()
  })
  const proc = async (start = true): Promise<Proc> => {
    const pdb = connectDb(url(), { poolOptions: { max: 4 } })
    dbs.push(pdb)
    const o = pgOutbox({ db: pdb, schema, define: { t: def } })
    if (start) await o.start()
    cleanup.unshift(() => o.close())
    return { db: pdb, relay: (opts) => o.topics.t.relay(sink, opts) }
  }
  return { schema, db, topic: outbox.topics.t, proc }
}

/** Runs `lock` in a transaction on its own connection, held open until the result is called. */
async function holding(db: Db, lock: AnyFragment): Promise<() => Promise<void>> {
  let locked!: () => void
  let unlock!: () => void
  const ready = new Promise<void>((r) => (locked = r))
  const gate = new Promise<void>((r) => (unlock = r))
  const tx = db.transaction(async (q) => {
    await q.sql`${lock}`.execute()
    locked()
    await gate
  })
  await Promise.race([ready, tx])
  const free = async (): Promise<void> => {
    unlock()
    await tx
  }
  cleanup.unshift(free)
  return free
}

/** Active statements on `schema` from other connections; `waiting` counts only lock waits. */
async function busy(db: Db, schema: string, waiting = false): Promise<number> {
  const [r] = await db.sql`select count(*)::int as n from pg_stat_activity
    where pid <> pg_backend_pid() and state = 'active' and query like ${`%${schema}%`}
      and (not ${waiting}::boolean or wait_event_type = 'Lock')`.execute()
  return r!['n'] as number
}

/** Partitions still leased, and the owners of membership rows. */
async function leftovers(db: Db, schema: string) {
  const [partitions, relays] = [sql.ident(schema, 'partitions'), sql.ident(schema, 'relays')]
  const [r] = await db.sql`select
      (select count(*)::int from ${partitions} where token is not null) as leases,
      (select coalesce(array_agg(owner), '{}') from ${relays}) as members`.execute()
  return r
}

describe('relay under concurrency', () => {
  test('per-key order under 4 relays and 8 writers', async () => {
    const KEYS = 200
    const PER = 100
    const log = new Map<string, number[]>()
    // A receiver as X6 asks for: it fences stale epochs and drops redeliveries, so a lease lost to
    // a stall shows up as neither a duplicate nor a step back.
    const fence = new Map<number, bigint>()
    const seen = new Set<string>()
    const sink = functionSink<{ key: string; seq: number }>(async (wave, ctx) => {
      await sleep(0)
      if (ctx.epoch < (fence.get(ctx.partition) ?? 0n)) throw new Error('stale epoch')
      fence.set(ctx.partition, ctx.epoch)
      for (const r of wave) {
        if (seen.has(r.idem)) continue
        seen.add(r.idem)
        log.set(r.payload.key, [...(log.get(r.payload.key) ?? []), r.payload.seq])
      }
    })
    const { schema, db, topic, proc } = await setup(
      defineOutbox<{ key: string; seq: number }>('order'),
      sink,
    )
    const agg = sql.ident(schema, 'agg')
    await db.sql`create table ${agg} (key text primary key, seq int not null default 0)`.execute()
    await db.sql`insert into ${agg} (key) select 'k' || g from generate_series(1, ${KEYS}::int) g`.execute()
    const procs = await Promise.all([0, 1, 2, 3].map(() => proc()))
    procs.map((p) => p.relay({ leaseMs: 3_000, pollMs: 50 }))

    const tasks = Array.from({ length: KEYS * PER }, (_, i) => `k${(i % KEYS) + 1}`)
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        for (let key = tasks.pop(); key !== undefined; key = tasks.pop()) {
          const k = key
          await db.transaction(async (tx) => {
            const [row] =
              await tx.sql`update ${agg} set seq = seq + 1 where key = ${k} returning seq`.execute()
            await topic.write({ key: k, seq: row!['seq'] as number }, { tx, key: k })
          })
        }
      }),
    )
    await until(() => [...log.values()].reduce((n, l) => n + l.length, 0) >= KEYS * PER, 120_000)
    const expected = Array.from({ length: PER }, (_, i) => i + 1)
    for (let k = 1; k <= KEYS; k++) expect(log.get(`k${k}`)).toStrictEqual(expected)
  }, 180_000)

  test('head failure keeps receiver order', async () => {
    let failedOnce = false
    const sent: string[] = []
    const { sink, got } = recordingSink<string>((r) => {
      sent.push(r.payload)
      if (r.payload === 'K1' && !failedOnce) {
        failedOnce = true
        return new Error('receiver down')
      }
      return undefined
    })
    const { db, topic, proc } = await setup(defineOutbox<string>('head'), sink)
    await db.transaction(async (tx) => {
      await topic.writeMany(
        [
          { payload: 'K1', key: 'K' },
          { payload: 'L1', key: 'L' },
          { payload: 'K2', key: 'K' },
          { payload: 'L2', key: 'L' },
          { payload: 'K3', key: 'K' },
        ],
        { tx },
      )
    })
    const p = await proc()
    p.relay({ pollMs: 20, retry: { baseDelayMs: 100, jitter: 'none' } })
    await until(() => got.length === 5)
    const k = got.map((r) => r.payload).filter((x) => x.startsWith('K'))
    expect(k).toStrictEqual(['K1', 'K2', 'K3'])
    expect(sent.filter((x) => x.startsWith('K'))).toStrictEqual(['K1', 'K1', 'K2', 'K3'])
    // L was not held up by K's failure.
    expect(got.findIndex((r) => r.payload === 'L2')).toBeLessThan(
      got.findIndex((r) => r.payload === 'K2'),
    )
  })

  test('no concurrent delivery of one partition while relays come and go', async () => {
    const spans: { p: number; epoch: bigint; from: number; to: number }[] = []
    const sink = functionSink<number>(async (wave, ctx) => {
      const from = performance.now()
      await sleep(2 + Math.random() * 8)
      spans.push({ p: ctx.partition, epoch: ctx.epoch, from, to: performance.now() })
      void wave
    })
    const { db, topic, proc } = await setup(defineOutbox<number>('spans', { partitions: 8 }), sink)
    let writing = true
    const writer = (async () => {
      for (let i = 0; writing; i++) {
        await topic.write(i, { tx: db, key: `k${i % 50}` })
        await sleep(1)
      }
    })()
    const opts = { leaseMs: 1_500, pollMs: 20 }
    const r1 = (await proc()).relay(opts)
    const r2 = (await proc()).relay(opts)
    await sleep(700)
    const r3 = (await proc()).relay(opts)
    await sleep(700)
    await r1.close()
    const r4 = (await proc()).relay(opts)
    await sleep(700)
    await r2.close()
    await sleep(700)
    writing = false
    await writer
    await until(async () => (await topic.stats()).pending === 0)
    await Promise.all([r3.close(), r4.close()])
    expect(spans.length).toBeGreaterThan(50)
    for (let p = 0; p < 8; p++) {
      const mine = spans.filter((s) => s.p === p).sort((a, b) => a.from - b.from)
      for (let i = 1; i < mine.length; i++) {
        expect(mine[i]!.from).toBeGreaterThanOrEqual(mine[i - 1]!.to)
        expect(mine[i]!.epoch).toBeGreaterThanOrEqual(mine[i - 1]!.epoch)
      }
    }
  })

  test('a failing partition does not let the next round serve its siblings twice', async () => {
    const spans: { p: number; from: number; to: number }[] = []
    const delivered: string[] = []
    const sink = functionSink<string>(async (wave, ctx) => {
      if (wave[0]!.payload === 'boom') return
      const from = performance.now()
      await sleep(300)
      spans.push({ p: ctx.partition, from, to: performance.now() })
      delivered.push(...wave.map((r) => r.payload))
    })
    const { schema, db, topic, proc } = await setup(
      defineOutbox<string>('isolate', { partitions: 4 }),
      sink,
    )
    // Settling a `boom` record throws, so its partition's serve rejects on every round.
    const fn = sql.ident(schema, 'boom')
    await db.sql`create function ${fn}() returns trigger language plpgsql
      as $$ begin raise exception 'boom'; end $$`.execute()
    await db.sql`create trigger boom before update or delete on ${sql.ident(schema, 'records')}
      for each row when (old.payload = '"boom"') execute function ${fn}()`.execute()
    const rows = await db.sql`select p, min(k) as k from (
        select 'k' || g as k, abs(hashtextextended('k' || g, 0) % 4) as p
        from generate_series(1, 100) g) x group by p order by p`.execute()
    const keyOf = rows.map((r) => r['k'] as string)

    await topic.pause()
    const opts = { leaseMs: 3_000, pollMs: 20 }
    const r1 = (await proc()).relay(opts)
    await until(() => r1.partitions.length === 4)
    const r2 = (await proc()).relay(opts)
    await until(() => r1.partitions.length === 2 && r2.partitions.length === 2, 5_000)
    expect([r1.partitions, r2.partitions]).toStrictEqual([
      [0, 1],
      [2, 3],
    ])
    // Each relay holds one failing partition and one whose serve takes three slow waves.
    await db.transaction((tx) =>
      topic.writeMany(
        [0, 2]
          .map((p) => ({ payload: 'boom', key: keyOf[p]! }))
          .concat(
            [1, 3].flatMap((p) => [1, 2, 3].map((i) => ({ payload: `${p}.${i}`, key: keyOf[p]! }))),
          ),
        { tx },
      ),
    )
    await topic.resume()
    await until(() => new Set(delivered).size === 6)
    await sleep(400)
    expect(delivered.sort()).toStrictEqual(['1.1', '1.2', '1.3', '3.1', '3.2', '3.3'])
    for (const p of [1, 3]) {
      const mine = spans.filter((s) => s.p === p).sort((a, b) => a.from - b.from)
      for (let i = 1; i < mine.length; i++)
        expect(mine[i]!.from).toBeGreaterThanOrEqual(mine[i - 1]!.to)
    }
  })

  test('rebalance 1 → 4 → 2: shares within one heartbeat, released partitions re-leased at once', async () => {
    const { sink } = recordingSink<number>()
    const { proc } = await setup(defineOutbox<number>('rebalance'), sink)
    const opts = { leaseMs: 3_000, pollMs: 5_000 }
    const r1 = (await proc()).relay(opts)
    await until(() => r1.partitions.length === 16)

    let t0 = performance.now()
    const rs = [r1, ...(await Promise.all([1, 2, 3].map(async () => (await proc()).relay(opts))))]
    await until(() => rs.every((r) => r.partitions.length === 4), 5_000)
    expect(performance.now() - t0).toBeLessThan(1_000 + 500)
    expect(new Set(rs.flatMap((r) => r.partitions)).size).toBe(16)

    t0 = performance.now()
    await Promise.all([rs[0]!.close(), rs[1]!.close()])
    await until(() => rs[2]!.partitions.length + rs[3]!.partitions.length === 16, 5_000)
    expect(performance.now() - t0).toBeLessThan(1_000)
    expect(Math.abs(rs[2]!.partitions.length - rs[3]!.partitions.length)).toBeLessThanOrEqual(1)
  })

  test('wake latency: p95 under 100 ms with pollMs 5000', async () => {
    const at = new Map<number, number>()
    const sink = functionSink<number>((wave) => {
      for (const r of wave) at.set(r.payload, performance.now())
      return Promise.resolve()
    })
    const { db, topic, proc } = await setup(defineOutbox<number>('wake'), sink)
    const relay = (await proc()).relay({ pollMs: 5_000 })
    await until(() => relay.partitions.length === 16)
    await sleep(200)
    const lat: number[] = []
    for (let i = 0; i < 40; i++) {
      await db.transaction((tx) => topic.write(i, { tx }))
      const committed = performance.now()
      await until(() => at.has(i), 6_000)
      lat.push(at.get(i)! - committed)
      await sleep(20)
    }
    lat.sort((a, b) => a - b)
    expect(lat[Math.floor(lat.length * 0.95)]).toBeLessThan(100)
  })
})

describe('relay close()', () => {
  const quiet = recordingSink<number>().sink

  test('waits for a retention sweep in flight, then leaves nothing behind', async () => {
    const { schema, db, proc } = await setup(defineOutbox<number>('sweep'), quiet)
    const p = await proc()
    // The sweep's gate updates the topic row, so it waits here.
    const unlock = await holding(
      db,
      sql`select from ${sql.ident(schema, 'topics')} for no key update`,
    )
    const relay = p.relay({ pollMs: 50 })
    await until(async () => (await busy(db, schema, true)) > 0)
    let closed = false
    const closing = relay.close().then(() => (closed = true))
    await sleep(300)
    expect(closed).toBe(false)
    await unlock()
    await closing
    expect(await busy(db, schema)).toBe(0)
    expect(await leftovers(db, schema)).toStrictEqual({ leases: 0, members: [] })
  })

  test('waits for a heartbeat in flight, so it cannot bring the membership row back', async () => {
    const { schema, db, proc } = await setup(defineOutbox<number>('ghost'), quiet)
    const relays = sql.ident(schema, 'relays')
    await db.sql`insert into ${relays} (topic, owner, seen_at)
      values ('ghost', 'stale', now() - interval '1 day')`.execute()
    // The heartbeat deletes stale members before it upserts its own row, so it waits here.
    const unlock = await holding(db, sql`select from ${relays} where owner = 'stale' for update`)
    const relay = (await proc()).relay({ graceMs: 100 })
    await until(async () => (await busy(db, schema, true)) > 0)
    let closed = false
    const closing = relay.close().then(() => (closed = true))
    await sleep(300)
    expect(closed).toBe(false)
    await unlock()
    await closing
    expect(await busy(db, schema)).toBe(0)
    expect(await leftovers(db, schema)).toStrictEqual({ leases: 0, members: [] })
  })

  test('an acquire that outlives graceMs releases what it took', async () => {
    const { schema, db, proc } = await setup(defineOutbox<number>('late'), quiet)
    // Only L1 sets a fresh token, so only L1 waits here.
    const fn = sql.ident(schema, 'stall')
    await db.sql`create function ${fn}() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock_shared(hashtext(tg_table_schema), 0); return new; end
      $$`.execute()
    await db.sql`create trigger stall before update on ${sql.ident(schema, 'partitions')}
      for each row when (new.token is distinct from old.token and new.token is not null)
      execute function ${fn}()`.execute()
    const unlock = await holding(db, sql`select pg_advisory_xact_lock(hashtext(${schema}), 0)`)
    const relay = (await proc()).relay({ graceMs: 100 })
    await until(async () => (await busy(db, schema, true)) > 0)
    await relay.close()
    await unlock()
    await until(async () => (await busy(db, schema)) === 0)
    await until(async () => (await leftovers(db, schema))!['leases'] === 0, 3_000)
    expect(await leftovers(db, schema)).toStrictEqual({ leases: 0, members: [] })
  })

  test('a start that outlives graceMs neither heartbeats nor leases', async () => {
    const { schema, db, proc } = await setup(defineOutbox<number>('slow'), quiet)
    // Any heartbeat would delete this row.
    await db.sql`insert into ${sql.ident(schema, 'relays')} (topic, owner, seen_at)
      values ('slow', 'stale', now() - interval '1 day')`.execute()
    // start() upserts the topic row, so it waits here.
    const unlock = await holding(
      db,
      sql`select from ${sql.ident(schema, 'topics')} for no key update`,
    )
    const relay = (await proc(false)).relay({ graceMs: 100 })
    await until(async () => (await busy(db, schema, true)) > 0)
    await relay.close()
    await unlock()
    await until(async () => (await busy(db, schema)) === 0)
    await sleep(300)
    expect(await leftovers(db, schema)).toStrictEqual({ leases: 0, members: ['stale'] })
    // Not even leased and given back.
    const [p] =
      await db.sql`select max(epoch) as e from ${sql.ident(schema, 'partitions')}`.execute()
    expect(p!['e']).toBe(0n)
  })

  test('keeps heartbeating while a wave finishes within graceMs', async () => {
    let entered!: () => void
    const delivering = new Promise<void>((r) => (entered = r))
    const sink = functionSink<number>(async () => {
      entered()
      await sleep(4_000)
    })
    const { db, topic, proc } = await setup(defineOutbox<number>('grace', { partitions: 1 }), sink)
    await topic.write(1, { tx: db })
    const relay = (await proc()).relay({ leaseMs: 1_500, pollMs: 20 })
    await delivering
    await relay.close()
    expect((await topic.stats()).pending).toBe(0)
  })
})
