/**
 * ══════════════════════════════════════════════════════════════════════════════
 *  DECODE SIDE — what a codec must REFUSE, and which error class it must refuse with
 *
 *  A decoder is not a parser of "roughly this shape": it reads exactly what PostgreSQL's output
 *  function emits (design/02 §4.5, all raw text there measured). Every leniency below was a
 *  silent wrong answer rather than a failure — `Number('')` is 0, `BigInt('0x10')` is 16n,
 *  `parseInt('0g', 16)` is 0 — so the value that came back was a plausible number that no row
 *  ever contained.
 *
 *  The oracles here are the wire spellings the live server produces (asserted, not assumed), the
 *  error CLASS, and byte-exact array literals. Never a message.
 * ══════════════════════════════════════════════════════════════════════════════
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeHarness, type Harness } from '../live/_harness.js'
import {
  arrayCodec,
  arrayCodecOf,
  boolCodec,
  byteaCodec,
  createRegistry,
  enumCodec,
  float8Codec,
  int4Codec,
  int8Codec,
  jsonbCodec,
  PgDecodeError,
  PgEncodeError,
  textCodec,
  writeArrayLiteral,
} from '../../src/codec/index.js'
import type { CodecContext } from '../../src/codec/index.js'
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
  await h?.driver.release(conn)
  await h?.end()
})

async function selectOne(
  text: string,
  params: readonly (string | Uint8Array | null)[] = [],
  paramTypes?: readonly number[],
): Promise<unknown> {
  const r = await conn.execute({ text, params, ...(paramTypes ? { paramTypes } : {}) })
  return registry.planFor(r.fields)[0]!(r.rows[0]![0]!)
}

// ─────────────────────────────────────────────────────────────────────────────
// strict spellings
// ─────────────────────────────────────────────────────────────────────────────

describe('decoders accept only the spellings PostgreSQL emits', () => {
  it('THE ORACLE: the raw wire text the server emits for bool, int and float', async () => {
    // Raw rows, no decode plan: this is `boolout`/`int4out`/`float8out` output verbatim, which is
    // the ONLY input a `decodeText` can ever legitimately receive.
    const r = await conn.execute({
      text: `select true, false, (-42)::int4, 1e3::float8, 'NaN'::float8, 9007199254740993::int8`,
      params: [],
    })
    expect(r.rows[0]).toEqual(['t', 'f', '-42', '1000', 'NaN', '9007199254740993'])

    // ⚠️ and the trap that makes the strictness worth pinning: the bool→text CAST is a different
    // function from `boolout`, so a `::text` in the wrong place produces a spelling the wire
    // never carries. The codec must not quietly accept both.
    const cast = await conn.execute({ text: `select true::text, false::text`, params: [] })
    expect(cast.rows[0]).toEqual(['true', 'false'])
  })

  it('bool: exactly t / f, at BOTH depths', () => {
    expect(boolCodec.decodeText('t', ctx)).toBe(true)
    expect(boolCodec.decodeText('f', ctx)).toBe(false)
    // used to return `true` for these, and `false` for anything else at all
    expect(() => boolCodec.decodeText('true', ctx)).toThrow(PgDecodeError)
    expect(() => boolCodec.decodeText('y', ctx)).toThrow(PgDecodeError)
    expect(() => boolCodec.decodeText('1', ctx)).toThrow(PgDecodeError)
    expect(() => boolCodec.decodeText('', ctx)).toThrow(PgDecodeError)
    // depth 3 was a DIFFERENT set — 't'/'true' — which is an R5 violation on its own
    expect(boolCodec.decodeJson(true, ctx)).toBe(true)
    expect(boolCodec.decodeJson('t', ctx)).toBe(true)
    expect(() => boolCodec.decodeJson('true', ctx)).toThrow(PgDecodeError)
  })

  it('integers: no blanks, no padding, no hex, no exponent', () => {
    for (const bad of ['', ' 12 ', '0x10', '1e3', '1.0', '+', 'NaN']) {
      expect(() => int4Codec.decodeText(bad, ctx), `int4 ${JSON.stringify(bad)}`).toThrow(
        PgDecodeError,
      )
      expect(() => int8Codec.decodeText(bad, ctx), `int8 ${JSON.stringify(bad)}`).toThrow(
        PgDecodeError,
      )
    }
    // `Number('')` is 0 and `BigInt('')` is 0n — the two values this used to invent
    expect(int4Codec.decodeText('-42', ctx)).toBe(-42)
    expect(int8Codec.decodeText('-9223372036854775808', ctx)).toBe(-9223372036854775808n)
  })

  it('float8: an empty string is not zero', () => {
    expect(() => float8Codec.decodeText('', ctx)).toThrow(PgDecodeError)
    expect(() => float8Codec.decodeText('0x10', ctx)).toThrow(PgDecodeError)
    // NEGATIVE CONTROL: the three special values PG really does emit are still decoded
    expect(float8Codec.decodeText('NaN', ctx)).toBeNaN()
    expect(float8Codec.decodeText('Infinity', ctx)).toBe(Number.POSITIVE_INFINITY)
    expect(float8Codec.decodeText('-Infinity', ctx)).toBe(Number.NEGATIVE_INFINITY)
    expect(float8Codec.decodeText('0.30000000000000004', ctx)).toBe(0.30000000000000004)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// bytea
// ─────────────────────────────────────────────────────────────────────────────

describe('bytea hex decoding is a nibble table, not parseInt', () => {
  it('a bad SECOND nibble is rejected — parseInt stopped at it and returned the first', () => {
    // `parseInt('0g', 16)` is 0, so '\\x0g' decoded to Uint8Array [0] with no complaint.
    expect(() => byteaCodec.decodeText('\\x0g', ctx)).toThrow(PgDecodeError)
    expect(() => byteaCodec.decodeText('\\x00ffzz', ctx)).toThrow(PgDecodeError)
    expect(() => byteaCodec.decodeText('\\x g0', ctx)).toThrow(PgDecodeError)
    expect(() => byteaCodec.decodeText('\\x0', ctx)).toThrow(PgDecodeError) // odd length
    expect(() => byteaCodec.decodeText('00ff', ctx)).toThrow(PgDecodeError) // no \\x prefix
  })

  it('NEGATIVE CONTROL: real hex still decodes, from the live server too', async () => {
    expect(byteaCodec.decodeText('\\x00ff80', ctx)).toEqual(new Uint8Array([0, 255, 128]))
    expect(byteaCodec.decodeText('\\x', ctx)).toEqual(new Uint8Array([]))
    // uppercase is accepted on the way in even though PG only ever emits lowercase
    expect(byteaCodec.decodeText('\\x00FF80', ctx)).toEqual(new Uint8Array([0, 255, 128]))
    expect(await selectOne(`select '\\x00ff80'::bytea`)).toEqual(new Uint8Array([0, 255, 128]))
  })

  it('a 1 MB value decodes correctly (the table is the hot path, not just the safe path)', () => {
    const bytes = new Uint8Array(1 << 20)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff
    const hex = byteaCodec.toJson!(bytes)
    expect(byteaCodec.decodeText(String(hex), ctx)).toEqual(bytes)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// arrays: leafness, nesting, serialisation
// ─────────────────────────────────────────────────────────────────────────────

describe('an array element that IS an array: only the element codec can tell', () => {
  const jsonbArray = arrayCodec(jsonbCodec, 3807)
  const int4Array = arrayCodec(int4Codec, 1007)

  it('jsonb[] carrying one array-valued document', () => {
    // was '{{1,2}}' — a 2-D array of the jsonb numbers 1 and 2, which is a different VALUE.
    expect(jsonbArray.encode([[1, 2]])).toBe('{"[1,2]"}')
    expect(jsonbArray.encode([[1, 2], { a: 1 }, null])).toBe('{"[1,2]","{\\"a\\":1}",NULL}')
  })

  it('LIVE: the server agrees it is ONE element, and that element is the array', async () => {
    const literal = jsonbArray.encode([[1, 2]])
    const r = await conn.execute({
      text: `select array_ndims($1::jsonb[]), array_length($1::jsonb[], 1), ($1::jsonb[])[1] = '[1,2]'::jsonb`,
      params: [literal],
      paramTypes: [3807],
    })
    // ndims 2 / length 1 / null is what the old '{{1,2}}' produced here
    expect(r.rows[0]).toEqual(['1', '1', 't'])

    const back = await selectOne('select $1::jsonb[]', [literal], [3807])
    expect(back).toEqual([[1, 2]])
  })

  it('NEGATIVE CONTROL: for a scalar element type, a nested array still NESTS', async () => {
    // A multi-dimensional array is outside the TS element type (`int4[]` is `number[]`), so the
    // structural case is exercised where it actually lives — the literal writer, whose `isLeaf`
    // predicate defaults to "every array nests".
    const twoDim = writeArrayLiteral([[1, 2], [3, 4]], ',', (v) => String(v))
    expect(twoDim).toBe('{{1,2},{3,4}}')
    // …and the SAME input with a leaf-classed element is one row of two documents instead
    expect(writeArrayLiteral([[1, 2], [3, 4]], ',', (v) => JSON.stringify(v), () => true)).toBe(
      '{"[1,2]","[3,4]"}',
    )
    const r = await conn.execute({
      text: `select array_ndims($1::int4[]), array_ndims($2::jsonb[])`,
      params: [twoDim, jsonbArray.encode([[1, 2], [3, 4]])],
      paramTypes: [1007, 3807],
    })
    expect(r.rows[0]).toEqual(['2', '1'])
    // the 1-D int4[] path is unchanged and still typed
    expect(int4Array.encode([1, null, 3])).toBe('{1,NULL,3}')
  })

  it('toJson recurses, so a 2-D int8[] serialises as numbers and not as joined strings', () => {
    const int8Array = arrayCodec(int8Codec, 1016)
    // the value as it comes back from a real 2-D int8[] column
    const decoded = int8Array.decodeText('{{1,2},{3,NULL}}', ctx)
    expect(decoded).toEqual([
      [1n, 2n],
      [3n, null],
    ])
    // `element.toJson` used to be applied to the nested ARRAY: String([1n,2n]) → '1,2'
    expect(int8Array.toJson!(decoded)).toEqual([
      ['1', '2'],
      ['3', null],
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// error classes
// ─────────────────────────────────────────────────────────────────────────────

describe('every failure in this layer is a PgDecodeError / PgEncodeError', () => {
  it('a malformed array literal is a PgDecodeError naming the codec, not a bare SyntaxError', () => {
    const int4Array = arrayCodec(int4Codec, 1007)
    for (const bad of ['{1,2', '{1,2}}', '"a"', '[1:2]{1}']) {
      expect(() => int4Array.decodeText(bad, ctx), bad).toThrow(PgDecodeError)
    }
    try {
      int4Array.decodeText('{1,2', ctx)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PgDecodeError)
      expect((e as PgDecodeError).codec).toBe('int4[]')
    }
  })

  it('enumCodec.encode raises PgEncodeError — it used to raise PgDecodeError', () => {
    const mood = enumCodec('mood', 99999, ['sad', 'ok', 'happy'])
    expect(() => mood.encode('elated')).toThrow(PgEncodeError)
    expect(() => mood.encode('elated')).not.toThrow(PgDecodeError)
    // decode stays PgDecodeError — the two directions are distinguishable, which is the point
    expect(() => mood.decodeText('elated', ctx)).toThrow(PgDecodeError)
    expect(mood.encode('ok')).toBe('ok')
  })

  it('constructing the error never throws, even for a raw value JSON cannot hold', () => {
    // `JSON.stringify(1n)` throws, so building the PgDecodeError threw a TypeError and the real
    // failure was replaced by an unrelated one from inside the error constructor.
    expect(() => boolCodec.decodeJson(1n, ctx)).toThrow(PgDecodeError)
    expect(new PgDecodeError('int8', 1n, 'boom').message).toContain('1n')
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(() => new PgDecodeError('jsonb', cyclic, 'boom')).not.toThrow()
  })

  it('a 10 MB raw value does not become a 10 MB exception message', () => {
    const huge = 'x'.repeat(10_000_000)
    const err = new PgDecodeError('bytea', huge, 'boom')
    expect(err.message.length).toBeLessThan(400)
    expect(err.raw).toBe(huge) // the full value is still on the error for a debugger
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// derived array identity
// ─────────────────────────────────────────────────────────────────────────────

describe('arrayCodecOf has ONE memo, with or without a registry', () => {
  it('the same element yields the same object through every door', () => {
    const r1 = createRegistry()
    const r2 = createRegistry()
    // these three used to be three DIFFERENT objects with identical behaviour, so an AST built
    // with a registry never compared `toStrictEqual` to one built without.
    expect(arrayCodecOf(textCodec)).toBe(r1.byName('text[]'))
    expect(arrayCodecOf(textCodec, r1)).toBe(arrayCodecOf(textCodec))
    expect(r1.byName('int4[]')).toBe(r2.byName('int4[]'))
  })

  it('a registry that OVERRIDES an array codec still wins for that registry', () => {
    const r = createRegistry()
    const impostor = { ...arrayCodecOf(textCodec), name: 'text[]', oid: 1009 }
    r.register(impostor, { override: true })
    expect(arrayCodecOf(textCodec, r)).toBe(impostor)
    // …and it did not leak into the shared memo
    expect(arrayCodecOf(textCodec)).not.toBe(impostor)
    expect(createRegistry().byName('text[]')).not.toBe(impostor)
  })
})
