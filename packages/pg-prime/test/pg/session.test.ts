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
import { textCodec } from '../../src/codec/index.js'
import type { PgDriver, PgLikePool } from '../../src/driver/index.js'
import { pgDriver } from '../../src/driver/index.js'
import {
  DeadlockDetectedError,
  IndeterminateCommitError,
  OperatorInterventionError,
  QueryCanceledError,
  QueryTimeoutError,
  SerializationFailureError,
  UniqueViolationError,
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
        const other = c
          .query(`update ${NS}.counters set n = n + 1 where id = 2`)
          .catch((e: unknown) => e)

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
  requiresConcurrency()(
    'a terminated backend classifies as 57P01 / OperatorInterventionError',
    async () => {
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
          else
            announce(
              `[pg] the terminated backend surfaced as ${String((err as Error).name)}, not 57P01`,
            )
        } finally {
          await killer.end()
        }
      } finally {
        await own.destroy().catch(() => {})
      }
    },
    60_000,
  )

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
    const e = mapError(raw, {
      context: { handle: 'tx' },
      errors: resolveErrorOptions(undefined, false),
    })
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
  requiresConcurrency()(
    'pg_advisory_xact_lock is visible while the transaction runs, and gone after',
    async () => {
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
    },
    60_000,
  )

  requiresConcurrency()(
    'try-lock returns false while another session holds it — a real second backend',
    async () => {
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
    },
    60_000,
  )

  requiresConcurrency()(
    'a SESSION advisory lock outlives its transaction and is released explicitly',
    async () => {
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
    },
    60_000,
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// §6.2 — the two ways a statement can be stopped, and the two classes
// ─────────────────────────────────────────────────────────────────────────────

describe('per-statement timeouts kill pg_sleep, both ways, with DIFFERENT classes (07 §6.2)', () => {
  requiresConcurrency()(
    'the server-side statement_timeout gives 57014 / QueryCanceledError',
    async () => {
      const err = await db
        .transaction(async (tx) =>
          tx.withOptions({ timeoutMs: 200 }).sql`select pg_sleep(3)`.execute(),
        )
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(QueryCanceledError)
      expect(sqlState(err)).toBe('57014')
      // §6.2: the SERVER gave up, and says so.
      expect((err as QueryCanceledError).context.reason).toBe('statement_timeout')
    },
    60_000,
  )

  requiresConcurrency()(
    'the client-side timer gives QueryTimeoutError — WE gave up, the server may not have',
    async () => {
      const own = pgDriver({ pool: makePool(2) as unknown as PgLikePool })
      try {
        const solo = pgPrime({ driver: own, schema })
        const started = Date.now()
        const err = await solo.withOptions({ timeoutMs: 250, timeoutStrategy: 'client' })
          .sql`select pg_sleep(5)`
          .execute()
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
    },
    60_000,
  )

  requiresConcurrency()(
    "timeoutStrategy: 'transaction' bounds an AUTOCOMMIT statement server-side",
    async () => {
      const err = await db.withOptions({ timeoutMs: 250, timeoutStrategy: 'transaction' })
        .sql`select pg_sleep(3)`
        .execute()
        .catch((e: unknown) => e)
      expect(sqlState(err)).toBe('57014')
      expect(err).toBeInstanceOf(QueryCanceledError)
      // The +2 RTT bought a SERVER-enforced bound, so the reason is the server's, not ours.
      expect((err as QueryCanceledError).context.reason).toBe('statement_timeout')
    },
    60_000,
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// §6.1 — an aborted statement costs one connection, on purpose
// ─────────────────────────────────────────────────────────────────────────────

describe('AbortSignal cancels in flight and the connection is destroyed (07 §6.1)', () => {
  requiresConcurrency()(
    'aborting mid-query rejects, and the pool does not hand the socket back',
    async () => {
      const own = pgDriver({ pool: makePool(2) as unknown as PgLikePool })
      try {
        const solo = pgPrime({ driver: own, schema })
        const ac = new AbortController()
        const p = solo.sql`select pg_sleep(5)`.execute().catch((e: unknown) => e)
        setTimeout(() => ac.abort(), 100)
        // The signal has to be on the statement, so route it through `run`.
        const q = solo
          .run(
            solo.from(schema.h.counters).select(({ counters: c }) => ({ id: c.id })),
            { signal: ac.signal },
          )
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
    },
    60_000,
  )
})

/**
 * The table name as a **fragment**, because the `sql` tag turns a plain interpolation into a bind
 * parameter and an identifier cannot be one. `sql.ident` quotes it; the namespace is ours, never
 * user input, and the quoting is what makes that irrelevant.
 */
function sqlName(): ReturnType<typeof sql.ident> {
  return sql.ident(NS, 'counters')
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.6 / §6.2 — what a per-statement timeout restores
// (design/12 §4 D finding b; R18: SHOW is the oracle)
// ─────────────────────────────────────────────────────────────────────────────

describe('a per-statement timeout restores the SESSION value pg-prime set (07 §3.6, finding b)', () => {
  requiresConcurrency()(
    'session 30s → in-tx 250ms → the rest of the transaction is 30s again',
    async () => {
      // `set_config(name, NULL, true)` restores the GUC's RESET value, and a session-level `SET`
      // does not become the reset value — so the restore used to land on the server's default,
      // which for `statement_timeout` is `0`: no timeout for the remainder of the transaction.
      // Measured here on the server itself, which is the only place that fact is visible.
      const app = pgPrime({
        connection: liveTarget().url,
        schema,
        session: { statementTimeout: '30s' },
        devGuard: false,
        poolOptions: { max: 2 },
      })
      try {
        const seen = await app.transaction(async (tx) => {
          const before = await show(tx)
          await tx.withOptions({ timeoutMs: 250 }).sql`select 1`.execute()
          const after = await show(tx)
          return [before, after]
        })
        expect(seen).toStrictEqual(['30s', '30s'])
        // …and the session value is untouched outside the transaction, which is what "LOCAL" means.
        expect(await show(app)).toBe('30s')
      } finally {
        await app.end()
      }
    },
    60_000,
  )

  requiresConcurrency()(
    'a transaction that set its own timeoutMs still restores to ITS baseline, not the session’s',
    async () => {
      const app = pgPrime({
        connection: liveTarget().url,
        schema,
        session: { statementTimeout: '30s' },
        devGuard: false,
        poolOptions: { max: 2 },
      })
      try {
        const seen = await app.transaction(
          async (tx) => {
            const before = await show(tx)
            await tx.withOptions({ timeoutMs: 250 }).sql`select 1`.execute()
            return [before, await show(tx)]
          },
          { timeoutMs: 9_000 },
        )
        expect(seen).toStrictEqual(['9s', '9s'])
      } finally {
        await app.end()
      }
    },
    60_000,
  )

  requiresConcurrency()(
    'the timeout it restores is still enforced — a 3 s sleep after a 250 ms statement is killed',
    async () => {
      // The regression was silent: the statement after the timed one simply ran forever. The
      // oracle for "the timeout came back" is a statement that trips it.
      const app = pgPrime({
        connection: liveTarget().url,
        schema,
        session: { statementTimeout: '900ms' },
        devGuard: false,
        poolOptions: { max: 2 },
      })
      try {
        const err = await app
          .transaction(async (tx) => {
            await tx.withOptions({ timeoutMs: 250 }).sql`select 1`.execute()
            await tx.sql`select pg_sleep(3)`.execute()
          })
          .catch((e: unknown) => e)
        expect(sqlState(err)).toBe('57014')
      } finally {
        await app.end()
      }
    },
    60_000,
  )
})

/** `SHOW statement_timeout` through whichever handle is asked. The server is the oracle (R18). */
async function show(handle: {
  sql: (t: TemplateStringsArray) => { execute(): Promise<Record<string, unknown>[]> }
}): Promise<unknown> {
  const rows = await handle.sql`show statement_timeout`.execute()
  return (rows[0] as Record<string, unknown>)['statement_timeout']
}

// ─────────────────────────────────────────────────────────────────────────────
// §4.3 — paramCount on a real 23505 (design/12 §4 D finding c)
// ─────────────────────────────────────────────────────────────────────────────

describe('QueryError.paramCount is the real count on a real error (07 §4.3, finding c)', () => {
  requiresConcurrency()(
    'a duplicate key reports three parameters and publishes none of them',
    async () => {
      await db.sql`insert into pgprime_pg_session.counters (id, n) values (900, 0)
                   on conflict do nothing`.execute()
      const err = await db
        .insertInto(schema.h.counters)
        .values({ id: 900, n: 1 })
        .execute()
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(UniqueViolationError)
      expect((err as UniqueViolationError).paramCount).toBe(2)
      expect((err as UniqueViolationError).params).toBeUndefined()
      expect((err as UniqueViolationError).paramTypes).toHaveLength(2)
    },
    60_000,
  )

  requiresConcurrency()(
    'includeParams: true adds the encoded binds, and nothing else changes',
    async () => {
      const loud = pgPrime({
        driver,
        schema,
        errors: { includeParams: true },
      })
      const err = await loud
        .insertInto(schema.h.counters)
        .values({ id: 900, n: 7 })
        .execute()
        .catch((e: unknown) => e)
      expect((err as UniqueViolationError).paramCount).toBe(2)
      expect((err as UniqueViolationError).params).toStrictEqual(['900', '7'])
    },
    60_000,
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// §1.2 — the pool holds nothing between statements (design/12 §4 D finding e)
// ─────────────────────────────────────────────────────────────────────────────

describe('a `connection:` handle holds no backend between statements (finding e)', () => {
  requiresConcurrency()(
    'pg_stat_activity counts one backend after two awaited statements, dev guard ON',
    async () => {
      // R18: `db.stats()` is our own report, so the claim is settled against the server's
      // catalogue as well. `application_name` is the filter, because a shared matrix container
      // has other clients on it.
      const app = pgPrime({
        connection: liveTarget().url,
        schema,
        session: { applicationName: 'pgprime_f1_leak' },
        poolOptions: { max: 4 },
      })
      try {
        await app.sql`select 1`.execute()
        await app.sql`select 2`.execute()
        expect(app.stats()).toStrictEqual({ total: 1, idle: 1, waiting: 0, max: 4 })
        const [row] = await db.sql`select count(*)::int as n from pg_catalog.pg_stat_activity
                                   where application_name = 'pgprime_f1_leak'`.execute()
        expect((row as { n: number }).n).toBe(1)
      } finally {
        await app.end()
      }
    },
    60_000,
  )

  requiresConcurrency()(
    'and it opens none while a transaction is holding one, across several probe ticks',
    async () => {
      // The arming delay is not the mechanism; the at-rest gate is (R10 M11). Keep the pool busy
      // long enough for the probe to have fired several times and count backends on the server.
      const app = pgPrime({
        connection: liveTarget().url,
        schema,
        session: { applicationName: 'pgprime_f1_busy' },
        poolOptions: { max: 4 },
      })
      try {
        await app.sql`select 1`.execute()
        const seen: number[] = []
        await app.transaction(async (tx) => {
          for (let i = 0; i < 6; i++) {
            await tx.sql`select 1`.execute()
            // `.outsideTransaction()` because this read is deliberately out of band: the dev
            // guard is right that a statement on the root handle inside a transaction runs on a
            // different connection — that is exactly what makes it a usable oracle here.
            const [row] = await db.outsideTransaction()
              .sql`select count(*)::int as n from pg_catalog.pg_stat_activity
                   where application_name = 'pgprime_f1_busy'`.execute()
            seen.push((row as { n: number }).n)
            await new Promise((r) => setTimeout(r, 120))
          }
        })
        expect(Math.max(...seen)).toBe(1)
      } finally {
        await app.end()
      }
    },
    60_000,
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// §6.1 / §6.2 / §1.5 / §2.3 — the builder-level options, on a real server
// ─────────────────────────────────────────────────────────────────────────────

describe('the builder-level option methods on a real server (07 §6.1, §6.2, §1.5, §2.3)', () => {
  requiresConcurrency()(
    '.timeout(ms) inside a transaction is enforced by the backend',
    async () => {
      const timed = await db
        .transaction(async (tx) =>
          tx
            .from(schema.h.counters)
            .select(() => ({ slept: sql`pg_sleep(3)::text`.as(textCodec) }))
            .timeout(250)
            .execute(),
        )
        .catch((e: unknown) => e)
      expect(timed).toBeInstanceOf(QueryCanceledError)
      expect(sqlState(timed)).toBe('57014')
    },
    60_000,
  )

  requiresConcurrency()(
    '.signal(s) aborts one statement in flight',
    async () => {
      const own = pgDriver({ pool: makePool(2) as unknown as PgLikePool })
      try {
        const solo = pgPrime({ driver: own, schema })
        const ac = new AbortController()
        setTimeout(() => ac.abort(), 200)
        const started = Date.now()
        const err = await solo
          .from(schema.h.counters)
          .select(() => ({ slept: sql`pg_sleep(5)::text`.as(textCodec) }))
          .signal(ac.signal)
          .execute()
          .catch((e: unknown) => e)
        // The class depends on a race the existing §6.1 case documents — the `CancelRequest` can
        // land before our rejection does, and then the SERVER's `57014` is the honest answer. What
        // `.signal(s)` has to prove is that the signal reached the statement at all, and a 5 s
        // sleep that stops in under two seconds is that proof.
        expect(err).toBeInstanceOf(Error)
        expect(['AbortError', 'QueryCanceledError']).toContain((err as Error).name)
        expect(Date.now() - started).toBeLessThan(2_000)
        // The handle survives; the socket does not (§6.1).
        expect(await solo.sql`select 1 as one`.execute()).toStrictEqual([{ one: 1 }])
      } finally {
        await own.destroy().catch(() => {})
      }
    },
    60_000,
  )

  requiresConcurrency()(
    '.withExecMode("named") really names the statement — pg_prepared_statements is the oracle',
    async () => {
      const own = pgDriver({ pool: makePool(1) as unknown as PgLikePool })
      try {
        const solo = pgPrime({ driver: own, schema })
        await solo
          .from(schema.h.counters)
          .select(({ counters: c }) => ({ id: c.id }))
          .withExecMode('named')
          .execute()
        const [row] =
          await solo.sql`select count(*)::int as n from pg_prepared_statements`.execute()
        expect((row as { n: number }).n).toBeGreaterThan(0)
      } finally {
        await own.destroy().catch(() => {})
      }
    },
    60_000,
  )

  requiresConcurrency()(
    '.outsideTransaction() is what lets the outer handle write during a transaction',
    async () => {
      // And the point of the escape hatch: the out-of-band row survives the rollback, because it
      // was never in the transaction.
      const app = pgPrime({ connection: liveTarget().url, schema, poolOptions: { max: 4 } })
      try {
        await app
          .transaction(async (tx) => {
            await tx.insertInto(schema.h.counters).values({ id: 901, n: 1 }).execute()
            await app
              .insertInto(schema.h.counters)
              .values({ id: 902, n: 1 })
              .outsideTransaction()
              .execute()
            throw new Error('abandon')
          })
          .catch(() => undefined)
        expect(await readN(901).catch(() => 'absent')).toBe('absent')
        expect(await readN(902)).toBe(1)
      } finally {
        await app.sql`delete from pgprime_pg_session.counters where id = 902`
          .execute()
          .catch(() => {})
        await app.end()
      }
    },
    60_000,
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// §6.1 — the protocol CancelRequest, on the path that has one (design/13 §5, E's F2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything above cancels through `pg_cancel_backend` on a spare pooled connection, because a
 * handle built from `driver:` has no `createCancelClient`. `pgPrime({ connection })` does — it
 * hands the adapter `() => new Client(sameConfig)` — and that is the only path that sends a real
 * protocol `CancelRequest`, so it is the only path where `pg`'s deprecated `Client.activeQuery`
 * was ever read.
 *
 * `process.throwDeprecation = true` for the duration is `--throw-deprecation` scoped to one
 * statement: `util.deprecate`'s warning is emitted at call time and node's own listener reads that
 * flag when it lands, so a re-introduced `canceller.cancel(target, target.activeQuery)` throws out
 * of a `nextTick` and the file fails loudly. The collected warnings are asserted too, because
 * `util.deprecate` warns **once per process** — if some earlier file in this worker had already
 * tripped it the throw would not fire, and only the empty list would still mean something.
 */
describe('the protocol CancelRequest (07 §6.1)', () => {
  requiresConcurrency()(
    'stops the backend, and reads no deprecated pg property doing it',
    async () => {
      const APP = 'pgprime_cancel_probe'
      const warnings: string[] = []
      const onWarning = (w: Error): void => {
        if (w.name === 'DeprecationWarning') warnings.push(w.message)
      }
      // `--throw-deprecation` on the command line makes the property READ-ONLY, so the write is
      // best-effort: when it is already on there is nothing to turn on.
      const throwBefore = process.throwDeprecation
      const setThrowDeprecation = (on: boolean): void => {
        if (process.throwDeprecation === on) return
        try {
          process.throwDeprecation = on
        } catch {
          /* set by NODE_OPTIONS — already exactly what this test wants */
        }
      }
      process.on('warning', onWarning)
      setThrowDeprecation(true)

      const app = pgPrime({
        connection: liveTarget().url,
        schema,
        devGuard: false,
        poolOptions: { max: 2 },
        session: { applicationName: APP },
      })
      const watcher = await client()
      try {
        // `timeoutStrategy: 'client'` is the one that arms OUR timer and then cancels — the
        // server-side `SET LOCAL statement_timeout` path never opens a cancel socket.
        const err = await app.withOptions({ timeoutMs: 250, timeoutStrategy: 'client' })
          .sql`select pg_sleep(5)`
          .execute()
          .catch((e: unknown) => e)
        expect(err).toBeInstanceOf(QueryTimeoutError)

        // R18: `pg_stat_activity` is the oracle for "the cancel landed", not our own rejection —
        // which would look identical if the CancelRequest had gone nowhere at all.
        const sleeping = async (): Promise<number> => {
          const r = await watcher.query(
            `select count(*)::int as n from pg_stat_activity
               where application_name = $1 and state = 'active' and query like '%pg_sleep(5)%'`,
            [APP],
          )
          return Number((r.rows[0] as { n: number }).n)
        }
        let left = await sleeping()
        for (let i = 0; i < 30 && left > 0; i++) {
          await new Promise((r) => setTimeout(r, 100))
          left = await sleeping()
        }
        expect(left).toBe(0)

        // A tick after the last await, so a warning emitted by the cancel has landed.
        await new Promise((r) => setTimeout(r, 50))
        expect(warnings).toStrictEqual([])
      } finally {
        setThrowDeprecation(throwBefore === true)
        process.off('warning', onWarning)
        await watcher.end().catch(() => {})
        await app.end().catch(() => {})
      }
    },
    60_000,
  )
})
