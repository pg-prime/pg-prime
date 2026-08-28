/**
 * ══════════════════════════════════════════════════════════════════════════════
 *  §4.5 ENCODING POLICY — the half of the codec boundary that decides what NEVER reaches the wire
 *
 *  design/02 §4.5, verbatim: "Everything else → the codec's `encode`. **No `JSON.stringify`
 *  fallback and no `toPostgres()` duck-typing**: an unregistered type is a compile-time error in
 *  the schema DSL and a `PgEncodeError` at runtime. `pg`'s implicit `JSON.stringify(obj)` fallback
 *  is exactly the kind of silent coercion we exist to remove."
 *
 *  Four classes of silent coercion were live in `src/codec` before this file existed, all of them
 *  ending in either a wrong value stored or a SQL NULL stored:
 *    · `unknownCodec` fell back to `JSON.stringify`, and to `String(leaf)` inside an array;
 *    · `undefined`, functions and symbols became SQL NULL;
 *    · `JSON.stringify(v) ?? 'null'` turned an unserialisable value into the JSON *null*;
 *    · a `Date` outside year [1, 9999] was spelled in ECMAScript's expanded-year form, which
 *      PostgreSQL rejects outright.
 *
 *  The oracle is never a message: it is the `PgEncodeError` class, a byte-exact wire literal, or
 *  the live server's own verdict (a value we send must come back equal; a value we refuse must be
 *  one the server would have refused too — that negative control is at the bottom).
 * ══════════════════════════════════════════════════════════════════════════════
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeHarness, type Harness } from '../live/_harness.js'
import {
  arrayCodec,
  createRegistry,
  int2Codec,
  int4Codec,
  int8Codec,
  int8NumberCodec,
  int8StringCodec,
  jsonbCodec,
  numericCodec,
  numericNumberCodec,
  PgEncodeError,
  textCodec,
  timestampCodec,
  timestamptzCodec,
  timestamptzStringCodec,
  unknownCodec,
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

/** Decode a one-row, one-column result through the real OID-driven plan. */
async function selectOne(
  text: string,
  params: readonly (string | Uint8Array | null)[] = [],
  paramTypes?: readonly number[],
): Promise<unknown> {
  const r = await conn.execute({ text, params, ...(paramTypes ? { paramTypes } : {}) })
  return registry.planFor(r.fields)[0]!(r.rows[0]![0]!)
}

// ─────────────────────────────────────────────────────────────────────────────
// unknownCodec — the codec on a bare `${value}` hole
// ─────────────────────────────────────────────────────────────────────────────

describe('unknownCodec refuses what it cannot spell, instead of inventing a spelling', () => {
  it('an object is a PgEncodeError, NOT JSON.stringify (§4.5)', () => {
    expect(() => unknownCodec.encode({ a: 1 })).toThrow(PgEncodeError)
    expect(() => unknownCodec.encode(new Map())).toThrow(PgEncodeError)
    // the fix the error names, spelled out: pick a codec.
    expect(jsonbCodec.encode({ a: 1 })).toBe('{"a":1}')
  })

  it('undefined, a function and a symbol are errors — they used to become SQL NULL', () => {
    // `undefined` returned `null` (SQL NULL) and the other two returned `undefined`, which `pg`
    // also sends as NULL. A forgotten `await` or a mistyped property wrote NULL into the column.
    expect(() => unknownCodec.encode(undefined)).toThrow(PgEncodeError)
    expect(() => unknownCodec.encode(() => 1)).toThrow(PgEncodeError)
    expect(() => unknownCodec.encode(Symbol('s'))).toThrow(PgEncodeError)
    expect(() => unknownCodec.encode(Promise.resolve(1))).toThrow(PgEncodeError)
  })

  it('NEGATIVE CONTROL: everything it CAN spell still goes out unchanged', () => {
    expect(unknownCodec.encode(null)).toBeNull() // SQL NULL is still a value, and still null
    expect(unknownCodec.encode('x')).toBe('x')
    expect(unknownCodec.encode(42)).toBe('42')
    expect(unknownCodec.encode(9007199254740993n)).toBe('9007199254740993')
    expect(unknownCodec.encode(true)).toBe('t')
    expect(unknownCodec.encode(false)).toBe('f')
    expect(unknownCodec.encode(new Date('2026-08-14T06:30:00.123Z'))).toBe(
      '2026-08-14 06:30:00.123Z',
    )
    expect(unknownCodec.encode(new Uint8Array([0, 255]))).toEqual(new Uint8Array([0, 255]))
  })

  it('array LEAVES go through the same rules — `String(leaf)` was the bug', () => {
    // `String(new Date(0))` is a LOCALE string ('Thu Jan 01 1970 09:00:00 GMT+0900 …'), which is
    // both unparseable by PG and different on every machine.
    // (the quotes are the array grammar doing its job: the timestamp text contains a space)
    expect(unknownCodec.encode([new Date(0)])).toBe('{"1970-01-01 00:00:00.000Z"}')
    expect(unknownCodec.encode([true, false])).toBe('{t,f}')
    // `String(new Uint8Array([1,2]))` is '1,2' — which parses as TWO array elements.
    expect(unknownCodec.encode([new Uint8Array([1, 2])])).toBe('{"\\\\x0102"}')
    // and an object leaf is refused exactly like a top-level object
    expect(() => unknownCodec.encode([{ a: 1 }])).toThrow(PgEncodeError)
    // nulls are still NULL, nesting still nests
    expect(unknownCodec.encode([1, null, [2, 3]])).toBe('{1,NULL,{2,3}}')
  })

  it('LIVE: the Date array literal is one timestamptz, not a locale string', async () => {
    const encoded = unknownCodec.encode([new Date('2026-08-14T06:30:00.123Z')])
    const out = await selectOne('select ($1::timestamptz[])[1]', [encoded as string], [1185])
    expect(out).toBeInstanceOf(Date)
    expect((out as Date).toISOString()).toBe('2026-08-14T06:30:00.123Z')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// json / jsonb
// ─────────────────────────────────────────────────────────────────────────────

describe("jsonb/json encode: `JSON.stringify(v) ?? 'null'` had four holes", () => {
  it('undefined / a function / a symbol are errors, not the JSON null', () => {
    // all three stringify to `undefined`, and `?? 'null'` then stored JSON null.
    expect(() => jsonbCodec.encode(undefined)).toThrow(PgEncodeError)
    expect(() => jsonbCodec.encode(() => 1)).toThrow(PgEncodeError)
    expect(() => jsonbCodec.encode(Symbol('s'))).toThrow(PgEncodeError)
  })

  it('a BigInt and a circular structure raise PgEncodeError, not a bare TypeError', () => {
    // `JSON.stringify(1n)` throws `TypeError: Do not know how to serialize a BigInt` — an error
    // with no codec and no column in it, from a layer the caller has never heard of.
    expect(() => jsonbCodec.encode({ n: 1n })).toThrow(PgEncodeError)
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(() => jsonbCodec.encode(circular)).toThrow(PgEncodeError)
  })

  it('NEGATIVE CONTROL: a JSON null is a real jsonb value and still round-trips', async () => {
    expect(jsonbCodec.encode(null)).toBe('null')
    expect(await selectOne('select $1::jsonb', [jsonbCodec.encode(null)], [3802])).toBeNull()
    // …and it is distinguishable from SQL NULL, which never reaches `encode` at all
    expect(await selectOne('select ($1::jsonb) is null', [jsonbCodec.encode(null)], [3802])).toBe(
      false,
    )
    expect(jsonbCodec.encode({ a: [1, 'two'] })).toBe('{"a":[1,"two"]}')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// temporal — the ECMAScript expanded-year form
// ─────────────────────────────────────────────────────────────────────────────

describe('Date encoding: PostgreSQL spelling, not `toISOString()`', () => {
  const YEAR_10000 = new Date('+010000-01-01T00:00:00.000Z')
  const YEAR_1_BC = new Date('0000-01-01T00:00:00.000Z') // ES year 0 IS 1 BC
  const YEAR_2_BC = new Date('-000001-01-01T00:00:00.000Z')

  it('NEGATIVE CONTROL: the server itself rejects all three `toISOString()` spellings', async () => {
    // This is the whole reason for the change. Each JS spelling fails differently, and none of
    // the three SQLSTATEs is something an application can act on.
    const rejected: [Date, string, string][] = [
      [YEAR_10000, '+010000-01-01T00:00:00.000Z', '22009'], // read as a zone displacement
      [YEAR_1_BC, '0000-01-01T00:00:00.000Z', '22008'], // PG has no year zero
      [YEAR_2_BC, '-000001-01-01T00:00:00.000Z', '22007'], // not a syntax PG knows at all
    ]
    for (const [d, iso, sqlstate] of rejected) {
      expect(d.toISOString()).toBe(iso)
      await expect(
        conn.execute({ text: 'select $1::timestamptz', params: [iso], paramTypes: [1184] }),
      ).rejects.toMatchObject({ pgPrime: { server: { sqlstate } } })
    }
  })

  it('year ≥ 10000 goes out in plain digits and round-trips', async () => {
    expect(timestamptzCodec.encode(YEAR_10000)).toBe('10000-01-01 00:00:00.000Z')
    expect(timestampCodec.encode(YEAR_10000)).toBe('10000-01-01 00:00:00.000')
    const out = await selectOne(
      'select $1::timestamptz',
      [timestamptzCodec.encode(YEAR_10000)],
      [1184],
    )
    expect((out as Date).getTime()).toBe(YEAR_10000.getTime())
  })

  it('year ≤ 0 goes out as PG`s ` BC` era, with the proleptic 1-year, and round-trips', async () => {
    // ES year 0 is 1 BC and ES −1 is 2 BC: `1 - year`, not `-year`.
    expect(timestamptzCodec.encode(YEAR_1_BC)).toBe('0001-01-01 00:00:00.000Z BC')
    expect(timestamptzCodec.encode(YEAR_2_BC)).toBe('0002-01-01 00:00:00.000Z BC')
    expect(timestampCodec.encode(YEAR_1_BC)).toBe('0001-01-01 00:00:00.000 BC')
    for (const d of [YEAR_1_BC, YEAR_2_BC]) {
      const out = await selectOne('select $1::timestamptz', [timestamptzCodec.encode(d)], [1184])
      expect((out as Date).getTime()).toBe(d.getTime())
    }
  })

  it('an Invalid Date is a PgEncodeError in EVERY temporal encoder, never a RangeError', () => {
    // `new Date(NaN).toISOString()` throws `RangeError: Invalid time value`.
    const invalid = new Date(Number.NaN)
    expect(() => timestampCodec.encode(invalid)).toThrow(PgEncodeError)
    expect(() => timestamptzCodec.encode(invalid)).toThrow(PgEncodeError)
    expect(() => timestamptzStringCodec.encode(invalid)).toThrow(PgEncodeError)
    expect(() => unknownCodec.encode(invalid)).toThrow(PgEncodeError)
  })

  it('NEGATIVE CONTROL: an ordinary Date is unchanged in value, only in spelling', async () => {
    const d = new Date('2026-08-14T06:30:00.123Z')
    expect(timestamptzCodec.encode(d)).toBe('2026-08-14 06:30:00.123Z')
    const out = await selectOne('select $1::timestamptz', [timestamptzCodec.encode(d)], [1184])
    expect((out as Date).toISOString()).toBe(d.toISOString())
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// arrays
// ─────────────────────────────────────────────────────────────────────────────

describe('array encoding: `undefined` is a hole, not a NULL', () => {
  const int4Array = arrayCodec(int4Codec, 1007)

  it('an undefined element is a PgEncodeError', () => {
    // A sparse array is the way an `undefined` reaches a `number[]` without a cast: a `map` that
    // forgot to return, or an index assignment past the end. Storing NULL for it is a lie.
    const sparse: (number | null)[] = []
    sparse[0] = 1
    sparse[2] = 3
    expect(sparse).toHaveLength(3)
    expect(() => int4Array.encode(sparse)).toThrow(PgEncodeError)
  })

  it('NEGATIVE CONTROL: an explicit null is still SQL NULL, at every depth', () => {
    expect(int4Array.encode([1, null, 3])).toBe('{1,NULL,3}')
    expect(int4Array.encode([])).toBe('{}')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// integer / numeric coercion
// ─────────────────────────────────────────────────────────────────────────────

describe('integer and numeric encoders validate instead of coercing', () => {
  it("int8: `String(BigInt(v))` turned '' into 0 and '0x10' into 16", () => {
    expect(() => int8Codec.encode('')).toThrow(PgEncodeError)
    expect(() => int8Codec.encode(' 12 ')).toThrow(PgEncodeError)
    expect(() => int8Codec.encode('0x10')).toThrow(PgEncodeError)
    expect(() => int8Codec.encode('1e3')).toThrow(PgEncodeError)
    expect(() => int8Codec.encode('1.0')).toThrow(PgEncodeError)
    // NEGATIVE CONTROL — the spellings PostgreSQL itself accepts
    expect(int8Codec.encode('42')).toBe('42')
    expect(int8Codec.encode('-9223372036854775808')).toBe('-9223372036854775808')
    expect(int8Codec.encode(9007199254740993n)).toBe('9007199254740993')
  })

  it('int8:number and int8:string were pure `String(v)` — anything at all went out', () => {
    expect(() => int8NumberCodec.encode(1.5)).toThrow(PgEncodeError)
    // oxlint-disable-next-line no-loss-of-precision -- 2^53+1 is the input the old codec let through
    expect(() => int8NumberCodec.encode(9007199254740993)).toThrow(PgEncodeError)
    expect(() => int8StringCodec.encode('abc')).toThrow(PgEncodeError)
    expect(() => int8StringCodec.encode('')).toThrow(PgEncodeError)
    expect(int8NumberCodec.encode(1259)).toBe('1259')
    expect(int8StringCodec.encode('-1')).toBe('-1')
  })

  it('int2/int4 still range-check (regression guard)', () => {
    expect(() => int2Codec.encode(32768)).toThrow(PgEncodeError)
    expect(() => int4Codec.encode(2147483648)).toThrow(PgEncodeError)
    expect(() => int4Codec.encode(1.5)).toThrow(PgEncodeError)
    expect(int2Codec.encode(32767)).toBe('32767')
  })

  it('numeric accepts what PostgreSQL accepts, and refuses what it refuses', async () => {
    // measured against the server below, not guessed: a leading `+` and a trailing point are
    // legal numeric input, and `NaN` takes no sign.
    expect(numericCodec.encode('+1.5')).toBe('+1.5')
    expect(numericCodec.encode('1.')).toBe('1.')
    expect(numericCodec.encode('NaN')).toBe('NaN')
    expect(numericCodec.encode('-Infinity')).toBe('-Infinity')
    expect(() => numericCodec.encode('-NaN')).toThrow(PgEncodeError)
    expect(() => numericCodec.encode('1,5')).toThrow(PgEncodeError)
    expect(() => numericNumberCodec.encode('abc')).toThrow(PgEncodeError)

    // THE ORACLE: the server's own verdict on the same four strings.
    expect(await selectOne(`select '+1.5'::numeric`)).toBe('1.5')
    expect(await selectOne(`select '1.'::numeric`)).toBe('1')
    expect(await selectOne(`select 'NaN'::numeric`)).toBe('NaN')
    await expect(
      conn.execute({ text: `select '-NaN'::numeric`, params: [] }),
    ).rejects.toMatchObject({ pgPrime: { server: { sqlstate: '22P02' } } })
  })

  it('every accepted numeric spelling round-trips as a real parameter', async () => {
    for (const v of ['+1.5', '1.', '0.000000000000000000001', '-Infinity', 'NaN']) {
      const out = await selectOne('select $1::numeric', [numericCodec.encode(v)], [1700])
      expect(typeof out).toBe('string')
    }
  })

  it('a text codec is unaffected — this is about coercion, not about strictness for its own sake', () => {
    expect(textCodec.encode('')).toBe('')
    expect(textCodec.encode('0x10')).toBe('0x10')
  })
})
