/**
 * `forUpdate({ wait })` — the queue-workload guarantee (design/09 WS4, tier 2).
 *
 * This is the one builder feature that **cannot** be tested on tier 1. PGlite multiplexes every
 * connection onto one backend, so session B sees session A's uncommitted locks as its own and a
 * completely broken `SKIP LOCKED` would test green (design/08 §4.2, F8). So: two real backends,
 * A holds a row inside a transaction, and B's three wait modes are checked against it.
 *
 * What each mode must do, and what going wrong looks like in production:
 *
 *   `skip locked` — return the OTHER rows, immediately. If it blocks instead, every worker in a
 *                   queue serialises behind the slowest job.
 *   `nowait`      — raise 55P03 immediately. If it blocks, a health check hangs.
 *   `block`       — wait. Asserted by *not* completing while the lock is held, then completing
 *                   once it is released, which is the only honest way to test a wait.
 */

import { afterAll, beforeAll, describe, expect } from 'vitest'
import { Registry } from '../../src/codec/index.js'
import { pgOrm } from '../../src/query/run.js'
import type { Db } from '../../src/query/types.js'
import * as q from '../../src/query/types.js'
import { makeHarness, requiresConcurrency, sqlState, type Harness } from '../live/_harness.js'
import type { PgConnection } from '../../src/driver/index.js'
import { makeFixture, type Fixture } from '../live/fixture.js'

const fx: Fixture = makeFixture('pgorm_q_locking')

let h: Harness
/** Session A: holds locks. It is a raw connection, so nothing about the builder can hide a bug. */
let a: PgConnection
/** Session B: the builder, on its own pool. */
let db: Db<Fixture['schema']>
let admin: PgConnection

beforeAll(async () => {
  h = await makeHarness(4)
  admin = await h.driver.acquire()
  a = await h.driver.acquire()
  await admin.execute({ text: fx.drop, params: [], mode: 'simple' })
  await admin.execute({ text: fx.ddl, params: [], mode: 'simple' })
  await admin.execute({ text: fx.seed, params: [], mode: 'simple' })
  const registry = new Registry()
  registry.setServerParameters(admin.serverParameters)
  await registry.resolveDynamic(admin, [
    { schema: fx.ns, name: 'user_role', kind: 'enum', enumLabels: ['admin', 'owner', 'member'] },
  ])
  db = pgOrm({ driver: h.driver, schema: fx.schema, registry })
}, 120_000)

afterAll(async () => {
  await admin?.execute({ text: 'rollback', params: [], mode: 'simple' }).catch(() => {})
  await a?.execute({ text: 'rollback', params: [], mode: 'simple' }).catch(() => {})
  await admin?.execute({ text: fx.drop, params: [], mode: 'simple' }).catch(() => {})
  if (h) {
    await h.driver.release(a, { dispose: true })
    await h.driver.release(admin, { dispose: true })
    await h.end()
  }
})

/** Session A takes and holds a row lock. Returns the id it locked. */
async function lockOneRow(): Promise<string> {
  await a.execute({ text: 'begin', params: [], mode: 'simple' })
  const r = await a.execute({
    text: `select id from ${fx.ns}.posts order by id limit 1 for update`,
    params: [],
  })
  return String(r.rows[0]![0])
}

const claim = (wait: 'skip locked' | 'nowait' | 'block') =>
  db
    .from(fx.schema.h.posts)
    .select(({ posts: p }) => ({ id: p.id }))
    .orderBy(({ posts: p }) => q.asc(p.id))
    .forUpdate({ of: ['posts'], wait })

describe('for update … with a row already locked by another session', () => {
  requiresConcurrency()('skip locked returns the other rows, immediately', async () => {
    const locked = await lockOneRow()
    try {
      const compiled = claim('skip locked').compile()
      expect(compiled.sql).toContain('for update of "posts" skip locked')

      const rows = await claim('skip locked').execute()
      // Every row except the one A holds — and it did not block to find that out.
      expect(rows.map((r) => String(r.id))).not.toContain(locked)
      expect(rows).toHaveLength(5)
    } finally {
      await a.execute({ text: 'rollback', params: [], mode: 'simple' })
    }
  })

  requiresConcurrency()('nowait raises 55P03 rather than waiting', async () => {
    await lockOneRow()
    try {
      const err = await claim('nowait').execute().catch((e: unknown) => e)
      expect(sqlState(err)).toBe('55P03')
    } finally {
      await a.execute({ text: 'rollback', params: [], mode: 'simple' })
    }
  })

  requiresConcurrency()('the default blocks, and completes when the lock is released', async () => {
    await lockOneRow()
    let settled = false
    const pending = claim('block')
      .execute()
      .then((rows) => {
        settled = true
        return rows
      })

    // It must NOT have finished while A holds the row. A generous window, because the assertion
    // that matters is the ordering, not the duration.
    await new Promise((r) => setTimeout(r, 300))
    expect(settled).toBe(false)

    await a.execute({ text: 'rollback', params: [], mode: 'simple' })
    const rows = await pending
    expect(settled).toBe(true)
    expect(rows).toHaveLength(6)
  })

  requiresConcurrency()('skip locked with no contention returns everything', async () => {
    expect(await claim('skip locked').execute()).toHaveLength(6)
  })
})
