/**
 * The SELECT builder against a real server, tier 1 (design/09 WS4).
 *
 * R3 everywhere: **every assertion pairs a static type with a runtime value on the same
 * expression**. `expectTypeOf(rows).toEqualTypeOf<…>()` and `expect(rows).toStrictEqual([…])`,
 * with the literal on the right written in the JavaScript type the type promises. That single
 * rule is what makes "the type says `bigint`, production says `'123'`" impossible to ship, and it
 * is the reason these tests are worth more than the tier-0 goldens they duplicate.
 *
 * The value traps `09` WS4 names by hand, each of which a plausible implementation gets wrong:
 *
 *  - the `limit` bind is `int4`, not `text` (an untyped `$n` there plans differently);
 *  - `order by createdAt desc, id asc` must tiebreak deterministically — the fixture has two
 *    posts with the SAME `created_at` to the microsecond, so a cursor built on the timestamp
 *    alone silently skips rows;
 *  - a left join that misses returns `null` for the WHOLE nested object, not `{ id: null }`;
 *  - two joined tables both exposing `id` and `created_at` decode positionally without clobber —
 *    the fixture guarantees the collision.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectTypeOf } from 'expect-type'
import { textCodec } from '../../src/codec/index.js'
import * as q from '../../src/query/types.js'
import { pgMajor, sqlState } from '../live/_harness.js'
import { FIRST_POST_ID } from '../live/fixture.js'
import { assertPlans, makeLiveDb, type LiveDb } from './_db.js'

let live: LiveDb

beforeAll(async () => {
  live = await makeLiveDb('pgprime_q_select')
}, 120_000)

afterAll(async () => {
  await live?.end()
})

const h = () => live.fx.schema.h

/**
 * PostgreSQL's own `timestamptz` text (`2026-03-01 00:00:00+00`) as a `Date`, spelled out here
 * rather than reached for through `timestamptzCodec` — an oracle that ran our decoder would be
 * comparing the implementation with itself (R1). The codec's own correctness is
 * `test/live-query/codec-seam.test.ts`'s subject, not this file's.
 */
const pgTs = (raw: string): Date =>
  new Date(raw.replace(' ', 'T').replace(/([+-])(\d\d)$/, '$1$2:00'))

describe('§2.1 — select / where / order / limit', () => {
  it('R3: the promised types are the values that come back', async () => {
    const rows = await live.db
      .from(h().users)
      .select(({ users: u }) => ({ id: u.id, email: u.email, joined: u.createdAt }))
      .where(({ users: u }) => q.and(q.isNull(u.deletedAt), q.inList(u.role, ['admin', 'owner'])))
      .orderBy(({ users: u }) => [q.desc(u.createdAt), q.asc(u.id)])
      .limit(20)
      .execute()

    expectTypeOf(rows).toEqualTypeOf<{ id: bigint; email: string; joined: Date }[]>()
    expect(rows).toStrictEqual([
      { id: 1n, email: 'ada@example.com', joined: new Date('2026-01-01T00:00:00.000001Z') },
    ])
  })

  it('the limit bind is int4 — the declared parameter type reaches Parse', async () => {
    const compiled = live.db
      .from(h().users)
      .select(({ users: u }) => ({ id: u.id }))
      .limit(3)
      .compile()
    expect(compiled.binds).toStrictEqual([{ k: 'value', encoded: '3', oid: 23 }])
    // …and PostgreSQL accepts it, which `limit $1::text` would not.
    expect(
      await live.db
        .from(h().users)
        .select(({ users: u }) => ({ id: u.id }))
        .limit(3)
        .execute(),
    ).toHaveLength(3)
  })

  it('the tiebreak is deterministic — two posts share created_at to the microsecond', async () => {
    const titles = async (withTiebreak: boolean) => {
      const base = live.db
        .from(h().posts)
        .select(({ posts: p }) => ({ title: p.title, id: p.id, at: p.createdAt }))
      const ordered = withTiebreak
        ? base.orderBy(({ posts: p }) => [q.desc(p.createdAt), q.asc(p.id)])
        : base.orderBy(({ posts: p }) => q.desc(p.createdAt))
      return (await ordered.execute()).map((r) => r.title)
    }
    // Both `tie-a` and `tie-b` sit at 2026-02-02T10:00:00.123456Z, so the timestamp alone does
    // not order them. The oracle is a hand-written query with the same ORDER BY.
    const oracle = await live.raw(
      `select title from ${live.fx.ns}.posts order by created_at desc, id asc`,
    )
    expect(await titles(true)).toStrictEqual(oracle.map((r) => r[0]))
    // The tie is real — two rows share the microsecond — so the id tiebreak is doing work…
    const tied = await live.raw(
      `select count(*) from ${live.fx.ns}.posts group by created_at having count(*) > 1`,
    )
    expect(tied).toStrictEqual([['2']])
    // …and the builder's order is stable across runs, which the timestamp alone would not be.
    expect(await titles(true)).toStrictEqual(await titles(true))
    expect(await titles(false)).toHaveLength(6)
  })

  it('selectAll decodes every column at its declared type', async () => {
    const rows = await live.db
      .from(h().users)
      .selectAll('users')
      .where(({ users: u }) => q.eq(u.email, 'bob@example.com'))
      .execute()

    expectTypeOf(rows[0]!.balance).toEqualTypeOf<string>()
    expectTypeOf(rows[0]!.tags).toEqualTypeOf<string[]>()
    expectTypeOf(rows[0]!.role).toEqualTypeOf<'admin' | 'owner' | 'member'>()
    expect(rows).toStrictEqual([
      {
        id: 2n,
        email: 'bob@example.com',
        name: 'Bob',
        role: 'member',
        tags: ['beta'],
        meta: {},
        // the trailing zero survives: `10.50`, not 10.5
        balance: '10.50',
        createdAt: new Date('2026-01-02T00:00:00Z'),
        deletedAt: null,
        birthday: null,
      },
    ])
  })

  it('an empty in-list returns nothing, and costs no parameter', async () => {
    const built = live.db
      .from(h().users)
      .select(({ users: u }) => ({ id: u.id }))
      .where(({ users: u }) => q.inList(u.id, []))
    expect(built.compile().binds).toStrictEqual([])
    expect(await built.execute()).toStrictEqual([])
  })
})

describe('§2.2 — joins, nest, and the positional decoder', () => {
  it('two joined tables both exposing id/created_at do not clobber', async () => {
    // The fixture assigns identity ids through a join, so which id a title got is not fixed.
    // The oracle names the same rows a different way, which is the point of having one.
    const oracle = await live.raw(
      `select p.id, p.created_at, c.id, c.created_at from ${live.fx.ns}.posts p ` +
        `join ${live.fx.ns}.comments c on c.post_id = p.id order by c.id asc`,
    )
    const rows = await live.db
      .from(h().posts)
      .innerJoin(h().comments, 'c', ({ posts: p, c }) => q.eq(c.postId, p.id))
      .select(({ posts: p, c }) => ({
        postId: p.id,
        postAt: p.createdAt,
        commentId: c.id,
        commentAt: c.createdAt,
      }))
      .orderBy(({ c }) => q.asc(c.id))
      .execute()

    expectTypeOf(rows).toEqualTypeOf<
      { postId: bigint; postAt: Date; commentId: bigint; commentAt: Date }[]
    >()
    expect(rows).toStrictEqual(
      oracle.map(([pid, pat, cid, cat]) => ({
        postId: BigInt(pid as string),
        postAt: pgTs(pat as string),
        commentId: BigInt(cid as string),
        commentAt: pgTs(cat as string),
      })),
    )
    // The collision is real: the post and the comment both have `id` and `created_at`, and the
    // three rows share ONE post — so a decoder keyed on column name would show the comment's id
    // three times, or the post's.
    expect(new Set(rows.map((r) => r.postId)).size).toBe(1)
    expect(new Set(rows.map((r) => r.commentId)).size).toBe(3)
    expect(rows.every((r) => r.postId !== r.commentId)).toBe(true)
    expect(rows.every((r) => r.postAt.getTime() !== r.commentAt.getTime())).toBe(true)
  })

  it('a left join that misses nulls the WHOLE nested object', async () => {
    const rows = await live.db
      .from(h().users)
      .leftJoin(h().posts, 'p', ({ users: u, p }) =>
        q.and(q.eq(p.authorId, u.id), q.eq(p.title, 'bobs')),
      )
      .select(({ users: u, p }) => ({
        email: u.email,
        post: q.nestNullable({ id: p.id, title: p.title }),
      }))
      .orderBy(({ users: u }) => q.asc(u.id))
      .execute()

    expectTypeOf(rows).toEqualTypeOf<
      { email: string; post: { id: bigint; title: string } | null }[]
    >()
    const bobsPostId = BigInt(
      (await live.raw(`select id from ${live.fx.ns}.posts where title = 'bobs'`))[0]![0]!,
    )
    const bob = rows.find((r) => r.email === 'bob@example.com')!
    const ada = rows.find((r) => r.email === 'ada@example.com')!
    expect(bob.post).toStrictEqual({ id: bobsPostId, title: 'bobs' })
    // Not `{ id: null, title: null }` — the whole object, so `if (r.post)` narrows usefully.
    expect(ada.post).toBeNull()
    expect(rows.filter((r) => r.post === null)).toHaveLength(5)
  })

  /**
   * T2 (audit 2026-08-26), against a real LEFT JOIN.
   *
   * The driving side is `posts`, so `p.id` is NOT NULL *and present on every row the query can
   * return* — it is not evidence that the join matched. Choosing it as the witness (which
   * "the first NOT NULL member in key order" did) made the object never null, and swapping the
   * two keys silently changed the answer. Only `u.email`, from the left-joined alias, witnesses.
   */
  it('T2: a driving-side NOT NULL column does not witness, in either key order', async () => {
    // The join matches only Ada's posts, so every other post must come back with a null group.
    const forward = await live.db
      .from(h().posts, 'p')
      .leftJoin(h().users, 'u', ({ p, u }) =>
        q.and(q.eq(p.authorId, u.id), q.eq(u.email, 'ada@example.com')),
      )
      .select(({ p, u }) => ({ pid: p.id, grp: q.nestNullable({ pid: p.id, email: u.email }) }))
      .orderBy(({ p }) => q.asc(p.id))
      .execute()

    expectTypeOf(forward).toEqualTypeOf<
      { pid: bigint; grp: { pid: bigint; email: string } | null }[]
    >()

    // Oracle: hand-written SQL through the driver, one row per post, saying whether the join hit.
    const oracle = await live.raw(
      `select p.id, u.email from ${live.fx.ns}.posts p ` +
        `left join ${live.fx.ns}.users u on p.author_id = u.id and u.email = 'ada@example.com' ` +
        `order by p.id asc`,
    )
    expect(forward).toHaveLength(oracle.length)
    // Both outcomes must actually occur, or the test proves nothing.
    expect(oracle.some((r) => r[1] !== null)).toBe(true)
    expect(oracle.some((r) => r[1] === null)).toBe(true)

    expect(forward).toStrictEqual(
      oracle.map(([id, email]) => ({
        pid: BigInt(id as string),
        grp: email === null ? null : { pid: BigInt(id as string), email },
      })),
    )

    // The same query with the group's two keys swapped must agree row for row: key order is a
    // formatting choice, and before T2 it decided nullability.
    const reversed = await live.db
      .from(h().posts, 'p')
      .leftJoin(h().users, 'u', ({ p, u }) =>
        q.and(q.eq(p.authorId, u.id), q.eq(u.email, 'ada@example.com')),
      )
      .select(({ p, u }) => ({ pid: p.id, grp: q.nestNullable({ email: u.email, pid: p.id }) }))
      .orderBy(({ p }) => q.asc(p.id))
      .execute()
    expect(reversed.map((r) => r.grp === null)).toStrictEqual(forward.map((r) => r.grp === null))
    expect(reversed.map((r) => r.grp?.email ?? null)).toStrictEqual(
      forward.map((r) => r.grp?.email ?? null),
    )
  })

  it('R4: plain nest() on the same query keeps per-field nulls', async () => {
    const rows = await live.db
      .from(h().users)
      .leftJoin(h().posts, 'p', ({ users: u, p }) =>
        q.and(q.eq(p.authorId, u.id), q.eq(p.title, 'bobs')),
      )
      .select(({ users: u, p }) => ({ email: u.email, post: q.nest({ id: p.id, title: p.title }) }))
      .where(({ users: u }) => q.eq(u.email, 'ada@example.com'))
      .execute()
    expect(rows).toStrictEqual([{ email: 'ada@example.com', post: { id: null, title: null } }])
  })

  it('nest() costs nothing: the SQL is the flat query’s, and the values agree', async () => {
    const nested = await live.db
      .from(h().posts)
      .innerJoin(h().users, 'u', ({ posts: p, u }) => q.eq(p.authorId, u.id))
      .select(({ posts: p, u }) => ({ id: p.id, author: q.nest({ id: u.id, name: u.name }) }))
      .orderBy(({ posts: p }) => q.asc(p.id))
      .limit(1)
      .execute()
    const oracle = await live.raw(
      `select p.id, u.id, u.name from ${live.fx.ns}.posts p join ${live.fx.ns}.users u ` +
        `on p.author_id = u.id order by p.id asc limit 1`,
    )
    expect(nested).toStrictEqual([
      { id: BigInt(oracle[0]![0]!), author: { id: BigInt(oracle[0]![1]!), name: oracle[0]![2] } },
    ])
  })

  it('a self-join is two aliases and nothing else', async () => {
    const rows = await live.db
      .from(h().users)
      .innerJoin(h().users, 'other', ({ users: a, other: b }) => q.gt(b.id, a.id))
      .select(({ users: a, other: b }) => ({ a: a.email, b: b.email }))
      .where(({ users: a }) => q.eq(a.email, 'ada@example.com'))
      .execute()
    expect(rows).toHaveLength(5)
    expect(rows.every((r) => r.a === 'ada@example.com')).toBe(true)
  })
})

describe('§2.8 — distinct on, group by, subqueries', () => {
  it('distinct on picks the latest row per group, matching a hand-written oracle', async () => {
    const rows = await live.db
      .from(h().posts)
      .distinctOn(({ posts: p }) => [p.authorId])
      .select(({ posts: p }) => ({ authorId: p.authorId, title: p.title }))
      .orderBy(({ posts: p }) => [q.asc(p.authorId), q.desc(p.createdAt), q.asc(p.id)])
      .execute()
    const oracle = await live.raw(
      `select distinct on (author_id) author_id, title from ${live.fx.ns}.posts ` +
        `order by author_id asc, created_at desc, id asc`,
    )
    expect(rows).toStrictEqual(oracle.map((r) => ({ authorId: BigInt(r[0]!), title: r[1] })))
    expect(rows).toHaveLength(2)
  })

  /**
   * `.distinctOn(a).orderBy(desc(b))` — the ordering the caller wrote *appended* to the keys.
   *
   * `.orderBy()` appends, and PostgreSQL requires the `DISTINCT ON` list to match the **initial**
   * `ORDER BY` expressions, so before 2026-08-27 this compiled to a statement the server refused
   * with `42P10`. The compiler now leads the ORDER BY with the keys, which is exactly "latest row
   * per group": the oracle below is that sentence written by hand.
   */
  it('distinctOn then a plain orderBy is the latest row per group, not a 42P10', async () => {
    const rows = await live.db
      .from(h().posts)
      .distinctOn(({ posts: p }) => [p.authorId])
      .select(({ posts: p }) => ({ authorId: p.authorId, title: p.title }))
      .orderBy(({ posts: p }) => [q.desc(p.createdAt), q.asc(p.id)])
      .execute()
    expectTypeOf(rows).toEqualTypeOf<{ authorId: bigint; title: string }[]>()
    const oracle = await live.raw(
      `select distinct on (author_id) author_id, title from ${live.fx.ns}.posts ` +
        `order by author_id asc, created_at desc, id asc`,
    )
    expect(rows).toStrictEqual(oracle.map((r) => ({ authorId: BigInt(r[0]!), title: r[1] })))
    expect(rows).toHaveLength(2)
  })

  /**
   * R4, the negative control for both `distinct` findings: the statements the builder used to emit
   * are still rejected by this very server, so the two rules above are preventing something real
   * rather than describing something that never happened. R13 — SQLSTATE, not message text.
   */
  it('R4: the un-reconciled statements are still 42P10 when written by hand', async () => {
    const keysAfter = await live
      .raw(
        `select distinct on (author_id) author_id, title from ${live.fx.ns}.posts ` +
          `order by created_at desc`,
      )
      .catch((e: unknown) => e)
    expect(sqlState(keysAfter)).toBe('42P10')

    const orderNotSelected = await live
      .raw(`select distinct author_id from ${live.fx.ns}.posts order by created_at desc`)
      .catch((e: unknown) => e)
    expect(sqlState(orderNotSelected)).toBe('42P10')
  })

  it('the builder refuses .distinct() + an unprojected orderBy before any round trip', async () => {
    const built = live.db
      .from(h().posts)
      .distinct()
      .select(({ posts: p }) => ({ authorId: p.authorId }))
      .orderBy(({ posts: p }) => q.desc(p.createdAt))
    await expect(built.execute()).rejects.toThrow(/cannot order by "posts"\."created_at"/)
  })

  it('group by + having, with exact aggregate types', async () => {
    const rows = await live.db
      .from(h().posts)
      .innerJoin(h().users, 'u', ({ posts: p, u }) => q.eq(p.authorId, u.id))
      .select(({ posts: p, u }) => ({
        email: u.email,
        n: q.fn.count(p.id),
        total: q.fn.sum(p.amount),
      }))
      .groupBy(({ u }) => [u.email])
      .having(({ posts: p }) => q.gt(q.fn.count(p.id), 1n))
      .orderBy(({ u }) => q.asc(u.email))
      .execute()

    expectTypeOf(rows).toEqualTypeOf<{ email: string; n: bigint; total: string | null }[]>()
    expect(rows).toStrictEqual([{ email: 'ada@example.com', n: 5n, total: '12345683.80' }])
  })

  it('a scalar subquery decodes at the sub-select’s codec', async () => {
    const rows = await live.db
      .from(h().users)
      .select(({ users: u }) => ({
        email: u.email,
        lastPostAt: live.db
          .from(h().posts)
          .select(({ posts: p }) => ({ v: q.fn.max(p.createdAt) }))
          .where(({ posts: p }) => q.eq(p.authorId, u.id))
          .asScalar(),
      }))
      .where(({ users: u }) => q.eq(u.email, 'cyd@example.com'))
      .execute()
    expectTypeOf(rows).toEqualTypeOf<{ email: string; lastPostAt: Date | null }[]>()
    expect(rows).toStrictEqual([{ email: 'cyd@example.com', lastPostAt: null }])
  })

  it('exists / inQuery against a builder sub-select', async () => {
    const authors = live.db.from(h().posts).select(({ posts: p }) => ({ authorId: p.authorId }))
    const viaIn = await live.db
      .from(h().users)
      .select(({ users: u }) => ({ email: u.email }))
      .where(({ users: u }) => q.inQuery(u.id, authors))
      .orderBy(({ users: u }) => q.asc(u.id))
      .execute()
    const oracle = await live.raw(
      `select email from ${live.fx.ns}.users u where u.id in (select author_id from ${live.fx.ns}.posts) order by u.id asc`,
    )
    expect(viaIn.map((r) => r.email)).toStrictEqual(oracle.map((r) => r[0]))
    expect(viaIn).toHaveLength(2)
  })

  it('a derived table carries its codecs through', async () => {
    const recent = live.db
      .from(h().posts)
      .select(({ posts: p }) => ({ id: p.id, amount: p.amount }))
      .where(({ posts: p }) => p.published)
      .as('recent')
    const rows = await live.db
      .from(recent)
      .select(({ recent: r }) => ({ id: r.id, amount: r.amount }))
      .orderBy(({ recent: r }) => q.asc(r.id))
      .limit(1)
      .execute()
    const oracle = await live.raw(
      `select id, amount from ${live.fx.ns}.posts where published order by id asc limit 1`,
    )
    expectTypeOf(rows).toEqualTypeOf<{ id: bigint; amount: string }[]>()
    expect(rows).toStrictEqual([{ id: BigInt(oracle[0]![0]!), amount: oracle[0]![1] }])
    // Every id in this fixture is past 2^53, which is the whole reason `int8` decodes to bigint.
    expect(rows[0]!.id).toBeGreaterThanOrEqual(FIRST_POST_ID)
  })
})

describe('plan-ability — PostgreSQL parses, analyses and plans every golden', () => {
  const statements = () => [
    live.db
      .from(h().users)
      .select(({ users: u }) => ({ id: u.id, email: u.email }))
      .where(({ users: u }) => q.and(q.isNull(u.deletedAt), q.inList(u.role, ['admin'])))
      .orderBy(({ users: u }) => q.desc(u.createdAt))
      .limit(20),
    live.db
      .from(h().posts)
      .innerJoin(h().users, 'u', ({ posts: p, u }) => q.eq(p.authorId, u.id))
      .select(({ posts: p, u }) => ({ id: p.id, author: q.nest({ id: u.id, name: u.name }) })),
    live.db
      .from(h().posts)
      .distinctOn(({ posts: p }) => [p.authorId])
      .select(({ posts: p }) => ({ id: p.id }))
      .orderBy(({ posts: p }) => [q.asc(p.authorId), q.desc(p.createdAt)]),
    live.db
      .from(h().users)
      .select(() => ({ c: q.val('x', textCodec) }))
      .forUpdate({ wait: 'skip locked' }),
  ]

  it('every statement plans', async () => {
    for (const built of statements()) {
      const compiled = built.compile()
      await assertPlans(
        live,
        compiled.sql,
        compiled.binds.map((b) => (b.k === 'value' ? (b.oid ?? 0) : 0)),
        pgMajor(),
      )
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// `$all`, right / full / cross and the two laterals, against the server (12 B)
// ─────────────────────────────────────────────────────────────────────────────

describe('§2.1 — `$all` (12 B)', () => {
  it('R3: the spread returns every column, decoded, with the promised types', async () => {
    const rows = await live.db
      .from(h().tags)
      .select(({ tags: t }) => ({ ...t.$all }))
      .orderBy(({ tags: t }) => q.asc(t.id))
      .execute()
    expectTypeOf(rows).toEqualTypeOf<{ id: bigint; name: string }[]>()
    // The oracle is a hand-written statement, not the same builder read back (R1).
    const oracle = await live.raw(`select id, name from ${live.fx.ns}.tags order by id`)
    expect(rows).toStrictEqual(oracle.map(([id, name]) => ({ id: BigInt(id as string), name })))
  })

  it('omit() removes exactly one column from the emitted list, and nothing else', async () => {
    const rows = await live.db
      .from(h().tags)
      .select(({ tags: t }) => ({ ...q.omit(t.$all, 'name') }))
      .orderBy(({ tags: t }) => q.asc(t.id))
      .execute()
    expectTypeOf(rows).toEqualTypeOf<{ id: bigint }[]>()
    expect(rows).toStrictEqual(
      (await live.raw(`select id from ${live.fx.ns}.tags order by id`)).map(([id]) => ({
        id: BigInt(id as string),
      })),
    )
  })

  it('under a LEFT JOIN every column nulls on its own — not the object', async () => {
    const rows = await live.db
      .from(h().users, 'u')
      .leftJoin(h().posts, 'p', ({ u, p }) => q.and(q.eq(p.authorId, u.id), q.eq(p.title, 'nope')))
      .select(({ u, p }) => ({ email: u.email, id: p.id, title: p.title }))
      .where(({ u }) => q.eq(u.email, 'cyd@example.com'))
      .execute()
    expectTypeOf(rows).toEqualTypeOf<{ email: string; id: bigint | null; title: string | null }[]>()
    expect(rows).toStrictEqual([{ email: 'cyd@example.com', id: null, title: null }])
  })
})

describe('§2.2 — right / full / cross joins (12 B)', () => {
  /** Cyd has no posts, so a RIGHT join from posts keeps her row and nulls the post side. */
  it('right join: the driving side nulls, and the server agrees', async () => {
    const rows = await live.db
      .from(h().posts, 'p')
      .rightJoin(h().users, 'u', ({ p, u }) => q.eq(p.authorId, u.id))
      .select(({ p, u }) => ({ email: u.email, title: p.title }))
      .where(({ u }) => q.eq(u.email, 'cyd@example.com'))
      .execute()
    expectTypeOf(rows).toEqualTypeOf<{ email: string; title: string | null }[]>()
    const oracle = await live.raw(
      `select u.email, p.title from ${live.fx.ns}.posts p
         right join ${live.fx.ns}.users u on p.author_id = u.id
        where u.email = 'cyd@example.com'`,
    )
    expect(rows).toStrictEqual(oracle.map(([email, title]) => ({ email, title })))
    expect(rows).toStrictEqual([{ email: 'cyd@example.com', title: null }])
  })

  it('full join: both sides null, and both null rows appear', async () => {
    const rows = await live.db
      .from(h().posts, 'p')
      .fullJoin(h().users, 'u', ({ p, u }) => q.and(q.eq(p.authorId, u.id), q.eq(p.title, 'first')))
      .select(({ p, u }) => ({ email: u.email, title: p.title }))
      .orderBy(() => [q.asc(q.sql`1`.as(textCodec)), q.asc(q.sql`2`.as(textCodec))])
      .execute()
    expectTypeOf(rows).toEqualTypeOf<{ email: string | null; title: string | null }[]>()
    const oracle = await live.raw(
      `select u.email, p.title from ${live.fx.ns}.posts p
         full join ${live.fx.ns}.users u on p.author_id = u.id and p.title = 'first'
        order by 1, 2`,
    )
    expect(rows).toStrictEqual(oracle.map(([email, title]) => ({ email, title })))
    // The point of a FULL join: rows with a null on each side, in the same result.
    expect(rows.some((r) => r.email === null)).toBe(true)
    expect(rows.some((r) => r.title === null)).toBe(true)
  })

  it('cross join is the Cartesian product, to the row', async () => {
    const rows = await live.db
      .from(h().tags, 't')
      .crossJoin(h().kv, 'k')
      .select(({ t, k }) => ({ name: t.name, v: k.v }))
      .orderBy(({ t, k }) => [q.asc(t.id), q.asc(k.k1)])
      .execute()
    expectTypeOf(rows).toEqualTypeOf<{ name: string; v: string }[]>()
    const oracle = await live.raw(
      `select t.name, k.v from ${live.fx.ns}.tags t cross join ${live.fx.ns}.kv k
        order by t.id, k.k1`,
    )
    expect(rows).toStrictEqual(oracle.map(([name, v]) => ({ name, v })))
    const tagCount = (await live.raw(`select count(*) from ${live.fx.ns}.tags`))[0]?.[0]
    const kvCount = (await live.raw(`select count(*) from ${live.fx.ns}.kv`))[0]?.[0]
    expect(rows).toHaveLength(Number(tagCount) * Number(kvCount))
  })
})

describe('§2.2 — lateral joins (12 B)', () => {
  it('inner join lateral, per-parent: the correlation is inside the sub-query', async () => {
    const rows = await live.db
      .from(h().users, 'u')
      .innerJoinLateral(
        (t) =>
          live.db
            .from(h().posts, 'p')
            .where(({ p }) => q.eq(p.authorId, t.u.id))
            .select(({ p }) => ({ id: p.id, title: p.title }))
            .orderBy(({ p }) => [q.desc(p.createdAt), q.asc(p.id)])
            .limit(2),
        'recent',
      )
      .select(({ u, recent }) => ({ email: u.email, id: recent.id, title: recent.title }))
      .orderBy(({ u, recent }) => [q.asc(u.email), q.asc(recent.id)])
      .execute()
    expectTypeOf(rows).toEqualTypeOf<{ email: string; id: bigint; title: string }[]>()

    // The oracle is the window-function spelling of the same question — a different statement and
    // a different plan for the same answer (R1).
    const oracle = await live.raw(
      `select email, id, title from (
         select u.email, p.id, p.title,
                row_number() over (partition by u.id order by p.created_at desc, p.id asc) rn
           from ${live.fx.ns}.users u join ${live.fx.ns}.posts p on p.author_id = u.id
       ) s where rn <= 2 order by email, id`,
    )
    expect(rows).toStrictEqual(
      oracle.map(([email, id, title]) => ({ email, id: BigInt(id as string), title })),
    )
    expect(rows.length).toBeGreaterThan(0)
  })

  it('left join lateral keeps the parents whose lateral found nothing', async () => {
    const rows = await live.db
      .from(h().users, 'u')
      .leftJoinLateral(
        (t) =>
          live.db
            .from(h().posts, 'p')
            .where(({ p }) => q.eq(p.authorId, t.u.id))
            .select(({ p }) => ({ title: p.title }))
            .limit(1),
        'recent',
      )
      .select(({ u, recent }) => ({ email: u.email, title: recent.title }))
      .where(({ u }) => q.eq(u.email, 'cyd@example.com'))
      .execute()
    expectTypeOf(rows).toEqualTypeOf<{ email: string; title: string | null }[]>()
    expect(rows).toStrictEqual([{ email: 'cyd@example.com', title: null }])
  })

  it('the same query with an INNER lateral drops her — the negative control (R4)', async () => {
    const rows = await live.db
      .from(h().users, 'u')
      .innerJoinLateral(
        (t) =>
          live.db
            .from(h().posts, 'p')
            .where(({ p }) => q.eq(p.authorId, t.u.id))
            .select(({ p }) => ({ title: p.title }))
            .limit(1),
        'recent',
      )
      .select(({ u, recent }) => ({ email: u.email, title: recent.title }))
      .where(({ u }) => q.eq(u.email, 'cyd@example.com'))
      .execute()
    expect(rows).toStrictEqual([])
  })

  it('every new join shape plans on this server', async () => {
    for (const built of [
      live.db
        .from(h().posts, 'p')
        .rightJoin(h().users, 'u', ({ p, u }) => q.eq(p.authorId, u.id))
        .select(({ u }) => ({ id: u.id })),
      live.db
        .from(h().posts, 'p')
        .fullJoin(h().users, 'u', ({ p, u }) => q.eq(p.authorId, u.id))
        .select(({ u }) => ({ id: u.id })),
      live.db
        .from(h().posts, 'p')
        .crossJoin(h().users, 'u')
        .select(({ u }) => ({ id: u.id })),
    ]) {
      await assertPlans(live, built.compile().sql, [], pgMajor())
    }
  })
})
