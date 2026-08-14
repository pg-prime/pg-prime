/**
 * ══════════════════════════════════════════════════════════════════════════════
 *  design/02-driver.md §5.2 — pg's Submittable protocol is its real extension seam.
 *
 *  ⚠️ DEVIATION (confirmed live): research §4.4 claimed `pg` exposes Describe-without-Execute.
 *  It does not. Driving `client.connection.parse/describe/sync` directly crashes the client
 *  with `Received unexpected parseComplete message from backend`, because
 *  `Client._handleParseComplete` requires an `activeQuery`. That crash is reproduced here so
 *  the reason for the Submittable implementation is on the record, not just in a comment.
 *
 *  `describe()` + `pg_attribute.attnotnull` is the nullability source for typed raw SQL and
 *  codegen; `closeStatement()` is protocol `Close('S')`, never SQL `DEALLOCATE` (the exact
 *  thing that broke PHP/PDO against PgBouncer).
 * ══════════════════════════════════════════════════════════════════════════════
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeHarness, type Harness } from './_harness.js'
import type { PgConnection } from '../../src/driver/index.js'

let h: Harness
let conn: PgConnection

beforeAll(async () => {
  h = await makeHarness()
  conn = await h.driver.acquire()
  await conn.execute({
    text: `create temp table nt (id int primary key, req text not null, opt text)`,
    params: [],
  })
})
afterAll(async () => {
  await h?.driver.release(conn)
  await h?.end()
})

describe('describe() — Parse + Describe(S) + Sync, with NO Execute', () => {
  it('is advertised in capabilities and present on the connection', () => {
    expect(h.driver.capabilities.describe).toBe(true)
    expect(typeof conn.describe).toBe('function')
  })

  it('returns server-inferred parameter OIDs in $1..$n order', async () => {
    const r = await conn.describe!(
      'select $1::int8 as big, $2::varchar(30) as t, now() as n, 1.5::numeric(10,2) as num',
    )
    expect(r.paramTypes).toEqual([20, 1043])
  })

  it('returns fields with typmods — the metadata Kysely’s QueryResult structurally cannot carry', async () => {
    const r = await conn.describe!(
      'select $1::int8 as big, $2::varchar(30) as t, now() as n, 1.5::numeric(10,2) as num',
    )
    expect(r.fields.map((f) => [f.name, f.dataTypeID, f.dataTypeModifier])).toEqual([
      ['big', 20, -1],
      ['t', 1043, 34], // varchar(30) → n + 4
      ['n', 1184, -1],
      ['num', 1700, 655366], // numeric(10,2) → ((10<<16)|2) + 4
    ])
  })

  it('returns tableID/columnID, which is what yields NULLABILITY via pg_attribute', async () => {
    const r = await conn.describe!('select id, req, opt from nt where id = $1')
    expect(r.paramTypes).toEqual([23])
    const tableIDs = new Set(r.fields.map((f) => f.tableID))
    expect(tableIDs.size).toBe(1)
    expect([...tableIDs][0]).toBeGreaterThan(0)
    expect(r.fields.map((f) => f.columnID)).toEqual([1, 2, 3])

    // the join that turns protocol metadata into `nullable: boolean`
    const notNull = await conn.execute({
      text: `select a.attname, a.attnotnull::text
               from pg_catalog.pg_attribute a
              where a.attrelid = $1::oid and a.attnum = any($2::int2[])
              order by a.attnum`,
      params: [String(r.fields[0]!.tableID), '{1,2,3}'],
      paramTypes: [26, 1005],
    })
    expect(notNull.rows).toEqual([
      ['id', 'true'],
      ['req', 'true'],
      ['opt', 'false'], // ← the only nullable column, derivable no other way over the wire
    ])
  })

  it('runs NO Execute: a mutating statement is described without being executed', async () => {
    const before = await conn.execute({ text: 'select count(*)::int4 from nt', params: [] })
    const r = await conn.describe!(`insert into nt (id, req) values ($1, $2)`)
    expect(r.paramTypes).toEqual([23, 25])
    expect(r.fields).toEqual([]) // protocol NoData
    const after = await conn.execute({ text: 'select count(*)::int4 from nt', params: [] })
    expect(after.rows).toEqual(before.rows) // nothing was inserted
  })

  it('surfaces errors as ordinary seam data and leaves the connection fully usable', async () => {
    await expect(conn.describe!('select * from no_such_table')).rejects.toMatchObject({
      pgorm: { kind: 'server', server: { sqlstate: '42P01' } },
    })
    const err = await conn.describe!('select * from no_such_table').catch((e: unknown) => e)
    expect((err as { pgorm: { server: { position?: number } } }).pgorm.server.position).toBe(15)
    expect(typeof (err as { pgorm: { server: { position?: number } } }).pgorm.server.position).toBe(
      'number',
    )
    expect(conn.usable).toBe(true)
    expect((await conn.execute({ text: 'select 1', params: [] })).rows).toEqual([['1']])
  })

  it('CONTROL: driving connection.parse/describe/sync directly CRASHES pg (why we use Submittable)', async () => {
    const scratch = await h.driver.acquire()
    try {
      const raw = scratch as unknown as {
        rawClient: {
          connection: {
            parse(q: unknown, more?: boolean): void
            describe(m: unknown, more?: boolean): void
            sync(): void
          }
          on(e: string, l: (a: unknown) => void): unknown
        }
      }
      const crash = new Promise<unknown>((resolve) => {
        raw.rawClient.on('error', resolve)
      })
      raw.rawClient.connection.parse({ name: '', text: 'select 1', types: [] }, true)
      raw.rawClient.connection.describe({ type: 'S', name: '' }, true)
      raw.rawClient.connection.sync()
      const e = (await crash) as Error
      expect(String(e.message)).toMatch(/unexpected parseComplete/i)
    } finally {
      await h.driver.release(scratch, { dispose: true })
    }
  })
})

describe('closeStatement() — protocol Close(S), never SQL DEALLOCATE', () => {
  it("frees the name, including pg's own bookkeeping, so it can be reused for different SQL", async () => {
    const name = 'pgorm_ps_close'
    const a = await conn.execute({
      text: 'select 1::int4 as a',
      params: [],
      mode: 'named',
      statementName: name,
    })
    expect(a.rows).toEqual([['1']])

    // pg guards the name client-side: reusing it for DIFFERENT SQL is refused before the wire
    await expect(
      conn.execute({
        text: 'select 2::int4 as b',
        params: [],
        mode: 'named',
        statementName: name,
      }),
    ).rejects.toThrow(/must be unique/i)

    await conn.closeStatement!(name)

    // after Close('S') + the parsedStatements fix, the same name takes new SQL
    const b = await conn.execute({
      text: 'select 2::int4 as b',
      params: [],
      mode: 'named',
      statementName: name,
    })
    expect(b.rows).toEqual([['2']])
    expect(conn.usable).toBe(true)
  })

  it('closing an unknown statement name is a no-op, not an error', async () => {
    await expect(conn.closeStatement!('pgorm_never_parsed')).resolves.toBeUndefined()
    expect(conn.usable).toBe(true)
  })
})
