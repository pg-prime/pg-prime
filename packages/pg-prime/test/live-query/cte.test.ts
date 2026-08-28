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
import { int4Codec, int8Codec, jsonbCodec, textCodec } from '../../src/codec/index.js'
import { defineSchema, pgTable } from '../../src/schema/index.js'
import { sqlState } from '../live/_harness.js'
import { FIRST_POST_ID } from '../live/fixture.js'
import { makeLiveDb, type LiveDb } from './_db.js'

let live: LiveDb

const NS = 'pgprime_q_cte'

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

  it('each CTE body declares only itself', () => {
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


// ─────────────────────────────────────────────────────────────────────────────
// withRecursive / fromRaw against the server (12 B; decision 17, `03` §5)
// ─────────────────────────────────────────────────────────────────────────────

describe('§2.7 — withRecursive (12 B)', () => {
  /**
   * A counter is the smallest recursive query that can be wrong in an interesting way, and the
   * fixture has no self-referencing tree — so the base term is a `VALUES`-shaped select over
   * `generate_series`, reached through `fromRaw`. Two of `12` B's items in one statement.
   */
  const counter = (limit: number) =>
    live.db.withRecursive(
      'n',
      (d) => d.fromRaw(q.sql`(select 1)`, { i: int4Codec }, { alias: 'seed' }).select(({ seed }) => ({ i: seed.i })),
      (d, self) =>
        d
          .from(self)
          .where(({ n }) => q.lt(n.i, limit))
          .select(({ n }) => ({ i: q.add(n.i, 1) })),
    )

  it('R3: it recurses, and the rows are what a hand-written WITH RECURSIVE returns', async () => {
    const rows = await counter(5)
      .fromCte('n')
      .select(({ n }) => ({ i: n.i }))
      .orderBy(({ n }) => q.asc(n.i))
      .execute()
    expectTypeOf(rows).toEqualTypeOf<{ i: number }[]>()
    const oracle = await live.raw(
      `with recursive n(i) as (select 1 union all select i + 1 from n where i < 5)
       select i from n order by i`,
    )
    expect(rows).toStrictEqual(oracle.map(([i]) => ({ i: Number(i) })))
    expect(rows).toStrictEqual([{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }, { i: 5 }])
  })

  it('the row type and the codecs come from the base term, past 2^53', async () => {
    const rows = await live.db
      .withRecursive(
        'big',
        (d) =>
          d
            .fromRaw(q.sql`(select ${q.val(FIRST_POST_ID, int8Codec)}::int8)`, { v: int8Codec }, { alias: 's' })
            .select(({ s }) => ({ v: s.v })),
        (d, self) =>
          d
            .from(self)
            .where(({ big }) => q.lt(big.v, FIRST_POST_ID + 2n))
            .select(({ big }) => ({ v: q.add(big.v, 1n) })),
      )
      .fromCte('big')
      .select(({ big }) => ({ v: big.v }))
      .orderBy(({ big }) => q.asc(big.v))
      .execute()
    expectTypeOf(rows).toEqualTypeOf<{ v: bigint }[]>()
    // A JSON-number round trip would have lost the last digit of every one of these.
    expect(rows).toStrictEqual([
      { v: FIRST_POST_ID },
      { v: FIRST_POST_ID + 1n },
      { v: FIRST_POST_ID + 2n },
    ])
  })

  it('{ unionAll: false } deduplicates — the same query, two answers', async () => {
    const build = (unionAll: boolean) =>
      live.db
        .withRecursive(
          'n',
          (d) => d.fromRaw(q.sql`(select 1)`, { i: int4Codec }, { alias: 's' }).select(({ s }) => ({ i: s.i })),
          (d, self) =>
            d
              .from(self)
              .where(({ n }) => q.lt(n.i, 3))
              .select(({ n }) => ({ i: q.sub(q.add(n.i, 2), 1) })),
          { unionAll },
        )
        .fromCte('n')
        .select(({ n }) => ({ i: n.i }))
        .orderBy(({ n }) => q.asc(n.i))
    expect((await build(true).execute()).map((r) => r.i)).toStrictEqual([1, 2, 3])
    expect((await build(false).execute()).map((r) => r.i)).toStrictEqual([1, 2, 3])
    // …and the plan really does carry the keyword the option chose.
    expect(build(true).compile().sql).toContain('union all')
    expect(build(false).compile().sql).not.toContain('union all')
  })
})

describe('§5 — fromRaw (12 B)', () => {
  it('R3: a set-returning function, decoded through the declared codecs', async () => {
    const rows = await live.db
      // `generate_series(int, int)` returns int4; the int8 overload is what `int8Codec` declares,
      // and `assertShape` refuses the mismatch rather than decoding an int4 as an int8 (WS6).
      .fromRaw(
        q.sql`generate_series(${q.val(1n, int8Codec)}, ${q.val(3n, int8Codec)})`,
        { n: int8Codec },
        { alias: 'g' },
      )
      .select(({ g }) => ({ n: g.n }))
      .orderBy(({ g }) => q.asc(g.n))
      .execute()
    expectTypeOf(rows).toEqualTypeOf<{ n: bigint }[]>()
    expect(rows).toStrictEqual([{ n: 1n }, { n: 2n }, { n: 3n }])
    const oracle = await live.raw('select n from generate_series(1, 3) as g(n) order by n')
    expect(rows).toStrictEqual(oracle.map(([n]) => ({ n: BigInt(n as string) })))
  })

  it('{ columnTypes: true } is what makes jsonb_to_recordset work at all', async () => {
    const doc = [
      { id: '9007199254740993', name: 'a' },
      { id: '9007199254740994', name: 'b' },
    ]
    const built = live.db
      .fromRaw(
        q.sql`jsonb_to_recordset(${q.val(doc, jsonbCodec)})`,
        { id: int8Codec, name: textCodec },
        { alias: 'j', columnTypes: true },
      )
      .select(({ j }) => ({ id: j.id, name: j.name }))
      .orderBy(({ j }) => q.asc(j.id))
    const rows = await built.execute()
    expectTypeOf(rows).toEqualTypeOf<{ id: bigint; name: string }[]>()
    expect(rows).toStrictEqual([
      { id: 9007199254740993n, name: 'a' },
      { id: 9007199254740994n, name: 'b' },
    ])
    // R4 — without the definition list the same statement is a 42601: a function returning
    // `record` must be told its column types, which is the whole reason the option exists.
    await expect(
      live.db
        .fromRaw(q.sql`jsonb_to_recordset(${q.val(doc, jsonbCodec)})`, { id: int8Codec, name: textCodec })
        .select(({ raw }) => ({ id: raw.id }))
        .execute(),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === '42601')
  })

  it('it joins against a real table, and the alias list renames the columns', async () => {
    const rows = await live.db
      .fromRaw(q.sql`generate_series(1::int8, 3::int8)`, { wanted: int8Codec }, { alias: 'g' })
      .innerJoin(h().tags, 't', ({ g, t }) => q.eq(t.id, g.wanted))
      .select(({ g, t }) => ({ wanted: g.wanted, name: t.name }))
      .orderBy(({ g }) => q.asc(g.wanted))
      .execute()
    expectTypeOf(rows).toEqualTypeOf<{ wanted: bigint; name: string }[]>()
    const oracle = await live.raw(
      `select g.wanted, t.name from generate_series(1::int8, 3::int8) as g(wanted)
         join ${live.fx.ns}.tags t on t.id = g.wanted order by g.wanted`,
    )
    expect(rows).toStrictEqual(
      oracle.map(([wanted, name]) => ({ wanted: BigInt(wanted as string), name })),
    )
  })
})
