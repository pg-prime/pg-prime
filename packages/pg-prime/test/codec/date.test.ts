/**
 * ══════════════════════════════════════════════════════════════════════════════
 *  DATE — the headline correctness guarantee (design/02 §4.5, sign-off 00 §6).
 *
 *  `date` → `'YYYY-MM-DD'` string, NEVER a `Date`. A DATE has no time and no time zone;
 *  every mapping to `Date` must invent both, and every driver invents differently:
 *
 *    pg@8.23.0 / pg-types@2.2.0   `SELECT '2026-08-14'::date` → a local-midnight `Date`
 *    @electric-sql/pglite@0.5.5   → a UTC-midnight `Date` (a different answer)
 *    postgres@3.4.9               → `new Date(x)` (a third answer)
 *
 *  This file runs in **Asia/Tokyo** (UTC+9) precisely so the failure mode is visible: local
 *  midnight on 2026-08-14 is 2026-08-13T15:00:00Z, so pg's own parser renders the WRONG
 *  CALENDAR DAY. Our codec cannot: the value is the verbatim wire text and never touches `Date`.
 * ══════════════════════════════════════════════════════════════════════════════
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeHarness, makePool, type Harness } from '../live/_harness.js'
import { createRegistry, dateCodec } from '../../src/codec/index.js'
import type { PgConnection } from '../../src/driver/index.js'

// Node re-reads TZ on the next Date operation, and vitest isolates each test file in its own
// fork, so this cannot leak into another suite.
process.env['TZ'] = 'Asia/Tokyo'

const registry = createRegistry()
const D = '2026-08-14'

let h: Harness
let conn: PgConnection

beforeAll(async () => {
  h = await makeHarness()
  conn = await h.driver.acquire()
  registry.setServerParameters(conn.serverParameters)
  await conn.execute({
    text: `create temp table date_t (id int primary key, d date, ds date[])`,
    params: [],
  })
})
afterAll(async () => {
  await h?.driver.release(conn)
  await h?.end()
})

/** Decode a single-column result through the real registry plan. */
async function selectOne(
  text: string,
  params: readonly (string | Uint8Array | null)[] = [],
  paramTypes?: readonly number[],
) {
  const r = await conn.execute({
    text,
    params,
    ...(paramTypes ? { paramTypes } : {}),
  })
  return registry.planFor(r.fields)[0]!(r.rows[0]![0]!)
}

describe("DATE roundtrip: '2026-08-14' in → exactly '2026-08-14' out", () => {
  it('as a bind parameter, encoded by our codec, with the OID in Parse (no ::cast)', async () => {
    const encoded = dateCodec.encode(D)
    expect(encoded).toBe(D) // the wire form IS the JS form — nothing to get wrong
    const out = await selectOne('select $1 as d', [encoded], [1082])
    expect(out).toBe(D)
    expect(typeof out).toBe('string')
    expect(out).not.toBeInstanceOf(Date)
  })

  it('through a real DATE column: insert → select is byte-identical', async () => {
    await conn.execute({
      text: 'insert into date_t (id, d) values ($1, $2)',
      params: ['1', dateCodec.encode(D)],
      paramTypes: [23, 1082],
    })
    const out = await selectOne('select d from date_t where id = 1')
    expect(out).toBe(D)
  })

  it('the RowDescription OID is 1082 and resolves to the `date` codec', async () => {
    const r = await conn.execute({ text: 'select d from date_t where id = 1', params: [] })
    expect(r.fields[0]!.dataTypeID).toBe(1082)
    expect(registry.forOid(1082)!.name).toBe('date')
    expect(registry.forOid(1082)!.sqlName).toBe('date')
  })

  it('survives a date[] column, and the array roundtrips too', async () => {
    const arr = registry.byName('date[]')!
    const encoded = arr.encode([D, '2026-01-01', null] as never)
    expect(encoded).toBe('{2026-08-14,2026-01-01,NULL}')
    await conn.execute({
      text: 'insert into date_t (id, ds) values ($1, $2)',
      params: ['2', encoded],
      paramTypes: [23, 1182],
    })
    const out = await selectOne('select ds from date_t where id = 2')
    expect(out).toEqual([D, '2026-01-01', null])
  })

  it('survives three levels of json_agg nesting (R5)', async () => {
    const r = await conn.execute({
      text: `select json_agg(l1)::text from (
               select json_build_object('l2', (select json_agg(l2) from (
                 select json_build_object('l3', (select json_agg(l3) from (
                   select json_build_object('d', d) as l3 from date_t where id = 1
                 ) s3)) as l2) s2)) as l1) s1`,
      params: [],
    })
    const payload = JSON.parse(String(r.rows[0]![0])) as [{ l2: [{ l3: [{ d: unknown }] }] }]
    const nested = payload[0]!.l2[0]!.l3[0]!.d
    expect(registry.jsonPlanFor([registry.byName('date')!])[0]!(nested)).toBe(D)
  })

  it('non-ISO DATE values are preserved verbatim, not rejected', async () => {
    for (const v of ['infinity', '-infinity', '0001-01-01 BC', '294276-12-31']) {
      expect(await selectOne(`select '${v}'::date as d`)).toBe(v)
    }
  })

  it('a DATE sorts lexicographically, which is why the string form is safe', async () => {
    const r = await conn.execute({
      text: `select unnest(array['2026-08-14','2026-01-01','2025-12-31']::date[]) as d order by 1`,
      params: [],
    })
    const plan = registry.planFor(r.fields)[0]!
    expect(r.rows.map((row) => plan(row[0]!))).toEqual(['2025-12-31', '2026-01-01', '2026-08-14'])
    expect(['2026-08-14', '2026-01-01', '2025-12-31'].sort()).toEqual([
      '2025-12-31',
      '2026-01-01',
      '2026-08-14',
    ])
  })
})

describe('CONTROL — what the drivers do to a DATE when we do NOT neutralise them', () => {
  it("pg's own parser shifts the calendar day in this (UTC+9) process", async () => {
    // sanity: the process really is in Asia/Tokyo
    expect(new Date(2026, 7, 14).toISOString()).toBe('2026-08-13T15:00:00.000Z')

    const pool = makePool(1)
    try {
      // The `as never` below is how this file reaches pg's `types`-per-query overload; it also
      // erases the Promise from the signature, so the checker cannot see that `pool.query` is
      // thenable. It is.
      // oxlint-disable-next-line typescript/await-thenable -- `as never` erased the Promise
      const raw = (await pool.query({
        text: `select '2026-08-14'::date as d`,
        rowMode: 'array',
        queryMode: 'extended',
        // deliberately no `types` — this is stock pg
      } as never)) as unknown as { rows: unknown[][] }
      const v = raw.rows[0]![0]
      expect(v).toBeInstanceOf(Date)
      // THE BUG: the day that comes back is not the day that is stored.
      expect((v as Date).toISOString().slice(0, 10)).toBe('2026-08-13')
      expect((v as Date).toISOString().slice(0, 10)).not.toBe(D)
    } finally {
      await pool.end()
    }
  })

  it('our codec is immune because the value never becomes a Date', async () => {
    expect(await selectOne(`select '2026-08-14'::date as d`)).toBe(D)
  })
})
