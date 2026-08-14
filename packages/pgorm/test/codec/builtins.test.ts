/**
 * The built-in codecs, against live PostgreSQL — design/02 §4.5 and the sign-off decode
 * defaults (design/00 §6): `int8` → `bigint`, `numeric` → `string`,
 * `date` → branded `'YYYY-MM-DD'` string, `timestamptz` → `Date` (throwing on infinity).
 *
 * Everything is decoded through `registry.planFor(result.fields)` — i.e. the real hot path,
 * OID-driven, one closure per column per RowDescription — not by calling a codec by hand.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeHarness, type Harness } from '../driver/_harness.js'
import { createRegistry, PgDecodeError, PgEncodeError } from '../../src/codec/index.js'
import {
  boolCodec,
  byteaCodec,
  dateCodec,
  int8Codec,
  numericCodec,
  timestamptzCodec,
  uuidCodec,
} from '../../src/codec/index.js'
import type { PgConnection } from '../../src/driver/index.js'

const registry = createRegistry()

let h: Harness
let conn: PgConnection

beforeAll(async () => {
  h = await makeHarness()
  conn = await h.driver.acquire()
  registry.setServerParameters(conn.serverParameters)
})
afterAll(async () => {
  await h?.driver.release(conn)
  await h?.end()
})

/** Decode every column of a one-row result through the real plan. */
async function row(text: string, params: readonly (string | Uint8Array | null)[] = [], paramTypes?: readonly number[]) {
  const r = await conn.execute({ text, params, ...(paramTypes ? { paramTypes } : {}) })
  const plan = registry.planFor(r.fields)
  return r.rows[0]!.map((v, i) => plan[i]!(v))
}

describe('int8 → bigint (sign-off 00 §6)', () => {
  it('is exact past 2^53, where Number silently lies', async () => {
    const [a, b, c] = await row(
      `select 9007199254740993::int8, '9223372036854775807'::int8, '-9223372036854775808'::int8`,
    )
    expect(a).toBe(9007199254740993n)
    expect(typeof a).toBe('bigint')
    // the reason bigint and not number:
    expect(Number('9007199254740993')).toBe(9007199254740992)
    expect(b).toBe(9223372036854775807n)
    expect(c).toBe(-9223372036854775808n)
  })

  it('round-trips both int64 endpoints as parameters', async () => {
    for (const v of [-9223372036854775808n, 9223372036854775807n, 0n]) {
      const [out] = await row('select $1::int8', [int8Codec.encode(v)], [20])
      expect(out).toBe(v)
    }
  })

  it('count(*) is int8 — the reason `int8:number` ships in the box', async () => {
    const r = await conn.execute({ text: 'select count(*) from generate_series(1,3)', params: [] })
    expect(r.fields[0]!.dataTypeID).toBe(20)
    expect(registry.planFor(r.fields)[0]!(r.rows[0]![0]!)).toBe(3n)
    const asNumber = registry.byName('int8:number')!
    expect(asNumber.decodeText('3', { typmod: -1, registry, serverParameters: {} })).toBe(3)
    expect(() =>
      asNumber.decodeText('9007199254740993', { typmod: -1, registry, serverParameters: {} }),
    ).toThrow(PgDecodeError)
  })

  it('`toJson` exists because JSON.stringify throws on bigint', () => {
    expect(() => JSON.stringify({ n: 1n })).toThrow(TypeError)
    expect(int8Codec.toJson!(1n)).toBe('1')
  })

  it('rejects a lossy number parameter rather than truncating it', () => {
    expect(() => int8Codec.encode(9007199254740993)).toThrow(PgEncodeError)
    expect(int8Codec.encode('9007199254740993')).toBe('9007199254740993')
  })
})

describe('numeric → string (sign-off 00 §6)', () => {
  it('preserves the scale that numeric(10,2) exists to carry', async () => {
    const [v] = await row('select 1.10::numeric(10,2)')
    expect(v).toBe('1.10')
    expect(String(1.1)).toBe('1.1') // what a Number default would have given you
  })

  it('carries the values no JS number can', async () => {
    expect(await row(`select 'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric`)).toEqual([
      'NaN',
      'Infinity',
      '-Infinity',
    ])
  })

  it('is exact at arbitrary precision', async () => {
    const big = '123456789012345678901234567890.123456789'
    expect(await row(`select '${big}'::numeric`)).toEqual([big])
    expect(await row('select $1::numeric', [numericCodec.encode(big)], [1700])).toEqual([big])
  })

  it('typmod reaches the codec context (numeric(10,2) → 655366)', async () => {
    const r = await conn.execute({ text: 'select 1.10::numeric(10,2) as n', params: [] })
    expect(r.fields[0]!.dataTypeModifier).toBe(655366)
    expect(((655366 - 4) >> 16) & 0xffff).toBe(10) // precision
    expect((655366 - 4) & 0xffff).toBe(2) // scale
  })

  it('refuses garbage on the way in', () => {
    expect(() => numericCodec.encode('12,34')).toThrow(PgEncodeError)
    expect(numericCodec.encode('-1.5e10')).toBe('-1.5e10')
  })
})

describe('timestamptz → Date, timestamp → verbatim string', () => {
  it('produces the same instant regardless of the offset PG happens to render', async () => {
    const [utc, plus9] = await row(
      `select '2026-08-14 06:30:00.123456+00'::timestamptz,
              '2026-08-14 15:30:00.123456+09'::timestamptz`,
    )
    expect(utc).toBeInstanceOf(Date)
    expect((utc as Date).toISOString()).toBe('2026-08-14T06:30:00.123Z')
    expect((plus9 as Date).getTime()).toBe((utc as Date).getTime())
  })

  it('truncates µs to ms, and `timestamptz:string` is the documented escape', async () => {
    const [d] = await row(`select '2026-08-14 06:30:00.123456+00'::timestamptz`)
    expect((d as Date).getMilliseconds()).toBe(123) // 456 µs dropped — Date cannot hold them
    const exact = registry.byName('timestamptz:string')!
    expect(
      exact.decodeText('2026-08-14 06:30:00.123456+00', {
        typmod: -1,
        registry,
        serverParameters: {},
      }),
    ).toBe('2026-08-14 06:30:00.123456+00')
  })

  it('THROWS on infinity, naming the column and pointing at the escape codec', async () => {
    const r = await conn.execute({
      text: `select 'infinity'::timestamptz as expires_at`,
      params: [],
    })
    const plan = registry.planFor(r.fields)
    expect(() => plan[0]!(r.rows[0]![0]!)).toThrow(PgDecodeError)
    expect(() => plan[0]!(r.rows[0]![0]!)).toThrow(/expires_at/)
    expect(() => plan[0]!(r.rows[0]![0]!)).toThrow(/timestamptz:string/)
    // …and -infinity likewise
    const r2 = await conn.execute({ text: `select '-infinity'::timestamptz as t`, params: [] })
    expect(() => registry.planFor(r2.fields)[0]!(r2.rows[0]![0]!)).toThrow(PgDecodeError)
  })

  it('BC years survive', async () => {
    const [d] = await row(`select '0001-01-01 12:00:00+00 BC'::timestamptz`)
    expect(d).toBeInstanceOf(Date)
    // year 1 BC is astronomical year 0
    expect((d as Date).getUTCFullYear()).toBe(0)
  })

  it('a Date parameter is encoded as unambiguous UTC ISO-8601, never a local-offset string', async () => {
    const d = new Date('2026-08-14T06:30:00.123Z')
    expect(timestamptzCodec.encode(d)).toBe('2026-08-14T06:30:00.123Z')
    const [out] = await row('select $1::timestamptz', [timestamptzCodec.encode(d)], [1184])
    expect((out as Date).getTime()).toBe(d.getTime())
  })

  it('naive `timestamp` is NEVER a Date — µs and all, verbatim', async () => {
    expect(await row(`select '2026-08-14 12:00:00.123456'::timestamp`)).toEqual([
      '2026-08-14 12:00:00.123456',
    ])
  })
})

describe('bool, uuid, float8, bytea, json', () => {
  it("bool compares the single char — `Boolean('f')` is the classic bug", async () => {
    expect(await row('select true, false')).toEqual([true, false])
    expect(Boolean('f')).toBe(true) // ← what a naive implementation returns for FALSE
    expect(boolCodec.decodeText('f', { typmod: -1, registry, serverParameters: {} })).toBe(false)
    expect(boolCodec.encode(true)).toBe('t')
    expect(boolCodec.encode(false)).toBe('f')
  })

  it('uuid: PG normalises case on output, and we normalise on input', async () => {
    const upper = '550E8400-E29B-41D4-A716-446655440000'
    expect(uuidCodec.encode(upper)).toBe(upper.toLowerCase())
    expect(await row(`select '${upper}'::uuid`)).toEqual([upper.toLowerCase()])
    expect(() => uuidCodec.encode('not-a-uuid')).toThrow(PgEncodeError)
  })

  it('float8 text is the exact shortest round-trip repr, incl. NaN/±Infinity', async () => {
    expect(await row(`select 0.1::float8 + 0.2::float8`)).toEqual([0.30000000000000004])
    const [nan, inf, ninf] = await row(
      `select 'NaN'::float8, 'Infinity'::float8, '-Infinity'::float8`,
    )
    expect(Number.isNaN(nan as number)).toBe(true)
    expect(inf).toBe(Number.POSITIVE_INFINITY)
    expect(ninf).toBe(Number.NEGATIVE_INFINITY)
  })

  it('bytea decodes hex and ENCODES BINARY (not `\\x` hex doubling)', async () => {
    const bytes = new Uint8Array([0, 255, 128])
    expect(byteaCodec.encode(bytes)).toBeInstanceOf(Uint8Array)
    const out = await row('select length($1::bytea)::int4, $1::bytea', [byteaCodec.encode(bytes)], [17])
    expect(out[0]).toBe(3) // 3 bytes on the wire, not the 8 chars of "\\x00ff80"
    expect(out[1]).toEqual(bytes)
    expect(byteaCodec.toJson!(bytes)).toBe('\\x00ff80')
    expect(() => byteaCodec.encode('nope' as never)).toThrow(PgEncodeError)
  })

  it('json keeps the source text, jsonb is reformatted by PG — never compare jsonb text', async () => {
    const src = '{"b":2,   "a":1}'
    const r = await conn.execute({
      text: `select $1::json::text, $1::jsonb::text, $1::json, $1::jsonb`,
      params: [src],
      paramTypes: [25],
    })
    expect(r.rows[0]![0]).toBe(src) // json: byte-identical source text
    expect(r.rows[0]![1]).not.toBe(src) // jsonb: keys reordered, whitespace normalised
    expect(r.rows[0]![1]).toBe('{"a": 1, "b": 2}')
    const plan = registry.planFor(r.fields)
    expect(plan[2]!(r.rows[0]![2]!)).toEqual({ a: 1, b: 2 })
    expect(plan[3]!(r.rows[0]![3]!)).toEqual({ a: 1, b: 2 })
  })

  it('bpchar is SPACE-PADDED by PG and must not be trimmed', async () => {
    expect(await row(`select 'ab'::char(5)`)).toEqual(['ab   '])
  })
})

describe('the named alternates ship in the box, addressable by name only', () => {
  it('do not steal the default OID mapping', () => {
    expect(registry.forOid(20)!.name).toBe('int8')
    expect(registry.forOid(1700)!.name).toBe('numeric')
    expect(registry.forOid(1184)!.name).toBe('timestamptz')
    for (const n of ['int8:number', 'int8:string', 'numeric:number', 'timestamptz:string']) {
      expect(registry.byName(n)!.name).toBe(n)
    }
  })

  it('`date` is branded so it cannot be confused with an arbitrary string', () => {
    // compile-time brand; at runtime it is the plain wire text
    const v = dateCodec.decodeText('2026-08-14', { typmod: -1, registry, serverParameters: {} })
    expect(v).toBe('2026-08-14')
    expect(typeof v).toBe('string')
  })
})
