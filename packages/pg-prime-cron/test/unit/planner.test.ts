import { describe, expect, it } from 'vitest'
import { plan, type PlanInput } from '../../src/planner.js'
import { ticker, type Spec, type Ticker } from '../../src/ticks.js'

const D = (s: string) => new Date(s)
const iso = (d: Date | null) => d?.toISOString() ?? null
const spec: Spec = {
  pattern: null,
  everyMs: null,
  at: null,
  tz: 'UTC',
  startAt: null,
  endAt: null,
  anchorAt: D('2026-01-01T00:00:00Z'),
}
const every = (ms: number, extra: Partial<Spec> = {}) => ticker({ ...spec, everyMs: ms, ...extra })
const input = (p: Partial<PlanInput> & Pick<PlanInput, 'nextAt' | 'dbNow'>): PlanInput => ({
  endAt: null,
  maxRuns: null,
  runs: 0,
  misfire: 'once',
  graceMs: 60_000,
  ...p,
})

/** What the instance loop does with the planner: claim, store `next`, repeat while due. */
function loop(t: Ticker, p: PlanInput) {
  const fired: { fire: string | null; missed: number; decided: string | null }[] = []
  let cur: PlanInput | null = p
  while (cur !== null && cur.nextAt <= cur.dbNow) {
    const r = plan(cur, t)
    expect(r.expect).toBe(cur.nextAt)
    fired.push({ fire: iso(r.fire), missed: r.missed, decided: r.decided })
    cur = r.next === null ? null : { ...cur, nextAt: r.next, runs: cur.runs + (r.fire ? 1 : 0) }
  }
  return { fired, next: cur?.nextAt ?? null }
}

describe('inside grace', () => {
  it('a loop 5 periods late fires every tick in order, none dropped', async () => {
    const t = await every(1000)
    const r = loop(t, input({ nextAt: D('2026-01-01T00:00:01Z'), dbNow: D('2026-01-01T00:00:05.200Z') }))
    expect(r.fired.map((f) => f.fire)).toEqual([1, 2, 3, 4, 5].map((s) => `2026-01-01T00:00:0${s}.000Z`))
    expect(r.fired.every((f) => f.missed === 0 && f.decided === null)).toBe(true)
    expect(iso(r.next)).toBe('2026-01-01T00:00:06.000Z')
  })
})

describe('misfire beyond grace', () => {
  const late = input({ nextAt: D('2026-01-01T10:00:00Z'), dbNow: D('2026-01-01T10:09:30Z') })

  it("'once' fires the latest tick and folds the other 9; expect is the stored next_at", async () => {
    const r = plan(late, await every(60_000))
    expect(r).toMatchObject({ decided: null, missed: 9, misfired: true })
    expect(iso(r.expect)).toBe('2026-01-01T10:00:00.000Z')
    expect(iso(r.fire)).toBe('2026-01-01T10:09:00.000Z')
    expect(iso(r.next)).toBe('2026-01-01T10:10:00.000Z')
  })

  it("'skip' records one missed run at the latest tick", async () => {
    const r = plan({ ...late, misfire: 'skip' }, await every(60_000))
    expect(r).toMatchObject({ decided: 'missed', missed: 9 })
    expect(iso(r.fire)).toBe('2026-01-01T10:09:00.000Z')
    expect(iso(r.next)).toBe('2026-01-01T10:10:00.000Z')
  })

  it('caps the count at 10 000 and still fires the latest tick', async () => {
    const r = plan(input({ nextAt: D('2026-01-01T00:00:00Z'), dbNow: D('2026-01-02T00:00:00Z') }), await every(1000))
    expect(r.missed).toBe(9_999)
    expect(iso(r.fire)).toBe('2026-01-02T00:00:00.000Z')
  })
})

describe('endAt', () => {
  it('downtime across endAt fires a tick at or before endAt, then ends', async () => {
    const endAt = D('2026-01-01T12:00:00Z')
    const t = await ticker({ ...spec, pattern: '0 * * * *', endAt })
    for (const misfire of ['once', 'skip'] as const) {
      const r = plan(input({ nextAt: D('2026-01-01T11:00:00Z'), dbNow: D('2026-01-01T15:30:00Z'), endAt, misfire }), t)
      expect(iso(r.fire)).toBe('2026-01-01T12:00:00.000Z')
      expect(r.missed).toBe(1)
      expect(r.next).toBeNull()
      expect(r.decided).toBe(misfire === 'skip' ? 'missed' : null)
    }
  })

  it('no fired tick is ever after endAt, under any policy', async () => {
    const endAt = D('2026-01-01T00:10:30Z')
    const t = await every(60_000, { endAt })
    for (const misfire of ['once', 'skip'] as const) {
      for (const graceMs of [0, 60_000, 3_600_000]) {
        for (const lateMin of [0, 1, 5, 30, 600]) {
          const nextAt = D('2026-01-01T00:05:00Z')
          const dbNow = new Date(nextAt.getTime() + lateMin * 60_000)
          const r = loop(t, input({ nextAt, dbNow, endAt, misfire, graceMs }))
          for (const f of r.fired) if (f.fire) expect(f.fire <= endAt.toISOString()).toBe(true)
        }
      }
    }
  })

  it('a stored next_at past endAt fires nothing', async () => {
    const endAt = D('2026-01-01T00:00:00Z')
    const r = plan(input({ nextAt: D('2026-01-01T01:00:00Z'), dbNow: D('2026-01-01T02:00:00Z'), endAt }), await every(60_000))
    expect(r.fire).toBeNull()
    expect(r.next).toBeNull()
  })
})

describe('limit counts claimed ticks', () => {
  it('ends after the limit-th claim, whatever each claim decided', async () => {
    const t = await every(1000)
    const at = D('2026-01-01T00:00:01Z')
    expect(plan(input({ nextAt: at, dbNow: at, maxRuns: 5, runs: 3 }), t).next).not.toBeNull()
    expect(plan(input({ nextAt: at, dbNow: at, maxRuns: 5, runs: 4 }), t).next).toBeNull()
    const skipped = plan(input({ nextAt: at, dbNow: D('2026-01-01T01:00:00Z'), maxRuns: 5, runs: 4, misfire: 'skip' }), t)
    expect(skipped.decided).toBe('missed')
    expect(skipped.next).toBeNull()
  })

  it('a schedule with limit 3 claims three ticks', async () => {
    const t = await every(1000)
    const r = loop(t, input({ nextAt: D('2026-01-01T00:00:01Z'), dbNow: D('2026-01-01T00:00:30Z'), maxRuns: 3 }))
    expect(r.fired.length).toBe(3)
    expect(r.next).toBeNull()
  })
})

describe('one-shot at', () => {
  it('fires once and ends; late beyond grace is still fired once', async () => {
    const at = D('2026-03-01T00:00:00Z')
    const t = await ticker({ ...spec, at })
    expect(plan(input({ nextAt: at, dbNow: at }), t)).toMatchObject({ fire: at, next: null, missed: 0 })
    const late = plan(input({ nextAt: at, dbNow: D('2026-03-02T00:00:00Z') }), t)
    expect(late).toMatchObject({ fire: at, next: null, missed: 0, misfired: true })
  })
})
