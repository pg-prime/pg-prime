/**
 * COPY against a real server, and the crossover `07` §6.6 promises to publish rather than guess
 * (design/12 §3 S).
 *
 * > *Documented crossover from measurement, expected around 5–10 k rows; we will publish the
 * > measured number rather than a guess.*
 *
 * PGlite cannot host this — its socket bridge exits the WASM backend on a COPY message (measured;
 * see `test/live/session.test.ts`) — so the whole file is tier 2.
 *
 * The measurement runs at five sizes and prints a table. It **asserts** only what is not
 * machine-dependent: both paths load the same rows, and COPY wins by 100 000. A wall-clock
 * threshold in a unit test would be a flake generator, and R21 (a number is a measurement from a
 * known runner, not a gate on a laptop) applies here too.
 *
 * **The measured answer, PG 17.11 over a local TCP socket: there is no crossover.** `copyFrom` is
 * faster than `insertMany` at every size from ten rows up — about 1.5–1.8× at 10–100 rows, ~2× at
 * 1 000–10 000 and 2.3–3.8× at 100 000. So §6.6's "expected around 5–10 k rows" is wrong in an
 * interesting way: the reason to reach for `insertMany` below a few thousand rows is ERGONOMICS —
 * `RETURNING`, `ON CONFLICT`, typed rows, one statement inside your transaction — and not speed.
 */

import { afterAll, beforeAll, describe, expect } from 'vitest'
import type { PgDriver, PgLikePool } from '../../src/driver/index.js'
import { pgDriver } from '../../src/driver/index.js'
import { pgPrime } from '../../src/query/run.js'
import type { Db } from '../../src/query/types.js'
import { defineSchema, pgTable } from '../../src/schema/index.js'
import { announce, liveTarget, makePool, requiresConcurrency } from '../live/_harness.js'

const NS = 'pgprime_pg_copy'

const events = pgTable(
  'events',
  (t) => ({
    id: t.integer().primaryKey(),
    kind: t.text(),
    amount: t.numeric(),
    at: t.timestamptz(),
  }),
  undefined,
  { schema: NS },
)
/**
 * The generated-column table (design/13 §5, E's F1 — the fix round's item 2).
 *
 * `id` is `.generatedAlways()`, so it is NOT insertable and must not be in `copyFrom`'s default
 * column list. `doubled` is a stored GENERATED expression column, which the DSL cannot declare at
 * all (`design/05` §2.3's row is not built; the kit's `pull` emits a note instead) — so it is
 * simply absent from the schema here, which is how a project models one today, and the default
 * list therefore cannot name it either. COPY *refuses* a generated expression column by name
 * (`428C9`), so a default list built from the database rather than from the schema would break
 * this table twice over.
 */
const ledger = pgTable(
  'ledger',
  (t) => ({
    id: t.bigint().primaryKey().generatedAlways(),
    label: t.text(),
    amount: t.numeric(),
    createdAt: t.timestamptz().defaultSql('now()'),
  }),
  undefined,
  { schema: NS },
)

const schema = defineSchema({ events, ledger })

const DDL = `
create schema ${NS};
create table ${NS}.events (
  id integer primary key,
  kind text not null,
  amount numeric(12,2) not null,
  at timestamptz not null
);
create table ${NS}.ledger (
  id         bigint generated always as identity primary key,
  label      text not null,
  amount     numeric(12,2) not null,
  doubled    numeric(14,2) generated always as (amount * 2) stored,
  created_at timestamptz not null default now()
);
`

let driver: PgDriver
let db: Db<typeof schema>

beforeAll(async () => {
  driver = pgDriver({ pool: makePool(4) as unknown as PgLikePool })
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

const AT = new Date('2026-08-29T12:00:00.000Z')

function rows(n: number, offset: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = new Array(n) as Record<string, unknown>[]
  for (let i = 0; i < n; i++) {
    out[i] = { id: offset + i, kind: `kind-${i % 7}`, amount: `${i % 1000}.25`, at: AT }
  }
  return out
}

async function truncate(): Promise<void> {
  await db.sql`truncate table pgprime_pg_copy.events`.execute()
}

async function count(): Promise<number> {
  const [row] = await db.sql`select count(*)::int as n from pgprime_pg_copy.events`.execute()
  return Number(row?.['n'])
}

async function time(label: string, f: () => Promise<unknown>): Promise<number> {
  const started = performance.now()
  await f()
  const ms = performance.now() - started
  void label
  return ms
}

describe('COPY vs insertMany — the crossover (07 §6.6)', () => {
  requiresConcurrency()(
    'both paths load the same rows, and the table is the measurement',
    async () => {
      const table: string[] = []
      let copyWonAt: number | undefined
      for (const n of [10, 100, 1_000, 10_000, 100_000]) {
        const data = rows(n, 1)

        await truncate()
        const insertMs = await time('insertMany', () =>
          db
            .insertInto(schema.h.events)
            .valuesMany(data as never, { chunkSize: 5_000 })
            .execute(),
        )
        expect(await count()).toBe(n)

        await truncate()
        const copyMs = await time('copyFrom', () => db.copyFrom(events, data))
        expect(await count()).toBe(n)

        const ratio = insertMs / copyMs
        table.push(
          `${String(n).padStart(7)} rows · insertMany ${insertMs.toFixed(0).padStart(6)} ms · ` +
            `copyFrom ${copyMs.toFixed(0).padStart(6)} ms · ${ratio.toFixed(2)}× `,
        )
        if (ratio > 1 && copyWonAt === undefined) copyWonAt = n
      }
      announce(`[pg] COPY vs insertMany (07 §6.6 crossover)\n  ${table.join('\n  ')}`)
      announce(`[pg] COPY first wins at ${copyWonAt ?? 'no size measured here'} rows`)

      // The only wall-clock claim worth asserting: at 100 000 rows COPY is the faster path. That is
      // the whole reason tier 2 of §6.6 exists, and if it ever stops being true the feature has no
      // purpose. Everything finer is a number to publish, not a gate (R21).
      expect(copyWonAt).toBeDefined()
      expect(copyWonAt).toBeLessThanOrEqual(100_000)
    },
    300_000,
  )

  requiresConcurrency()(
    'copyFrom encodes through the CODECS, not through String(value)',
    async () => {
      await truncate()
      // `numeric` is a precision-exact string on the wire and `timestamptz` an ISO instant. A COPY
      // that stringified the JS values would round the first and localise the second.
      await db.copyFrom(events, [{ id: 1, kind: 'k', amount: '12345678.91', at: AT }])
      const [row] = await db
        .from(schema.h.events)
        .select(({ events: e }) => ({ amount: e.amount, at: e.at }))
        .execute()
      expect(row?.amount).toBe('12345678.91')
      expect(row && (row.at as Date).toISOString()).toBe(AT.toISOString())
    },
    120_000,
  )

  requiresConcurrency()('the driver advertises the capability it now really has', () => {
    expect(driver.capabilities.copyIn).toBe(true)
    expect(driver.capabilities.copyOut).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The default column list is the INSERTABLE set (design/13 §5, E's F1)
// ─────────────────────────────────────────────────────────────────────────────

describe("copyFrom's default columns are the ones an insert may name (07 §6.6)", () => {
  const clear = async (): Promise<void> => {
    await db.sql`truncate table pgprime_pg_copy.ledger restart identity`.execute()
  }

  requiresConcurrency()(
    'a table with a generated identity and a generated expression loads with no `columns` at all',
    async () => {
      await clear()
      const at = new Date('2026-08-30T09:00:00.000Z')
      const res = await db.copyFrom(ledger, [
        { label: 'a', amount: '10.00', createdAt: at },
        { label: 'b', amount: '20.50', createdAt: at },
      ])
      expect(res.rowCount).toBe(2)

      // The server supplied both generated columns, which is the proof neither was in the list:
      // `\N` into `id` is the `23502` this fix exists to remove, and naming `doubled` at all is a
      // `428C9`. Read with raw SQL, because `doubled` is not in the schema.
      const rows = await db.sql`
        select id::int as id, label, amount::text as amount, doubled::text as doubled
        from pgprime_pg_copy.ledger order by id
      `.execute()
      expect(rows.map((r) => [r['label'], r['amount'], r['doubled']])).toStrictEqual([
        ['a', '10.00', '20.00'],
        ['b', '20.50', '41.00'],
      ])
      expect(rows.map((r) => Number(r['id']))).toStrictEqual([1, 2])
    },
    120_000,
  )

  requiresConcurrency()(
    'an explicit `columns` is still honoured — including writing the identity, which COPY allows',
    async () => {
      await clear()
      const at = new Date('2026-08-30T09:00:00.000Z')
      await db.copyFrom(
        ledger,
        [
          { id: 900, label: 'restored', amount: '1.00', createdAt: at },
          { id: 901, label: 'also restored', amount: '2.00', createdAt: at },
        ],
        { columns: ['id', 'label', 'amount', 'createdAt'] },
      )
      const rows = await db.sql`
        select id::int as id, label from pgprime_pg_copy.ledger order by id
      `.execute()
      expect(rows.map((r) => Number(r['id']))).toStrictEqual([900, 901])

      // …and a NARROWER explicit list is how a database default gets to apply: a column left out
      // of the statement is defaulted by COPY, where a column left IN with no key goes out as `\N`.
      await db.copyFrom(ledger, [{ label: 'defaulted', amount: '3.00' }], {
        columns: ['label', 'amount'],
      })
      const [fresh] = await db.sql`
        select created_at is not null as has_default
        from pgprime_pg_copy.ledger where label = 'defaulted'
      `.execute()
      expect(fresh?.['has_default']).toBe(true)
    },
    120_000,
  )

  requiresConcurrency()(
    'copyTo is unaffected — it is raw SQL, and it reads the generated columns straight back',
    async () => {
      await clear()
      await db.copyFrom(ledger, [
        { label: 'out', amount: '5.00', createdAt: new Date('2026-08-30T09:00:00.000Z') },
      ])
      const lines: string[] = []
      for await (const line of db.copyTo.lines(
        `copy (select label, amount, doubled from ${NS}.ledger order by id) to stdout with (format csv)`,
      )) {
        lines.push(line)
      }
      expect(lines).toStrictEqual(['out,5.00,10.00'])
    },
    120_000,
  )
})

void liveTarget
