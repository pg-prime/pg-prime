import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { seed } from '../../src/log/cursor.js'
import { statements } from '../../src/log/sql.js'
import { backoffMs } from '../../src/util.js'
import { recorder } from './_fake.js'

const c = seed(100n, [90n, 95n])

async function all() {
  const { q, seen } = recorder([[{ ids: [1n], woke: true }], [{ xmax: '100', xip: ['90'] }]])
  const s = statements('pgprime_events')
  await s.publish(q, 'orders', 'ev_x', [
    { type: 't', key: null, headers: { h: '1' }, payload: '{"a":1}' },
  ])
  await s.seedNow(q)
  await s.upsertTopic(q, 'orders', 1000, true)
  await s.upsertSubscription(q, 'orders', 'billing', ['t'], c)
  await s.lease(q, 'orders', 'billing', 30_000)
  await s.heartbeat(q, 'orders', 'billing', 'tok', 30_000)
  await s.release(q, 'orders', 'billing', 'tok')
  await s.read(q, 'orders', c, 100, null).catch(() => {})
  await s.mark(q, 'orders', 'billing', 'tok', 5n, 3)
  await s.commit(q, 'orders', 'billing', 'tok', c)
  await s.stored(q, 'orders', 'billing', 'tok')
  await s.nack(q, 'orders', 'billing', 'tok', 250)
  await s.park(q, 'orders', 'billing', 'tok', c, 5n, 3, 'boom')
  await s.maintain(q, 'orders', 60_000)
  await s.reset(q, 'orders', 'billing', c)
  await s.lag(q, 'orders', 'billing').catch(() => {})
  await s.parked(q, 'orders', 'billing', 10)
  await s.discard(q, 'orders', 'billing', [5n])
  await s.remove(q, 'orders', 'billing')
  await s.browse(q, 'orders', 0n, 10)
  return seen
}

describe('statements', () => {
  it('match the golden SQL, labelled events.<op>', async () => {
    const seen = await all()
    expect(
      seen.map((x) => `-- ${x.label}\n${x.sql.replace(/\s+/g, ' ').trim()}`).join('\n\n'),
    ).toMatchSnapshot()
    expect(seen.map((x) => x.params)).toMatchSnapshot()
  })

  it('never modify the same table twice in one statement', async () => {
    for (const { label, sql } of await all()) {
      const writes = [
        ...sql.matchAll(/\b(?:insert into|update|delete from)\s+("[^"]+"\."[^"]+")/g),
      ].map((m) => m[1])
      expect(new Set(writes).size, label).toBe(writes.length)
    }
  })

  it('reference every pg_notify from the final select', async () => {
    const [publish] = await all()
    expect(publish?.sql).toMatch(/select array_agg\(id order by id\) as ids,\s+\(select pg_notify/)
  })
})

describe('backoffMs', () => {
  it('matches the family fixed vectors', () => {
    const { vectors } = JSON.parse(
      readFileSync(new URL('../../../../fixtures/backoff/vectors.json', import.meta.url), 'utf8'),
    ) as {
      vectors: {
        policy: { baseDelayMs: number; maxDelayMs: number; jitter: 'full' | 'equal' | 'none' }
        attempt: number
        random: number
        delayMs: number
      }[]
    }
    expect(vectors.length).toBeGreaterThan(0)
    for (const v of vectors) expect(backoffMs(v.policy, v.attempt, () => v.random)).toBe(v.delayMs)
  })
})
