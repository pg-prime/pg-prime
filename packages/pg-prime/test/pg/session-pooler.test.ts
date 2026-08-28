/**
 * The pooler profile, through a REAL transaction-mode PgBouncer (design/07 §5; R19).
 *
 * R19: *a profile claim that has only been tested against a direct connection is not tested*. Every
 * assertion here is gated on `PG_PRIME_TEST_PGBOUNCER_URL` and skips **loudly** without it, naming
 * the recipe — a silent skip is a test that has stopped existing.
 *
 * The gate for the whole workstream is at the bottom: `07` §0's five-minute snippet, run unchanged
 * on a direct connection and through the pooler.
 */

import { afterAll, describe, expect, it, vi } from 'vitest'
import { ConfigError, UnsupportedInPoolerModeError } from '../../src/errors/index.js'
import { POOLER_PROFILES } from '../../src/pooler/index.js'
import { pgPrime } from '../../src/query/run.js'
import type { Db } from '../../src/query/types.js'
import { defineSchema, pgTable } from '../../src/schema/index.js'
import { announce, liveTarget, requiresConcurrency, type TestDecl } from '../live/_harness.js'

const NS = 'pgprime_pooler'

const orders = pgTable(
  'orders',
  (t) => ({ id: t.integer().primaryKey(), tenant: t.text(), total: t.integer() }),
  undefined,
  { schema: NS },
)
const schema = defineSchema({ orders })
type S = typeof schema

const BOUNCER = process.env['PG_PRIME_TEST_PGBOUNCER_URL']

/** Loud, like `requiresConcurrency()`. */
function requiresPgBouncer(): TestDecl {
  if (BOUNCER !== undefined && BOUNCER !== '') return it
  announce(
    '[pg] skip: PG_PRIME_TEST_PGBOUNCER_URL is unset, so `07` §5 pooler-profile behaviour is ' +
      'UNVERIFIED in this run. Start one with POOL_MODE=transaction and ' +
      'MAX_PREPARED_STATEMENTS=200 and set the variable (design/12 §3 S, R19).',
  )
  return it.skip
}

const open: Db<S>[] = []
function make(config: Parameters<typeof pgPrime<S>>[0]): Db<S> {
  const db = pgPrime(config)
  open.push(db)
  return db
}

afterAll(async () => {
  for (const db of open) await db.end().catch(() => {})
})

async function ddl(db: Db<S>): Promise<void> {
  await db.sql`drop schema if exists pgprime_pooler cascade`.execute()
  await db.sql`create schema pgprime_pooler`.execute()
  await db.sql`create table pgprime_pooler.orders (
    id integer primary key, tenant text not null, total integer not null)`.execute()
}

// ─────────────────────────────────────────────────────────────────────────────
// §5.4 — the behavioural probe, on both sides of the pooler
// ─────────────────────────────────────────────────────────────────────────────

describe('diagnosePooler() (07 §5.4, R19)', () => {
  requiresConcurrency()('says `direct` against the server itself', async () => {
    const db = make({ schema, connection: liveTarget().url, poolOptions: { max: 4 } })
    const r = await db.diagnosePooler()
    expect(r.verdict).toBe('direct')
    expect(r.recommendedPoolerMode).toBe('none')
    expect(r.agrees).toBe(true)
  }, 60_000)

  requiresPgBouncer()('says `likely-transaction-pooled` through PgBouncer', async () => {
    const db = make({ schema, connection: BOUNCER as string, poolOptions: { max: 4 } })
    const r = await db.diagnosePooler()
    expect(r.verdict).toBe('likely-transaction-pooled')
    // Never 'high'. The type says so and so does the report.
    expect(r.confidence).toBe('medium')

    // `named-statement-survives` is the probe that decides WHICH transaction profile, and with
    // `max_prepared_statements=200` PgBouncer tracks them — so the recommendation is the one that
    // keeps the option open rather than the conservative floor.
    const named = r.signals.find((s) => s.name === 'named-statement-survives')
    expect(named).toBeDefined()
    if (named!.result === 'supports-session-pooling') {
      expect(r.recommendedPoolerMode).toBe('pgbouncer-transaction')
    } else {
      expect(r.recommendedPoolerMode).toBe('transaction')
    }

    // The pid pair is what spotted the pooler in the first place.
    const across = r.signals.find((s) => s.name === 'backend-pid-across-statements')
    expect(across?.result).toBe('supports-transaction-pooling')
    // …and within one transaction the backend MUST be stable, in every correct pooler.
    const within = r.signals.find((s) => s.name === 'backend-pid-within-transaction')
    expect(within?.result).toBe('supports-direct')
    expect(r.warnings).toStrictEqual([])
  }, 60_000)

  requiresPgBouncer()(
    'the dev-mode startup check warns ONCE, asynchronously, when agrees === false (07 §5.4)',
    async () => {
      const lines: string[] = []
      const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
        lines.push(String(a[0]))
      })
      try {
        // `poolerMode: 'none'` against a real transaction pooler is the dangerous direction, and
        // the whole point of the check. `pgPrime` must still open no socket…
        const db = make({ schema, connection: BOUNCER as string, poolOptions: { max: 4 } })
        expect(lines).toStrictEqual([])
        // …and the probe rides the FIRST connection rather than blocking it.
        await db.sql`select 1`.execute()
        const deadline = Date.now() + 15_000
        while (!lines.some((l) => l.includes('poolerMode')) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100))
        }
        const hits = lines.filter((l) => l.includes('poolerMode is'))
        expect(hits).toHaveLength(1)
        expect(hits[0]).toMatch(/likely-transaction-pooled/)
        expect(hits[0]).toMatch(/db\.diagnosePooler\(\)/)

        // Once. A second statement must not re-probe.
        await db.sql`select 1`.execute()
        await new Promise((r) => setTimeout(r, 500))
        expect(lines.filter((l) => l.includes('poolerMode is'))).toHaveLength(1)
      } finally {
        warn.mockRestore()
      }
    },
    60_000,
  )

  requiresConcurrency()('and says nothing at all when the configuration agrees', async () => {
    const lines: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      lines.push(String(a[0]))
    })
    try {
      const db = make({ schema, connection: liveTarget().url, poolOptions: { max: 4 } })
      await db.sql`select 1`.execute()
      await new Promise((r) => setTimeout(r, 1_000))
      expect(lines.filter((l) => l.includes('poolerMode is'))).toStrictEqual([])
    } finally {
      warn.mockRestore()
    }
  }, 60_000)

  requiresPgBouncer()('reports agrees: false when the configuration is the conservative floor', async () => {
    const db = make({ schema, connection: BOUNCER as string, poolerMode: 'none', poolOptions: { max: 4 } })
    const r = await db.diagnosePooler()
    // Configured `none` against a real pooler is the dangerous direction, and it is what the
    // dev-mode startup warning exists for.
    expect(r.agrees).toBe(false)
    expect(r.configuredPoolerMode).toBe('none')
  }, 60_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// §5.2 — what a transaction profile refuses, and what it silently does not do
// ─────────────────────────────────────────────────────────────────────────────

describe('a transaction profile only ever restricts (07 §5.2, §5.3)', () => {
  requiresPgBouncer()('db.session() is refused, and db.transaction() is not', async () => {
    const db = make({
      schema,
      connection: BOUNCER as string,
      poolerMode: 'transaction',
      poolOptions: { max: 4 },
    })
    await ddl(db)
    const err = await db.session(() => Promise.resolve(1)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UnsupportedInPoolerModeError)
    expect((err as Error).message).toMatch(/db\.transaction\(\)/)

    // A transaction IS one backend for its duration, which is exactly what a transaction pooler
    // guarantees — so it works, and the row proves it.
    await db.transaction(async (tx) => {
      await tx.insertInto(schema.h.orders).values({ id: 1, tenant: 't', total: 10 }).execute()
    })
    expect(
      await db.from(schema.h.orders).select(({ orders: o }) => ({ id: o.id })).execute(),
    ).toStrictEqual([{ id: 1 }])
  }, 60_000)

  requiresPgBouncer()('session GUCs are NOT applied — SHOW is the oracle (07 §3.6)', async () => {
    const pooled = make({
      schema,
      connection: BOUNCER as string,
      poolerMode: 'transaction',
      session: { applicationName: 'pgprime_pooled_probe', statementTimeout: '7s' },
      poolOptions: { max: 4 },
    })
    const [row] = await pooled.sql`select current_setting('statement_timeout') as t,
                                          current_setting('application_name') as a`.execute()
    // §3.6: a `SET statement_timeout` at connect would land on a server connection PgBouncer hands
    // to another client, so we do not emit it at all. `SHOW` reports the server default, not ours.
    expect(row?.['t']).not.toBe('7s')
    // `application_name` is the documented exception: it is pg's own STARTUP field rather than a
    // `SET`, PgBouncer forwards it per client, and it changes no query semantics — so it is free
    // and it survives, which is what makes pg_stat_activity readable behind a pooler.
    expect(row?.['a']).toBe('pgprime_pooled_probe')

    // …and `diagnose()` says what was skipped rather than leaving the user to wonder.
    const d = await pooled.diagnose()
    expect(d.notes.join('\n')).toMatch(/ALTER ROLE/)
  }, 60_000)

  requiresConcurrency()('the SAME session config IS applied on a direct connection', async () => {
    const direct = make({
      schema,
      connection: liveTarget().url,
      session: { applicationName: 'pgprime_sticks', statementTimeout: '7s' },
      poolOptions: { max: 4 },
    })
    const [row] = await direct.sql`select current_setting('statement_timeout') as t,
                                          current_setting('application_name') as a`.execute()
    expect(row?.['t']).toBe('7s')
    expect(row?.['a']).toBe('pgprime_sticks')
  }, 60_000)

  it("statement: 'named' is refused at CONSTRUCTION under the conservative floor", () => {
    expect(() =>
      pgPrime({ schema, connection: 'postgres://x/y', poolerMode: 'transaction', statement: 'named' }),
    ).toThrow(ConfigError)
    // …and allowed under the profile that says the pooler tracks them.
    expect(POOLER_PROFILES['pgbouncer-transaction'].namedPreparedStatements).toBe('shared-lru')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The workstream's gate: `07` §0's snippet, unchanged, on both
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `07` §0's five-minute version, with `pgPrime` for `createDb` (decision 1) and the builder's own
 * spelling for the query entry points.
 *
 * > *Every decision below exists to make that snippet correct on a direct connection, behind
 * > PgBouncer, behind Supavisor, and on Neon — with the same code.*
 */
async function fiveMinuteVersion(db: Db<S>, tenantId: string, id: number): Promise<unknown> {
  const rows = await db
    .from(schema.h.orders)
    .select(({ orders: o }) => ({ id: o.id, total: o.total }))
    .execute()

  const order = await db.transaction(
    async (db) => {
      await db.setLocal('app.tenant_id', tenantId)
      const [o] = await db
        .insertInto(schema.h.orders)
        .values({ id, tenant: tenantId, total: 42 })
        .returning(({ orders: r }) => ({ id: r.id }))
        .execute()
      await db.insertInto(schema.h.orders).values({ id: id + 1, tenant: tenantId, total: 7 }).execute()
      return o
    },
    { isolation: 'serializable' },
  )
  return { seen: rows.length, order }
}

describe("07 §0's snippet runs unchanged on both (the S gate)", () => {
  requiresConcurrency()('on a direct connection', async () => {
    const db = make({
      schema,
      connection: liveTarget().url,
      directConnection: liveTarget().url,
      poolOptions: { max: 4 },
    })
    await ddl(db)
    const out = (await fiveMinuteVersion(db, 'tenant-1', 100)) as { order: { id: number } }
    expect(out.order.id).toBe(100)
    expect(
      await db.from(schema.h.orders).select(({ orders: o }) => ({ id: o.id })).execute(),
    ).toStrictEqual([{ id: 100 }, { id: 101 }])
  }, 60_000)

  requiresPgBouncer()('and through PgBouncer transaction mode, with the same code', async () => {
    const db = make({
      schema,
      connection: BOUNCER as string,
      directConnection: liveTarget().url,
      poolerMode: 'pgbouncer-transaction',
      poolOptions: { max: 4 },
    })
    await ddl(db)
    const out = (await fiveMinuteVersion(db, 'tenant-2', 200)) as { order: { id: number } }
    expect(out.order.id).toBe(200)
    expect(
      await db.from(schema.h.orders).select(({ orders: o }) => ({ id: o.id })).execute(),
    ).toStrictEqual([{ id: 200 }, { id: 201 }])
  }, 60_000)
})
