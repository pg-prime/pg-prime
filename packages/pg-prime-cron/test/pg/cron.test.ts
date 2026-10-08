import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { requiresConcurrency } from '@pg-prime/testing'
import { defineSchema, pgPrime } from 'pg-prime'
import type { Db } from 'pg-prime'
import { defineSchedule, pgCron } from '../../src/index.js'
import type { Cron, CronConfig, ScheduleDef } from '../../src/index.js'
import { dropSchema, open, rows, sleep, until } from '../_harness.js'

const S = 'pgprime_cron_pg'
const direct = process.env['PG_PRIME_TEST_URL'] ?? ''
const pgbouncer = process.env['PG_PRIME_TEST_PGBOUNCER_URL']
const targets = [{ name: 'direct', url: direct, pooled: false }]
if (pgbouncer) targets.push({ name: 'pgbouncer transaction mode', url: pgbouncer, pooled: true })
else if (direct)
  process.stderr.write(
    '[pg] skip: PG_PRIME_TEST_PGBOUNCER_URL is unset, so the cron suite runs direct only\n',
  )

const test = requiresConcurrency(it)
let admin: Db
const dbs: Db[] = []
const crons: Cron[] = []

const q = (text: string) => rows(admin, text.replaceAll('$S', S))
const runsOf = (name: string) =>
  q(`select id, state::text as state, tick_at, started_at, manual, missed, error, instance
     from $S.runs where schedule = '${name}' order by tick_at nulls last, id`)
const sched = async (name: string) =>
  (await q(`select * from $S.schedules where name = '${name}'`))[0]!

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
  await admin.end()
})

describe.each(targets)('cron on $name', ({ url, pooled }) => {
  const internal: string[] = []
  const instance = (cfg: Partial<CronConfig> = {}): Cron => {
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
      pollMs: pooled ? 250 : 1000,
      leaseMs: 1500,
      maintenanceMs: 500,
      graceMs: 500,
      hooks: { onInternal: (e) => void internal.push(e.kind) },
      ...cfg,
    })
    crons.push(c)
    return c
  }
  const fleet = async (n: number, schedules: (i: number) => ScheduleDef<any>[]) => {
    const all = Array.from({ length: n }, (_, i) =>
      instance({ schedules: schedules(i), instance: `i${i}` }),
    )
    await Promise.all(all.map((c) => c.start()))
    return all
  }
  const fresh = async () => {
    await dropSchema(admin, S)
    internal.length = 0
  }

  test('tick fires once across 5 instances', async () => {
    await fresh()
    const calls = new Map<string, number>()
    const handler = async (r: { schedule: string; tickAt: Date | null }) => {
      const k = `${r.schedule}@${r.tickAt?.toISOString()}`
      calls.set(k, (calls.get(k) ?? 0) + 1)
    }
    await fleet(5, () => [
      defineSchedule('every', { everyMs: 1000 }, { handler }),
      defineSchedule('cron', { cron: '*/1 * * * * *' }, { handler }),
    ])
    await sleep(20_000)
    await Promise.all(crons.map((c) => c.close()))
    for (const name of ['every', 'cron']) {
      const runs = await runsOf(name)
      expect(runs.length).toBeGreaterThanOrEqual(18)
      expect(runs.every((r) => r['state'] === 'succeeded')).toBe(true)
      const ticks = runs.map((r) => (r['tick_at'] as Date).getTime())
      for (let i = 1; i < ticks.length; i++) expect(ticks[i]! - ticks[i - 1]!).toBe(1000)
      expect(new Set(runs.map((r) => r['instance'])).size).toBeGreaterThan(1)
    }
    expect([...calls.values()].every((n) => n === 1)).toBe(true)
    expect(calls.size).toBe((await runsOf('every')).length + (await runsOf('cron')).length)
    if (pooled) expect(internal).toContain('listen-unavailable')
  }, 60_000)

  test("overlap under 3 instances: 'skip' never two running, 'allow' runs concurrently", async () => {
    await fresh()
    const live = { skip: 0, allow: 0 }
    const peak = { skip: 0, allow: 0 }
    const slow = (k: 'skip' | 'allow') => async () => {
      peak[k] = Math.max(peak[k], ++live[k])
      await sleep(2500)
      live[k]--
    }
    await fleet(3, () => [
      defineSchedule('skip', { everyMs: 1000 }, { handler: slow('skip') }),
      defineSchedule('allow', { everyMs: 1000 }, { handler: slow('allow') }, { overlap: 'allow' }),
    ])
    await sleep(8000)
    expect(peak.skip).toBe(1)
    expect(peak.allow).toBeGreaterThanOrEqual(2)
    expect((await runsOf('skip')).some((r) => r['state'] === 'skipped')).toBe(true)
  }, 60_000)

  test('instance SIGKILL mid-run: lease expires, slot frees, the next tick fires on time', async () => {
    await fresh()
    await instance().start()
    const child = spawn(process.execPath, [await victim(), url, S, pooled ? '1' : '0'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    try {
      await new Promise<void>((res, rej) => {
        child.stdout.on('data', (d: Buffer) => d.toString().includes('running') && res())
        child.on('exit', (code) => rej(new Error(`victim exited early with ${code}`)))
      })
    } finally {
      child.kill('SIGKILL')
    }
    const killedAt = Date.now()
    const ran: Date[] = []
    await instance({
      schedules: [
        defineSchedule(
          'victim',
          { everyMs: 2000 },
          { handler: async (r) => void ran.push(r.tickAt!) },
        ),
      ],
    }).start()
    await until(async () => (await runsOf('victim'))[0]?.['state'] === 'failed')
    expect(Date.now() - killedAt).toBeLessThan(1500 + 500 + 1500)
    expect((await runsOf('victim'))[0]).toMatchObject({ error: 'lease-expired' })
    await until(async () => (await runsOf('victim')).some((r) => r['state'] === 'succeeded'))
    const next = (await runsOf('victim')).find((r) => r['state'] === 'succeeded')!
    expect(
      (next['started_at'] as Date).getTime() - (next['tick_at'] as Date).getTime(),
    ).toBeLessThan(1000)
    await Promise.all(crons.map((c) => c.close()))
    expect((await sched('victim'))['running']).toBe(0)
  }, 60_000)

  test('a manual run is picked only by an instance that registered the handler', async () => {
    await fresh()
    const where: string[] = []
    const s = defineSchedule(
      's',
      { cron: '0 0 1 1 *' },
      { handler: async () => void where.push('a') },
    )
    await instance({ schedules: [s], instance: 'a' }).start()
    const b = instance({
      schedules: [defineSchedule('other', { cron: '0 0 1 1 *' }, { handler: async () => {} })],
      instance: 'b',
    })
    await b.start()
    const { runId, state } = await b.trigger('s')
    expect(state).toBe('pending')
    await until(async () => (await runsOf('s'))[0]?.['state'] === 'succeeded')
    expect(where).toEqual(['a'])
    expect((await runsOf('s'))[0]).toMatchObject({ id: runId, instance: 'a', manual: true })
  }, 30_000)

  test('a manual trigger is picked by exactly one of 3 owners', async () => {
    await fresh()
    let calls = 0
    const all = await fleet(3, () => [
      defineSchedule('s', { cron: '0 0 1 1 *' }, { handler: async () => void calls++ }),
    ])
    await all[1]!.trigger('s')
    await until(async () => (await runsOf('s'))[0]?.['state'] === 'succeeded')
    await sleep(1000)
    expect(calls).toBe(1)
    expect((await runsOf('s')).length).toBe(1)
  }, 30_000)

  test("cancel under 'skip': no second run starts until the cancelled handler stops", async () => {
    await fresh()
    let live = 0
    let peak = 0
    let stoppedAt = 0
    const handler = async (r: { signal: AbortSignal }) => {
      peak = Math.max(peak, ++live)
      await new Promise((res) => r.signal.addEventListener('abort', res))
      await sleep(1500)
      live--
      stoppedAt = Date.now()
    }
    const all = await fleet(3, () => [defineSchedule('s', { everyMs: 1000 }, { handler })])
    await until(async () => (await runsOf('s')).some((r) => r['state'] === 'running'))
    const first = (await runsOf('s')).find((r) => r['state'] === 'running')!
    expect(await all[0]!.cancel(first['id'] as bigint)).toBe(true)
    await until(
      async () =>
        (await runsOf('s')).find((r) => r['id'] === first['id'])!['state'] === 'cancelled',
    )
    const runs = await runsOf('s')
    const later = runs.filter((r) => r['state'] !== 'skipped' && r['id'] !== first['id'])
    for (const r of later)
      expect((r['started_at'] as Date).getTime()).toBeGreaterThanOrEqual(stoppedAt - 50)
    expect(peak).toBe(1)
    await Promise.all(crons.map((c) => c.close()))
    expect((await sched('s'))['running']).toBe(0)
  }, 30_000)

  test("misfire 'once' after 10 ticks of downtime: one run, missed = 9, next tick in the future", async () => {
    await fresh()
    const s = () => [
      defineSchedule('s', { everyMs: 2000 }, { handler: async () => {} }, { misfireGraceMs: 1000 }),
    ]
    const first = instance({ schedules: s() })
    await first.start()
    await first.close()
    await q(
      `update $S.schedules set next_at = next_at - interval '20 seconds', anchor_at = anchor_at - interval '20 seconds'`,
    )
    const before = (await sched('s'))['next_at'] as Date
    await fleet(3, s)
    await until(async () => (await runsOf('s'))[0]?.['state'] === 'succeeded')
    const [r] = await runsOf('s')
    expect(r).toMatchObject({ missed: 9, state: 'succeeded' })
    expect((r!['tick_at'] as Date).getTime()).toBe(before.getTime() + 18_000)
    expect(((await sched('s'))['next_at'] as Date).getTime()).toBe(before.getTime() + 20_000)
  }, 30_000)

  test('misfire past endAt: the fired tick is at or before endAt and the schedule ends', async () => {
    for (const misfire of ['once', 'skip'] as const) {
      await fresh()
      const [{ now }] = (await q(
        `select date_trunc('hour', now()) - interval '3 hours' as now`,
      )) as [{ now: Date }]
      const endAt = now
      let calls = 0
      const def = defineSchedule(
        's',
        { cron: '0 * * * *' },
        { handler: async () => void calls++ },
        { endAt, misfire },
      )
      const c = instance()
      await c.create(def)
      await q(
        `update $S.schedules set next_at = '${new Date(endAt.getTime() - 3_600_000).toISOString()}'`,
      )
      await fleet(3, () => [def])
      await until(async () => (await sched('s'))['next_at'] === null)
      const runs = await runsOf('s')
      expect(runs.length).toBe(1)
      expect((runs[0]!['tick_at'] as Date).getTime()).toBe(endAt.getTime())
      expect(runs[0]).toMatchObject({
        missed: 1,
        state: misfire === 'skip' ? 'missed' : 'succeeded',
      })
      await until(() => calls === (misfire === 'once' ? 1 : 0))
      await Promise.all(crons.splice(0).map((x) => x.close()))
    }
  }, 60_000)
})

// Claims a tick, says so, then hangs until killed.
const VICTIM = `
import { defineSchema, pgPrime } from 'pg-prime'
import { defineSchedule, pgCron } from '../../src/index.js'
const [url, schema, pooled] = process.argv.slice(2)
const db = pgPrime({
  connection: url,
  schema: defineSchema({}),
  ...(pooled === '1' ? { poolerMode: 'pgbouncer-transaction' } : {}),
})
const handler = () => (console.log('running'), new Promise(() => {}))
const victim = defineSchedule('victim', { everyMs: 2000 }, { handler })
await pgCron({ db, schema, pollMs: 200, leaseMs: 1500, schedules: [victim] }).start()
`

let bundled: Promise<string> | undefined
/** The victim as one ESM file, so a plain `node`/`bun` child can run the sources. */
function victim(): Promise<string> {
  return (bundled ??= (async () => {
    const { build } = await import('esbuild')
    const outfile = join(tmpdir(), `pgprime-cron-victim-${process.pid}.mjs`)
    await build({
      stdin: { contents: VICTIM, resolveDir: import.meta.dirname, loader: 'ts' },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      alias: { 'pg-prime': resolve(import.meta.dirname, '../../../pg-prime/src/index.ts') },
      external: ['pg-native'],
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      logLevel: 'error',
    })
    return outfile
  })())
}
