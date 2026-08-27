/**
 * ══════════════════════════════════════════════════════════════════════════════
 *  THE WEEK-1 OPEN QUESTION (design/07-runtime.md §6.3 / §9.1)
 *
 *  "`DECLARE` is a *utility* statement and I could not verify whether PostgreSQL reliably
 *   accepts bind parameters in `DECLARE … CURSOR FOR <query>` over the extended protocol.
 *   psycopg2's named cursors interpolate client-side, which is weak evidence against.
 *   Must be settled with a live PG matrix before committing. If it works, it becomes the
 *   zero-dep default and pg-cursor becomes an optimisation."
 *
 *  ANSWER: **YES.** Measured on PostgreSQL 17.11 through pg's extended query path
 *  (`queryMode: 'extended'`, params bound in the Bind message, param OIDs in Parse).
 *  `.stream()` is zero-dependency. `pg-cursor` is not needed, not even as an optional peer.
 *
 *  Two boundary conditions this file also pins, because they shape the implementation:
 *    - `DECLARE` outside a transaction block → `25P01`, unless `WITH HOLD` (which pins the
 *      connection and is forbidden under transaction pooling). So a stream is transaction-scoped.
 *    - The FETCH COUNT may NOT be a bind parameter: `FETCH FORWARD $1` → `42601 syntax error`.
 *      It must be an inlined integer literal — safe, because the ORM supplies it, never the user.
 * ══════════════════════════════════════════════════════════════════════════════
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeHarness, type Harness } from '../live/_harness.js'
import type { PgConnection } from '../../src/driver/index.js'

let h: Harness
let conn: PgConnection

beforeAll(async () => {
  h = await makeHarness()
  conn = await h.driver.acquire()
  await conn.execute({
    text: `create temp table cur_t (id int primary key, bucket int, s text)`,
    params: [],
  })
  await conn.execute({
    text: `insert into cur_t select g, g % 3, 'row' || g from generate_series(1, 20) g`,
    params: [],
  })
})

afterAll(async () => {
  await h?.driver.release(conn)
  await h?.end()
})

describe('DECLARE … CURSOR with bind parameters over the extended protocol', () => {
  it('ACCEPTS bind parameters — the definitive answer to 07 §9.1', async () => {
    await conn.execute({ text: 'begin', params: [] })
    try {
      const declared = await conn.execute({
        text: 'declare c_bind no scroll cursor for select id, s from cur_t where bucket = $1 order by id',
        params: ['1'],
        paramTypes: [23], // int4 — sent in Parse, no ::cast in the SQL
        mode: 'unnamed',
      })
      expect(declared.command).toBe('DECLARE')

      const first = await conn.execute({ text: 'fetch forward 3 from c_bind', params: [] })
      expect(first.rows).toEqual([
        ['1', 'row1'],
        ['4', 'row4'],
        ['7', 'row7'],
      ])

      const second = await conn.execute({ text: 'fetch forward 3 from c_bind', params: [] })
      expect(second.rows).toEqual([
        ['10', 'row10'],
        ['13', 'row13'],
        ['16', 'row16'],
      ])

      await conn.execute({ text: 'close c_bind', params: [] })
    } finally {
      await conn.execute({ text: 'rollback', params: [] })
    }
  })

  it('accepts MULTIPLE bind parameters of different types', async () => {
    await conn.execute({ text: 'begin', params: [] })
    try {
      await conn.execute({
        text: 'declare c_multi cursor for select id, s from cur_t where bucket = $1 and s <> $2 order by id',
        params: ['1', 'row1'],
        paramTypes: [23, 25],
      })
      const r = await conn.execute({ text: 'fetch forward 4 from c_multi', params: [] })
      expect(r.rows.map((row) => row[0])).toEqual(['4', '7', '10', '13'])
    } finally {
      await conn.execute({ text: 'rollback', params: [] })
    }
  })

  it('also works with a NAMED prepared statement', async () => {
    await conn.execute({ text: 'begin', params: [] })
    try {
      const r = await conn.execute({
        text: 'declare c_named cursor for select id from cur_t where bucket = $1 order by id',
        params: ['2'],
        paramTypes: [23],
        mode: 'named',
        statementName: 'pgorm_decl_1',
      })
      expect(r.command).toBe('DECLARE')
      const f = await conn.execute({ text: 'fetch all from c_named', params: [] })
      expect(f.rows.map((row) => row[0])).toEqual(['2', '5', '8', '11', '14', '17', '20'])
    } finally {
      await conn.execute({ text: 'rollback', params: [] })
    }
  })

  it('the bound value is frozen at DECLARE time (normal cursor semantics)', async () => {
    await conn.execute({ text: 'begin', params: [] })
    try {
      await conn.execute({
        text: 'declare c_frozen cursor for select id from cur_t where bucket = $1 order by id',
        params: ['0'],
        paramTypes: [23],
      })
      const f = await conn.execute({ text: 'fetch all from c_frozen', params: [] })
      expect(f.rows.map((row) => row[0])).toEqual(['3', '6', '9', '12', '15', '18'])
    } finally {
      await conn.execute({ text: 'rollback', params: [] })
    }
  })

  it('the SIMPLE protocol, by contrast, cannot carry $1 at all (42P02)', async () => {
    await conn.execute({ text: 'begin', params: [] })
    try {
      await expect(
        conn.execute({
          text: 'declare c_simple cursor for select id from cur_t where bucket = $1',
          params: [],
          mode: 'simple',
        }),
      ).rejects.toMatchObject({ pgorm: { server: { sqlstate: '42P02' } } })
    } finally {
      await conn.execute({ text: 'rollback', params: [] })
    }
  })

  it('BOUNDARY: DECLARE outside a transaction block fails with 25P01', async () => {
    await expect(
      conn.execute({
        text: 'declare c_notx cursor for select id from cur_t where bucket = $1',
        params: ['1'],
        paramTypes: [23],
      }),
    ).rejects.toMatchObject({ pgorm: { server: { sqlstate: '25P01' } } })
  })

  it('BOUNDARY: WITH HOLD works outside a transaction, but pins the connection', async () => {
    const r = await conn.execute({
      text: 'declare c_hold cursor with hold for select id from cur_t where bucket = $1 order by id',
      params: ['1'],
      paramTypes: [23],
    })
    expect(r.command).toBe('DECLARE')
    const f = await conn.execute({ text: 'fetch forward 2 from c_hold', params: [] })
    expect(f.rows.map((row) => row[0])).toEqual(['1', '4'])
    await conn.execute({ text: 'close c_hold', params: [] })
  })

  it('BOUNDARY: the FETCH COUNT may NOT be a bind parameter (42601)', async () => {
    await conn.execute({ text: 'begin', params: [] })
    try {
      await conn.execute({ text: 'declare c_fetchp cursor for select id from cur_t', params: [] })
      await expect(
        conn.execute({ text: 'fetch forward $1 from c_fetchp', params: ['3'], paramTypes: [23] }),
      ).rejects.toMatchObject({ pgorm: { server: { sqlstate: '42601' } } })
    } finally {
      await conn.execute({ text: 'rollback', params: [] })
    }
  })
})

describe('PgConnection.stream() — built on the answer above, zero dependencies', () => {
  it('streams a parameterised query in fixed-size chunks', async () => {
    const chunks: string[][] = []
    let fieldNames: readonly string[] = []
    for await (const chunk of conn.stream(
      {
        text: 'select id, s from cur_t where bucket = $1 order by id',
        params: ['1'],
        paramTypes: [23],
      },
      3,
    )) {
      fieldNames = chunk.fields.map((f) => f.name)
      chunks.push(chunk.rows.map((r) => String(r[0])))
    }
    // 7 matching rows at chunk size 3 → 3 + 3 + 1
    expect(chunks).toEqual([['1', '4', '7'], ['10', '13', '16'], ['19']])
    // `fields` is repeated on every chunk (§2.2)
    expect(fieldNames).toEqual(['id', 's'])
  })

  it('breaking out of the loop closes the portal and leaves the connection clean', async () => {
    for await (const chunk of conn.stream(
      { text: 'select id from cur_t order by id', params: [] },
      2,
    )) {
      expect(chunk.rows.length).toBe(2)
      break
    }
    expect(conn.transactionStatus).toBe('I')
    const after = await conn.execute({ text: 'select 1', params: [] })
    expect(after.rows).toEqual([['1']])
  })

  it('joins an already-open transaction instead of opening its own', async () => {
    await conn.execute({ text: 'begin', params: [] })
    const seen: string[] = []
    for await (const chunk of conn.stream(
      { text: 'select id from cur_t where id <= $1 order by id', params: ['4'], paramTypes: [23] },
      2,
    )) {
      for (const r of chunk.rows) seen.push(String(r[0]))
    }
    expect(seen).toEqual(['1', '2', '3', '4'])
    // still inside OUR transaction — stream() did not commit it
    expect(conn.transactionStatus).toBe('T')
    await conn.execute({ text: 'rollback', params: [] })
  })

  it('maxRows really caps the rows fetched (pg’s own `rows` option only pages)', async () => {
    const r = await conn.execute({
      text: 'select id from cur_t order by id',
      params: [],
      maxRows: 5,
    })
    expect(r.rows.map((row) => row[0])).toEqual(['1', '2', '3', '4', '5'])
    expect(r.rowCount).toBe(5)
  })

  it('refuses to stream inside a FAILED transaction instead of BEGINning blindly', async () => {
    await conn.execute({ text: 'begin', params: [] })
    await conn.execute({ text: 'select 1/0', params: [] }).catch(() => {})
    expect(conn.transactionStatus).toBe('E')
    try {
      const iterator = conn.stream({ text: 'select id from cur_t', params: [] }, 2)[
        Symbol.asyncIterator
      ]()
      // an adapter error, not a raw 25P02 escaping un-normalised from the internal BEGIN
      await expect(iterator.next()).rejects.toMatchObject({ pgorm: { kind: 'adapter' } })
      // …and the caller's failed transaction is still theirs to roll back
      expect(conn.transactionStatus).toBe('E')
    } finally {
      await conn.execute({ text: 'rollback', params: [] })
    }
  })
})
