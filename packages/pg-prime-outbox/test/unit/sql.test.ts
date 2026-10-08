import { createMockPool } from '@pg-prime/testing'
import { pgPrime, sql } from 'pg-prime'
import { describe, expect, it } from 'vitest'
import { channelOf, hooksOf } from '../../src/context.js'
import type { TopicCtx } from '../../src/context.js'
import { defineOutbox } from '../../src/index.js'
import {
  readPartition,
  settleDelivered,
  settleFailed,
  settleParked,
  sweep,
} from '../../src/relay/deliver.js'
import { acquire, heartbeat, release } from '../../src/relay/lease.js'
import { createTopic, discard, listParked, replay, setPaused, stats } from '../../src/sql/admin.js'
import { writeRecords } from '../../src/sql/write.js'
import { schema } from '../support.js'

const lease = { p: 3, token: 'tok', epoch: 7n }

/** Every statement the package sends, by name, as the mock pool recorded it. */
async function statements(): Promise<Record<string, string>> {
  const pool = createMockPool()
  const db = pgPrime({ pool, schema })
  const ctx = (keepDeliveredMs = 1000): TopicCtx<unknown> => ({
    db,
    s: sql.ident('pgprime_outbox'),
    def: defineOutbox('orders', { keepDeliveredMs }),
    chan: channelOf('pgprime_outbox', 'orders'),
    hooks: hooksOf(undefined),
    start: () => Promise.resolve(),
    decode: (r) => r as never,
  })
  const calls: Record<string, () => Promise<unknown>> = {
    W1: () => writeRecords(ctx(), [{ payload: 1, key: 'k', idempotencyKey: 'i' }], db),
    heartbeat: () => heartbeat(ctx(), 'me', 30_000, [lease]),
    L1: () => acquire(ctx(), 'me', 30_000),
    release: () => release(ctx(), 'me', [lease], true),
    R1: () => readPartition(ctx(), 3, 100),
    D1: () => settleDelivered(ctx(), lease, [1n]),
    'D1 (keepDeliveredMs: 0)': () => settleDelivered(ctx(0), lease, [1n]),
    F1: () => settleFailed(ctx(), lease, 1n, 'err', 500),
    K1: () => settleParked(ctx(), lease, 1n, 'err'),
    retention: () => sweep(ctx(), 30_000, 5000, false),
    start: () => createTopic(ctx()),
    parked: () => listParked(ctx(), 10, 0n),
    replay: () => replay(ctx(), [1n]),
    discard: () => discard(ctx(), [1n]),
    pause: () => setPaused(ctx(), true),
    stats: () => stats(ctx()),
  }
  const out: Record<string, string> = {}
  for (const [name, call] of Object.entries(calls)) {
    const before = pool.texts.length
    // The mock answers with no rows; only the SQL text matters here.
    await call().catch(() => {})
    const sent = pool.texts.slice(before).filter((t) => t.includes('"pgprime_outbox"'))
    sent.forEach((t, i) => (out[i === 0 ? name : `${name} #${i + 1}`] = t))
  }
  await db.end()
  return out
}

const targets = (text: string): string[] =>
  [...text.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+"pgprime_outbox"\.(\w+)/g)].map(
    (m) => m[1]!,
  )

describe('statements', () => {
  it('golden SQL', async () => {
    expect(await statements()).toMatchSnapshot()
  })

  it('no two data-modifying CTEs of one statement can touch the same row', async () => {
    // Same table, disjoint rows: the membership upsert (owner = $me) and the stale sweep (owner <> $me).
    const disjoint: Record<string, string[]> = { heartbeat: ['relays'] }
    for (const [name, text] of Object.entries(await statements())) {
      const ts = targets(text)
      const repeated = ts.filter((t, i) => ts.indexOf(t) !== i)
      expect([name, repeated]).toStrictEqual([name, disjoint[name] ?? []])
    }
  })
})
