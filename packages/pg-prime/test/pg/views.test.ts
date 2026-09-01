/**
 * `REFRESH MATERIALIZED VIEW`, tier 2 (design/01 §3 row 58; design/14 §0's W row).
 *
 * Two things tier 1 cannot state, and both are the reason this file exists:
 *
 *  1. **The statement that reaches the server is observable.** The helper is one line of SQL, so
 *     "it worked" is not evidence — a `REFRESH` that silently dropped `CONCURRENTLY` would pass
 *     every functional assertion in `test/live-query/views.test.ts`. The statement log
 *     (`db.observe({ onQueryStart })`, `07` §7.1) is the oracle: the exact text, with and without
 *     the keyword, is asserted there.
 *  2. **`concurrently` without a unique index is the server's error, mapped and rethrown.** PG
 *     answers `55000` (`RefreshMatViewByOid`, matview.c) and the promise rejects with a
 *     `PgPrimeError` carrying that SQLSTATE. It never quietly falls back to a blocking refresh,
 *     which is the failure mode that would matter: a `CONCURRENTLY` refresh that takes an ACCESS
 *     EXCLUSIVE lock is an outage, not a slow query.
 *
 * Unguarded on purpose: neither claim needs a second backend, so the file also runs on PGlite
 * during `pnpm test:pg` without `PG_PRIME_TEST_URL` and states the same two facts there.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pgDriver } from '../../src/driver/index.js'
import type { PgDriver, PgLikePool } from '../../src/driver/index.js'
import { sqlStateOfError } from '../../src/errors/index.js'
import { pgPrime } from '../../src/query/run.js'
import type { Db } from '../../src/query/types.js'
import { defineSchema, pgMaterializedView, pgTable } from '../../src/schema/index.js'
import { sql } from '../../src/sql/index.js'
import { makePool } from '../live/_harness.js'

const NS = 'pgprime_pg_views'

const readings = pgTable(
  'readings',
  (t) => ({
    id: t.integer().primaryKey(),
    sensor: t.text(),
    value: t.integer(),
  }),
  undefined,
  { schema: NS },
)

/** Has a unique index, so `CONCURRENTLY` is available. */
const perSensor = pgMaterializedView('per_sensor', { schema: NS })
  .columns((t) => ({ sensor: t.text(), total: t.bigint() }))
  .refreshable({ concurrently: true })
  .as(sql`select sensor, sum(value) from ${sql.ident(NS, 'readings')} group by 1`)

/** Deliberately has none: this is the `55000` case. */
const noIndex = pgMaterializedView('no_index', { schema: NS })
  .columns((t) => ({ n: t.bigint() }))
  .as(sql`select count(*) from ${sql.ident(NS, 'readings')}`)

const schema = defineSchema({ readings })

const DDL = `
create schema ${NS};
create table ${NS}.readings (id integer primary key, sensor text not null, value integer not null);
insert into ${NS}.readings values (1, 'a', 10), (2, 'a', 5), (3, 'b', 7);
create materialized view ${NS}.per_sensor ("sensor","total") as
  select sensor, sum(value) from ${NS}.readings group by 1;
create unique index per_sensor_pk on ${NS}.per_sensor ("sensor");
create materialized view ${NS}.no_index ("n") as select count(*) from ${NS}.readings;
`

let driver: PgDriver
let db: Db<typeof schema>

beforeAll(async () => {
  driver = pgDriver({ pool: makePool(2) as unknown as PgLikePool })
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

/** Every statement this handle dispatched while `f` ran. */
async function statements(f: () => Promise<void>): Promise<string[]> {
  const seen: string[] = []
  const off = db.observe({ onQueryStart: (e) => seen.push(e.sql) })
  try {
    await f()
  } finally {
    off()
  }
  return seen
}

describe('REFRESH MATERIALIZED VIEW reaches the server verbatim', () => {
  it('emits CONCURRENTLY when the declaration asked for it', async () => {
    const seen = await statements(() => db.refreshMaterializedView(perSensor))
    expect(seen).toEqual([`refresh materialized view concurrently "${NS}"."per_sensor"`])
  })

  it('emits a plain refresh when the call overrides the declaration', async () => {
    const seen = await statements(() =>
      db.refreshMaterializedView(perSensor, { concurrently: false }),
    )
    expect(seen).toEqual([`refresh materialized view "${NS}"."per_sensor"`])
  })

  it('emits a plain refresh for a matview that never declared one', async () => {
    const seen = await statements(() => db.refreshMaterializedView(noIndex))
    expect(seen).toEqual([`refresh materialized view "${NS}"."no_index"`])
  })

  it('actually refreshes: the snapshot follows the base table', async () => {
    const total = async (): Promise<bigint> => {
      const rows = await db
        .from(perSensor)
        .select((t) => ({ total: t.per_sensor.total }))
        .execute()
      return rows.reduce((a, r) => a + r.total, 0n)
    }
    expect(await total()).toBe(22n)
    await db.insertInto(db.h.readings).values({ id: 4, sensor: 'a', value: 3 }).execute()
    expect(await total()).toBe(22n)
    await db.refreshMaterializedView(perSensor)
    expect(await total()).toBe(25n)
  })
})

describe('CONCURRENTLY without a unique index', () => {
  it('is the server`s 55000, mapped and rethrown — never a silent blocking refresh', async () => {
    const seen: string[] = []
    const off = db.observe({ onQueryStart: (e) => seen.push(e.sql) })
    try {
      await expect(
        db.refreshMaterializedView(noIndex, { concurrently: true }),
      ).rejects.toMatchObject({ name: expect.stringMatching(/Error$/) })
    } finally {
      off()
    }
    // One statement, and it carried the keyword: nothing retried it without.
    expect(seen).toEqual([`refresh materialized view concurrently "${NS}"."no_index"`])

    const err = await db
      .refreshMaterializedView(noIndex, { concurrently: true })
      .then(() => undefined)
      .catch((e: unknown) => e)
    expect(sqlStateOfError(err)).toBe('55000')
    expect(String((err as Error).message)).toMatch(/concurrently/i)
  })
})
