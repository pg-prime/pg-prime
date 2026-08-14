/**
 * ══════════════════════════════════════════════════════════════════════════════
 *  design/02-driver.md §5.1 — the per-query `query.types` trick, verified live.
 *
 *  `pg` reads `query.types` TWICE with two different meanings:
 *    - as an ARRAY of parameter type OIDs, for the Parse message
 *    - as an OBJECT with `getTypeParser`, for the result-parser table
 *  We satisfy both with ONE value: an array of param OIDs carrying a `getTypeParser`
 *  own-property. Both halves are asserted here:
 *    (1) parameter OIDs really reach Parse  → `pg_typeof($1)` is what we declared, and a bare
 *        `$n` does not raise 42P18, so no `::type` casts pollute the generated SQL.
 *    (2) every result parser is neutralised → raw wire TEXT reaches our codecs (D7).
 *  Plus the consequence that makes the user-supplied-pool model viable: this needs NO
 *  cooperation from how the user built their Pool, and it does not leak to other queries.
 * ══════════════════════════════════════════════════════════════════════════════
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeHarness, makePool, typeSourceRaw, type Harness } from './_harness.js'
import { typeSource } from '../../src/driver/index.js'
import type { PgConnection } from '../../src/driver/index.js'

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

describe('typeSource() satisfies both of pg’s readers of `query.types`', () => {
  it('is an Array (Parse reader) AND carries getTypeParser (Result reader)', () => {
    const ts = typeSource([20, 25])
    expect(Array.isArray(ts)).toBe(true)
    expect([...ts]).toEqual([20, 25])
    expect(typeof ts.getTypeParser).toBe('function')
    expect(ts.getTypeParser(1082)('2026-08-14')).toBe('2026-08-14')
    expect(ts.getTypeParser(1184, 'binary')('x')).toBe('x')
  })

  it('(1) parameter OIDs REACH the server — no ::casts needed', async () => {
    const r = await conn.execute({
      text: 'select $1 as a, $2 as b, pg_typeof($1)::text as t1, pg_typeof($2)::text as t2',
      params: ['9007199254740993', 'x'],
      paramTypes: [20, 25],
    })
    expect(r.rows[0]).toEqual(['9007199254740993', 'x', 'bigint', 'text'])
  })

  it('(1b) a bare $n with paramTypes does NOT raise 42P18', async () => {
    const r = await conn.execute({
      text: 'select $1::text as v',
      params: ['hello'],
      paramTypes: [25],
    })
    expect(r.rows[0]).toEqual(['hello'])
  })

  it('(1c) zero params + typeSource([]) is safe (pg writes zero parameter OIDs)', async () => {
    const r = await conn.execute({ text: 'select 42::int8 as v', params: [] })
    expect(r.rows[0]).toEqual(['42'])
  })

  it('(2) ALL result parsers are neutralised — every value is raw wire text', async () => {
    const r = await conn.execute({
      text: `select 1::int8            as a,
                    1.10::numeric(10,2) as b,
                    '2026-08-14'::date  as c,
                    '2026-08-14 06:30:00.123456+00'::timestamptz as d,
                    true                as e,
                    '{1,2}'::int4[]     as f,
                    '\\x00ff80'::bytea  as g,
                    '{"a":1}'::jsonb    as h,
                    'infinity'::timestamptz as i`,
      params: [],
    })
    const row = r.rows[0]!
    for (const v of row) expect(typeof v).toBe('string')
    expect(row).toEqual([
      '1',
      '1.10',
      '2026-08-14',
      '2026-08-14 06:30:00.123456+00',
      't',
      '{1,2}',
      '\\x00ff80',
      '{"a": 1}',
      'infinity',
    ])
  })

  it('(2b) neutralisation also holds under mode: "simple"', async () => {
    const r = await conn.execute({
      text: `select '2026-08-14'::date as d, 1::int8 as n`,
      params: [],
      mode: 'simple',
    })
    expect(r.rows[0]).toEqual(['2026-08-14', '1'])
  })

  it('CONTROL: without the trick, pg lies about exactly these types', async () => {
    // Same pool, same connection style — only `types` removed. This is the behaviour D7 exists
    // to eliminate, and it is why codecs live in ORM core.
    const pool = makePool(1)
    try {
      const raw = (await pool.query({
        text: `select 1::int8, 1.10::numeric(10,2), '2026-08-14'::date,
                      '2026-08-14 06:30:00.123456+00'::timestamptz, '{1,2}'::int4[]`,
        rowMode: 'array',
        queryMode: 'extended',
        // deliberately no `types`
      } as never)) as unknown as { rows: unknown[][] }
      const [i8, numv, date, tstz, arr] = raw.rows[0]!
      expect(typeof i8).toBe('string') // int8 → string on pg, bigint on PGlite: divergence
      expect(typeof numv).toBe('string')
      expect(date).toBeInstanceOf(Date) // ← a DATE became a Date
      expect(tstz).toBeInstanceOf(Date)
      expect(Array.isArray(arr)).toBe(true)
    } finally {
      await pool.end()
    }
  })

  it('per-query types does NOT pollute the pool: the next query sees pg’s defaults again', async () => {
    const pool = makePool(1)
    try {
      const neutral = (await pool.query({
        text: `select '2026-08-14'::date`,
        rowMode: 'array',
        queryMode: 'extended',
        types: typeSourceRaw([]),
      } as never)) as unknown as { rows: unknown[][] }
      expect(neutral.rows[0]![0]).toBe('2026-08-14')

      const polluted = (await pool.query({
        text: `select '2026-08-14'::date`,
        rowMode: 'array',
        queryMode: 'extended',
      } as never)) as unknown as { rows: unknown[][] }
      expect(polluted.rows[0]![0]).toBeInstanceOf(Date)
    } finally {
      await pool.end()
    }
  })

  it('a Uint8Array parameter is sent in BINARY format (bytea, §4.4)', async () => {
    const r = await conn.execute({
      text: 'select length($1::bytea)::text as n, $1::bytea as v',
      params: [new Uint8Array([0, 255, 128])],
      paramTypes: [17],
    })
    // 3 bytes, not the 8 characters of a "\\x00ff80" text literal
    expect(r.rows[0]).toEqual(['3', '\\x00ff80'])
  })
})

describe('D4/§5.3 — the extended protocol is forced, even with zero parameters', () => {
  it('a multi-statement string is REJECTED by the server (42601), not silently run', async () => {
    await expect(
      conn.execute({ text: 'select 1 as a; select 2 as b', params: [] }),
    ).rejects.toMatchObject({ pgorm: { server: { sqlstate: '42601' } } })
  })

  it("mode 'simple' is the ONLY way to run a multi-statement body (migrations need it)", async () => {
    const r = await conn.execute({ text: 'select 1 as a; select 2 as b', params: [], mode: 'simple' })
    expect(r.rows).toEqual([['2']]) // last statement's result
  })

  it("mode 'simple' refuses parameters at the seam", async () => {
    await expect(
      conn.execute({ text: 'select $1', params: ['x'], mode: 'simple' }),
    ).rejects.toMatchObject({ pgorm: { kind: 'adapter' } })
  })
})
