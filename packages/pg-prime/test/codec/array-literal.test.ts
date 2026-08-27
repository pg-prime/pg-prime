/**
 * The PostgreSQL array-literal grammar — real parsing, real writing, checked against a live
 * server rather than against a guess (design/02 §4.3, §4.5).
 *
 * The four things every hand-rolled array parser gets wrong, all pinned here:
 *   1. unquoted `NULL` is SQL NULL; quoted `"NULL"` is the four-character STRING. A writer must
 *      therefore quote the string 'NULL' and must NOT quote a real null.
 *   2. `\"` and `\\` are the only escapes inside a quoted element.
 *   3. the delimiter is NOT always `,` — `box`/`_box` use `;`, taken from `pg_type.typdelim`.
 *      Verified live below.
 *   4. arrays nest, and a non-default lower bound emits a `[0:1]=` dimension prefix.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeHarness, type Harness } from '../live/_harness.js'
import { parseArrayLiteral, writeArrayLiteral } from '../../src/codec/index.js'
import { createRegistry } from '../../src/codec/index.js'
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

describe('parseArrayLiteral', () => {
  it('empty array', () => {
    expect(parseArrayLiteral('{}')).toEqual([])
  })

  it('plain elements', () => {
    expect(parseArrayLiteral('{a,b,c}')).toEqual(['a', 'b', 'c'])
    expect(parseArrayLiteral('{1,2,3}')).toEqual(['1', '2', '3'])
  })

  it('unquoted NULL is null; quoted "NULL" is the STRING', () => {
    expect(parseArrayLiteral('{NULL,"NULL",null,"null"}')).toEqual([null, 'NULL', null, 'null'])
  })

  it('quoted elements keep the delimiter, braces and whitespace', () => {
    expect(parseArrayLiteral('{a,"b,c","{}","  pad  ",""}')).toEqual([
      'a',
      'b,c',
      '{}',
      '  pad  ',
      '',
    ])
  })

  it(String.raw`\" and \\ are the only escapes`, () => {
    expect(parseArrayLiteral(String.raw`{"he said \"hi\"","back\\slash"}`)).toEqual([
      'he said "hi"',
      String.raw`back\slash`,
    ])
  })

  it('unquoted elements are trimmed, quoted ones are not', () => {
    expect(parseArrayLiteral('{ a , b }')).toEqual(['a', 'b'])
    expect(parseArrayLiteral('{" a "," b "}')).toEqual([' a ', ' b '])
  })

  it('nests', () => {
    expect(parseArrayLiteral('{{1,2},{3,NULL}}')).toEqual([
      ['1', '2'],
      ['3', null],
    ])
    expect(parseArrayLiteral('{{{a}}}')).toEqual([[['a']]])
  })

  it('accepts a non-default lower-bound dimension prefix', () => {
    expect(parseArrayLiteral('[0:1]={a,b}')).toEqual(['a', 'b'])
    expect(parseArrayLiteral('[0:1][0:1]={{a,b},{c,d}}')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('honours a non-comma delimiter (box uses ";")', () => {
    expect(parseArrayLiteral('{(1,1),(0,0);(3,3),(2,2)}', ';')).toEqual([
      '(1,1),(0,0)',
      '(3,3),(2,2)',
    ])
  })

  it('rejects malformed input rather than silently truncating', () => {
    expect(() => parseArrayLiteral('{a,b')).toThrow(SyntaxError)
    expect(() => parseArrayLiteral('{"a}')).toThrow(SyntaxError)
    expect(() => parseArrayLiteral('{a} trailing')).toThrow(SyntaxError)
    expect(() => parseArrayLiteral('a,b')).toThrow(SyntaxError)
  })
})

describe('writeArrayLiteral', () => {
  it('quotes exactly what must be quoted, and nothing else', () => {
    expect(writeArrayLiteral(['a', 'b,c', null, 'NULL', '{}', ''])).toBe(
      '{a,"b,c",NULL,"NULL","{}",""}',
    )
  })

  it('escapes backslash and double quote', () => {
    expect(writeArrayLiteral(['he said "hi"', String.raw`back\slash`])).toBe(
      String.raw`{"he said \"hi\"","back\\slash"}`,
    )
  })

  it('quotes anything containing whitespace', () => {
    expect(writeArrayLiteral(['  pad  '])).toBe('{"  pad  "}')
  })

  it('nests', () => {
    expect(writeArrayLiteral([['1', '2'], ['3', null]])).toBe('{{1,2},{3,NULL}}')
  })

  it('quoting is DELIMITER-RELATIVE: a comma is ordinary text in a ";"-delimited array', () => {
    // `(1,1),(0,0)` contains commas but no `;`, so under `;` it needs no quotes at all —
    // which is exactly how PostgreSQL itself renders `box[]` (asserted live below).
    expect(writeArrayLiteral(['(1,1),(0,0)', '(3,3),(2,2)'], ';')).toBe(
      '{(1,1),(0,0);(3,3),(2,2)}',
    )
    // …and the same strings under `,` MUST be quoted, or they would parse as six elements.
    expect(writeArrayLiteral(['(1,1),(0,0)', '(3,3),(2,2)'], ',')).toBe(
      '{"(1,1),(0,0)","(3,3),(2,2)"}',
    )
  })
})

describe('LIVE ORACLE — PostgreSQL agrees with both halves', () => {
  const zoo = ['a', 'b,c', null, 'NULL', '{}', 'he said "hi"', String.raw`back\slash`, '  pad  ', '']

  it("what we WRITE, PG reads back as the same JS array (the 'NULL' string included)", async () => {
    const literal = writeArrayLiteral(zoo)
    const r = await conn.execute({
      text: 'select $1::text[] as v',
      params: [literal],
      paramTypes: [1009],
    })
    const decoded = registry.planFor(r.fields)[0]!(r.rows[0]![0]!)
    expect(decoded).toEqual(zoo)
  })

  it('what PG WRITES, we parse back to the same JS array', async () => {
    const r = await conn.execute({
      text: `select array['a','b,c',null,'NULL','{}','he said "hi"','back\\slash','  pad  ','']::text[] as v`,
      params: [],
    })
    const raw = String(r.rows[0]![0])
    expect(raw).toBe(String.raw`{a,"b,c",NULL,"NULL","{}","he said \"hi\"","back\\slash","  pad  ",""}`)
    expect(parseArrayLiteral(raw)).toEqual(zoo)
  })

  it('a full write → server → read round trip is lossless for int4[], int8[] and text[]', async () => {
    const cases: readonly [string, number, readonly unknown[]][] = [
      ['int4[]', 1007, [1, -2, null]],
      ['int8[]', 1016, [9007199254740993n, -1n, null]],
      ['text[]', 1009, zoo],
      ['bool[]', 1000, [true, false, null]],
      ['numeric[]', 1231, ['1.10', '2.20', null]],
      ['date[]', 1182, ['2026-08-14', null]],
      ['uuid[]', 2951, ['550e8400-e29b-41d4-a716-446655440000']],
      // bytea is the one type whose scalar parameter goes out in BINARY format; inside an array
      // literal it has to fall back to its `\x…` text spelling.
      ['bytea[]', 1001, [new Uint8Array([0, 255, 128]), null]],
    ]
    for (const [name, oid, value] of cases) {
      const codec = registry.byName(name)!
      const literal = codec.encode(value as never)
      const r = await conn.execute({
        text: `select $1::${codec.sqlName} as v`,
        params: [literal as string],
        paramTypes: [oid],
      })
      expect(r.fields[0]!.dataTypeID, name).toBe(oid)
      expect(registry.planFor(r.fields)[0]!(r.rows[0]![0]!), name).toEqual(value)
    }
  })

  it("box[] really does use ';' — the catalogue, not a hard-coded comma, is the source", async () => {
    const cat = await conn.execute({
      text: `select typdelim from pg_catalog.pg_type where typname = $1`,
      params: ['_box'],
      paramTypes: [19],
    })
    expect(cat.rows[0]![0]).toBe(';')

    const r = await conn.execute({
      text: `select '{(1,1),(0,0);(3,3),(2,2)}'::box[] as v`,
      params: [],
    })
    const raw = String(r.rows[0]![0])
    expect(raw).toBe('{(1,1),(0,0);(3,3),(2,2)}')
    // the delimiter-aware parse gives the two boxes…
    expect(parseArrayLiteral(raw, ';')).toEqual(['(1,1),(0,0)', '(3,3),(2,2)'])
    // …while a hard-coded comma shreds them into seven fragments. This is the geometry-column
    // bug every hand-rolled PG array parser ships with.
    expect(parseArrayLiteral(raw, ',')).toEqual(['(1', '1)', '(0', '0);(3', '3)', '(2', '2)'])

    // and our WRITER reproduces PG's own rendering byte-for-byte under the same delimiter
    expect(writeArrayLiteral(['(1,1),(0,0)', '(3,3),(2,2)'], ';')).toBe(raw)
  })
})
