/**
 * `PgQuery.maxRows` — design/02 amendment ③, REVISED.
 *
 * The amendment implemented the cap over `DECLARE`/`FETCH` because pg's own `rows` option pages
 * instead of truncating. That is true of pg's `rows`, but not of the protocol: an `Execute` with a
 * row count answers `PortalSuspended` and stops, and closing the portal ends it. Driving the
 * portal ourselves is one round trip instead of five, and — what this file pins — it keeps the
 * things the cursor could only invent:
 *
 *   - the REAL CommandComplete tag and row count,
 *   - the notices the statement raised,
 *   - `INSERT … RETURNING`, which `DECLARE … CURSOR FOR` cannot wrap at all (42601),
 *   - no transaction of its own, so the session is exactly as idle afterwards as before.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeHarness, type Harness } from '../live/_harness.js'
import type { PgConnection } from '../../src/driver/index.js'

let h: Harness
let conn: PgConnection

beforeAll(async () => {
  h = await makeHarness()
  conn = await h.driver.acquire()
  // pg_temp on the function, like the two tables: an UNQUALIFIED create function lands in
  // public and outlives the session, so a second run against the same tier-2 server
  // (PG_PRIME_TEST_URL) failed this hook with 42723 "already exists with same argument types".
  // The temp tables were session-scoped already; the function has to be too.
  await conn.execute({
    text: `create temp table cap_t (id int primary key, s text);
           insert into cap_t select g, 'row' || g from generate_series(1, 20) g;
           create temp table cap_ins (id int primary key);
           create function pg_temp.cap_notice() returns int language plpgsql as $$
             begin raise notice 'capped notice'; return 7; end $$;`,
    params: [],
    mode: 'simple',
  })
})
afterAll(async () => {
  await h?.driver.release(conn)
  await h?.end()
})

describe('maxRows caps the portal', () => {
  it('returns exactly n rows and the real fields', async () => {
    const r = await conn.execute({ text: 'select id, s from cap_t order by id', params: [], maxRows: 5 })
    expect(r.rows.map((row) => row[0])).toEqual(['1', '2', '3', '4', '5'])
    expect(r.fields.map((f) => f.name)).toEqual(['id', 's'])
    expect(r.rowCount).toBe(5)
    // it opened no transaction of its own
    expect(conn.transactionStatus).toBe('I')
  })

  it('a cap larger than the result set reports the statement’s own tag and count', async () => {
    const r = await conn.execute({
      text: `select id from cap_t where id <= $1 order by id`,
      params: ['3'],
      paramTypes: [23],
      maxRows: 100,
    })
    expect(r.rows.map((row) => row[0])).toEqual(['1', '2', '3'])
    expect(r.command).toBe('SELECT')
    expect(r.rowCount).toBe(3)
  })

  it('works INSIDE a caller’s transaction and leaves it open', async () => {
    await conn.execute({ text: 'begin', params: [] })
    try {
      const r = await conn.execute({ text: 'select id from cap_t order by id', params: [], maxRows: 2 })
      expect(r.rows).toHaveLength(2)
      expect(conn.transactionStatus).toBe('T')
    } finally {
      await conn.execute({ text: 'rollback', params: [] })
    }
  })

  it('carries the statement’s NOTICES, which the cursor implementation could not', async () => {
    const r = await conn.execute({ text: 'select pg_temp.cap_notice()', params: [], maxRows: 1 })
    expect(r.rows).toEqual([['7']])
    expect(r.notices.map((n) => n.message)).toEqual(['capped notice'])
  })

  it('supports INSERT … RETURNING, which DECLARE … CURSOR FOR cannot wrap', async () => {
    const r = await conn.execute({
      text: `insert into cap_ins (id) values (101) returning id`,
      params: [],
      maxRows: 5,
    })
    expect(r.rows).toEqual([['101']])
    expect(r.command).toBe('INSERT')
    const back = await conn.execute({ text: 'select id from cap_ins order by id', params: [] })
    expect(back.rows).toEqual([['101']])
  })

  it('maxRows: 0 still RUNS the statement, and returns no rows', async () => {
    const r = await conn.execute({
      text: `insert into cap_ins (id) values (102) returning id`,
      params: [],
      maxRows: 0,
    })
    expect(r.rows).toEqual([])
    expect(r.rowCount).toBe(0)
    expect(r.fields.map((f) => f.name)).toEqual(['id']) // Describe(portal) still ran
    // the side effect happened — "cap the rows" never meant "skip the statement"
    const back = await conn.execute({ text: 'select id from cap_ins order by id', params: [] })
    expect(back.rows).toEqual([['101'], ['102']])
  })

  it('a truncated portal reports the statement’s verb, not a fabricated SELECT', async () => {
    const r = await conn.execute({
      text: `insert into cap_ins (id) select g from generate_series(201, 210) g returning id`,
      params: [],
      maxRows: 2,
    })
    expect(r.rows.map((row) => row[0])).toEqual(['201', '202'])
    expect(r.command).toBe('INSERT')
    await conn.execute({ text: 'delete from cap_ins where id >= 200', params: [] })
  })

  it('a bad cap is an adapter error, and the connection stays usable', async () => {
    await expect(
      conn.execute({ text: 'select 1', params: [], maxRows: -1 }),
    ).rejects.toMatchObject({ pgPrime: { kind: 'adapter' } })
    await expect(
      conn.execute({ text: 'select 1', params: [], maxRows: 1.5 }),
    ).rejects.toMatchObject({ pgPrime: { kind: 'adapter' } })
    expect(conn.usable).toBe(true)
  })

  it('a server error on a capped query crosses the seam as data and does not poison the connection', async () => {
    await expect(
      conn.execute({ text: 'select * from no_such_table_here', params: [], maxRows: 1 }),
    ).rejects.toMatchObject({ pgPrime: { kind: 'server', server: { sqlstate: '42P01' } } })
    expect(conn.usable).toBe(true)
    expect((await conn.execute({ text: 'select 1', params: [] })).rows).toEqual([['1']])
  })

  it('binds parameters through our own Bind, with the OIDs in Parse (no ::casts)', async () => {
    const r = await conn.execute({
      text: 'select $1::text || s from cap_t where id = $2 order by id',
      params: ['x-', '3'],
      paramTypes: [25, 23],
      maxRows: 1,
    })
    expect(r.rows).toEqual([['x-row3']])
  })

  it('a bytea parameter still goes out in BINARY format on the capped path (D9)', async () => {
    const bytes = new Uint8Array([0x00, 0x80, 0xff, 0x41])
    const r = await conn.execute({
      text: 'select length($1::bytea), encode($1::bytea, $2::text)',
      params: [bytes, 'hex'],
      paramTypes: [17, 25],
      maxRows: 1,
    })
    expect(r.rows).toEqual([['4', '0080ff41']])
  })
})
