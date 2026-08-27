/**
 * Set operations and window functions against a real server (design/09 WS4, tier 1).
 *
 * Every case has a **hand-written SQL oracle** in this file, executed through `raw()`, and the two
 * result sets must be `toStrictEqual`. That is the only kind of check worth making for these two
 * features: their SQL is easy to emit plausibly and wrong, and both failure modes are silent —
 * a `UNION` that de-duplicates when it should not, a frame that sums the whole partition instead
 * of the rows so far.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectTypeOf } from 'expect-type'
import { textCodec } from '../../src/codec/index.js'
import * as q from '../../src/query/types.js'
import { makeLiveDb, type LiveDb } from './_db.js'

let live: LiveDb

beforeAll(async () => {
  live = await makeLiveDb('pgprime_q_setop')
}, 120_000)

afterAll(async () => {
  await live?.end()
})

const h = () => live.fx.schema.h
const ns = () => live.fx.ns

describe('§2.8 — set operations', () => {
  const emails = () =>
    live.db.from(h().users).select(({ users: u }) => ({ v: u.email, kind: q.val('user', textCodec) }))
  const titles = () =>
    live.db.from(h().posts).select(({ posts: p }) => ({ v: p.title, kind: q.val('post', textCodec) }))

  it('union all keeps duplicates; union removes them', async () => {
    const all = await emails().unionAll(emails()).orderBy((r) => q.asc(r.v)).execute()
    const distinct = await emails().union(emails()).orderBy((r) => q.asc(r.v)).execute()
    expectTypeOf(all).toEqualTypeOf<{ v: string; kind: string }[]>()
    expect(all).toHaveLength(12)
    expect(distinct).toHaveLength(6)

    const oracle = await live.raw(
      `select v, kind from (
         select email as v, 'user' as kind from ${ns()}.users
         union all
         select email as v, 'user' as kind from ${ns()}.users
       ) x order by v asc`,
    )
    expect(all).toStrictEqual(oracle.map(([v, kind]) => ({ v, kind })))
  })

  it('union all across two tables, ordered and limited on the WHOLE result', async () => {
    const rows = await emails().unionAll(titles()).orderBy((r) => [q.asc(r.v)]).limit(4).execute()
    const oracle = await live.raw(
      `select v, kind from (
         select email as v, 'user' as kind from ${ns()}.users
         union all
         select title as v, 'post' as kind from ${ns()}.posts
       ) x order by v asc limit 4`,
    )
    expect(rows).toStrictEqual(oracle.map(([v, kind]) => ({ v, kind })))
    expect(rows).toHaveLength(4)
  })

  it('intersect and except', async () => {
    const admins = live.db
      .from(h().users)
      .select(({ users: u }) => ({ v: u.email }))
      .where(({ users: u }) => q.eq(u.role, 'member'))
    const alive = live.db
      .from(h().users)
      .select(({ users: u }) => ({ v: u.email }))
      .where(({ users: u }) => q.isNull(u.deletedAt))

    const both = await admins.intersect(alive).orderBy((r) => q.asc(r.v)).execute()
    const only = await alive.except(admins).orderBy((r) => q.asc(r.v)).execute()

    const oracleBoth = await live.raw(
      `select email from ${ns()}.users where role = 'member'
       intersect select email from ${ns()}.users where deleted_at is null order by 1`,
    )
    const oracleOnly = await live.raw(
      `select email from ${ns()}.users where deleted_at is null
       except select email from ${ns()}.users where role = 'member' order by 1`,
    )
    expect(both).toStrictEqual(oracleBoth.map(([v]) => ({ v })))
    expect(only).toStrictEqual(oracleOnly.map(([v]) => ({ v })))
    expect(both.length).toBeGreaterThan(0)
    expect(only.length).toBeGreaterThan(0)
  })

  it('a branch with its own limit is parenthesised, and PostgreSQL agrees', async () => {
    const rows = await emails()
      .unionAll(titles().limit(2))
      .orderBy((r) => q.asc(r.v))
      .execute()
    expect(rows).toHaveLength(8)
  })

  it('a set operation feeds a CTE, codecs intact', async () => {
    const rows = await live.db
      .with('both', () => emails().unionAll(titles()))
      .fromCte('both')
      .select(({ both: b }) => ({ v: b.v, kind: b.kind }))
      .orderBy(({ both: b }) => q.asc(b.v))
      .limit(2)
      .execute()
    expectTypeOf(rows).toEqualTypeOf<{ v: string; kind: string }[]>()
    expect(rows).toHaveLength(2)
  })
})

describe('§2.8 — window functions', () => {
  it('row_number over a partition, against a hand-written oracle', async () => {
    const rows = await live.db
      .from(h().posts)
      .select(({ posts: p }) => ({
        title: p.title,
        n: q.over(q.fn.rowNumber(), (w) => w.partitionBy(p.authorId).orderBy([q.desc(p.createdAt), q.asc(p.id)])),
      }))
      .orderBy(({ posts: p }) => [q.asc(p.authorId), q.desc(p.createdAt), q.asc(p.id)])
      .execute()

    expectTypeOf(rows).toEqualTypeOf<{ title: string; n: bigint }[]>()
    const oracle = await live.raw(
      `select title, row_number() over (partition by author_id order by created_at desc, id asc)
       from ${ns()}.posts order by author_id asc, created_at desc, id asc`,
    )
    expect(rows).toStrictEqual(oracle.map(([title, n]) => ({ title, n: BigInt(n!) })))
  })

  it('a running total needs the frame, and the frame is what we emit', async () => {
    const rows = await live.db
      .from(h().posts)
      .select(({ posts: p }) => ({
        title: p.title,
        run: q.over(q.fn.sum(p.amount), (w) =>
          w
            .partitionBy(p.authorId)
            .orderBy([q.asc(p.createdAt), q.asc(p.id)])
            .rows({ from: 'unbounded preceding', to: 'current row' }),
        ),
        whole: q.over(q.fn.sum(p.amount), (w) => w.partitionBy(p.authorId)),
      }))
      .orderBy(({ posts: p }) => [q.asc(p.authorId), q.asc(p.createdAt), q.asc(p.id)])
      .execute()

    const oracle = await live.raw(
      `select title,
              sum(amount) over (partition by author_id order by created_at asc, id asc
                                rows between unbounded preceding and current row),
              sum(amount) over (partition by author_id)
       from ${ns()}.posts order by author_id asc, created_at asc, id asc`,
    )
    expect(rows).toStrictEqual(oracle.map(([title, run, whole]) => ({ title, run, whole })))
    // R4: the frame is doing work — a running total is NOT the partition total.
    expect(rows.some((r) => r.run !== r.whole)).toBe(true)
  })

  it('a named window is shared by several projection items', async () => {
    const rows = await live.db
      .from(h().posts)
      .select(({ posts: p }) => ({
        title: p.title,
        r: q.over(q.fn.rank(), 'byAuthor'),
        d: q.over(q.fn.denseRank(), 'byAuthor'),
      }))
      .window('byAuthor', ({ posts: p }) => ({
        partitionBy: [p.authorId],
        orderBy: [q.desc(p.amount)],
      }))
      .orderBy(({ posts: p }) => [q.asc(p.authorId), q.desc(p.amount)])
      .execute()

    expectTypeOf(rows).toEqualTypeOf<{ title: string; r: bigint; d: bigint }[]>()
    const oracle = await live.raw(
      `select title, rank() over w, dense_rank() over w from ${ns()}.posts
       window w as (partition by author_id order by amount desc)
       order by author_id asc, amount desc`,
    )
    expect(rows).toStrictEqual(oracle.map(([title, r, d]) => ({ title, r: BigInt(r!), d: BigInt(d!) })))
  })

  it('a numeric offset frame', async () => {
    const rows = await live.db
      .from(h().posts)
      .select(({ posts: p }) => ({
        title: p.title,
        near: q.over(q.fn.count(p.id), (w) =>
          w.orderBy(q.asc(p.id)).rows({ from: { preceding: 1 }, to: { following: 1 } }),
        ),
      }))
      .orderBy(({ posts: p }) => q.asc(p.id))
      .execute()
    const oracle = await live.raw(
      `select title, count(id) over (order by id asc rows between 1 preceding and 1 following)
       from ${ns()}.posts order by id asc`,
    )
    expect(rows).toStrictEqual(oracle.map(([title, n]) => ({ title, near: BigInt(n!) })))
    expect(rows[0]!.near).toBe(2n)
  })
})

describe('§2.8 × §2.7 — a set-operation branch that carries a WITH', () => {
  it('executes on either side, and returns the union of the two branches', async () => {
    // `… union with "recent" as (…) select …` is 42601; the branch has to be parenthesised, and
    // the CTE therefore has to stay inside the branch that references it. Both directions are
    // executed because only one of them is the shape the compiler used to get wrong.
    const withCte = live.db.with('recent', (d) =>
      d
        .from(h().posts)
        .select(({ posts: p }) => ({ id: p.id }))
        .where(({ posts: p }) => q.isTrue(p.published)),
    )
    const cteSide = () => withCte.fromCte('recent').select(({ recent: r }) => ({ id: r.id }))
    const plain = () =>
      live.db
        .from(h().posts)
        .select(({ posts: p }) => ({ id: p.id }))
        .where(({ posts: p }) => q.isFalse(p.published))

    // The oracle: the same two sets, hand-written, with no CTE at all.
    const expected = await live.raw(
      `select id::text from ${ns()}.posts where published
       union
       select id::text from ${ns()}.posts where not published
       order by 1`,
    )

    for (const built of [cteSide().union(plain()), plain().union(cteSide())]) {
      const rows = await built.orderBy((r) => q.asc(r.id)).execute()
      expect(rows.map((r) => [String(r.id)])).toStrictEqual(expected)
    }
    expect(expected.length).toBeGreaterThan(1)
  })
})

