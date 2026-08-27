/**
 * The seam's hot path — design/02-driver.md §2.3/§2.4, D3, D4, D5, D12.
 *
 *  D3  array row mode ALWAYS, `fields[]` metadata ALWAYS
 *  D4  extended protocol ALWAYS (see types-trick.test.ts for the multi-statement proof)
 *  D5  exec mode is a seam parameter, default `'unnamed'`
 *  D12 errors cross the seam as plain DATA, never as classes
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  makeHarness,
  requiresConcurrency,
  requiresRealPostgres,
  type Harness,
} from '../live/_harness.js'
import { assertSessionGucs } from '../../src/driver/index.js'
import type { PgConnection, PgDriverErrorData } from '../../src/driver/index.js'

/** Await a query that must fail, and hand back the seam DATA it carries (D12). */
async function seamError(p: Promise<unknown>): Promise<PgDriverErrorData> {
  try {
    await p
  } catch (e) {
    return (e as { pgPrime: PgDriverErrorData }).pgPrime
  }
  throw new Error('expected the query to reject, but it resolved')
}

let h: Harness
let conn: PgConnection

beforeAll(async () => {
  h = await makeHarness()
  conn = await h.driver.acquire()
  await conn.execute({
    text: `create temp table ex_a (id int primary key, name text not null);
           create temp table ex_b (id int primary key, name text);`,
    params: [],
    mode: 'simple',
  })
  await conn.execute({
    text: `insert into ex_a values (1,'a1'),(2,'a2'); insert into ex_b values (1,'b1');`,
    params: [],
    mode: 'simple',
  })
})
afterAll(async () => {
  await h?.driver.release(conn)
  await h?.end()
})

describe('D3 — array row mode always, fields[] always', () => {
  it('duplicate JOIN column names survive positionally (object mode would clobber them)', async () => {
    const r = await conn.execute({
      text: `select a.id, a.name, b.id, b.name from ex_a a join ex_b b on b.id = a.id`,
      params: [],
    })
    expect(r.rows).toEqual([['1', 'a1', '1', 'b1']])
    expect(r.fields.map((f) => f.name)).toEqual(['id', 'name', 'id', 'name'])
    // …and tableID/columnID is what disambiguates them
    expect(r.fields[0]!.tableID).not.toBe(r.fields[2]!.tableID)
    expect(r.fields.map((f) => f.columnID)).toEqual([1, 2, 1, 2])
  })

  it('fields[] carries every piece of PgField metadata the codec layer needs', async () => {
    const r = await conn.execute({
      text: `select id, 'x'::varchar(30) as v, 1.5::numeric(10,2) as n, now() as t from ex_a limit 1`,
      params: [],
    })
    expect(r.fields.map((f) => f.dataTypeID)).toEqual([23, 1043, 1700, 1184])
    expect(r.fields.map((f) => f.dataTypeModifier)).toEqual([-1, 34, 655366, -1])
    expect(r.fields.map((f) => f.format)).toEqual(['text', 'text', 'text', 'text'])
    // fixed-width types report a positive byte count, variable-width report -1
    expect(r.fields[0]!.dataTypeSize).toBe(4)
    expect(r.fields[1]!.dataTypeSize).toBe(-1)
    // a real column carries its source table; a computed one does not
    expect(r.fields[0]!.tableID).toBeGreaterThan(0)
    expect(r.fields[1]!.tableID).toBe(0)
    expect(r.fields[1]!.columnID).toBe(0)
  })

  it('every value is raw wire text or null — the adapter never interprets', async () => {
    const r = await conn.execute({
      text: `select 1::int8, null::text, '2026-08-14'::date, true`,
      params: [],
    })
    expect(r.rows[0]).toEqual(['1', null, '2026-08-14', 't'])
  })

  it('rowCount and command come from CommandComplete', async () => {
    expect(await tag('select * from ex_a')).toEqual(['SELECT', 2])
    expect(await tag(`insert into ex_a values (9,'a9')`)).toEqual(['INSERT', 1])
    expect(await tag(`update ex_a set name = 'a9!' where id = 9`)).toEqual(['UPDATE', 1])
    expect(await tag('delete from ex_a where id = 9')).toEqual(['DELETE', 1])
    expect(await tag('create temp table ex_tmp (i int)')).toEqual(['CREATE', null])
  })

  async function tag(text: string): Promise<[string, number | null]> {
    const r = await conn.execute({ text, params: [] })
    return [r.command, r.rowCount]
  }
})

describe('D5 — exec modes', () => {
  it("defaults to 'unnamed' (pooler-safe, zero server session state)", async () => {
    const withoutMode = await conn.execute({ text: 'select 1::int4 as a', params: [] })
    const withMode = await conn.execute({
      text: 'select 1::int4 as a',
      params: [],
      mode: 'unnamed',
    })
    expect(withoutMode.rows).toEqual(withMode.rows)
    expect(h.driver.capabilities.execModes).toEqual(['unnamed', 'named', 'simple'])
  })

  it("'named' reuses a server-side plan across executions", async () => {
    for (const v of ['1', '2', '3']) {
      const r = await conn.execute({
        text: 'select $1::int4 * 10 as v',
        params: [v],
        paramTypes: [23],
        mode: 'named',
        statementName: 'pgprime_ps_reuse',
      })
      expect(r.rows).toEqual([[String(Number(v) * 10)]])
    }
    await conn.closeStatement!('pgprime_ps_reuse')
  })

  it("'named' without a statementName is an adapter error, not a protocol error", async () => {
    await expect(
      conn.execute({ text: 'select 1', params: [], mode: 'named' }),
    ).rejects.toMatchObject({ pgPrime: { kind: 'adapter' } })
    expect(conn.usable).toBe(true)
  })

  it("'simple' runs a multi-statement body and returns the LAST result", async () => {
    const r = await conn.execute({
      text: `select 1 as a; select 2 as b; select 3 as c`,
      params: [],
      mode: 'simple',
    })
    expect(r.rows).toEqual([['3']])
  })
})

describe('§4.4 — binary results are refused, loudly, at the seam', () => {
  it('capabilities.binaryResults is false and the request throws with the reason', async () => {
    expect(h.driver.capabilities.binaryResults).toBe(false)
    await expect(
      conn.execute({ text: 'select 1', params: [], resultFormat: 'binary' }),
    ).rejects.toThrow(/UTF-8-decodes every DataRow field/)
  })
})

describe('D12 — errors cross the seam as plain data', () => {
  it('a unique violation carries constraint, detail, table and a NUMERIC position', async () => {
    const d = await seamError(conn.execute({ text: `insert into ex_a values (1,'dup')`, params: [] }))
    expect(d.kind).toBe('server')
    expect(d.connectionUnusable).toBe(false)
    expect(d.adapter).toBe('pg')
    expect(d.sql).toContain('insert into ex_a')
    expect(d.server!.sqlstate).toBe('23505')
    expect(d.server!.constraint).toBe('ex_a_pkey')
    expect(d.server!.detail).toMatch(/Key \(id\)=\(1\) already exists/)
    expect(d.server!.severity).toBe('ERROR')
    expect(conn.usable).toBe(true)
  })

  it('`position` is a NUMBER even though pg hands it over as a string', async () => {
    const d = await seamError(conn.execute({ text: 'select * from no_such_table', params: [] }))
    expect(d.server!.position).toBe(15)
    expect(typeof d.server!.position).toBe('number')
  })

  it('absent fields are ABSENT, not null', async () => {
    const d = await seamError(conn.execute({ text: 'select * from no_such_table', params: [] }))
    expect('constraint' in d.server!).toBe(false)
    expect('detail' in d.server!).toBe(false)
    expect(d.server!.routine).toBeTypeOf('string')
  })

  it('notices are DATA on the result, never thrown — migrations depend on this', async () => {
    const r = await conn.execute({
      text: `do $$ begin raise notice 'hello %', 42; raise notice 'again'; end $$`,
      params: [],
    })
    expect(r.command).toBe('DO')
    expect(r.notices.map((n) => n.message)).toEqual(['hello 42', 'again'])
    expect(r.notices[0]!.severity).toBe('NOTICE')
    expect(r.notices[0]!.sqlstate).toBe('00000')
    // and they do not leak into the NEXT statement's result
    expect((await conn.execute({ text: 'select 1', params: [] })).notices).toEqual([])
  })

  it('transactionStatus tracks I → T → E → I', async () => {
    expect(conn.transactionStatus).toBe('I')
    await conn.execute({ text: 'begin', params: [] })
    expect(conn.transactionStatus).toBe('T')
    await conn.execute({ text: 'select 1/0', params: [] }).catch(() => {})
    expect(conn.transactionStatus).toBe('E') // failed transaction — the runtime must roll back
    await conn.execute({ text: 'rollback', params: [] })
    expect(conn.transactionStatus).toBe('I')
  })
})

describe('§5.4 — timeoutMs is a client deadline, not a cancellation', () => {
  // Both of these watch one session from another. On PGlite they would pass for the wrong reason:
  // `pg_stat_activity` there reports the one backend's last statement, so the "the server is still
  // running it" assertion holds even if the timeout had cancelled the query. design/08 §4.2.
  requiresConcurrency()('rejects with kind "timeout", RETIRES the connection, and the query KEEPS RUNNING', async () => {
    const victim = await h.driver.acquire()
    const observer = await h.driver.acquire()
    try {
      const pid = victim.backendPid!
      expect(pid).toBeGreaterThan(0)

      // `connectionUnusable` is TRUE, and that is the whole point: pg gave up client-side while
      // the statement stayed on the socket. Handing that client back to the pool makes the next
      // borrower wait behind our `pg_sleep(3)` for reasons they can never diagnose. This test used
      // to paper over it with `release(victim, { dispose: true })` in its own teardown.
      await expect(
        victim.execute({ text: 'select pg_sleep(3)', params: [], timeoutMs: 250 }),
      ).rejects.toMatchObject({ pgPrime: { kind: 'timeout', connectionUnusable: true } })

      // the client gave up; the SERVER did not — this is why `signal` exists separately
      const still = await observer.execute({
        text: `select count(*)::int4 from pg_stat_activity
                where pid = $1::int4 and state = 'active' and query like '%pg_sleep%'`,
        params: [String(pid)],
        paramTypes: [23],
      })
      expect(still.rows[0]![0]).toBe('1')

      expect(victim.usable).toBe(false)
      // and nothing else may be put on that socket behind the statement still running on it
      await expect(victim.execute({ text: 'select 1', params: [] })).rejects.toMatchObject({
        pgPrime: { connectionUnusable: true },
      })
    } finally {
      await h.driver.release(observer)
      // a plain release: the adapter itself knows this one must not go back into rotation
      await h.driver.release(victim)
    }
  })

  // `pglite-socket` answers a CancelRequest with `handleData: CancelRequest received, ignoring
  // (not supported)` — there is no second backend to signal — so the query simply completes.
  requiresRealPostgres('PGlite ignores CancelRequest (pglite-socket has no backend to signal)')(
    'an AbortSignal issues a REAL cancel and the query comes back 57014',
    async () => {
      const victim = await h.driver.acquire()
      try {
        const ac = new AbortController()
        const p = victim.execute({ text: 'select pg_sleep(5)', params: [], signal: ac.signal })
        setTimeout(() => ac.abort(), 200)
        const d = await seamError(p)
        expect(d.kind).toBe('cancelled')
        expect(d.server?.sqlstate).toBe('57014')
        // 57014 is NOT tagged 'server', so agent 07's retry logic can never retry a user cancel
        expect((await victim.execute({ text: 'select 1', params: [] })).rows).toEqual([['1']])
      } finally {
        await h.driver.release(victim)
      }
    },
  )

  it('the give-up RETIRES the connection: the statement is still on that socket', async () => {
    // Runs on PGlite too — it is about what the ADAPTER does with a client whose statement did
    // not finish, not about a second session watching the first.
    const victim = await h.driver.acquire()
    const d = await seamError(
      victim.execute({ text: 'select pg_sleep(3)', params: [], timeoutMs: 200 }),
    )
    expect(d.kind).toBe('timeout')
    expect(d.connectionUnusable).toBe(true)
    expect(victim.usable).toBe(false)
    // a plain release must NOT hand a busy client back to the pool
    await h.driver.release(victim)
  })

  it('a pre-aborted signal never reaches the wire', async () => {
    await expect(
      conn.execute({ text: 'select 1', params: [], signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ pgPrime: { kind: 'cancelled' } })
  })
})

describe('driver lifecycle and capabilities', () => {
  it('capabilities describe the pg adapter accurately', () => {
    const c = h.driver.capabilities
    expect(c.adapter).toBe('pg')
    expect(c.binaryResults).toBe(false)
    expect(c.paramTypeOids).toBe(true)
    expect(c.describe).toBe(true)
    expect(c.richFieldMetadata).toBe(true)
    expect(c.cursors).toBe(true)
    expect(c.listenNotify).toBe(true)
    expect(c.multipleStatementsPerSession).toBe(true)
    expect(c.cancel).toBe('pg_cancel_backend')
    expect(c.maxParams).toBe(65535)
    expect(c.serverVersionNum).toBeGreaterThanOrEqual(150000)
  })

  it('serverParameters are captured and the codec-critical GUCs are asserted, never SET', async () => {
    const p = conn.serverParameters
    expect(p['DateStyle']!.startsWith('ISO')).toBe(true)
    expect(p['client_encoding']).toBe('UTF8')
    expect(p['standard_conforming_strings']).toBe('on')
    expect(p['integer_datetimes']).toBe('on')
    expect(['postgres', 'iso_8601']).toContain(p['IntervalStyle'])
    expect(() => assertSessionGucs(p)).not.toThrow()
    expect(() => assertSessionGucs({ ...p, DateStyle: 'German, DMY' })).toThrow(/DateStyle/)
    expect(() => assertSessionGucs({ ...p, client_encoding: 'LATIN1' })).toThrow(/client_encoding/)
  })

  it('init() is idempotent and acquire/release round-trips', async () => {
    await h.driver.init()
    await h.driver.init()
    const c1 = await h.driver.acquire()
    expect(c1.usable).toBe(true)
    expect(c1.backendPid).toBeGreaterThan(0)
    await h.driver.release(c1)
    await h.driver.release(c1) // releasing twice is a no-op, not a crash
  })

  it("route: 'direct' falls back to the single pool when no directPool is configured", async () => {
    const c = await h.driver.acquire({ route: 'direct' })
    expect((await c.execute({ text: 'select 1', params: [] })).rows).toEqual([['1']])
    await h.driver.release(c)
  })
})
