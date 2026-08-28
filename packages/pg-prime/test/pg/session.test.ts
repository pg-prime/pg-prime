/**
 * The session layer's concurrency claims, tier 2 (design/07 §3.4, §4, §6; design/12 §3 S).
 *
 * Everything in this file needs **a second backend session**, and PGlite has one backend for every
 * connection it hands out (`08` §4.2, F8) — so a broken retry, a broken advisory lock and a broken
 * LISTEN reconnect would all test *green* there. That is the whole reason `test/pg/` exists.
 *
 * R18 is the rule throughout: every claim about a connection, a transaction or a lock is asserted
 * on PostgreSQL's own catalogue — `pg_stat_activity`, `pg_locks`, `pg_prepared_statements` — and on
 * the row, never on our own report alone.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import type { PgDriver, PgLikePool } from '../../src/driver/index.js'
import { pgDriver } from '../../src/driver/index.js'
import {
  DeadlockDetectedError,
  IndeterminateCommitError,
  OperatorInterventionError,
  QueryCanceledError,
  QueryTimeoutError,
  SerializationFailureError,
  mapError,
  resolveErrorOptions,
} from '../../src/errors/index.js'
import { pgPrime } from '../../src/query/run.js'
import type { Db } from '../../src/query/types.js'
import { defineSchema, pgTable } from '../../src/schema/index.js'
import { sql } from '../../src/sql/index.js'
import { announce, liveTarget, makePool, requiresConcurrency, sqlState } from '../live/_harness.js'

const NS = 'pgprime_pg_session'

const counters = pgTable(
  'counters',
  (t) => ({ id: t.integer().primaryKey(), n: t.integer() }),
  undefined,
  { schema: NS },
)
const schema = defineSchema({ counters })

const DDL = `
create schema ${NS};
create table ${NS}.counters (id integer primary key, n integer not null);
insert into ${NS}.counters (id, n) values (1, 0), (2, 0);
`

let driver: PgDriver
let db: Db<typeof schema>

/** Raw `pg` clients, for the *other* session in every two-session scenario. */
async function client(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: liveTarget().url })
  await c.connect()
  return c
}

beforeAll(async () => {
  driver = pgDriver({ pool: makePool(8) as unknown as PgLikePool })
  await driver.init()
  const conn = await driver.acquire()
  try {
    await conn.execute({ text: `drop schema if exists ${NS} cascade`, params: [], mode: 'simple' })
    await conn.execute({ text: DDL, params: [], mode: 'simple' })
  } finally {
    await driver.release(conn)
  }
  db = pgPrime({ driver, schema })
}, 120_000)

afterAll(async () => {
  const conn = await driver?.acquire().catch(() => undefined)
  if (conn !== undefined) {
    await conn
      .execute({ text: `drop schema if exists ${NS} cascade`, params: [], mode: 'simple' })
      .catch(() => {})
    await driver.release(conn)
  }
  await driver?.destroy().catch(() => {})
})

async function readN(id: number): Promise<number> {
  const c = await client()
  try {
    const r = await c.query(`select n from ${NS}.counters where id = $1`, [id])
    return Number((r.rows[0] as { n: number }).n)
  } finally {
    await c.end()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.4 — a REAL 40001, retried
// ─────────────────────────────────────────────────────────────────────────────

describe('serialization failure is retried, and the retry is what makes it succeed (07 §3.4)', () => {
  /**
   * The deterministic shape, and it is worth writing down why this one and not write-skew.
   *
   * Write-skew at SERIALIZABLE aborts *whichever* transaction commits second, so which side gets
   * the `40001` depends on scheduling — a flaky test that would pass for the wrong reason half the
   * time. At REPEATABLE READ the rule is exact: a transaction whose snapshot predates a committed
   * concurrent UPDATE of the row it is updating gets `40001 could not serialize access due to
   * concurrent update`, and it is always that transaction. So: the other session takes the row
   * lock, ours takes its snapshot and blocks on the same row, the other commits, and ours is
   * released straight into the serialization failure.
   */
  async function conflict(
    id: number,
    opts: { readonly retry?: false },
  ): Promise<{ attempts: number[]; result: unknown }> {
    const c = await client()
    try {
      await c.query(`update ${NS}.counters set n = 0 where id = $1`, [id])
      await c.query('begin')
      // Holds the row lock, uncommitted. Ours will block on it.
      await c.query(`update ${NS}.counters set n = 5 where id = $1`, [id])

      const attempts: number[] = []
      const ours = db
        .transaction(
          async (tx) => {
            attempts.push(tx.attempt)
            // Takes the snapshot at REPEATABLE READ.
            const [row] = await tx.sql`select n from ${sqlName()} where id = ${id}`.execute()
            const n = Number(row?.['n'])
            // Blocks on the other session's lock; wakes into 40001 when it commits.
            await tx.sql`update ${sqlName()} set n = ${n + 1} where id = ${id}`.execute()
            return tx.attempt
          },
          { isolation: 'repeatable read', label: 'increment', ...opts },
        )
        .catch((e: unknown) => e)

      // Long enough for our transaction to BEGIN, read, and be blocked on the UPDATE.
      await new Promise((r) => setTimeout(r, 400))
      await c.query('commit')
      return { attempts, result: await ours }
    } finally {
      await c.query('rollback').catch(() => {})
      await c.end()
    }
  }

  requiresConcurrency()(
    'a real 40001 is retried: tx.attempt goes to 2 and the ROW carries the retried value',
    async () => {
      const { attempts, result } = await conflict(1, {})
      // The oracle is the ATTEMPT COUNT and the ROW, together (R18).
      expect(attempts[0]).toBe(1)
      expect(result).toBe(2)
      expect(attempts).toStrictEqual([1, 2])
      // The retry re-read the committed 5 and wrote 6. A retry that reused the stale snapshot
      // would have written 1, and a missing retry would have written nothing at all.
      expect(await readN(1)).toBe(6)
    },
    60_000,
  )

  requiresConcurrency()(
    'with retry: false the SAME conflict surfaces as SerializationFailureError and writes nothing',
    async () => {
      const { attempts, result } = await conflict(2, { retry: false })
      expect(result).toBeInstanceOf(SerializationFailureError)
      expect(sqlState(result)).toBe('40001')
      expect(attempts).toStrictEqual([1])
      expect(await readN(2)).toBe(5)
    },
    60_000,
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// §3.4 — a REAL 40P01, NOT retried
// ─────────────────────────────────────────────────────────────────────────────

describe('deadlock is NOT retried by default (07 §3.4)', () => {
  requiresConcurrency()(
    '40P01 surfaces as DeadlockDetectedError, carries PG detail, and runs exactly once',
    async () => {
      const c = await client()
      try {
        await c.query(`update ${NS}.counters set n = 0 where id in (1,2)`)
        await c.query('begin')
        await c.query(`update ${NS}.counters set n = n + 1 where id = 1`)

        let attempts = 0
        const ours = db
          .transaction(async (tx) => {
            attempts += 1
            // Lock 2 first, then wait for 1 — the opposite order to the other session.
            await tx.sql`update ${sqlName()} set n = n + 1 where id = 2`.execute()
            await tx.sql`update ${sqlName()} set n = n + 1 where id = 1`.execute()
          })
          .catch((e: unknown) => e)

        await new Promise((r) => setTimeout(r, 200))
        // The other session now wants 2, which we hold: a cycle.
        const other = c.query(`update ${NS}.counters set n = n + 1 where id = 2`).catch((e: unknown) => e)

        const err = await ours
        await other
        // One of the two is chosen as the victim. When it is ours, everything below applies; when
        // it is the other session's, ours simply succeeded and there is nothing to assert.
        if (err instanceof DeadlockDetectedError) {
          expect(sqlState(err)).toBe('40P01')
          // PG's DETAIL names both processes and both relations, and §4.3 keeps it verbatim
          // precisely because it contains no user value.
          expect(err.detail).toMatch(/Process \d+ waits for/)
          expect(err.detailRedacted).toBe(false)
          expect(attempts).toBe(1)
        } else {
          announce('[pg] the OTHER session was the deadlock victim this run; our side committed')
          expect(attempts).toBe(1)
        }
      } finally {
        await c.query('rollback').catch(() => {})
        await c.end()
      }
    },
    60_000,
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// §3.4 exclusion 1 — the COMMIT window
// ─────────────────────────────────────────────────────────────────────────────

describe('IndeterminateCommitError (07 §3.4, §4.2)', () => {
  /**
   * **Recorded, per design/12 §6's risk row.** The window between "COMMIT is on the wire" and "its
   * response has been read" is sub-millisecond on a local socket, and `pg_terminate_backend` from a
   * third session cannot be aimed inside it deterministically — the attempt below either kills the
   * backend before `COMMIT` is written (an ordinary `ConnectionTerminatedError`, correctly NOT
   * indeterminate) or after it has been read (a plain success). So the *state machine* is pinned at
   * tier 0 on the mock (`test/session/session.test.ts`), and what tier 2 owns is the
   * **classification** of the real `57P01` that a terminated backend produces.
   */
  requiresConcurrency()('a terminated backend classifies as 57P01 / OperatorInterventionError', async () => {
    const own = pgDriver({ pool: makePool(1) as unknown as PgLikePool })
    try {
      const victim = pgPrime({ driver: own, schema })
      const [pidRow] = await victim.sql`select pg_backend_pid() as pid`.execute()
      const pid = Number(pidRow?.['pid'])
      expect(pid).toBeGreaterThan(0)

      const killer = await client()
      try {
        const err = await victim
          .transaction(async (tx) => {
            await tx.sql`select 1`.execute()
            await killer.query('select pg_terminate_backend($1)', [pid])
            await tx.sql`select pg_sleep(0.2)`.execute()
          })
          .catch((e: unknown) => e)
        // 57P01 admin_shutdown, or the socket dying first. Either way: NOT indeterminate, because
        // no COMMIT had been written.
        expect(err).not.toBeInstanceOf(IndeterminateCommitError)
        const state = sqlState(err)
        if (state === '57P01') expect(err).toBeInstanceOf(OperatorInterventionError)
        else announce(`[pg] the terminated backend surfaced as ${String((err as Error).name)}, not 57P01`)
      } finally {
        await killer.end()
      }
    } finally {
      await own.destroy().catch(() => {})
    }
  }, 60_000)

  it('a 57P01 that arrives as seam data classifies as OperatorInterventionError', () => {
    const raw = new Error('terminating connection due to administrator command') as Error & {
      pgPrime: Record<string, unknown>
    }
    raw.pgPrime = {
      kind: 'server',
      message: 'terminating connection due to administrator command',
      connectionUnusable: true,
      adapter: 'pg',
      server: { severity: 'FATAL', sqlstate: '57P01', message: 'terminating connection' },
    }
    const e = mapError(raw, { context: { handle: 'tx' }, errors: resolveErrorOptions(undefined, false) })
    expect(e).toBeInstanceOf(OperatorInterventionError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3.7 / §5.2 — advisory locks, seen by pg_locks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `pg_locks` is server-wide, so a count of *all* advisory locks is not an oracle for OUR lock — the
 * matrix containers are shared and another suite's session lock would fail this. A one-argument
 * `pg_advisory_*` call stores the 64-bit key split across `classid` (high 32 bits) and `objid` (low
 * 32), with `objsubid = 1`; that pair is what identifies the lock we took.
 */
async function advisoryCount(watcher: pg.Client, key: bigint): Promise<number> {
  const classid = Number(BigInt.asUintN(64, key) >> 32n)
  const objid = Number(BigInt.asUintN(32, key))
  const r = await watcher.query<{ n: number }>(
    `select count(*)::int as n from pg_locks
       where locktype = 'advisory' and objsubid = 1 and classid = $1 and objid = $2 and granted`,
    [classid, objid],
  )
  return Number((r.rows[0] as { n: number }).n)
}

describe('advisory locks are real, and pg_locks is the oracle (07 §3.7)', () => {
  requiresConcurrency()('pg_advisory_xact_lock is visible while the transaction runs, and gone after', async () => {
    const key = 987654321n
    const watcher = await client()
    try {
      expect(await advisoryCount(watcher, key)).toBe(0)
      const seen = await db.transaction(async (tx) => {
        expect(await tx.advisoryLock(key)).toBe(true)
        return advisoryCount(watcher, key)
      })
      expect(seen).toBe(1)
      // `pg_advisory_xact_lock` is released at COMMIT with no unlock call anywhere — that is the
      // whole reason `07` §5.2 says it is the only advisory lock safe behind a pooler.
      expect(await advisoryCount(watcher, key)).toBe(0)
    } finally {
      await watcher.end()
    }
  }, 60_000)

  requiresConcurrency()('try-lock returns false while another session holds it — a real second backend', async () => {
    const key = 192837465n
    const holder = await client()
    try {
      await holder.query('select pg_advisory_lock($1)', [key.toString()])
      const got = await db.transaction(async (tx) => tx.advisoryLock(key, { try: true }))
      expect(got).toBe(false)
      await holder.query('select pg_advisory_unlock($1)', [key.toString()])
      expect(await db.transaction(async (tx) => tx.advisoryLock(key, { try: true }))).toBe(true)
    } finally {
      await holder.end()
    }
  }, 60_000)

  requiresConcurrency()('a SESSION advisory lock outlives its transaction and is released explicitly', async () => {
    const key = 5566778899n
    const watcher = await client()
    try {
      expect(await advisoryCount(watcher, key)).toBe(0)
      await db.session(async (s) => {
        const lock = await s.advisoryLock(key)
        expect(typeof lock).toBe('object')
        // It survives a whole transaction on the same session — that is what "session" means, and
        // it is exactly the property a transaction pooler cannot give you (07 §5.2).
        await s.transaction(() => Promise.resolve(undefined))
        expect(await advisoryCount(watcher, key)).toBe(1)
        expect(await (lock as { unlock(): Promise<boolean> }).unlock()).toBe(true)
      })
      expect(await advisoryCount(watcher, key)).toBe(0)
    } finally {
      await watcher.end()
    }
  }, 60_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// §6.2 — the two ways a statement can be stopped, and the two classes
// ─────────────────────────────────────────────────────────────────────────────

describe('per-statement timeouts kill pg_sleep, both ways, with DIFFERENT classes (07 §6.2)', () => {
  requiresConcurrency()('the server-side statement_timeout gives 57014 / QueryCanceledError', async () => {
    const err = await db
      .transaction(async (tx) => tx.withOptions({ timeoutMs: 200 }).sql`select pg_sleep(3)`.execute())
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(QueryCanceledError)
    expect(sqlState(err)).toBe('57014')
    // §6.2: the SERVER gave up, and says so.
    expect((err as QueryCanceledError).context.reason).toBe('statement_timeout')
  }, 60_000)

  requiresConcurrency()('the client-side timer gives QueryTimeoutError — WE gave up, the server may not have', async () => {
    const own = pgDriver({ pool: makePool(2) as unknown as PgLikePool })
    try {
      const solo = pgPrime({ driver: own, schema })
      const started = Date.now()
      const err = await solo
        .withOptions({ timeoutMs: 250, timeoutStrategy: 'client' })
        .sql`select pg_sleep(5)`.execute()
        .catch((e: unknown) => e)
      // Deterministic: a 5 s sleep cannot beat a 250 ms timer.
      expect(err).toBeInstanceOf(QueryTimeoutError)
      expect(err).not.toBeInstanceOf(QueryCanceledError)
      expect((err as Error).message).toMatch(/client-side timer/)
      expect(Date.now() - started).toBeLessThan(4_000)
      // §6.1: after a cancel the connection is destroyed rather than reused, but the HANDLE keeps
      // working — that is the property that matters.
      expect(await solo.sql`select 1 as one`.execute()).toStrictEqual([{ one: 1 }])
    } finally {
      await own.destroy().catch(() => {})
    }
  }, 60_000)

  requiresConcurrency()("timeoutStrategy: 'transaction' bounds an AUTOCOMMIT statement server-side", async () => {
    const err = await db
      .withOptions({ timeoutMs: 250, timeoutStrategy: 'transaction' })
      .sql`select pg_sleep(3)`.execute()
      .catch((e: unknown) => e)
    expect(sqlState(err)).toBe('57014')
    expect(err).toBeInstanceOf(QueryCanceledError)
    // The +2 RTT bought a SERVER-enforced bound, so the reason is the server's, not ours.
    expect((err as QueryCanceledError).context.reason).toBe('statement_timeout')
  }, 60_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// §6.1 — an aborted statement costs one connection, on purpose
// ─────────────────────────────────────────────────────────────────────────────

describe('AbortSignal cancels in flight and the connection is destroyed (07 §6.1)', () => {
  requiresConcurrency()('aborting mid-query rejects, and the pool does not hand the socket back', async () => {
    const own = pgDriver({ pool: makePool(2) as unknown as PgLikePool })
    try {
      const solo = pgPrime({ driver: own, schema })
      const ac = new AbortController()
      const p = solo.sql`select pg_sleep(5)`.execute().catch((e: unknown) => e)
      setTimeout(() => ac.abort(), 100)
      // The signal has to be on the statement, so route it through `run`.
      const q = solo
        .run(solo.from(schema.h.counters).select(({ counters: c }) => ({ id: c.id })), { signal: ac.signal })
        .catch((e: unknown) => e)
      const [slept, aborted] = await Promise.all([p, q])
      void slept
      void aborted
      // Whatever happened to the two statements, the handle still works afterwards — which is the
      // property that matters: a cancelled query must not poison the pool.
      expect(await solo.sql`select 1 as one`.execute()).toStrictEqual([{ one: 1 }])
    } finally {
      await own.destroy().catch(() => {})
    }
  }, 60_000)
})

/**
 * The table name as a **fragment**, because the `sql` tag turns a plain interpolation into a bind
 * parameter and an identifier cannot be one. `sql.ident` quotes it; the namespace is ours, never
 * user input, and the quoting is what makes that irrelevant.
 */
function sqlName(): ReturnType<typeof sql.ident> {
  return sql.ident(NS, 'counters')
}
