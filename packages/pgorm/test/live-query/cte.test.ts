/**
 * CTEs, including writable ones, against a real server (design/09 WS4, tier 1).
 *
 * `03` §2.7's archive-and-move is the case worth executing rather than compiling: it is one
 * statement that *deletes from one table and inserts into another*, and the only way to know it
 * did both is to count the rows afterwards with a query that shares no code with it. So both
 * assertions here are raw `select count(*)`.
 *
 * `staging` and `live` are declared in this file rather than in the shared fixture, next to the
 * DDL that creates them, for the same R5 reason the fixture pairs its own two halves.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectTypeOf } from 'expect-type'
import * as q from '../../src/query/types.js'
import { defineSchema, pgTable } from '../../src/schema/index.js'
import { makeLiveDb, type LiveDb } from './_db.js'

let live: LiveDb

const NS = 'pgorm_q_cte'

const staging = pgTable(
  'staging',
  (t) => ({
    id: t.bigint().primaryKey().generatedAlways(),
    payload: t.jsonb(),
    at: t.timestamptz(),
    ready: t.boolean(),
  }),
  undefined,
  { schema: NS },
)

const liveTable = pgTable(
  'live',
  (t) => ({
    id: t.bigint().primaryKey().generatedAlways(),
    payload: t.jsonb(),
    at: t.timestamptz(),
  }),
  undefined,
  { schema: NS },
)

const moveSchema = defineSchema({ staging, live: liveTable })

const DDL = `
create table ${NS}.staging (
  id      bigint generated always as identity primary key,
  payload jsonb not null,
  at      timestamptz not null,
  ready   boolean not null
);
create table ${NS}.live (
  id      bigint generated always as identity primary key,
  payload jsonb not null,
  at      timestamptz not null
);
insert into ${NS}.staging (payload, at, ready) values
  ('{"n":1}', '2026-05-01T00:00:00Z', true),
  ('{"n":2}', '2026-05-02T00:00:00Z', true),
  ('{"n":3}', '2026-05-03T00:00:00Z', false);
`

beforeAll(async () => {
  live = await makeLiveDb(NS)
  await live.conn.execute({ text: DDL, params: [], mode: 'simple' })
}, 120_000)

afterAll(async () => {
  await live?.end()
})

const h = () => live.fx.schema.h

describe('§2.7 — a CTE is a table handle', () => {
  it('codecs flow through, and the CTE joins like any other source', async () => {
    const rows = await live.db
      .with('recent', (d) =>
        d
          .from(h().posts)
          .select(({ posts: p }) => ({ id: p.id, authorId: p.authorId, amount: p.amount }))
          .where(({ posts: p }) => q.gt(p.createdAt, new Date('2026-02-01T00:00:00Z'))),
      )
      .fromCte('recent', 'r')
      .innerJoin(h().users, 'u', ({ r, u }) => q.eq(r.authorId, u.id))
      .select(({ r, u }) => ({ email: u.email, total: q.fn.sum(r.amount) }))
      .groupBy(({ u }) => [u.email])
      .having(({ r }) => q.gt(q.fn.sum(r.amount), '0'))
      .orderBy(({ u }) => q.asc(u.email))
      .execute()

    // `numeric` decoded to a precision-exact string, five clauses from the column it came from.
    //
    // The declared type is the union of every numeric `sum` result, not `string`: a CTE ref's PG
    // type class is `any` (03 §2.7's amendment, kept in WS4 — see `test/query/types/cte.probe.ts`),
    // so `SumOut<P>` cannot narrow. The *value* is exact regardless, which is what this asserts.
    expectTypeOf(rows).toEqualTypeOf<{ email: string; total: string | number | bigint | null }[]>()
    const oracle = await live.raw(
      `select u.email, sum(r.amount)::text from (
         select id, author_id, amount from ${live.fx.ns}.posts
         where created_at > timestamptz '2026-02-01 00:00:00+00'
       ) r join ${live.fx.ns}.users u on r.author_id = u.id
       group by u.email having sum(r.amount) > 0 order by u.email asc`,
    )
    expect(rows).toStrictEqual(oracle.map((r) => ({ email: r[0], total: r[1] })))
    expect(rows.length).toBeGreaterThan(0)
  })

  it('MATERIALIZED is a planner hint and nothing more — same rows either way', async () => {
    const run = (materialized: boolean) =>
      live.db
        .with(
          'x',
          (d) => d.from(h().posts).select(({ posts: p }) => ({ id: p.id, title: p.title })),
          { materialized },
        )
        .fromCte('x')
        .select(({ x }) => ({ title: x.title }))
        .orderBy(({ x }) => q.asc(x.id))
        .execute()
    expect(await run(true)).toStrictEqual(await run(false))
  })
})

describe('Appendix A — archive and move, in one statement', () => {
  it('leaves staging with only the not-ready row and live with the rest', async () => {
    const db = live.dbFor(moveSchema)
    const before = await live.raw(`select count(*) from ${NS}.staging`)
    expect(before).toStrictEqual([['3']])

    const rows = await db
      .with('moved', (d) =>
        d
          .deleteFrom(moveSchema.h.staging)
          .where(({ staging: s }) => s.ready)
          .returning(({ staging: s }) => ({ payload: s.payload, at: s.at })),
      )
      .insertInto(moveSchema.h.live)
      .fromSelect((d) =>
        d.fromCte('moved').select(({ moved: m }) => ({ payload: m.payload, at: m.at })),
      )
      .returning(({ live: l }) => ({ id: l.id }))
      .execute()

    expectTypeOf(rows).toEqualTypeOf<{ id: bigint }[]>()
    expect(rows).toHaveLength(2)

    // The oracle: raw counts, sharing no code with the statement above.
    expect(await live.raw(`select count(*) from ${NS}.staging`)).toStrictEqual([['1']])
    expect(await live.raw(`select ready from ${NS}.staging`)).toStrictEqual([['f']])
    expect(
      await live.raw(`select payload, at from ${NS}.live order by at`),
    ).toStrictEqual([
      ['{"n": 1}', '2026-05-01 00:00:00+00'],
      ['{"n": 2}', '2026-05-02 00:00:00+00'],
    ])
  })

  it('a writable CTE runs even when nothing references it', async () => {
    // PostgreSQL: "data-modifying statements in WITH are executed exactly once, and always to
    // completion, independently of whether the primary query reads their output." So an unused
    // writable CTE is NOT free — it is a delete. Pinned because the opposite is the intuitive
    // reading (this test was written asserting it, and the server disagreed).
    const db = live.dbFor(moveSchema)
    expect(await live.raw(`select count(*) from ${NS}.live`)).toStrictEqual([['2']])
    await db
      .with('unused', (d) =>
        d.deleteFrom(moveSchema.h.live).allRows().returning(({ live: l }) => ({ id: l.id })),
      )
      .from(moveSchema.h.live)
      .select(({ live: l }) => ({ id: l.id }))
      .execute()
    expect(await live.raw(`select count(*) from ${NS}.live`)).toStrictEqual([['0']])
  })
})

describe('§2.7 — a chained .with() does not nest the earlier CTEs', () => {
  it('a WRITABLE first CTE followed by a second one executes (it used to be 0A000)', async () => {
    // The second callback's executor carries `moved` so `d.cte.moved` resolves — but the
    // statement it built copied that list into its own WITH, nesting a data-modifying CTE inside
    // another CTE's body. PostgreSQL: `0A000 WITH clause containing a data-modifying statement
    // must be at the top level`. The oracle is a raw count of what actually moved.
    const db = live.dbFor(moveSchema)
    await live.conn.execute({
      text: `insert into ${NS}.staging (payload, at, ready) values ('{"n":9}', '2026-05-09T00:00:00Z', true)`,
      params: [],
      mode: 'simple',
    })
    const before = await live.raw(`select count(*) from ${NS}.staging where ready`)

    const rows = await db
      .with('moved', (d) =>
        d
          .deleteFrom(moveSchema.h.staging)
          .where(({ staging: s }) => q.isTrue(s.ready))
          .returning(({ staging: s }) => ({ id: s.id, payload: s.payload })),
      )
      .with('counted', (d) => d.fromCte('moved').select(({ moved: m }) => ({ id: m.id })))
      .fromCte('counted')
      .select(({ counted: c }) => ({ id: c.id }))
      .execute()

    expect(rows).toHaveLength(Number(before[0]![0]))
    expect(await live.raw(`select count(*) from ${NS}.staging where ready`)).toStrictEqual([['0']])
  })

  it('each CTE body declares only itself', async () => {
    const db = live.dbFor(moveSchema)
    const sql = db
      .with('a', (d) => d.from(moveSchema.h.live).select(({ live: l }) => ({ id: l.id })))
      .with('b', (d) => d.fromCte('a').select(({ a }) => ({ id: a.id })))
      .fromCte('b')
      .select(({ b }) => ({ id: b.id }))
      .compile().sql
    expect(sql.match(/with "a" as \(/g)).toHaveLength(1)
    expect(sql.match(/"b" as \(/g)).toHaveLength(1)
  })
})

