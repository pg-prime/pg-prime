/**
 * ══════════════════════════════════════════════════════════════════════════════
 *  interval (OID 1186) — the last structured decoding in §4.5's table
 *
 *  It was the one row of that table with no codec at all, so every `interval` column came back as
 *  untyped raw text through `planFor`'s unknown-OID escape hatch — and, being raw text, it also
 *  carried whichever `IntervalStyle` the session happened to have.
 *
 *  §4.7 lets a session run under `postgres` OR `iso_8601` (the driver rejects the other two at
 *  connect), so the decoder handles both grammars and this file proves it by flipping the GUC on a
 *  live server and decoding the SAME value twice. Encoding always emits ISO-8601, which every
 *  `IntervalStyle` accepts — a parameter must not depend on a session setting.
 * ══════════════════════════════════════════════════════════════════════════════
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeHarness, type Harness } from '../live/_harness.js'
import { createRegistry, intervalCodec, PgDecodeError } from '../../src/codec/index.js'
import type { CodecContext, PgInterval } from '../../src/codec/index.js'
import type { PgConnection } from '../../src/driver/index.js'

const registry = createRegistry()
const ctx: CodecContext = { typmod: -1, registry, serverParameters: {} }

let h: Harness
let conn: PgConnection

beforeAll(async () => {
  h = await makeHarness()
  conn = await h.driver.acquire()
})
afterAll(async () => {
  await conn?.execute({ text: `set intervalstyle = 'postgres'`, params: [], mode: 'simple' })
  await h?.driver.release(conn)
  await h?.end()
})

const zero: PgInterval = { years: 0, months: 0, days: 0, hours: 0, minutes: 0, seconds: 0 }

async function decodeOne(expr: string): Promise<unknown> {
  const r = await conn.execute({ text: `select ${expr} as v`, params: [] })
  expect(r.fields[0]!.dataTypeID).toBe(1186)
  return registry.planFor(r.fields)[0]!(r.rows[0]![0]!)
}

describe('interval decodes under BOTH IntervalStyles the driver accepts', () => {
  const VALUE = `'1 year 2 mons 3 days 04:05:06.789'::interval`
  const EXPECTED: PgInterval = {
    years: 1,
    months: 2,
    days: 3,
    hours: 4,
    minutes: 5,
    seconds: 6.789,
  }

  it('THE ORACLE: the same value has two different wire spellings', async () => {
    await conn.execute({ text: `set intervalstyle = 'postgres'`, params: [], mode: 'simple' })
    const pgStyle = await conn.execute({ text: `select ${VALUE}`, params: [] })
    await conn.execute({ text: `set intervalstyle = 'iso_8601'`, params: [], mode: 'simple' })
    const isoStyle = await conn.execute({ text: `select ${VALUE}`, params: [] })

    expect(pgStyle.rows[0]![0]).toBe('1 year 2 mons 3 days 04:05:06.789')
    expect(isoStyle.rows[0]![0]).toBe('P1Y2M3DT4H5M6.789S')
    expect(pgStyle.rows[0]![0]).not.toBe(isoStyle.rows[0]![0])
  })

  it('…and both decode to the same object', async () => {
    for (const style of ['postgres', 'iso_8601']) {
      await conn.execute({ text: `set intervalstyle = '${style}'`, params: [], mode: 'simple' })
      expect(await decodeOne(VALUE), style).toEqual(EXPECTED)
    }
    await conn.execute({ text: `set intervalstyle = 'postgres'`, params: [], mode: 'simple' })
  })

  it('per-component signs, a bare time, and zero', async () => {
    expect(await decodeOne(`'-1 year -2 mons +3 days -04:05:06'::interval`)).toEqual({
      years: -1,
      months: -2,
      days: 3,
      hours: -4,
      minutes: -5,
      seconds: -6,
    })
    expect(await decodeOne(`'00:00:00'::interval`)).toEqual(zero)
    expect(await decodeOne(`'-00:00:01'::interval`)).toEqual({ ...zero, seconds: -1 })
    expect(await decodeOne(`'1 mon'::interval`)).toEqual({ ...zero, months: 1 })
    // hours are NOT capped at 24 in the time component
    expect(await decodeOne(`'8760:00:00'::interval`)).toEqual({ ...zero, hours: 8760 })
    // µs resolution survives
    expect(await decodeOne(`'1 day -00:00:00.000001'::interval`)).toEqual({
      ...zero,
      days: 1,
      seconds: -0.000001,
    })
  })

  it('a grammar we do not implement is a PgDecodeError naming IntervalStyle', () => {
    // `sql_standard` emits '+1-2 +3 +4:05:06'; §4.7 has the driver reject that GUC at connect,
    // and if one ever slips through it must be a loud failure, not a zero interval.
    expect(() => intervalCodec.decodeText('+1-2 +3 +4:05:06', ctx)).toThrow(PgDecodeError)
    expect(() => intervalCodec.decodeText('', ctx)).toThrow(PgDecodeError)
    expect(() => intervalCodec.decodeText('PXY', ctx)).toThrow(PgDecodeError)
  })
})

describe('interval encodes as ISO-8601, which every IntervalStyle accepts', () => {
  it('round-trips through the server under both styles', async () => {
    const value: PgInterval = { years: 1, months: 2, days: 3, hours: 4, minutes: 5, seconds: 6.789 }
    expect(intervalCodec.encode(value)).toBe('P1Y2M3DT4H5M6.789S')
    expect(intervalCodec.encode(zero)).toBe('P0Y0M0DT0H0M0S')
    expect(intervalCodec.encode({ ...zero, seconds: -0.000001 })).toBe('P0Y0M0DT0H0M-0.000001S')

    for (const style of ['postgres', 'iso_8601']) {
      await conn.execute({ text: `set intervalstyle = '${style}'`, params: [], mode: 'simple' })
      for (const v of [value, zero, { ...zero, months: -14 }, { ...zero, seconds: -0.000001 }]) {
        const r = await conn.execute({
          text: 'select $1::interval as v',
          params: [intervalCodec.encode(v)],
          paramTypes: [1186],
        })
        const back = registry.planFor(r.fields)[0]!(r.rows[0]![0]!) as PgInterval
        // PG normalises (−14 months is '-1 years -2 mons'), so compare in months, not shape
        expect(back.years * 12 + back.months, `${style} ${JSON.stringify(v)}`).toBe(
          v.years * 12 + v.months,
        )
        expect(back.days).toBe(v.days)
        expect(back.hours * 3600 + back.minutes * 60 + back.seconds).toBeCloseTo(
          v.hours * 3600 + v.minutes * 60 + v.seconds,
          6,
        )
      }
    }
    await conn.execute({ text: `set intervalstyle = 'postgres'`, params: [], mode: 'simple' })
  })

  it('a string passes through, and a non-interval is a PgEncodeError', () => {
    expect(intervalCodec.encode('1 day')).toBe('1 day')
    expect(() => intervalCodec.encode({ ...zero, seconds: Number.NaN })).toThrow(
      /finite 'seconds'/,
    )
  })
})
