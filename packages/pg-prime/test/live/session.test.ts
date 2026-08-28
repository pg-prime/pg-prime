/**
 * The session layer against a real backend, tier 1 (design/07 §3, §4, §6, §7; design/12 §3 S).
 *
 * PGlite by default, `PG_PRIME_TEST_URL` when it is set. Everything here needs *a* server and
 * nothing here needs a *second session*: the concurrency claims — a real `40001`, a `40P01`, a
 * killed backend, a pooler — are tier 2, because PGlite multiplexes every connection onto one
 * backend and would pass a broken implementation (`08` §4.2, F8).
 *
 * R18 throughout: "rolled back" means the ROW IS ABSENT and the statement log shows `ROLLBACK`, in
 * the same test. The row is read back through a **separate** path (`raw()`, hand-written SQL over
 * the driver) so the assertion is an oracle rather than an echo of the builder.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PgDriver, PgLikePool } from '../../src/driver/index.js'
import { pgDriver } from '../../src/driver/index.js'
import {
  InFailedTransactionError,
  TransactionRollback,
  UniqueViolationError,
  isUniqueViolation,
} from '../../src/errors/index.js'
import { pgPrime } from '../../src/query/run.js'
import type { Db } from '../../src/query/types.js'
import { defineSchema, pgTable } from '../../src/schema/index.js'
import { liveTarget, makeHarness, makePool, requiresRealPostgres, type Harness } from './_harness.js'

const NS = 'pgprime_live_session'

const widgets = pgTable(
  'widgets',
  (t) => ({ id: t.integer().primaryKey(), name: t.text(), qty: t.integer().default(0) }),
  undefined,
  { schema: NS },
)
const schema = defineSchema({ widgets })

const DDL = `
create schema ${NS};
create table ${NS}.widgets (id integer primary key, name text not null, qty integer not null default 0);
insert into ${NS}.widgets (id, name) values (1, 'one'), (2, 'two'), (3, 'three');
`

let h: Harness
let db: Db<typeof schema>
/** A SECOND driver, so the oracle's reads never share a connection with the writes they check. */
let oracleDriver: PgDriver

beforeAll(async () => {
  h = await makeHarness(4)
  const conn = await h.driver.acquire()
  try {
    await conn.execute({ text: `drop schema if exists ${NS} cascade`, params: [], mode: 'simple' })
    await conn.execute({ text: DDL, params: [], mode: 'simple' })
  } finally {
    await h.driver.release(conn)
  }
  db = pgPrime({ driver: h.driver, schema })
  oracleDriver = pgDriver({ pool: makePool(1) as unknown as PgLikePool })
  await oracleDriver.init()
}, 120_000)

afterAll(async () => {
  const conn = await h?.driver.acquire().catch(() => undefined)
  if (conn !== undefined) {
    await conn
      .execute({ text: `drop schema if exists ${NS} cascade`, params: [], mode: 'simple' })
      .catch(() => {})
    await h.driver.release(conn)
  }
  await oracleDriver?.destroy().catch(() => {})
  await h?.end()
})

/**
 * Hand-written SQL, through a different driver, with values read as raw text (R1).
 *
 * A write verified by reading it back through the same builder proves only that the builder is
 * self-consistent. This is the oracle.
 */
async function raw(text: string): Promise<readonly (readonly (string | null)[])[]> {
  const conn = await oracleDriver.acquire()
  try {
    const r = await conn.execute({ text, params: [] })
    return r.rows as readonly (readonly (string | null)[])[]
  } finally {
    await oracleDriver.release(conn)
  }
}

async function ids(): Promise<number[]> {
  const rows = await raw(`select id from ${NS}.widgets order by id`)
  return rows.map((r) => Number(r[0]))
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.3 — a savepoint is the ONLY way to continue after a statement error
// ─────────────────────────────────────────────────────────────────────────────

describe('savepoints un-poison a transaction (07 §3.3)', () => {
  it('without one, the next statement is 25P02 and the whole transaction is lost', async () => {
    const before = await ids()
    const err = await db
      .transaction(async (tx) => {
        await tx.insertInto(schema.h.widgets).values({ id: 90, name: 'ninety' }).execute()
        await tx
          .insertInto(schema.h.widgets)
          .values({ id: 1, name: 'duplicate' })
          .execute()
          .catch(() => undefined)
        // The transaction is aborted; PostgreSQL refuses everything until it ends.
        await tx.insertInto(schema.h.widgets).values({ id: 91, name: 'ninety-one' }).execute()
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InFailedTransactionError)
    expect((err as InFailedTransactionError).poisonedBy).toBeInstanceOf(UniqueViolationError)
    // R18: the ROW is the oracle, not our report. Nothing from that transaction survived.
    expect(await ids()).toStrictEqual(before)
  })

  it('with one, the speculative insert fails and the transaction carries on and COMMITS', async () => {
    let caught: unknown
    await db.transaction(async (tx) => {
      await tx.insertInto(schema.h.widgets).values({ id: 92, name: 'audit' }).execute()
      try {
        await tx.savepoint(async (sp) => {
          await sp.insertInto(schema.h.widgets).values({ id: 1, name: 'duplicate' }).execute()
        })
      } catch (e) {
        caught = e
      }
      // This is the line that fails with 25P02 without the savepoint. It is the whole point.
      await tx.insertInto(schema.h.widgets).values({ id: 93, name: 'events' }).execute()
    })
    expect(isUniqueViolation(caught, widgets.cols.id)).toBe(true)
    expect(await ids()).toContain(92)
    expect(await ids()).toContain(93)
  })

  it('the constraint resolves to the schema object, on a real server error', async () => {
    const err = await db
      .insertInto(schema.h.widgets)
      .values({ id: 1, name: 'dupe' })
      .execute()
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UniqueViolationError)
    const e = err as UniqueViolationError
    expect(e.code).toBe('23505')
    expect(e.table?.$.name).toBe('widgets')
    expect(e.columns?.map((c) => c.$.dbName)).toStrictEqual(['id'])
    // §4.3: the DETAIL's VALUE is redacted, its COLUMNS are kept.
    expect(e.detailRedacted).toBe(true)
    expect(e.detail).toContain('id')
    expect(e.detail).not.toMatch(/\(1\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3.7 — rollback ergonomics, proved on the rows
// ─────────────────────────────────────────────────────────────────────────────

describe('rollback() and rollbackWith() (07 §3.7)', () => {
  it('rollbackWith(v) resolves with v AND the row is absent', async () => {
    const out = await db.transaction(async (tx) => {
      await tx.insertInto(schema.h.widgets).values({ id: 80, name: 'doomed' }).execute()
      return tx.rollbackWith({ status: 'conflict' } as const)
    })
    expect(out).toStrictEqual({ status: 'conflict' })
    expect(await ids()).not.toContain(80)
  })

  it('rollback() throws TransactionRollback AND the row is absent', async () => {
    const err = await db
      .transaction(async (tx) => {
        await tx.insertInto(schema.h.widgets).values({ id: 81, name: 'doomed' }).execute()
        tx.rollback()
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TransactionRollback)
    expect(await ids()).not.toContain(81)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3.5 — SET LOCAL, visible to current_setting, gone after the transaction
// ─────────────────────────────────────────────────────────────────────────────

describe('setLocal is transaction-local and injection-safe (07 §3.5)', () => {
  it('current_setting sees it inside, and it is gone outside', async () => {
    const inside = await db.transaction(async (tx) => {
      await tx.setLocal('app.tenant_id', 'tenant-7')
      const [row] = await tx.sql`select current_setting('app.tenant_id', true) as v`.execute()
      return row?.['v']
    })
    expect(inside).toBe('tenant-7')
    const [after] = await db.sql`select current_setting('app.tenant_id', true) as v`.execute()
    // PostgreSQL keeps the custom GUC in the session's table once it has been mentioned and resets
    // it to the empty string at commit; what matters is that the VALUE did not survive.
    expect(after?.['v'] ?? '').toBe('')
  })

  it('localSettings in TxOptions lands immediately after BEGIN, batched', async () => {
    const seen = await db.transaction(
      async (tx) => {
        const [row] = await tx.sql`
          select current_setting('app.tenant_id', true) as t,
                 current_setting('app.user_id', true) as u`.execute()
        return [row?.['t'], row?.['u']]
      },
      { localSettings: { 'app.tenant_id': 'a', 'app.user_id': 'b' } },
    )
    expect(seen).toStrictEqual(['a', 'b'])
  })

  it('a value that looks like SQL is a bind parameter and stays a value', async () => {
    const evil = "'; drop table widgets; --"
    const back = await db.transaction(async (tx) => {
      await tx.setLocal('app.tenant_id', evil)
      const [row] = await tx.sql`select current_setting('app.tenant_id') as v`.execute()
      return row?.['v']
    })
    expect(back).toBe(evil)
    // The table is still there, which is the assertion that matters.
    expect((await ids()).length).toBeGreaterThan(0)
  })

  it('a per-transaction timeoutMs really sets statement_timeout for the block', async () => {
    const v = await db.transaction(
      async (tx) => {
        const [row] = await tx.sql`select current_setting('statement_timeout') as v`.execute()
        return row?.['v']
      },
      { timeoutMs: 4_242 },
    )
    expect(v).toBe('4242ms')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 — streamBatches
// ─────────────────────────────────────────────────────────────────────────────

describe('streamBatches is one FETCH per batch (07 §6.3, decision 10)', () => {
  it('batches of the requested size, the last one shorter, and the totals match', async () => {
    const all = await db
      .from(schema.h.widgets)
      .select(({ widgets: w }) => ({ id: w.id }))
      .orderBy(({ widgets: w }) => w.id)
      .execute()
    const sizes: number[] = []
    const seen: number[] = []
    for await (const batch of db.streamBatches(
      db
        .from(schema.h.widgets)
        .select(({ widgets: w }) => ({ id: w.id }))
        .orderBy(({ widgets: w }) => w.id),
      { batchSize: 2 },
    )) {
      sizes.push(batch.length)
      for (const row of batch) seen.push(row.id)
    }
    expect(seen).toStrictEqual(all.map((r) => r.id))
    // Every batch but the last is exactly `batchSize`; that is what "a batch IS a FETCH" means.
    expect(sizes.slice(0, -1).every((n) => n === 2)).toBe(true)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(all.length)
  })

  it('breaking out of streamBatches closes the cursor and releases the connection', async () => {
    for await (const batch of db.streamBatches(
      db.from(schema.h.widgets).select(({ widgets: w }) => ({ id: w.id })),
      { batchSize: 1 },
    )) {
      expect(batch).toHaveLength(1)
      break
    }
    // If the cursor or the transaction leaked, this next statement would hang or fail.
    expect((await ids()).length).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §7.1 — hooks, with real timings
// ─────────────────────────────────────────────────────────────────────────────

describe('hooks report real timings (07 §7.1)', () => {
  it('serverMs, decodeMs and waitedForConnectionMs are all measured, and add up', async () => {
    const ends: { durationMs: number; serverMs: number; decodeMs: number; waited: number; rows: number }[] = []
    const off = db.observe({
      onQueryEnd: (e) =>
        ends.push({
          durationMs: e.durationMs,
          serverMs: e.serverMs,
          decodeMs: e.decodeMs,
          waited: e.waitedForConnectionMs,
          rows: e.rowCount,
        }),
    })
    try {
      await db.from(schema.h.widgets).select(({ widgets: w }) => ({ id: w.id })).execute()
    } finally {
      off()
    }
    expect(ends).toHaveLength(1)
    const e = ends[0]!
    expect(e.rows).toBeGreaterThan(0)
    expect(e.serverMs).toBeGreaterThan(0)
    expect(e.decodeMs).toBeGreaterThanOrEqual(0)
    expect(e.waited).toBeGreaterThanOrEqual(0)
    // The three parts cannot exceed the whole (allowing for the clock's own resolution).
    expect(e.serverMs + e.decodeMs).toBeLessThanOrEqual(e.durationMs + 1)
  })

  it('a RAISE NOTICE from a function reaches onNotice', async () => {
    const notices: string[] = []
    const off = db.observe({ onNotice: (e) => notices.push(e.notice.message) })
    try {
      await db.sql`do $$ begin raise notice 'hello from plpgsql'; end $$`.execute()
    } finally {
      off()
    }
    expect(notices.join('\n')).toContain('hello from plpgsql')
  })

  it('a transaction reports start and end with the outcome', async () => {
    const seen: string[] = []
    const off = db.observe({
      onTransactionStart: (e) => seen.push(`start ${e.isolation ?? 'default'}`),
      onTransactionEnd: (e) => seen.push(`end ${e.outcome}`),
    })
    try {
      await db.transaction(async () => undefined, { isolation: 'repeatable read' })
      await db.transaction(async (tx) => tx.rollback()).catch(() => undefined)
    } finally {
      off()
    }
    expect(seen).toStrictEqual(['start repeatable read', 'end commit', 'start default', 'end error'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §6.6 — COPY, round trip
// ─────────────────────────────────────────────────────────────────────────────

describe('COPY round trip (07 §6.6)', () => {
  /**
   * **Measured, and it is why `07` §6.6's tier-1 plan has an escape clause.** PGlite's
   * `PGLiteSocketServer` terminates the WASM backend on the simple-query `COPY` message
   * (`ExitStatus: Program terminated with exit(1)`), taking the whole instance with it — so a COPY
   * test here does not merely fail, it poisons every test after it in the file. The claim moves to
   * tier 2, where design/12 §3 S already puts the 100k crossover measurement.
   */
  const copyWorks = requiresRealPostgres("PGlite's socket bridge exits the backend on a COPY message")

  copyWorks('copyFrom encodes through the codecs and copyTo reads it back', async () => {
    const rows = [
      { id: 500, name: 'plain', qty: 1 },
      { id: 501, name: 'with\ttab and \\backslash', qty: 2 },
      { id: 502, name: 'with\nnewline', qty: 3 },
    ]
    const res = await db.copyFrom(widgets, rows)
    expect(res.rowCount).toBe(3)

    // The oracle is a hand-written read, not our own COPY: the escaping is the thing under test.
    const back = await raw(`select id, name, qty from ${NS}.widgets where id >= 500 order by id`)
    expect(back.map((r) => r[1])).toStrictEqual(rows.map((r) => r.name))

    const lines: string[] = []
    for await (const line of db.copyTo.lines(
      `copy (select id, name from ${NS}.widgets where id >= 500 order by id) to stdout`,
    )) {
      lines.push(line)
    }
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('500\tplain')
    // Round trip: the escapes survive both directions.
    expect(lines[1]).toBe('501\twith\\ttab and \\\\backslash')
  })

  copyWorks('copyFrom.raw takes bytes the caller framed, and csv format works', async () => {
    const bytes = new TextEncoder().encode('600,csv-one,7\n601,csv-two,8\n')
    const res = await db.copyFrom.raw(
      `copy ${NS}.widgets (id, name, qty) from stdin with (format csv)`,
      [bytes],
    )
    expect(res.rowCount).toBe(2)
    const back = await raw(`select name from ${NS}.widgets where id in (600,601) order by id`)
    expect(back.map((r) => r[0])).toStrictEqual(['csv-one', 'csv-two'])
  })

  copyWorks('a failing source aborts the COPY and leaves nothing behind', async () => {
    async function* boom(): AsyncIterable<Record<string, unknown>> {
      yield { id: 700, name: 'first', qty: 0 }
      throw new Error('source exploded')
    }
    await expect(db.copyFrom(widgets, boom())).rejects.toThrow(/source exploded/)
    expect(await raw(`select id from ${NS}.widgets where id = 700`)).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §5.4 — diagnose reports what is actually true of this connection
// ─────────────────────────────────────────────────────────────────────────────

describe('db.diagnose() (07 §5.4)', () => {
  it('reports the server version, the effective GUCs and the max_connections arithmetic', async () => {
    const d = await db.diagnose()
    expect(d.serverVersion).toMatch(/PostgreSQL/)
    expect(d.effectiveSettings['TimeZone']).toBeDefined()
    expect(d.connections.maxConnections).toBeGreaterThan(0)
    expect(d.statements.statement).toBe('unnamed')
    expect(d.statements.downgraded).toBe(false)
    expect(d.poolerMode).toBe('none')
  })

  requiresRealPostgres('PGlite reports one shared backend, so a pid pair proves nothing')(
    'diagnosePooler says `direct` against a server with no pooler in front of it',
    async () => {
      const r = await db.diagnosePooler()
      expect(r.verdict).toBe('direct')
      expect(r.recommendedPoolerMode).toBe('none')
      expect(r.agrees).toBe(true)
      expect(r.confidence).not.toBe('high')
      const names = r.signals.map((s) => s.name)
      expect(names).toContain('backend-pid-across-statements')
      expect(names).toContain('backend-pid-within-transaction')
      expect(names).toContain('named-statement-survives')
      // The session-state probe writes, so it is off unless asked for.
      expect(names).not.toContain('application-name-sticky')
      expect((await db.diagnosePooler({ probeSessionState: true })).signals.map((s) => s.name)).toContain(
        'application-name-sticky',
      )
    },
  )
})

/** Kept honest under `noUnusedLocals`. */
void liveTarget
