import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { UsageError } from 'pg-prime'
import type { Db } from 'pg-prime'
import { CronLeaseLostError, defineSchedule, pgCron, SchemaVersionError } from '../../src/index.js'
import type { Cron, CronConfig, RunContext } from '../../src/index.js'
import { dropSchema, open, rows, server, sleep, until } from '../_harness.js'

const S = 'pgprime_cron_live'
let srv: Awaited<ReturnType<typeof server>>
let db: Db
const crons: Cron[] = []

const make = (cfg: Partial<CronConfig> = {}): Cron => {
  const c = pgCron({
    db,
    schema: S,
    pollMs: 200,
    leaseMs: 3000,
    maintenanceMs: 300,
    graceMs: 500,
    ...cfg,
  })
  crons.push(c)
  return c
}
const q = (text: string) => rows(db, text.replaceAll('$S', S))
const runsOf = (name: string) =>
  q(`select id, state::text as state, tick_at, manual, missed, error, attempts, payload, result
     from $S.runs where schedule = '${name}' order by id`)
const sched = async (name: string) =>
  (await q(`select * from $S.schedules where name = '${name}'`))[0]!

beforeAll(async () => {
  srv = await server()
  db = open(srv.url, srv.pglite ? 1 : 4)
}, 60_000)

beforeEach(async () => {
  await Promise.all(crons.splice(0).map((c) => c.close()))
  await dropSchema(db, S)
})

afterAll(async () => {
  await Promise.all(crons.splice(0).map((c) => c.close()))
  await dropSchema(db, S).catch(() => {})
  await db.end()
  await srv.stop()
})

describe('start and sync', () => {
  it('migrates once and syncs code schedules', async () => {
    const a = defineSchedule('a', { everyMs: 60_000 }, { handler: async () => {} })
    await make({ schedules: [a] }).start()
    await make({ schedules: [a] }).start()
    const s = await sched('a')
    expect(s['source']).toBe('code')
    expect(s['next_at']).toBeInstanceOf(Date)
    expect((await q(`select version from $S.migrations`)).length).toBe(1)
  })

  it('an already-aborted signal closes the instance before it starts', async () => {
    const c = make({ signal: AbortSignal.abort() })
    await expect(c.start()).rejects.toBeInstanceOf(UsageError)
  })

  it('refuses a missing schema with autoMigrate off', async () => {
    await expect(make({ autoMigrate: false }).start()).rejects.toBeInstanceOf(SchemaVersionError)
  })
})

describe('handler runs', () => {
  it('claims and runs a tick, recording history', async () => {
    const seen: RunContext<{ n: number }>[] = []
    const a = defineSchedule<{ n: number }>(
      'a',
      { everyMs: 1000 },
      {
        handler: async (r) => {
          seen.push(r)
          return { ok: true }
        },
      },
      { payload: { n: 7 } },
    )
    await make({ schedules: [a] }).start()
    await until(async () => (await runsOf('a')).some((r) => r['state'] === 'succeeded'))
    const [r] = await runsOf('a')
    expect(r).toMatchObject({
      state: 'succeeded',
      manual: false,
      attempts: 1,
      result: { ok: true },
    })
    expect(seen[0]).toMatchObject({
      schedule: 'a',
      manual: false,
      payload: { n: 7 },
      attempt: 1,
      missed: 0,
    })
    expect((await sched('a'))['running']).toBe(0)
  })

  it('manual trigger is picked up by the instance that registered the handler', async () => {
    let got: unknown
    const a = defineSchedule(
      'a',
      { cron: '0 0 1 1 *' },
      { handler: async (r) => void (got = r.payload) },
    )
    const c = make({ schedules: [a] })
    await c.start()
    const t = await c.trigger('a', { payload: { x: 1 } })
    expect(t.state).toBe('pending')
    await until(async () => (await runsOf('a'))[0]?.['state'] === 'succeeded')
    expect(got).toEqual({ x: 1 })
    await expect(c.trigger('nope')).rejects.toBeInstanceOf(UsageError)
  })

  it('a finish that matches no row reports a lost lease, not a completion', async () => {
    const ends: string[] = []
    const lost: unknown[] = []
    const a = defineSchedule(
      'a',
      { cron: '0 0 1 1 *' },
      {
        handler: async () =>
          void (await q(`update $S.runs set state = 'failed', token = null where schedule = 'a'`)),
      },
    )
    const c = make({
      schedules: [a],
      hooks: {
        onRunEnd: (e) => void ends.push(e.state),
        onInternal: (e) => void lost.push(e.cause),
      },
    })
    await c.start()
    await c.trigger('a')
    await until(() => lost.length > 0)
    await c.close()
    expect(lost[0]).toBeInstanceOf(CronLeaseLostError)
    expect(ends).toEqual([])
  })

  it('cancels a pending run and a running one', async () => {
    let aborted = false
    const a = defineSchedule(
      'a',
      { cron: '0 0 1 1 *' },
      {
        handler: (r) =>
          new Promise((resolve) =>
            r.signal.addEventListener('abort', () => resolve((aborted = true))),
          ),
      },
    )
    const admin = make()
    await make({ schedules: [a] }).start()
    const { runId } = await admin.trigger('a')
    await until(async () => (await runsOf('a'))[0]?.['state'] === 'running')
    expect(await admin.cancel(runId)).toBe(true)
    await until(async () => (await runsOf('a'))[0]?.['state'] === 'cancelled')
    expect(aborted).toBe(true)
    expect((await sched('a'))['running']).toBe(0)
  })
})

describe('overlap', () => {
  const slow = (ms: number) => async () => void (await sleep(ms))

  it("'skip' never runs two at once; 'allow' does", async () => {
    let live = 0
    let peak = 0
    const handler = async () => {
      peak = Math.max(peak, ++live)
      await sleep(2500)
      live--
    }
    const skip = defineSchedule('skip', { everyMs: 1000 }, { handler })
    await make({ schedules: [skip] }).start()
    await until(async () => (await runsOf('skip')).some((r) => r['state'] === 'skipped'))
    expect(peak).toBe(1)

    const allow = defineSchedule(
      'allow',
      { everyMs: 1000 },
      { handler: slow(2500) },
      { overlap: 'allow' },
    )
    await make({ schedules: [allow] }).start()
    await until(async () => ((await sched('allow'))['running'] as number) >= 2)
  })

  it('a timed-out handler that ignores its signal keeps the slot until it settles', async () => {
    let calls = 0
    const a = defineSchedule(
      'a',
      { everyMs: 1000 },
      { handler: async () => void (calls++, await sleep(2200)) },
      { timeoutMs: 300 },
    )
    await make({ schedules: [a] }).start()
    await until(async () => (await runsOf('a'))[0]?.['state'] === 'cancelling')
    await until(async () => (await runsOf('a')).some((r) => r['state'] === 'skipped'))
    expect(calls).toBe(1)
    await until(async () => (await runsOf('a'))[0]?.['state'] === 'failed')
    expect((await runsOf('a'))[0]).toMatchObject({ error: 'timeout' })
    await until(async () => calls === 2)
  })
})

describe('misfire', () => {
  const shift = async (name: string, sql: string) => {
    await q(`update $S.schedules set paused = true where name = '${name}'`)
    await q(`update $S.schedules set ${sql}, paused = false where name = '${name}'`)
  }

  it("'once' after 10 ticks of downtime: one run with missed = 9, next tick in the future", async () => {
    const misses: number[] = []
    const a = defineSchedule('a', { everyMs: 60_000 }, { handler: async () => {} })
    const c = make({ schedules: [a], hooks: { onMisfire: (e) => void misses.push(e.missed) } })
    await c.start()
    const before = (await sched('a'))['next_at'] as Date
    await c.pause('a')
    await shift(
      'a',
      `next_at = next_at - interval '10 minutes', anchor_at = anchor_at - interval '10 minutes'`,
    )
    await c.resume('a')
    await until(async () => (await runsOf('a')).length === 1)
    const [r] = await runsOf('a')
    expect(r).toMatchObject({ missed: 9 })
    expect((r!['tick_at'] as Date).getTime()).toBe(before.getTime() - 60_000)
    expect(((await sched('a'))['next_at'] as Date).getTime()).toBe(before.getTime())
    expect(misses).toEqual([9])
  })

  it("'skip' records one missed run and runs nothing", async () => {
    let calls = 0
    const a = defineSchedule(
      'a',
      { everyMs: 60_000 },
      { handler: async () => void calls++ },
      { misfire: 'skip' },
    )
    await make({ schedules: [a] }).start()
    await shift(
      'a',
      `next_at = next_at - interval '5 minutes', anchor_at = anchor_at - interval '5 minutes'`,
    )
    await until(async () => (await runsOf('a')).length === 1)
    expect((await runsOf('a'))[0]).toMatchObject({ state: 'missed', missed: 4 })
    expect(calls).toBe(0)
    expect((await sched('a'))['running']).toBe(0)
  })

  it('an every schedule keeps its grid across restarts', async () => {
    const a = defineSchedule('a', { everyMs: 1000 }, { handler: async () => {} })
    const first = make({ schedules: [a] })
    await first.start()
    const anchor = (await sched('a'))['anchor_at'] as Date
    await first.close()
    await sleep(1500)
    await make({
      schedules: [defineSchedule('a', { everyMs: 1000 }, { handler: async () => {} })],
    }).start()
    await until(async () => (await runsOf('a')).length >= 2)
    const s = await sched('a')
    expect(s['anchor_at']).toEqual(anchor)
    for (const r of await runsOf('a'))
      expect(((r['tick_at'] as Date).getTime() - anchor.getTime()) % 1000).toBe(0)
  })
})

describe('bounds and history', () => {
  it('limit claims that many ticks, then ends', async () => {
    const a = defineSchedule('a', { everyMs: 1000 }, { handler: async () => {} }, { limit: 2 })
    await make({ schedules: [a] }).start()
    await until(async () => (await sched('a'))['next_at'] === null)
    expect((await runsOf('a')).length).toBe(2)
    expect((await sched('a'))['runs']).toBe(2)
  })

  it('a one-shot at fires once', async () => {
    let calls = 0
    const a = defineSchedule(
      'a',
      { at: new Date(Date.now() + 300) },
      { handler: async () => void calls++ },
    )
    await make({ schedules: [a] }).start()
    await until(async () => (await runsOf('a'))[0]?.['state'] === 'succeeded')
    await sleep(500)
    expect(calls).toBe(1)
    expect((await sched('a'))['next_at']).toBeNull()
  })

  it('retention keeps the newest history.keep finished runs', async () => {
    const a = defineSchedule(
      'a',
      { everyMs: 1000 },
      { handler: async () => {} },
      { history: { keep: 2 } },
    )
    await make({ schedules: [a] }).start()
    await until(async () => ((await sched('a'))['runs'] as number) >= 5, 20_000)
    await until(
      async () => (await runsOf('a')).filter((r) => r['state'] === 'succeeded').length <= 2,
    )
    expect((await runsOf('a'))[0]!['id']).toBeGreaterThan(1n)
  })
})

describe('admin', () => {
  it('create, get, list, update, runs, preview, prune, remove', async () => {
    const c = make()
    await c.create(
      defineSchedule(
        'api',
        { cron: '0 3 * * *', tz: 'Europe/Berlin' },
        { handler: async () => {} },
      ),
    )
    await expect(
      c.create(defineSchedule('api', { everyMs: 1000 }, { handler: async () => {} })),
    ).rejects.toBeInstanceOf(UsageError)
    const info = await c.get('api')
    expect(info).toMatchObject({
      source: 'api',
      target: 'handler',
      when: { cron: '0 3 * * *', tz: 'Europe/Berlin' },
    })
    expect(await c.get('nope')).toBeUndefined()

    await c.update('api', { when: { everyMs: 5000 }, timeoutMs: 100 })
    const updated = await c.get('api')
    expect(updated).toMatchObject({ when: { everyMs: 5000 }, timeoutMs: 100, overlap: 'skip' })
    expect(updated!.nextAt!.getTime()).not.toBe(info!.nextAt!.getTime())
    await expect(c.update('nope', {})).rejects.toBeInstanceOf(UsageError)

    const p = await c.preview(
      { cron: '0 0 * * *' },
      { count: 2, from: new Date('2026-01-01T12:00:00Z') },
    )
    expect(p.map((d) => d.toISOString())).toEqual([
      '2026-01-02T00:00:00.000Z',
      '2026-01-03T00:00:00.000Z',
    ])

    for (let i = 0; i < 3; i++) await c.trigger('api')
    const page = await c.runs('api', { limit: 2 })
    expect(page.length).toBe(2)
    expect((await c.runs('api', { before: page[1]!.id })).length).toBe(1)
    await expect(c.remove('api')).rejects.toBeInstanceOf(UsageError)
    expect(await c.remove('api', { force: true })).toBe(true)
    expect(await c.remove('api')).toBe(false)

    await make({
      schedules: [defineSchedule('x', { everyMs: 60_000 }, { handler: async () => {} })],
    }).start()
    expect(await c.prune([])).toEqual(['x'])
    expect(await c.list()).toEqual([])
  })

  it('pause/resume and disable/enable', async () => {
    const a = defineSchedule('a', { everyMs: 60_000 }, { handler: async () => {} })
    const c = make({ schedules: [a] })
    await c.start()
    await c.pause('a')
    expect((await c.get('a'))!.paused).toBe(true)
    await c.disable('a')
    expect((await c.get('a'))!).toMatchObject({ enabled: false, nextAt: null })
    await c.enable('a')
    expect((await c.get('a'))!.nextAt!.getTime()).toBeGreaterThan(Date.now())
    await c.resume('a')
    expect((await c.get('a'))!).toMatchObject({ enabled: true, paused: false })
    await expect(c.pause('nope')).rejects.toBeInstanceOf(UsageError)
  })

  it('sync updates a changed definition and keeps operational flags', async () => {
    const c = make({
      schedules: [defineSchedule('a', { everyMs: 60_000 }, { handler: async () => {} })],
    })
    await c.start()
    await c.pause('a')
    const before = await sched('a')
    await c.close()
    await make({
      schedules: [defineSchedule('a', { everyMs: 60_000 }, { handler: async () => {} })],
    }).start()
    expect((await sched('a'))['next_at']).toEqual(before['next_at'])
    await make({
      schedules: [defineSchedule('a', { everyMs: 120_000 }, { handler: async () => {} })],
    }).start()
    const after = await sched('a')
    expect(after).toMatchObject({ paused: true, every_ms: 120_000n })
    expect(after['spec_hash']).not.toBe(before['spec_hash'])
    expect(after['next_at']).not.toEqual(before['next_at'])
  })
})

describe('isolation', () => {
  it('a throwing hook is reported and does not stop the loop', async () => {
    const internal: string[] = []
    const a = defineSchedule('a', { everyMs: 1000 }, { handler: async () => {} })
    await make({
      schedules: [a],
      hooks: {
        onTick: () => {
          throw new Error('boom')
        },
        onInternal: (e) => void internal.push(e.kind),
      },
    }).start()
    await until(
      async () => (await runsOf('a')).filter((r) => r['state'] === 'succeeded').length >= 2,
    )
    expect(internal).toContain('hook-failed')
  })

  it('a schedule whose payload throws does not block the others', async () => {
    const internal: string[] = []
    const bad = defineSchedule<null>(
      'bad',
      { everyMs: 1000 },
      { handler: async () => {} },
      {
        payload: () => {
          throw new Error('no payload')
        },
      },
    )
    const good = defineSchedule('good', { everyMs: 1000 }, { handler: async () => {} })
    await make({
      schedules: [bad, good],
      hooks: { onInternal: (e) => void internal.push(e.kind) },
    }).start()
    await until(
      async () => (await runsOf('good')).filter((r) => r['state'] === 'succeeded').length >= 2,
    )
    expect(internal).toContain('loop-failed')
    expect(await runsOf('bad')).toEqual([])
  })
})
