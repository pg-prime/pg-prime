import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { requiresConcurrency } from '@pg-prime/testing'
import { defineQueue, pgMq } from '@pg-prime/mq'
import { defineSchema, pgPrime } from 'pg-prime'
import type { Db } from 'pg-prime'
import { defineSchedule, pgCron } from '../../src/index.js'
import type { Cron, CronEnqueuer } from '../../src/index.js'
import { dropSchema, open, rows, sleep } from '../_harness.js'

const S = 'pgprime_cron_qt_pg'
const MQ = 'pgprime_mq_qt_pg'
const direct = process.env['PG_PRIME_TEST_URL'] ?? ''
const pgbouncer = process.env['PG_PRIME_TEST_PGBOUNCER_URL']
const targets = [{ name: 'direct', url: direct, pooled: false }]
if (pgbouncer) targets.push({ name: 'pgbouncer transaction mode', url: pgbouncer, pooled: true })

const test = requiresConcurrency(it)
const jobs = defineQueue<{ n: number }>('jobs')
let admin: Db
const dbs: Db[] = []
const crons: Cron[] = []
const q = (text: string) => rows(admin, text.replaceAll('$S', S).replaceAll('$MQ', MQ))

beforeAll(async () => {
  if (direct) admin = open(direct, 2)
})
afterEach(async () => {
  await Promise.all(crons.splice(0).map((c) => c.close()))
  await Promise.all(dbs.splice(0).map((d) => d.end()))
})
afterAll(async () => {
  if (!admin) return
  await dropSchema(admin, S)
  await dropSchema(admin, MQ)
  await admin.end()
})

describe.each(targets)('queue target on $name', ({ url, pooled }) => {
  test('one message per tick across 3 instances, with transactions failing after the send', async () => {
    await dropSchema(admin, S)
    await dropSchema(admin, MQ)
    let crashes = 0
    // Throws after mq's insert, inside the claim's transaction: a crash before COMMIT.
    const flaky = (mq: CronEnqueuer): CronEnqueuer => ({
      queue: (def) => {
        const h = mq.queue(def)
        return {
          start: () => h.start!(),
          send: async (payload, opts) => {
            const r = await h.send(payload, opts)
            if (Math.random() < 0.3) throw new Error(`crash ${++crashes}`)
            return r
          },
        }
      },
    })
    const tick = defineSchedule(
      'q',
      { everyMs: 1000 },
      { queue: jobs },
      { overlap: 'allow', payload: { n: 1 } },
    )
    await Promise.all(
      [0, 1, 2].map((i) => {
        const db = pgPrime({
          connection: url,
          schema: defineSchema({}),
          poolOptions: { max: 3 },
          ...(pooled ? { poolerMode: 'pgbouncer-transaction' as const } : {}),
        })
        dbs.push(db)
        const c = pgCron({
          db,
          schema: S,
          instance: `i${i}`,
          pollMs: pooled ? 250 : 1000,
          schedules: [tick],
          enqueuer: flaky(pgMq({ db, schema: MQ })),
        })
        crons.push(c)
        return c.start()
      }),
    )
    await sleep(12_000)
    await Promise.all(crons.map((c) => c.close()))

    const runs = await q(`select state::text as state, tick_at, message_id, instance
      from $S.runs where schedule = 'q' order by tick_at`)
    const msgs = await q(`select id, key from $MQ.messages order by id`)
    expect(crashes).toBeGreaterThan(0)
    expect(runs.length).toBeGreaterThanOrEqual(10)
    expect(runs.every((r) => r['state'] === 'enqueued')).toBe(true)
    const ticks = runs.map((r) => (r['tick_at'] as Date).getTime())
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]! - ticks[i - 1]!).toBe(1000)
    expect(new Set(runs.map((r) => r['instance'])).size).toBeGreaterThan(1)
    expect(new Set(msgs.map((m) => m['key'])).size).toBe(msgs.length)
    expect(msgs.map((m) => [m['id'], m['key']])).toEqual(
      runs.map((r) => [r['message_id'], `cron:q:${(r['tick_at'] as Date).getTime()}`]),
    )
  }, 60_000)
})
