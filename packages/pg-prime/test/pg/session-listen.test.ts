/**
 * LISTEN / NOTIFY against a real server, tier 2 (design/07 §6.5; design/12 §3 S, decision 8).
 *
 * Three claims, and none of them can be made anywhere else:
 *
 *  1. **The connection is dedicated and there is exactly one of it.** `pg_stat_activity` is the
 *     oracle. On PGlite every "connection" is the same backend, so a implementation that took a
 *     pool client — the thing `07` §6.5 forbids — would look identical.
 *  2. **A killed backend produces `reconnect` and `gap`.** `pg_terminate_backend` needs a second
 *     session.
 *  3. **The gap is real**: a notification published while we were down is LOST, which is the whole
 *     reason `'gap'` exists and the reason the doc says a LISTEN-based cache invalidation without
 *     it is incorrect.
 */

import { afterAll, beforeAll, describe, expect } from 'vitest'
import pg from 'pg'
import { defineSchema, pgTable } from '../../src/schema/index.js'
import { pgPrime } from '../../src/query/run.js'
import type { Db } from '../../src/query/types.js'
import { UnsupportedInPoolerModeError, UsageError } from '../../src/errors/index.js'
import { liveTarget, requiresConcurrency } from '../live/_harness.js'

const APP = 'pgprime_listen_probe'
const marker = pgTable('listen_marker', (t) => ({ id: t.integer().primaryKey() }))
const schema = defineSchema({ marker })

let db: Db<typeof schema>

async function client(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: liveTarget().url })
  await c.connect()
  return c
}

beforeAll(() => {
  // Through `connection:` on purpose: that is the path that supplies `createDedicatedClient`, and
  // therefore the only one where `PgDriver.connect()` opens a socket the pool does not own.
  db = pgPrime({
    schema,
    connection: liveTarget().url,
    session: { applicationName: APP },
    poolOptions: { max: 2 },
    // `devGuard: false` turns off §5.4's dev-mode startup probe, which opens up to three extra
    // pooled connections once to create the contention it needs. This file COUNTS backends, so a
    // diagnostic that opens some would make every assertion here a race. Nothing else in this file
    // depends on the guard.
    devGuard: false,
  })
})

afterAll(async () => {
  await db?.end().catch(() => {})
})

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Backends belonging to this test's `application_name`, from a THIRD session. */
async function backends(c: pg.Client): Promise<{ pid: number; query: string }[]> {
  const r = await c.query<{ pid: number; query: string }>(
    `select pid, query from pg_stat_activity where application_name = $1 order by pid`,
    [APP],
  )
  return r.rows
}

describe('LISTEN owns a dedicated connection (07 §6.5)', () => {
  requiresConcurrency()(
    'exactly ONE extra backend appears while subscribed, and it goes away on close',
    async () => {
      const watcher = await client()
      try {
        // Warm the pool first, so the count below is about the LISTEN connection and nothing else.
        await db.sql`select 1`.execute()
        const before = (await backends(watcher)).length

        const seen: string[] = []
        const a = await db.listen('chan_a', (payload) => seen.push(`a:${payload}`))
        const b = await db.listen('chan_b', (payload) => seen.push(`b:${payload}`))
        await sleep(150)

        const during = await backends(watcher)
        // ONE more, for TWO channels: the connection is multiplexed and reference-counted.
        expect(during.length).toBe(before + 1)
        const listener = during.find((r) => /^\s*listen /i.test(r.query))
        expect(listener).toBeDefined()

        await db.notify('chan_a', 'one')
        await db.notify('chan_b', 'two')
        await sleep(300)
        expect(seen.sort()).toStrictEqual(['a:one', 'b:two'])

        await a.close()
        await sleep(100)
        // Still one: `chan_b` is still subscribed, so the shared connection stays.
        expect((await backends(watcher)).length).toBe(before + 1)

        await b.close()
        await sleep(200)
        expect((await backends(watcher)).length).toBe(before)
      } finally {
        await watcher.end()
      }
    },
    60_000,
  )

  requiresConcurrency()(
    'a killed backend produces reconnect AND gap, and the subscription keeps working',
    async () => {
      const killer = await client()
      try {
        const got: string[] = []
        const reconnects: number[] = []
        const gaps: number[] = []
        const sub = await db.listen('chan_kill', (payload) => got.push(payload))
        sub.on('reconnect', (i) => reconnects.push(i.attempt))
        sub.on('gap', (i) => gaps.push(i.downMs))
        await sleep(150)

        const before = await backends(killer)
        const listener = before.find((r) => /^\s*listen /i.test(r.query))
        expect(listener).toBeDefined()

        await killer.query('select pg_terminate_backend($1)', [listener!.pid])

        // Full-jitter backoff starts at 100 ms, so this is generous rather than tight.
        const deadline = Date.now() + 20_000
        while (reconnects.length === 0 && Date.now() < deadline) await sleep(100)
        expect(reconnects).toStrictEqual([1])
        // `'gap'` fires with the outage, AFTER the re-LISTEN — so a reconcile started here cannot
        // miss a notification published between the two steps.
        expect(gaps).toHaveLength(1)
        expect(gaps[0]).toBeGreaterThanOrEqual(0)

        // And the subscription really works again: a NOTIFY from a third session arrives.
        await killer.query(`select pg_notify('chan_kill', 'after-reconnect')`)
        const until = Date.now() + 10_000
        while (got.length === 0 && Date.now() < until) await sleep(50)
        expect(got).toStrictEqual(['after-reconnect'])

        await sub.close()
      } finally {
        await killer.end()
      }
    },
    90_000,
  )
})

describe('notify is pg_notify($1,$2) and works everywhere (07 §6.5)', () => {
  requiresConcurrency()(
    'the payload is a bind parameter, so a quote in it is just a quote',
    async () => {
      const listener = await client()
      try {
        await listener.query(`listen "chan_quote"`)
        const arrived: string[] = []
        listener.on('notification', (n) => arrived.push(n.payload ?? ''))
        const evil = `'); drop table x; --`
        await db.notify('chan_quote', evil)
        const deadline = Date.now() + 5_000
        while (arrived.length === 0 && Date.now() < deadline) await sleep(50)
        expect(arrived).toStrictEqual([evil])
      } finally {
        await listener.end()
      }
    },
    60_000,
  )

  requiresConcurrency()(
    'the 8000-byte payload limit is enforced client-side, at the REAL boundary',
    async () => {
      await expect(db.notify('chan_big', 'x'.repeat(8000))).rejects.toBeInstanceOf(UsageError)
      await expect(db.notify('chan_big', 'x'.repeat(8000))).rejects.toThrow(/8000 bytes/)
      // 7999 is the largest PostgreSQL accepts — its own check is `>= 8000` (async.c), which is why
      // `07` §6.5's "at most 8000" is off by one and this test is the measurement that says so.
      await expect(db.notify('chan_big', 'x'.repeat(7999))).resolves.toBeUndefined()
    },
    60_000,
  )

  requiresConcurrency()(
    'notify works inside a transaction and delivers on COMMIT, not before',
    async () => {
      const listener = await client()
      try {
        await listener.query(`listen "chan_tx"`)
        const arrived: string[] = []
        listener.on('notification', (n) => arrived.push(n.payload ?? ''))

        await db.transaction(async (tx) => {
          await tx.notify('chan_tx', 'committed')
          await sleep(200)
          // Still nothing: PostgreSQL queues NOTIFY until commit.
          expect(arrived).toStrictEqual([])
        })
        const deadline = Date.now() + 5_000
        while (arrived.length === 0 && Date.now() < deadline) await sleep(50)
        expect(arrived).toStrictEqual(['committed'])

        // And a rolled-back NOTIFY never arrives at all.
        await db.transaction(async (tx) => {
          await tx.notify('chan_tx', 'rolled-back')
          return tx.rollbackWith(null)
        })
        await sleep(300)
        expect(arrived).toStrictEqual(['committed'])
      } finally {
        await listener.end()
      }
    },
    60_000,
  )
})

describe('LISTEN under a transaction pooler profile (07 §5.3)', () => {
  requiresConcurrency()(
    'without directConnection it is refused, naming the config key that fixes it',
    async () => {
      const pooled = pgPrime({
        schema,
        connection: liveTarget().url,
        poolerMode: 'transaction',
        poolOptions: { max: 1 },
      })
      try {
        const err = await pooled.listen('nope', () => {}).catch((e: unknown) => e)
        expect(err).toBeInstanceOf(UnsupportedInPoolerModeError)
        expect((err as Error).message).toMatch(/directConnection/)
        // The asymmetry: NOTIFY still works in the same profile.
        await expect(pooled.notify('nope', 'x')).resolves.toBeUndefined()
      } finally {
        await pooled.end().catch(() => {})
      }
    },
    60_000,
  )

  requiresConcurrency()(
    'with directConnection it is routed there automatically',
    async () => {
      const pooled = pgPrime({
        schema,
        connection: liveTarget().url,
        directConnection: liveTarget().url,
        poolerMode: 'transaction',
        poolOptions: { max: 1 },
      })
      try {
        const got: string[] = []
        const sub = await pooled.listen('chan_direct', (p) => got.push(p))
        await pooled.notify('chan_direct', 'routed')
        const deadline = Date.now() + 5_000
        while (got.length === 0 && Date.now() < deadline) await sleep(50)
        expect(got).toStrictEqual(['routed'])
        await sub.close()
      } finally {
        await pooled.end().catch(() => {})
      }
    },
    60_000,
  )
})
