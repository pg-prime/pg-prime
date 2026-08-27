/**
 * The executor's session-scoped behaviour, tier 2 (design/09 WS6; `07` §2.4, §5.1).
 *
 * Two claims live here and can live nowhere else:
 *
 *  1. **A named statement lives on a backend.** `pg_prepared_statements` is session-scoped, so
 *    "the statement exists" and "it does not exist over there" are two different sessions'
 *    answers — and PGlite multiplexes every connection onto one backend, so it would report both
 *    as the same session and pass a broken implementation (`08` §4.2, F8).
 *  2. **A transaction-mode pooler moves the goalposts.** PgBouncer hands a different server
 *    connection to each transaction, so an unnamed statement is always fine and a named one is
 *    only fine if the pooler tracks it. That is exactly what `07` §2.4 designs the self-heal for,
 *    and the only honest way to pin it is against a real PgBouncer.
 *
 * The PgBouncer half is gated on `PG_PRIME_TEST_PGBOUNCER_URL` and skips **loudly** when unset,
 * in the same style as `requiresConcurrency()` — a silent skip is a test that stops existing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Registry, int4Codec } from '../../src/codec/index.js'
import type { PgConnection, PgLikePool } from '../../src/driver/index.js'
import { pgDriver } from '../../src/driver/index.js'
import type { ExecOptions } from '../../src/query/executor.js'
import { pgPrime, statementStats } from '../../src/query/run.js'
import * as q from '../../src/query/types.js'
import { defineSchema, pgTable } from '../../src/schema/index.js'
import pg from 'pg'
import {
  announce,
  liveTarget,
  makeHarness,
  requiresConcurrency,
  requiresRealPostgres,
  sqlState,
  type Harness,
  type TestDecl,
} from '../live/_harness.js'

const NS = 'pgprime_pg_executor'

/** A two-column table; enough to name a relation and nothing more. */
const widgets = pgTable('widgets', (t) => ({ id: t.integer().primaryKey(), name: t.text() }), undefined, {
  schema: NS,
})
const schema = defineSchema({ widgets })

const DDL = `
create schema ${NS};
create table ${NS}.widgets (id integer primary key, name text not null);
insert into ${NS}.widgets (id, name) values (1, 'one'), (2, 'two'), (3, 'three');
`

let h: Harness
let conn: PgConnection

beforeAll(async () => {
  h = await makeHarness(4)
  conn = await h.driver.acquire()
  await conn.execute({ text: `drop schema if exists ${NS} cascade`, params: [], mode: 'simple' })
  await conn.execute({ text: DDL, params: [], mode: 'simple' })
}, 120_000)

afterAll(async () => {
  await conn
    ?.execute({ text: `drop schema if exists ${NS} cascade`, params: [], mode: 'simple' })
    .catch(() => {})
  if (conn) await h.driver.release(conn)
  await h?.end()
})

const NAME = /^pgprime_[0-9a-z]+_\d+$/

/**
 * A pool of **one**, torn down afterwards — i.e. one backend, fresh, all to ourselves.
 *
 * Both halves matter. *Fresh*, because `pg_prepared_statements` is session state and the shared
 * harness pool hands the same backend to the next test with the previous test's statements still
 * on it (found the hard way: the eviction assertion read 3 where it expected 1). *One*, because
 * the self-heal must be observed OUTSIDE a transaction, and only a single-connection pool
 * guarantees that two consecutive `execute()` calls land on the same backend.
 */
async function withOwnBackend(f: (h: Harness) => Promise<void>): Promise<void> {
  const own = await makeHarness(1)
  try {
    await f(own)
  } finally {
    await own.end()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. `pg_prepared_statements` — the server's own catalogue
// ─────────────────────────────────────────────────────────────────────────────

describe('{ statement: "named" } really prepares on the server', () => {
  requiresRealPostgres('pg_prepared_statements needs a real backend session')(
    'the name we generated is in pg_prepared_statements, on the SAME connection',
    async () => {
      await withOwnBackend(async (own) => {
        const db = pgPrime({ driver: own.driver, schema })
        await db.transaction(async (tx) => {
          const p = tx
            .from(schema.h.widgets)
            .select(({ widgets: w }) => ({ id: w.id, name: w.name }))
            .where(({ widgets: w }) => q.eq(w.id, q.placeholder('id', int4Codec)))
            .prepare<{ id: number }>('widget_by_id', { statement: 'named' })

          expect(await p.execute({ id: 2 })).toStrictEqual([{ id: 2, name: 'two' }])

          // The ORACLE is PostgreSQL's own catalogue, read on the same session through a
          // different statement. It reports the name WE minted — the `pgprime_<hash>_<seq>` of
          // `07` §2.4 — and never the JS-side `'widget_by_id'`, which is the distinction
          // `03` §1.4b insists on.
          const rows =
            await tx.sql`select name, statement from pg_prepared_statements order by name`.execute()
          expect(rows).toHaveLength(1)
          expect(String(rows[0]?.['name'])).toMatch(NAME)
          expect(String(rows[0]?.['statement'])).toContain(`"${NS}"."widgets"`)
          expect(rows.some((r) => r['name'] === 'widget_by_id')).toBe(false)

          // Re-executing reuses it: still exactly one.
          expect(await p.execute({ id: 3 })).toStrictEqual([{ id: 3, name: 'three' }])
          expect(await tx.sql`select name from pg_prepared_statements`.execute()).toHaveLength(1)
        })
      })
    },
  )

  requiresConcurrency()('a named statement is invisible to a second backend', async () => {
    const db = pgPrime({ driver: h.driver, schema, statement: 'named' })
    let mine = 0
    await db.transaction(async (tx) => {
      await tx.from(schema.h.widgets).select(({ widgets: w }) => ({ id: w.id })).execute()
      const here =
        await tx.sql`select count(*)::int4 as n from pg_prepared_statements where name like 'pgprime_%'`.execute()
      mine = Number(here[0]?.['n'])
      expect(mine).toBeGreaterThan(0)
    })
    // A different session, from a POOL OF ITS OWN so it cannot be handed the one above.
    // `pg_prepared_statements` is per backend, which is exactly why the statement cache in
    // `./executor.ts` is keyed on the CONNECTION and never process-wide.
    await withOwnBackend(async (own) => {
      const other = await own.driver.acquire()
      try {
        const r = await other.execute({
          text: `select count(*)::int4 from pg_prepared_statements where name like 'pgprime_%'`,
          params: [],
        })
        expect(r.rows[0]?.[0]).toBe('0')
      } finally {
        await own.driver.release(other)
      }
    })
  })

  requiresRealPostgres('needs a real backend to hold a named statement')(
    'the default is unnamed: nothing is left behind on the session',
    async () => {
      await withOwnBackend(async (own) => {
        const db = pgPrime({ driver: own.driver, schema })
        await db.transaction(async (tx) => {
          await tx.from(schema.h.widgets).select(({ widgets: w }) => ({ id: w.id })).execute()
          const rows =
            await tx.sql`select count(*)::int4 as n from pg_prepared_statements`.execute()
          expect(rows[0]?.['n']).toBe(0)
        })
      })
    },
  )

  requiresRealPostgres('protocol Close needs a real backend')(
    'LRU eviction removes the statement from the catalogue — protocol Close, not DEALLOCATE',
    async () => {
      await withOwnBackend(async (own) => {
        const db = pgPrime({
          driver: own.driver,
          schema,
          statement: 'named',
          preparedStatements: { maxPerConnection: 1 },
        })
        await db.transaction(async (tx) => {
          await tx.from(schema.h.widgets).select(({ widgets: w }) => ({ id: w.id })).execute()
          const first = await tx.sql`select name from pg_prepared_statements`.execute()
          expect(first).toHaveLength(1)

          // A second, different statement evicts the first at maxPerConnection = 1.
          await tx.from(schema.h.widgets).select(({ widgets: w }) => ({ name: w.name })).execute()
          const second = await tx.sql`select name from pg_prepared_statements`.execute()
          // Still one — and a DIFFERENT one. If eviction had merely forgotten the entry, the
          // server-side statement would still be here and this would be two. That is the whole
          // difference between the protocol `Close` and evict-by-forgetting (`07` §2.4).
          expect(second).toHaveLength(1)
          expect(second[0]?.['name']).not.toBe(first[0]?.['name'])
        })
      })
    },
  )

  requiresRealPostgres('needs a real pool that hands the same backend back')(
    'the statement is reused across pooled executions, not re-minted per checkout (07 §2.4)',
    async () => {
      await withOwnBackend(async (own) => {
        const db = pgPrime({ driver: own.driver, schema, statement: 'named' })
        const p = db
          .from(schema.h.widgets)
          .select(({ widgets: w }) => ({ id: w.id }))
          .prepare(undefined, { statement: 'named' })

        // Five executions OUTSIDE any transaction, i.e. five pool checkouts of the one physical
        // connection this harness has. The cache key is "per physical connection" (`07` §2.4), so
        // the server must end up with exactly ONE statement — not five.
        for (let i = 0; i < 5; i++) expect(await p.execute({})).toHaveLength(3)

        const names = await db.sql`select name from pg_prepared_statements`.execute()
        expect(names).toHaveLength(1)
        expect(String(names[0]?.['name'])).toMatch(NAME)
      })
    },
  )

  requiresRealPostgres('26000 comes from a real backend')(
    'a DEALLOCATEd statement is re-prepared once and the caller never sees the 26000',
    async () => {
      await withOwnBackend(async (own) => {
        const db = pgPrime({ driver: own.driver, schema, statement: 'named' })
        const p = db
          .from(schema.h.widgets)
          .select(({ widgets: w }) => ({ id: w.id }))
          .prepare(undefined, { statement: 'named' })
        expect(await p.execute({})).toHaveLength(3)

        // What a pooler (or a restart) does to us: throw our statement away behind our back.
        // OUTSIDE a transaction, deliberately — see the next test for why that is not incidental.
        await db.sql`deallocate all`.execute()

        // `07` §2.4 policy 1: re-prepare at most once, and the caller gets rows.
        expect(await p.execute({})).toHaveLength(3)
        expect(statementStats(db).downgraded).toBe(false)
      })
    },
  )

  requiresRealPostgres('the 25P02 rule needs a real transaction block')(
    'inside a transaction the SAME 26000 is surfaced, not healed (07 §2.4 policy 2)',
    async () => {
      await withOwnBackend(async (own) => {
        const db = pgPrime({ driver: own.driver, schema, statement: 'named' })
        const err = await db
          .transaction(async (tx) => {
            const p = tx
              .from(schema.h.widgets)
              .select(({ widgets: w }) => ({ id: w.id }))
              .prepare(undefined, { statement: 'named' })
            await p.execute({})
            await tx.sql`deallocate all`.execute()
            await p.execute({})
          })
          .catch((e: unknown) => e)

        // The 26000 ABORTED the block, so `transactionStatus` is 'E' and a retry would get
        // `25P02 current transaction is aborted`. Surfacing it is the designed behaviour and the
        // reason the policy has a clause about it at all — measured here, not assumed.
        expect(sqlState(err)).toBe('26000')
      })
    },
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. PgBouncer, transaction mode
// ─────────────────────────────────────────────────────────────────────────────

const PGBOUNCER_URL = process.env['PG_PRIME_TEST_PGBOUNCER_URL']

/**
 * Loud, like `requiresConcurrency()`: a PgBouncer skip has to be visible in CI output, because
 * "named statements work through a transaction pooler" is a claim nobody can check by reading.
 */
function requiresPgBouncer(): TestDecl {
  if (PGBOUNCER_URL !== undefined && PGBOUNCER_URL !== '') return it
  announce(
    '[pg] skip: PG_PRIME_TEST_PGBOUNCER_URL is unset, so `07` §5.1 transaction-pooling behaviour ' +
      'is UNVERIFIED in this run. Start one with POOL_MODE=transaction and ' +
      'MAX_PREPARED_STATEMENTS=200 and set the variable (design/09 §3.6).',
  )
  return it.skip
}

describe('through a PgBouncer transaction-mode pool (07 §5.1)', () => {
  const makeDb = (opts: ExecOptions = {}) => {
    const pool = new pg.Pool({ connectionString: PGBOUNCER_URL, max: 4 })
    const driver = pgDriver({ pool: pool as unknown as PgLikePool })
    const db = pgPrime({ ...opts, driver, schema, registry: new Registry() })
    return { db, done: async () => void (await driver.destroy()) }
  }

  requiresPgBouncer()('the DEFAULT (unnamed) works, repeatedly, across pooled connections', async () => {
    const { db, done } = makeDb()
    try {
      for (let i = 0; i < 10; i++) {
        expect(
          await db
            .from(schema.h.widgets)
            .select(({ widgets: w }) => ({ id: w.id, name: w.name }))
            .where(({ widgets: w }) => q.eq(w.id, 1))
            .execute(),
        ).toStrictEqual([{ id: 1, name: 'one' }])
      }
      // One round trip, zero session state — the reason it is the default (`07` §2.2).
      expect(statementStats(db).statement).toBe('unnamed')
    } finally {
      await done()
    }
  })

  requiresPgBouncer()('the NAMED opt-in also works, and pins which of `07` s two outcomes we get', async () => {
    const { db, done } = makeDb({ statement: 'named' })
    try {
      const p = db
        .from(schema.h.widgets)
        .select(({ widgets: w }) => ({ id: w.id, name: w.name }))
        .where(({ widgets: w }) => q.eq(w.id, q.placeholder('id', int4Codec)))
        .prepare<{ id: number }>('bouncer_widget', { statement: 'named' })

      // 20 executions, each of which PgBouncer may route to a different server connection.
      for (let i = 0; i < 20; i++) {
        expect(await p.execute({ id: 1 })).toStrictEqual([{ id: 1, name: 'one' }])
      }

      // THE PIN. PgBouncer >= 1.21 tracks named statements per client when
      // `max_prepared_statements > 0`, rewriting the name on the way through, so we should see
      // ZERO self-heals — the `26000` path exists for poolers that do not, and for a server that
      // was restarted underneath us. If this line ever goes red the environment changed, and the
      // right response is to read `07` §5.2's matrix rather than to loosen the assertion.
      const stats = statementStats(db)
      expect(stats.selfHeals).toBe(0)
      expect(stats.downgraded).toBe(false)
    } finally {
      await done()
    }
  })

  requiresPgBouncer()('LRU eviction through the pooler keeps working — protocol Close, not DEALLOCATE', async () => {
    const { db, done } = makeDb({ statement: 'named', preparedStatements: { maxPerConnection: 1 } })
    try {
      // `maxPerConnection: 1` forces an eviction on every alternation, so this exercises the
      // protocol `Close('S', name)` path against a pooler that rewrites statement names in flight.
      for (let i = 0; i < 6; i++) {
        expect(
          await db.from(schema.h.widgets).select(({ widgets: w }) => ({ id: w.id })).execute(),
        ).toHaveLength(3)
        expect(
          await db.from(schema.h.widgets).select(({ widgets: w }) => ({ name: w.name })).execute(),
        ).toHaveLength(3)
      }
      expect(statementStats(db).downgraded).toBe(false)
    } finally {
      await done()
    }
  })

  requiresPgBouncer()('PIN: `DEALLOCATE ALL` through the pooler is FATAL 08P01 — hence `07` §2.4 s ban', async () => {
    // This is the measured reason `07` §2.4 says "never SQL `DEALLOCATE`, never `DEALLOCATE ALL`
    // / `DISCARD ALL`". With `max_prepared_statements > 0` PgBouncer keeps its OWN client→server
    // name map and rewrites names in flight; a `DEALLOCATE ALL` desynchronises that map, and the
    // next Bind gets `08P01 protocol_violation` at severity FATAL — the connection is gone, and
    // no self-heal can help because the statement is not merely missing, the session is.
    //
    // Our own eviction path never emits it (the test above), so this pins the environment rather
    // than our behaviour: if a future PgBouncer makes it survivable, this line is where we find out.
    const { db, done } = makeDb({ statement: 'named' })
    try {
      const p = db
        .from(schema.h.widgets)
        .select(({ widgets: w }) => ({ id: w.id }))
        .prepare(undefined, { statement: 'named' })
      expect(await p.execute({})).toHaveLength(3)
      await db.transaction(async (tx) => {
        await tx.sql`deallocate all`.execute()
      })
      const err = await p.execute({}).catch((e: unknown) => e)
      expect(sqlState(err)).toBe('08P01')
    } finally {
      await done()
    }
  })
})

/** Kept honest under `noUnusedLocals`; `liveTarget`/`sqlState` are the harness's own vocabulary. */
void [liveTarget, sqlState]
