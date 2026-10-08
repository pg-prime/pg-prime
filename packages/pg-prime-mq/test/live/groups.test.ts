import { describe, expect, it } from 'vitest'
import { sql } from 'pg-prime'
import { defineQueue, pgMq } from '../../src/index.js'
import { freshSchema, sleep, until, useServer } from '../_db.js'

const server = useServer()
type P = { g: string; n: number }
const fast = { pollMs: 20, expireScanMs: 20, maintenanceMs: 20 }
const pad = (i: number) => `g${String(i).padStart(2, '0')}`

function setup(opts: Parameters<typeof defineQueue<P>>[1] = {}) {
  const db = server.db()
  const schema = freshSchema()
  const q = pgMq({ db, schema }).queue(defineQueue<P>('jobs', opts))
  return { db, schema, q }
}

async function sendGroups(q: ReturnType<typeof setup>['q'], groups: number, each: number) {
  const items = []
  for (let n = 0; n < each; n++)
    for (let i = 1; i <= groups; i++)
      items.push({ payload: { g: pad(i), n }, opts: { group: pad(i) } })
  await q.sendMany(items)
}

describe('groups (S5)', () => {
  it('with n = 1 and 12 busy groups, every group is served once per 12 fetches, FIFO within', async () => {
    const { q } = setup()
    await sendGroups(q, 12, 3)
    const served: P[] = []
    const w = q.work(async (m) => void served.push(m.payload), { ...fast, group: { scan: 4 } })
    await until(() => served.length === 36)
    await w.close()
    for (let round = 0; round < 3; round++) {
      const slice = served.slice(round * 12, round * 12 + 12)
      expect(new Set(slice.map((p) => p.g)).size).toBe(12)
      expect(slice.every((p) => p.n === round)).toBe(true)
    }
  })

  it('advances its cursor past paused groups and serves the next one', async () => {
    const { q } = setup()
    await sendGroups(q, 8, 1)
    for (let i = 1; i <= 4; i++) await q.pauseGroup(pad(i))
    const served: string[] = []
    const w = q.work(async (m) => void served.push(m.payload.g), { ...fast, group: { scan: 4 } })
    await until(() => served.length === 4)
    expect(served).toStrictEqual(['g05', 'g06', 'g07', 'g08'])
    await q.resumeGroup('g02')
    await until(() => served.length === 5)
    await w.close()
    expect(served[4]).toBe('g02')
  })

  it('a saturated worker goes back to an empty claim path within pollMs', async () => {
    const { q } = setup()
    await sendGroups(q, 200, 1)
    const served: string[] = []
    const w = q.work(
      async (m) => {
        served.push(m.payload.g)
        await sleep(10)
      },
      { ...fast, pollMs: 100, concurrency: 2 },
    )
    await until(() => served.length >= 10)
    await q.send({ g: 'plain', n: 0 })
    await until(() => served.includes('plain'))
    await w.close()
    expect(served.indexOf('plain')).toBeLessThan(150)
  })

  it('manual claims serve groups round-robin and move past paused ones', async () => {
    const { q } = setup()
    await sendGroups(q, 8, 2)
    for (let i = 1; i <= 4; i++) await q.pauseGroup(pad(i))
    const served: string[][] = []
    for (let i = 0; i < 7; i++) {
      const ms = await q.claim()
      for (const m of ms) await q.complete(m, undefined)
      served.push(ms.map((m) => m.payload.g))
    }
    // A call that probes only paused groups comes back empty; the next one goes on after them.
    expect(served).toStrictEqual([[], ['g05'], ['g06'], ['g07'], ['g08'], [], ['g05']])
  })

  it('a group concurrency of 1 runs one message of a group at a time', async () => {
    const { q } = setup()
    await sendGroups(q, 3, 4)
    const running = new Map<string, number>()
    let worst = 0
    let done = 0
    const w = q.work(
      async (m) => {
        const r = (running.get(m.payload.g) ?? 0) + 1
        running.set(m.payload.g, r)
        worst = Math.max(worst, r)
        await sleep(5)
        running.set(m.payload.g, r - 1)
        done++
      },
      { ...fast, concurrency: 6, group: { concurrency: 1 } },
    )
    await until(() => done === 12)
    await w.close()
    expect(worst).toBe(1)
  })

  it('setGroupLimits overrides one group; every grouped send has its group row', async () => {
    const { db, schema, q } = setup()
    await sendGroups(q, 2, 3)
    await q.setGroupLimits('g01', { concurrency: 2 })
    const rows =
      await db.sql`select key, concurrency from ${sql.ident(schema, 'groups')} order by key`.execute()
    expect(rows).toStrictEqual([
      { key: 'g01', concurrency: 2 },
      { key: 'g02', concurrency: null },
    ])
    await q.setGroupLimits('g01', { concurrency: null })
    const [r] =
      await db.sql`select concurrency from ${sql.ident(schema, 'groups')} where key = 'g01'`.execute()
    expect(r?.['concurrency']).toBeNull()
  })

  it('a group rate limits claims per window', async () => {
    const { q } = setup()
    await sendGroups(q, 1, 4)
    await q.setGroupLimits('g01', { rate: { max: 2, perMs: 300 } })
    const at: number[] = []
    const w = q.work(async () => void at.push(Date.now()), { ...fast, concurrency: 4 })
    await until(() => at.length === 4, 5000)
    await w.close()
    expect(at[2]! - at[0]!).toBeGreaterThanOrEqual(250)
  })
})

describe('global limits (S4)', () => {
  it('global concurrency holds for grouped and ungrouped messages; the counter returns to 0', async () => {
    const { db, schema, q } = setup({ concurrency: 2 })
    await q.sendMany(
      Array.from({ length: 10 }, (_, n) => ({
        payload: { g: '', n },
        opts: n % 2 ? { group: pad(n % 3) } : {},
      })),
    )
    let running = 0
    let worst = 0
    let done = 0
    const w = q.work(
      async () => {
        worst = Math.max(worst, ++running)
        await sleep(5)
        running--
        done++
      },
      { ...fast, concurrency: 5 },
    )
    await until(() => done === 10)
    await w.close()
    expect(worst).toBeLessThanOrEqual(2)
    const [r] = await db.sql`select active from ${sql.ident(schema, 'queues')}`.execute()
    expect(r?.['active']).toBe(0)
  })

  it('a global rate caps claims per window', async () => {
    const { q } = setup({ rate: { max: 2, perMs: 300 } })
    await q.sendMany(Array.from({ length: 4 }, (_, n) => ({ payload: { g: '', n } })))
    const at: number[] = []
    const w = q.work(async () => void at.push(Date.now()), { ...fast, concurrency: 4 })
    await until(() => at.length === 4, 5000)
    await w.close()
    expect(at[2]! - at[0]!).toBeGreaterThanOrEqual(250)
  })

  it('localRate caps this worker', async () => {
    const { q } = setup()
    await q.sendMany(Array.from({ length: 3 }, (_, n) => ({ payload: { g: '', n } })))
    const at: number[] = []
    const w = q.work(async () => void at.push(Date.now()), {
      ...fast,
      concurrency: 3,
      localRate: { max: 1, perMs: 150 },
    })
    await until(() => at.length === 3, 5000)
    await w.close()
    expect(at[2]! - at[0]!).toBeGreaterThanOrEqual(280)
  })
})
