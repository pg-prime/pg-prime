import { describe, expect, it } from 'vitest'
import { defineSchedule, ScheduleError } from '../../src/index.js'
import { ticker, type Spec } from '../../src/ticks.js'

const D = (s: string) => new Date(s)
const iso = (d: Date | null) => d?.toISOString() ?? null
const base: Spec = {
  pattern: null,
  everyMs: null,
  at: null,
  tz: 'UTC',
  startAt: null,
  endAt: null,
  anchorAt: D('2026-01-01T00:00:00.500Z'),
}
const cron = (pattern: string, tz = 'UTC', extra: Partial<Spec> = {}) =>
  ticker({ ...base, pattern, tz, ...extra })

async function walk(pattern: string, tz: string, from: string, n: number) {
  const t = await cron(pattern, tz)
  const out: (string | null)[] = []
  let x: Date | null = D(from)
  for (let i = 0; i < n && x; i++) out.push(iso((x = t.next(x))))
  return out
}

describe('cron patterns across DST', () => {
  it('America/New_York spring forward: 02:30 fires at 03:30 EDT, hourly never doubles', async () => {
    expect(await walk('30 2 * * *', 'America/New_York', '2026-03-07T00:00:00Z', 3)).toEqual([
      '2026-03-07T07:30:00.000Z',
      '2026-03-08T07:30:00.000Z',
      '2026-03-09T06:30:00.000Z',
    ])
    expect(await walk('0 * * * *', 'America/New_York', '2026-03-08T05:00:00Z', 3)).toEqual([
      '2026-03-08T06:00:00.000Z',
      '2026-03-08T07:00:00.000Z',
      '2026-03-08T08:00:00.000Z',
    ])
  })

  it('America/New_York fall back: the repeated 01:xx fires once', async () => {
    expect(await walk('30 1 * * *', 'America/New_York', '2026-10-31T00:00:00Z', 3)).toEqual([
      '2026-10-31T05:30:00.000Z',
      '2026-11-01T05:30:00.000Z',
      '2026-11-02T06:30:00.000Z',
    ])
    expect(await walk('*/30 * * * *', 'America/New_York', '2026-11-01T04:50:00Z', 4)).toEqual([
      '2026-11-01T05:00:00.000Z',
      '2026-11-01T05:30:00.000Z',
      '2026-11-01T07:00:00.000Z',
      '2026-11-01T07:30:00.000Z',
    ])
  })

  it('Europe/Berlin both transitions', async () => {
    expect(await walk('0 2 * * *', 'Europe/Berlin', '2026-03-28T00:00:00Z', 3)).toEqual([
      '2026-03-28T01:00:00.000Z',
      '2026-03-29T01:00:00.000Z',
      '2026-03-30T00:00:00.000Z',
    ])
    expect(await walk('0 30 2 * * *', 'Europe/Berlin', '2026-10-25T00:00:00Z', 2)).toEqual([
      '2026-10-25T00:30:00.000Z',
      '2026-10-26T01:30:00.000Z',
    ])
    expect(await walk('0 * * * *', 'Europe/Berlin', '2026-10-25T00:00:00Z', 2)).toEqual([
      '2026-10-25T02:00:00.000Z',
      '2026-10-25T03:00:00.000Z',
    ])
  })

  it('seconds, L, W, # and nicknames', async () => {
    expect(await walk('*/15 * * * * *', 'UTC', '2026-02-01T00:00:00Z', 4)).toEqual([
      '2026-02-01T00:00:15.000Z',
      '2026-02-01T00:00:30.000Z',
      '2026-02-01T00:00:45.000Z',
      '2026-02-01T00:01:00.000Z',
    ])
    expect(await walk('0 0 L * *', 'UTC', '2026-02-01T00:00:00Z', 2)).toEqual([
      '2026-02-28T00:00:00.000Z',
      '2026-03-31T00:00:00.000Z',
    ])
    expect(await walk('0 0 15W * *', 'UTC', '2026-02-01T00:00:00Z', 2)).toEqual([
      '2026-02-16T00:00:00.000Z',
      '2026-03-16T00:00:00.000Z',
    ])
    expect(await walk('0 0 * * 1#2', 'UTC', '2026-02-01T00:00:00Z', 2)).toEqual([
      '2026-02-09T00:00:00.000Z',
      '2026-03-09T00:00:00.000Z',
    ])
    expect(await walk('@hourly', 'UTC', '2026-02-01T00:10:00Z', 1)).toEqual([
      '2026-02-01T01:00:00.000Z',
    ])
  })

  it('last() is the latest tick at or before the bound', async () => {
    const t = await cron('0 * * * *')
    expect(iso(t.last(D('2026-01-01T12:00:00Z')))).toBe('2026-01-01T12:00:00.000Z')
    expect(iso(t.last(D('2026-01-01T12:59:59.999Z')))).toBe('2026-01-01T12:00:00.000Z')
  })

  it('honours startAt and endAt', async () => {
    const t = await cron('0 * * * *', 'UTC', {
      startAt: D('2026-01-01T10:00:00Z'),
      endAt: D('2026-01-01T12:00:00Z'),
    })
    expect(iso(t.next(D('2026-01-01T00:00:00Z')))).toBe('2026-01-01T10:00:00.000Z')
    expect(iso(t.next(D('2026-01-01T11:00:00Z')))).toBe('2026-01-01T12:00:00.000Z')
    expect(t.next(D('2026-01-01T12:00:00Z'))).toBeNull()
    expect(t.last(D('2026-01-01T09:59:00Z'))).toBeNull()
  })
})

describe('every and at', () => {
  it('every is a grid anchored at startAt ?? anchorAt', async () => {
    const t = await ticker({ ...base, everyMs: 1000 })
    expect(iso(t.next(D('2026-01-01T00:00:03Z')))).toBe('2026-01-01T00:00:03.500Z')
    expect(iso(t.next(D('2026-01-01T00:00:03.500Z')))).toBe('2026-01-01T00:00:04.500Z')
    expect(iso(t.last(D('2026-01-01T00:00:03.499Z')))).toBe('2026-01-01T00:00:02.500Z')
    const s = await ticker({ ...base, everyMs: 60_000, startAt: D('2026-06-01T00:00:00Z') })
    expect(iso(s.next(D('2026-01-01T00:00:00Z')))).toBe('2026-06-01T00:00:00.000Z')
  })

  it('at is a single tick', async () => {
    const t = await ticker({ ...base, at: D('2026-05-01T00:00:00Z') })
    expect(iso(t.next(D('2026-04-01T00:00:00Z')))).toBe('2026-05-01T00:00:00.000Z')
    expect(t.next(D('2026-05-01T00:00:00Z'))).toBeNull()
  })
})

describe('invalid schedules', () => {
  const field = async (f: () => unknown) => {
    try {
      await f()
    } catch (e) {
      expect(e).toBeInstanceOf(ScheduleError)
      return (e as ScheduleError).field
    }
    throw new Error('did not throw')
  }
  const h = { handler: async () => {} }

  it('names the field', async () => {
    expect(await field(() => cron('not a pattern'))).toBe('cron')
    expect(await field(() => cron('0 0 0 1 1 * 2030'))).toBe('cron')
    expect(await field(() => defineSchedule('x', { cron: '* * * * *', tz: 'Mars/Base' }, h))).toBe('tz')
    expect(await field(() => defineSchedule('x', { everyMs: 999 }, h))).toBe('everyMs')
    expect(await field(() => defineSchedule('x', { at: new Date('nope') }, h))).toBe('at')
    expect(await field(() => defineSchedule('', { everyMs: 1000 }, h))).toBe('name')
    expect(await field(() => defineSchedule('x', { everyMs: 1000 }, {} as never))).toBe('target')
    expect(await field(() => defineSchedule('x', {} as never, h))).toBe('when')
    expect(
      await field(() =>
        defineSchedule('x', { everyMs: 1000 }, h, { startAt: D('2026-02-01'), endAt: D('2026-01-01') }),
      ),
    ).toBe('endAt')
    expect(await field(() => defineSchedule('x', { everyMs: 1000 }, h, { limit: 0 }))).toBe('limit')
    expect(await field(() => defineSchedule('x', { everyMs: 1000 }, h, { overlap: 'queue' as never }))).toBe(
      'overlap',
    )
  })
})
