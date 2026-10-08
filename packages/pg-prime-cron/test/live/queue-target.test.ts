import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { UsageError } from 'pg-prime'
import type { Db } from 'pg-prime'
import { defineQueue, pgMq } from '@pg-prime/mq'
import { defineSchedule, pgCron } from '../../src/index.js'
import type { Cron, CronConfig, ScheduleOptions } from '../../src/index.js'
import { dropSchema, open, rows, server, sleep, until } from '../_harness.js'

const S = 'pgprime_cron_qt'
const MQ = 'pgprime_mq_qt'
const jobs = defineQueue<unknown>('jobs')
let srv: Awaited<ReturnType<typeof server>>
let db: Db
const crons: Cron[] = []

const mq = () => pgMq({ db, schema: MQ })
const make = (cfg: Partial<CronConfig> = {}): Cron => {
  const c = pgCron({ db, schema: S, pollMs: 200, maintenanceMs: 300, enqueuer: mq(), ...cfg })
  crons.push(c)
  return c
}
const q = (text: string) => rows(db, text.replaceAll('$S', S).replaceAll('$MQ', MQ))
const runsOf = (state?: string) =>
  q(`select id, state::text as state, tick_at, manual, missed, message_id, finished_at
     from $S.runs where schedule = 'q' ${state ? `and state = '${state}'` : ''} order by id`)
const messages = () => q(`select id, key, payload, state from $MQ.messages order by id`)
// mq refuses a null payload (not-null violation), so every schedule here carries one.
const schedule = (o: ScheduleOptions<unknown> = {}, everyMs = 1000) =>
  defineSchedule('q', { everyMs }, { queue: jobs }, { payload: { n: 1 }, ...o })

beforeAll(async () => {
  srv = await server()
  db = open(srv.url, srv.pglite ? 1 : 4)
}, 60_000)

beforeEach(async () => {
  await Promise.all(crons.splice(0).map((c) => c.close()))
  await dropSchema(db, S)
  await dropSchema(db, MQ)
})

afterAll(async () => {
  await Promise.all(crons.splice(0).map((c) => c.close()))
  await dropSchema(db, S).catch(() => {})
  await dropSchema(db, MQ).catch(() => {})
  await db.end()
  await srv.stop()
})

describe('queue target', () => {
  it('cron.start() starts a bare pgMq queue; each tick sends one message', async () => {
    const decisions: string[] = []
    await make({
      schedules: [schedule({ overlap: 'allow' })],
      hooks: { onTick: (e) => void decisions.push(e.decision) },
    }).start()
    await until(async () => (await runsOf('enqueued')).length >= 2)
    await crons[0]!.close()
    const runs = await runsOf()
    const msgs = await messages()
    expect(runs.every((r) => r['state'] === 'enqueued' && r['finished_at'] !== null)).toBe(true)
    expect(msgs).toHaveLength(runs.length)
    expect(msgs.map((m) => [m['id'], m['key'], m['payload']])).toEqual(
      runs.map((r) => [r['message_id'], `cron:q:${(r['tick_at'] as Date).getTime()}`, { n: 1 }]),
    )
    expect(new Set(decisions)).toEqual(new Set(['enqueued']))
    expect((await q(`select running from $S.schedules`))[0]).toEqual({ running: 0 })
  })

  it("overlap 'skip' sends nothing while the previous message is unfinished", async () => {
    const enqueuer = mq()
    await make({ schedules: [schedule()], enqueuer }).start()
    await until(async () => (await runsOf('skipped')).length >= 2)
    const [first] = await runsOf('enqueued')
    expect(await messages()).toHaveLength(1)
    expect((await runsOf('skipped')).every((r) => r['message_id'] === first!['message_id'])).toBe(
      true,
    )

    const h = enqueuer.queue(jobs)
    const [m] = await h.claim()
    await h.complete(m!, undefined)
    await until(async () => (await runsOf('enqueued')).length === 2)
    expect((await messages()).map((x) => x['key'])).toEqual(['cron:q', 'cron:q'])
  })

  it("misfire 'skip' after downtime records one missed run and sends nothing", async () => {
    const c = make({ schedules: [schedule({ misfire: 'skip' }, 60_000)] })
    await c.start()
    await c.pause('q')
    await q(`update $S.schedules set next_at = next_at - interval '10 minutes',
             anchor_at = anchor_at - interval '10 minutes' where name = 'q'`)
    await c.resume('q')
    await until(async () => (await runsOf()).length === 1)
    expect((await runsOf())[0]).toMatchObject({ state: 'missed', missed: 9, message_id: null })
    expect(await messages()).toEqual([])
    expect(
      ((await q(`select next_at from $S.schedules`))[0]!['next_at'] as Date) > new Date(),
    ).toBe(true)
  })

  it('a manual trigger sends once and creates no pending run', async () => {
    const yearly = (o: ScheduleOptions<unknown>) =>
      defineSchedule('q', { cron: '0 0 1 1 *' }, { queue: jobs }, { payload: { n: 1 }, ...o })
    const c = make({ schedules: [yearly({ overlap: 'allow' })] })
    await c.start()
    const a = await c.trigger('q', { payload: { x: 1 } })
    const b = await c.trigger('q')
    expect([a.state, b.state]).toEqual(['enqueued', 'enqueued'])
    expect((await messages()).map((m) => [m['key'], m['payload']])).toEqual([
      [`cron:q:manual:${a.runId}`, { x: 1 }],
      [`cron:q:manual:${b.runId}`, { n: 1 }],
    ])
    expect((await runsOf()).map((r) => [r['id'], r['manual'], r['state']])).toEqual([
      [a.runId, true, 'enqueued'],
      [b.runId, true, 'enqueued'],
    ])

    await c.close()
    await dropSchema(db, S)
    await dropSchema(db, MQ)
    const skip = make({ schedules: [yearly({})] })
    await skip.start()
    expect((await skip.trigger('q')).state).toBe('enqueued')
    expect((await skip.trigger('q')).state).toBe('skipped')
    expect(await messages()).toHaveLength(1)
  })

  it('only an instance that declared the queue and has an enqueuer claims or triggers it', async () => {
    const plain = pgCron({ db, schema: S, pollMs: 200, schedules: [schedule()] })
    crons.push(plain)
    await plain.start()
    await expect(plain.trigger('q')).rejects.toBeInstanceOf(UsageError)
    await expect(make().trigger('q')).rejects.toBeInstanceOf(UsageError)
    await sleep(1500)
    expect(await runsOf()).toEqual([])
  })
})
