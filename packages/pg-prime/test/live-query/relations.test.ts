/**
 * Relation accessors against a real server — tier 1 (design/09 WS5).
 *
 * ## The headline oracle
 *
 * **Per-parent pagination.** `u.posts.many(q => q.orderBy(…).limit(3))` must mean *three posts for
 * each user*, not three posts in total. That is the semantic MikroORM reaches only through
 * `populateHints` + a `select-in` fallback and that Drizzle's RQB gets but forbids combining with
 * aggregates — so it is the one to prove rather than assume. The oracle is a hand-written
 * `row_number() over (partition by author_id order by created_at desc, id asc) <= 3`, executed
 * through `live.raw`: a completely separate path to the same answer (R1).
 *
 * ## The second claim
 *
 * **No dehydration tax.** A column's type is the same at the top level and three relations deep.
 * Every depth-3 assertion here pairs a static type with a runtime value (R3), and the negative
 * control runs the same JSON aggregation *without* the `::text` cast so the precision loss it
 * prevents is visible rather than asserted.
 *
 * Post ids are never hard-coded: the fixture assigns identity through a join, so a title does not
 * pin an id across runs (a WS4 finding). Everything resolves ids by title through raw SQL first.
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
  live = await makeLiveDb('pgprime_q_rel')
}, 120_000)

afterAll(async () => {
  await live?.end()
})

const h = () => live.fx.schema.h
const ns = () => live.fx.ns

/** PostgreSQL's own `timestamptz` text as a `Date` — not through our codec (R1). */
const pgTs = (raw: string): Date =>
  new Date(raw.replace(' ', 'T').replace(/([+-])(\d\d)$/, '$1$2:00'))

/** `title → id`, straight from the server, because identity order is not the insert order. */
async function postIds(): Promise<Record<string, bigint>> {
  const rows = await live.raw(`select title, id from ${ns()}.posts`)
  return Object.fromEntries(rows.map((r) => [r[0] as string, BigInt(r[1] as string)]))
}

async function userIds(): Promise<Record<string, bigint>> {
  const rows = await live.raw(`select name, id from ${ns()}.users`)
  return Object.fromEntries(rows.map((r) => [r[0] as string, BigInt(r[1] as string)]))
}

// ─────────────────────────────────────────────────────────────────────────────
// The per-parent LIMIT oracle
// ─────────────────────────────────────────────────────────────────────────────

describe('per-parent pagination', () => {
  it('matches a hand-written row_number() window, pair for pair and in order', async () => {
    const rows = await live.db
      .from(h().users, 'u')
      .select((t) => ({
        id: t.u.id,
        posts: t.u.posts.many((sub) =>
          sub
            .select((p) => ({ id: p.id }))
            .orderBy((p) => [q.desc(p.createdAt), q.asc(p.id)])
            .limit(3),
        ),
      }))
      .orderBy((t) => q.asc(t.u.id))
      .execute()

    expectTypeOf(rows).toEqualTypeOf<{ id: bigint; posts: { id: bigint }[] }[]>()

    const ours = rows.flatMap((r) => r.posts.map((p) => `${r.id}:${p.id}`))

    // The oracle. `<= 3` is the per-parent limit; the ORDER BY is the same one the builder was
    // given, tiebroken on id because the fixture has two posts sharing created_at to the
    // microsecond — without the tiebreak both queries would be non-deterministic and could agree
    // by luck.
    const oracle = await live.raw(`
      select u.id, x.id
      from ${ns()}.users u
      join (
        select p.id, p.author_id,
               row_number() over (partition by p.author_id order by p.created_at desc, p.id asc) as rn
        from ${ns()}.posts p
      ) x on x.author_id = u.id and x.rn <= 3
      order by u.id asc, x.rn asc
    `)

    expect(ours).toStrictEqual(oracle.map((r) => `${r[0]}:${r[1]}`))
    // …and it is actually doing work: Ada has five posts and gets three.
    expect(rows.find((r) => r.posts.length === 3)?.posts).toHaveLength(3)
    expect(ours).toHaveLength(4)
  })

  it('the LIMIT is inside the lateral, so it is a per-parent count and not a global one', async () => {
    const c = live.db
      .from(h().users, 'u')
      .select((t) => ({
        posts: t.u.posts.many((sub) => sub.select((p) => ({ id: p.id })).limit(3)),
      }))
      .compile()
    // Two `limit`s would be a global one; one, inside the lateral, is per parent.
    expect(c.sql.match(/limit \$1/g)).toHaveLength(1)
    expect(c.sql.indexOf('limit $1')).toBeLessThan(c.sql.indexOf(') as "_r0" on true'))
    await assertPlans(live, c.sql, [23], pgMajor())
  })

  it('the empty relation is [] in the SQL itself, not only after decoding', async () => {
    // The decoder maps a null `json_agg` to `[]` too, so `coalesce(…, '[]'::json)` is belt and
    // braces *for us* — but not for anyone reading `EXPLAIN` or piping `toSQL()` into psql. This
    // runs the builder's own SQL through the raw path, where a missing coalesce is a NULL column.
    const c = live.db
      .from(h().users, 'u')
      .select((t) => ({ posts: t.u.posts.many((s) => s.select((p) => ({ id: p.id }))) }))
      .compile()
    expect(c.binds).toStrictEqual([])
    const raw = await live.raw(c.sql)
    expect(raw.map((r) => r[0])).toContain('[]')
    expect(raw.some((r) => r[0] === null)).toBe(false)
  })

  it('a parent with no related rows is [] and never null', async () => {
    const rows = await live.db
      .from(h().users, 'u')
      .where((t) => q.eq(t.u.email, 'cyd@example.com'))
      .select((t) => ({
        email: t.u.email,
        posts: t.u.posts.many((sub) => sub.select((p) => ({ id: p.id }))),
      }))
      .execute()
    expect(rows).toStrictEqual([{ email: 'cyd@example.com', posts: [] }])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Depth 3, exact values (R3) — the no-dehydration-tax claim
// ─────────────────────────────────────────────────────────────────────────────

describe('depth 3, every codec', () => {
  it('decodes each leaf at its declared type three relations deep', async () => {
    const pid = (await postIds())['first'] as bigint
    const uid = (await userIds())['Ada'] as bigint
    const commentRows = await live.raw(
      `select id, body, created_at from ${ns()}.comments order by created_at asc`,
    )

    const rows = await live.db
      .from(h().users, 'u')
      .where((t) => q.eq(t.u.email, 'ada@example.com'))
      .select((t) => ({
        id: t.u.id,
        posts: t.u.posts.many((sub) =>
          sub
            .where((p) => q.eq(p.title, 'first'))
            .select((p) => ({
              id: p.id,
              amount: p.amount,
              tagIds: p.tagIds,
              at: p.createdAt,
              comments: p.comments.many((s2) =>
                s2
                  .select((c) => ({ id: c.id, body: c.body, at: c.createdAt }))
                  .orderBy((c) => q.asc(c.createdAt)),
              ),
              author: p.author.one((s2) =>
                s2.select((a) => ({
                  id: a.id,
                  name: a.name,
                  meta: a.meta,
                  tags: a.tags,
                  birthday: a.birthday,
                  balance: a.balance,
                  role: a.role,
                })),
              ),
            })),
        ),
      }))
      .execute()

    expectTypeOf(rows[0]!.posts[0]!.id).toEqualTypeOf<bigint>()
    expectTypeOf(rows[0]!.posts[0]!.comments[0]!.at).toEqualTypeOf<Date>()
    expectTypeOf(rows[0]!.posts[0]!.author.balance).toEqualTypeOf<string>()
    expectTypeOf(rows[0]!.posts[0]!.author.tags).toEqualTypeOf<string[]>()
    expectTypeOf(rows[0]!.posts[0]!.author.role).toEqualTypeOf<'admin' | 'owner' | 'member'>()

    expect(rows).toStrictEqual([
      {
        id: uid,
        posts: [
          {
            // int8 past 2^53 — exact only because `json_build_object` got a `::text`
            id: pid,
            // numeric keeps its trailing zeros
            amount: '0.00',
            // int8[] inside JSON
            tagIds: [1n, 2n],
            at: new Date('2026-02-01T10:00:00.000Z'),
            comments: commentRows.map((r) => ({
              id: BigInt(r[0] as string),
              body: r[1] as string,
              at: pgTs(r[2] as string),
            })),
            author: {
              id: uid,
              name: 'Ada',
              // jsonb embeds natively — not a string, not double-encoded
              meta: { billing: { country: 'DE' }, 'k"ey': 1, 'a->b': 2 },
              tags: ['vip', 'beta'],
              // date is a 'YYYY-MM-DD' string and cannot shift a day
              birthday: '1990-05-17',
              balance: '1234.00',
              role: 'admin',
            },
          },
        ],
      },
    ])
  })

  it('R4: the same aggregation without ::text loses the last digit', async () => {
    // The negative control for the mechanism above. Same shape, hand-written, no cast — and the
    // id comes back as a JSON *number*, which cannot represent 2^53 + 1.
    const pid = (await postIds())['first'] as bigint
    const [row] = await live.raw(
      `select json_build_object('id', p.id)::text from ${ns()}.posts p where p.title = 'first'`,
    )
    const bad = JSON.parse(row![0] as string) as { id: number }
    expect(BigInt(bad.id)).not.toBe(pid)
    // …and with the cast, which is what the builder emits, it survives.
    const [good] = await live.raw(
      `select json_build_object('id', p.id::text)::text from ${ns()}.posts p where p.title = 'first'`,
    )
    expect(BigInt((JSON.parse(good![0] as string) as { id: string }).id)).toBe(pid)
  })

  it('the emitted SQL is the reason: ::text on int8 and numeric, nothing on timestamptz', async () => {
    const c = live.db
      .from(h().users, 'u')
      .select((t) => ({
        posts: t.u.posts.many((sub) =>
          sub.select((p) => ({ id: p.id, amount: p.amount, at: p.createdAt })),
        ),
      }))
      .compile()
    expect(c.sql).toContain('\'id\', "posts"."id"::text')
    expect(c.sql).toContain('\'amount\', "posts"."amount"::text')
    expect(c.sql).toContain('\'at\', "posts"."created_at"')
    expect(c.sql).not.toContain('"posts"."created_at"::text')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Ordering
// ─────────────────────────────────────────────────────────────────────────────

describe('ordering through the hidden keys', () => {
  it('nested order equals the raw ORDER BY order, tie included', async () => {
    const rows = await live.db
      .from(h().users, 'u')
      .where((t) => q.eq(t.u.email, 'ada@example.com'))
      .select((t) => ({
        posts: t.u.posts.many((sub) =>
          sub
            .select((p) => ({ title: p.title }))
            .orderBy((p) => [q.desc(p.createdAt), q.asc(p.id)]),
        ),
      }))
      .execute()

    const oracle = await live.raw(`
      select p.title from ${ns()}.posts p
      join ${ns()}.users u on u.id = p.author_id
      where u.email = 'ada@example.com'
      order by p.created_at desc, p.id asc
    `)
    expect(rows[0]!.posts.map((p) => p.title)).toStrictEqual(oracle.map((r) => r[0]))
  })

  it('json_agg does not preserve input order by itself — the hidden key is what does', async () => {
    // The `order by "x"."k0" desc` inside the aggregate is the mechanism; without it the order
    // would be whatever the executor happened to produce. Pin that it is emitted.
    const c = live.db
      .from(h().users, 'u')
      .select((t) => ({
        posts: t.u.posts.many((sub) =>
          sub.select((p) => ({ title: p.title })).orderBy((p) => q.desc(p.createdAt)),
        ),
      }))
      .compile()
    expect(c.sql).toContain('json_agg("x"."o" order by "x"."k0" desc)')
    expect(c.sql).toContain('"posts"."created_at" as "k0"')
    // …and the hidden key never reaches the JSON, because the object is built from a key list.
    expect(c.sql).not.toContain("'k0'")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Edge semantics
// ─────────────────────────────────────────────────────────────────────────────

describe('to-one nullability', () => {
  it('a required `one` is an object; an optional `one` is null when it misses', async () => {
    const rows = await live.db
      .from(h().posts, 'p')
      .select((t) => ({
        title: t.p.title,
        author: t.p.author.one((s) => s.select((a) => ({ email: a.email }))),
        kv: t.p.kv.one((s) => s.select((k) => ({ v: k.v }))),
      }))
      .orderBy((t) => q.asc(t.p.title))
      .execute()

    expectTypeOf(rows[0]!.author).toEqualTypeOf<{ email: string }>()
    expectTypeOf(rows[0]!.kv).toEqualTypeOf<{ v: string } | null>()

    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]))
    expect(byTitle['first']!.kv).toStrictEqual({ v: 'kv-a1' })
    expect(byTitle['bobs']!.kv).toStrictEqual({ v: 'kv-b2' })
    expect(byTitle['draft']!.kv).toBeNull()
    expect(byTitle['draft']!.author).toStrictEqual({ email: 'ada@example.com' })
  })
})

describe('a child that would shadow its own parent', () => {
  it('binds the child under a suffixed alias and still correlates on the parent', async () => {
    // `posts` aliased `users`, then its `author` relation — which also wants to be called
    // `users`. Without the suffix the correlation becomes `users.id = users.author_id`, naming
    // one alias for both sides; PostgreSQL rejects it (`users` has no `author_id`), which is the
    // loud version of a bug that would otherwise be a silent self-join.
    const rows = await live.db
      .from(h().posts, 'users')
      .select((t) => ({
        title: t.users.title,
        author: t.users.author.one((s) => s.select((a) => ({ email: a.email }))),
      }))
      .orderBy((t) => q.asc(t.users.title))
      .execute()

    expect(live.db
      .from(h().posts, 'users')
      .select((t) => ({ a: t.users.author.all() }))
      .compile().sql).toContain('as "users2"')

    const oracle = await live.raw(`
      select p.title, u.email from ${ns()}.posts p
      join ${ns()}.users u on u.id = p.author_id order by p.title asc
    `)
    expect(rows).toStrictEqual(
      oracle.map((r) => ({ title: r[0] as string, author: { email: r[1] as string } })),
    )
  })
})

describe('some / none / every against the server', () => {
  const emails = async (f: Parameters<ReturnType<typeof base>['where']>[0]) =>
    (await base().where(f).orderBy((t) => q.asc(t.u.email)).execute()).map((r) => r.email)
  const base = () => live.db.from(h().users, 'u').select((t) => ({ email: t.u.email }))

  it('some(published) selects only users who have a published post', async () => {
    const ours = await emails((t) => t.u.posts.some((p) => q.isTrue(p.published)))
    const oracle = await live.raw(`
      select u.email from ${ns()}.users u
      where exists (select 1 from ${ns()}.posts p where p.author_id = u.id and p.published)
      order by u.email asc
    `)
    expect(ours).toStrictEqual(oracle.map((r) => r[0]))
    expect(ours).toStrictEqual(['ada@example.com', 'bob@example.com'])
  })

  it('every(published) is vacuously true for a user with no posts', async () => {
    const ours = await emails((t) => t.u.posts.every((p) => q.isTrue(p.published)))
    // Ada has an unpublished draft, so she is out; everyone with no posts at all is in.
    expect(ours).not.toContain('ada@example.com')
    expect(ours).toContain('cyd@example.com')
    expect(ours).toContain('bob@example.com')
    const oracle = await live.raw(`
      select u.email from ${ns()}.users u
      where not exists (
        select 1 from ${ns()}.posts p where p.author_id = u.id and (p.published) is not true
      )
      order by u.email asc
    `)
    expect(ours).toStrictEqual(oracle.map((r) => r[0]))
  })

  it('every is three-valued: a NULL predicate does NOT count as satisfied', async () => {
    // The case that separates `(p) is not true` from `not (p)`, and the only reason `every` is
    // spelled the long way. `posts.k1` is nullable, so `k1 = 'a'` is NULL for most of Ada's
    // posts. Under `is not true` those rows fail the predicate and Ada is excluded; under
    // `not (p)` they evaluate to NULL, no row matches the NOT EXISTS body, and Ada comes back as
    // if every one of her posts had `k1 = 'a'`. Both spellings agree on every other user, which
    // is exactly why this needs a nullable column to catch.
    const ours = await emails((t) => t.u.posts.every((p) => q.eq(p.k1, q.val('a', textCodec))))
    const oracle = await live.raw(`
      select u.email from ${ns()}.users u
      where not exists (
        select 1 from ${ns()}.posts p where p.author_id = u.id and (p.k1 = 'a') is not true
      )
      order by u.email asc
    `)
    expect(ours).toStrictEqual(oracle.map((r) => r[0]))
    expect(ours).not.toContain('ada@example.com')

    // …and the wrong spelling, written out, disagrees — so the assertion above is load-bearing.
    const wrong = await live.raw(`
      select u.email from ${ns()}.users u
      where not exists (
        select 1 from ${ns()}.posts p where p.author_id = u.id and not (p.k1 = 'a')
      )
      order by u.email asc
    `)
    expect(wrong.map((r) => r[0])).toContain('ada@example.com')
  })

  it('none(published) is the complement of some(published)', async () => {
    const some = await emails((t) => t.u.posts.some((p) => q.isTrue(p.published)))
    const none = await emails((t) => t.u.posts.none((p) => q.isTrue(p.published)))
    const all = (
      await live.raw(`select email from ${ns()}.users order by email asc`)
    ).map((r) => r[0] as string)
    expect([...some, ...none].sort()).toStrictEqual([...all].sort())
  })

  it('exists() finds the users with any post at all', async () => {
    expect(await emails((t) => t.u.posts.exists())).toStrictEqual([
      'ada@example.com',
      'bob@example.com',
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Aggregates
// ─────────────────────────────────────────────────────────────────────────────

describe('count / sum', () => {
  it('R3: count is bigint and sum is a precision-exact string', async () => {
    const rows = await live.db
      .from(h().users, 'u')
      .select((t) => ({
        email: t.u.email,
        n: t.u.posts.count(),
        revenue: t.u.posts.sum((p) => p.amount),
      }))
      .orderBy((t) => q.asc(t.u.email))
      .execute()

    expectTypeOf(rows).toEqualTypeOf<{ email: string; n: bigint; revenue: string }[]>()

    const oracle = await live.raw(`
      select u.email,
             (select count(*) from ${ns()}.posts p where p.author_id = u.id),
             (select coalesce(sum(p.amount), 0) from ${ns()}.posts p where p.author_id = u.id)
      from ${ns()}.users u order by u.email asc
    `)
    expect(rows).toStrictEqual(
      oracle.map((r) => ({ email: r[0] as string, n: BigInt(r[1] as string), revenue: r[2] as string })),
    )
    // A user with no posts sums to zero rather than to null — which is why the type has no `| null`.
    expect(rows.find((r) => r.email === 'cyd@example.com')).toStrictEqual({
      email: 'cyd@example.com',
      n: 0n,
      revenue: '0',
    })
  })

  it('shares one lateral between an aggregate and a window over it, and still gets it right', async () => {
    const rows = await live.db
      .from(h().users, 'u')
      .select((t) => ({
        email: t.u.email,
        revenue: t.u.posts.sum((p) => p.amount),
        rank: q.over(q.fn.rank(), (w) => w.orderBy(q.desc(t.u.posts.sum((p) => p.amount)))),
      }))
      .orderBy((t) => q.asc(t.u.email))
      .execute()

    expect(rows[0]!.rank).toBeTypeOf('bigint')
    const oracle = await live.raw(`
      select u.email, r.v, rank() over (order by r.v desc)
      from ${ns()}.users u
      cross join lateral (
        select coalesce(sum(p.amount), 0) as v from ${ns()}.posts p where p.author_id = u.id
      ) r
      order by u.email asc
    `)
    expect(rows).toStrictEqual(
      oracle.map((r) => ({ email: r[0] as string, revenue: r[1] as string, rank: BigInt(r[2] as string) })),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// m2m and composite keys
// ─────────────────────────────────────────────────────────────────────────────

describe('m2m through a junction', () => {
  it('fans out both ways: a tag on two posts, a post with two tags', async () => {
    const rows = await live.db
      .from(h().posts, 'p')
      .select((t) => ({
        title: t.p.title,
        tags: t.p.tags.many((s) => s.select((g) => ({ name: g.name })).orderBy((g) => q.asc(g.name))),
      }))
      .orderBy((t) => q.asc(t.p.title))
      .execute()

    const oracle = await live.raw(`
      select p.title, coalesce(string_agg(g.name, ',' order by g.name), '')
      from ${ns()}.posts p
      left join ${ns()}.post_tags pt on pt.post_id = p.id
      left join ${ns()}.tags g on g.id = pt.tag_id
      group by p.title order by p.title asc
    `)
    expect(rows.map((r) => `${r.title}|${r.tags.map((g) => g.name).join(',')}`)).toStrictEqual(
      oracle.map((r) => `${r[0]}|${r[1]}`),
    )
    expect(rows.find((r) => r.title === 'first')!.tags).toStrictEqual([
      { name: 'beta' },
      { name: 'vip' },
    ])
    expect(rows.find((r) => r.title === 'tie-a')!.tags).toStrictEqual([{ name: 'vip' }])
    expect(rows.find((r) => r.title === 'draft')!.tags).toStrictEqual([])
  })

  it('counts through the junction', async () => {
    const rows = await live.db
      .from(h().posts, 'p')
      .select((t) => ({ title: t.p.title, n: t.p.tags.count() }))
      .orderBy((t) => q.asc(t.p.title))
      .execute()
    const oracle = await live.raw(`
      select p.title, (select count(*) from ${ns()}.post_tags pt where pt.post_id = p.id)
      from ${ns()}.posts p order by p.title asc
    `)
    expect(rows).toStrictEqual(
      oracle.map((r) => ({ title: r[0] as string, n: BigInt(r[1] as string) })),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The two strategies, and the two JSON variants, are differentials of each other
// ─────────────────────────────────────────────────────────────────────────────

describe('strategy and variant', () => {
  const shape = (opts?: { strategy?: 'lateral' | 'subquery'; variant?: 'json' | 'jsonb' }) =>
    live.db
      .from(h().posts, 'p')
      .select((t) => ({
        title: t.p.title,
        comments: t.p.comments.many(
          (s) => s.select((c) => ({ id: c.id, body: c.body })).orderBy((c) => q.asc(c.createdAt)),
          opts,
        ),
      }))
      .orderBy((t) => q.asc(t.p.title))

  it("strategy: 'subquery' returns exactly what 'lateral' returns", async () => {
    const lateral = await shape({ strategy: 'lateral' }).execute()
    const sub = await shape({ strategy: 'subquery' }).execute()
    expect(shape({ strategy: 'subquery' }).compile().sql).not.toContain('left join lateral')
    expect(sub).toStrictEqual(lateral)
  })

  it("variant: 'jsonb' decodes identically, even though jsonb reorders keys", async () => {
    expect(await shape({ variant: 'jsonb' }).execute()).toStrictEqual(
      await shape({ variant: 'json' }).execute(),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// RETURNING
// ─────────────────────────────────────────────────────────────────────────────

describe('relations in RETURNING', () => {
  it('a relation aggregate returns the right number, correlated on the updated row', async () => {
    // RETURNING emits the target's own columns unqualified, but a correlated subquery inside it
    // has its own FROM clause. Emitting *its* columns unqualified turns
    // `comments.post_id = posts.id` into `post_id = id` — two columns of `comments`, silently
    // counting zero. Only executing it catches that; the SQL is well-formed either way.
    const rows = await live.db
      .update(h().posts)
      .set((t) => ({ body: t.posts.body }))
      .where((t) => q.eq(t.posts.title, q.val('first', textCodec)))
      .returning((t) => ({ title: t.posts.title, n: t.posts.comments.count() }))
      .execute()

    expectTypeOf(rows).toEqualTypeOf<{ title: string; n: bigint }[]>()
    const oracle = await live.raw(
      `select count(*) from ${ns()}.comments c
       join ${ns()}.posts p on p.id = c.post_id where p.title = 'first'`,
    )
    expect(rows).toStrictEqual([{ title: 'first', n: BigInt(oracle[0]![0] as string) }])
    expect(rows[0]!.n).toBe(3n)
  })

  it("a relation projection under { strategy: 'subquery' } returns the rows themselves", async () => {
    const rows = await live.db
      .update(h().posts)
      .set((t) => ({ body: t.posts.body }))
      .where((t) => q.eq(t.posts.title, q.val('first', textCodec)))
      .returning((t) => ({
        title: t.posts.title,
        comments: t.posts.comments.many(
          (s) => s.select((c) => ({ body: c.body })).orderBy((c) => q.asc(c.createdAt)),
          { strategy: 'subquery' },
        ),
      }))
      .execute()
    expect(rows).toStrictEqual([
      { title: 'first', comments: [{ body: 'one' }, { body: 'two' }, { body: 'three' }] },
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Plan-ability
// ─────────────────────────────────────────────────────────────────────────────

describe('every shape plans', () => {
  it('PostgreSQL accepts the feed query, the m2m lateral and the composite to-one', async () => {
    const feed = live.db
      .from(h().users, 'u')
      .select((t) => ({
        id: t.u.id,
        n: t.u.posts.count(),
        revenue: t.u.posts.sum((p) => p.amount),
        posts: t.u.posts.many((s) =>
          s
            .select((p) => ({
              id: p.id,
              tags: p.tags.many((s2) => s2.select((g) => ({ name: g.name }))),
              kv: p.kv.one((s2) => s2.select((k) => ({ v: k.v }))),
              author: p.author.one((s2) => s2.select((a) => ({ email: a.email }))),
            }))
            .orderBy((p) => q.desc(p.createdAt))
            .limit(3),
        ),
      }))
      .where((t) => t.u.posts.some((p) => q.isTrue(p.published)))
      .compile()
    await assertPlans(live, feed.sql, [23], pgMajor())
    // …and it runs.
    expect((await live.db
      .from(h().users, 'u')
      .select((t) => ({ id: t.u.id, n: t.u.posts.count() }))
      .execute()).length).toBe(6)
  })
})

describe('a relation sub-query does not shadow a SIBLING alias', () => {
  it('returns the same rows a hand-written query with distinct aliases does', async () => {
    // `users JOIN posts` binds "posts"; the relation's child was named "posts" too, so the
    // sub-query's scope hid the joined one and `gt(c.id, t.posts.id)` became
    // `"posts"."id" > "posts"."id"` — false for every row. Well-formed SQL, no error, an empty
    // array for every parent, and the correct answer is NOT empty.
    const rows = await live.db
      .from(h().users)
      .innerJoin(h().posts, (t) => q.eq(t.posts.authorId, t.users.id))
      .select((t) => ({
        pid: t.posts.id,
        later: t.users.posts.many((sq) =>
          sq.select((c) => ({ id: c.id })).where((c) => q.gt(c.id, t.posts.id)),
        ),
      }))
      .orderBy((t) => q.asc(t.posts.id))
      .execute()

    // The oracle: the same question in hand-written SQL, with aliases that cannot collide.
    const expected = await live.raw(`
      select p.id::text,
             coalesce((select count(*) from ${ns()}.posts later
                       where later.author_id = p.author_id and later.id > p.id), 0)::text
      from ${ns()}.posts p
      order by p.id
    `)

    expect(rows.map((r) => [String(r.pid), String(r.later.length)])).toStrictEqual(expected)
    // …and the correct answer is non-empty, so an all-zero result would not pass by accident.
    expect(rows.some((r) => r.later.length > 0)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 03 §2.3 point 5, AS BUILT 2026-08-27 — a relation column under `select distinct`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The claim is that the **value is unchanged** by the variant switch, so every assertion here is
 * an R3 pair against the `json` form of the same query: the two must be `toStrictEqual`, leaves
 * and all. `jsonb` reorders keys and dedupes them, which is why this needs a server to settle —
 * the decode plan is positional over keys, so key order cannot matter, but that is an argument and
 * this is a measurement.
 *
 * The leaves are chosen for the two that a JSON round trip destroys: `int8` past 2^53 (every
 * fixture post id is above `FIRST_POST_ID`) and `numeric` with a trailing zero. Both go through
 * `::text` (R5) and the cast is unchanged by the variant — asserted, not assumed.
 */
describe('select distinct over a relation column', () => {
  it('R3: many() — same types, same values, and the ids survive past 2^53', async () => {
    const of = (distinct: boolean) => {
      const base = live.db.from(h().users, 'u')
      const src = distinct ? base.distinct() : base
      return src
        .select((t) => ({
          email: t.u.email,
          posts: t.u.posts.many((sub) =>
            sub
              .select((p) => ({ id: p.id, title: p.title, amount: p.amount, at: p.createdAt }))
              .orderBy((p) => q.asc(p.title)),
          ),
        }))
        .orderBy((t) => q.asc(t.u.email))
    }

    const rows = await of(true).execute()
    expectTypeOf(rows).toEqualTypeOf<
      { email: string; posts: { id: bigint; title: string; amount: string; at: Date }[] }[]
    >()
    expect(of(true).compile().sql).toContain('jsonb_agg')
    expect(of(false).compile().sql).toContain('json_agg("x"."o"')

    // The value oracle: the same query without `distinct`, whose json form is what every other
    // test in this file has already checked against hand-written SQL.
    expect(rows).toStrictEqual(await of(false).execute())

    const ada = rows.find((r) => r.email === 'ada@example.com')
    expect(ada?.posts).toHaveLength(5)
    // int8 past 2^53 and numeric's trailing zero, both intact through jsonb. Titles order the
    // list because the fixture assigns identity through a join, so id order is not insert order.
    expect(ada?.posts.every((p) => p.id >= FIRST_POST_ID)).toBe(true)
    expect(ada?.posts.map((p) => [p.title, p.amount])).toStrictEqual([
      ['draft', '5.00'],
      ['fifth', '1.00'],
      ['first', '0.00'],
      ['tie-a', '-1.10'],
      ['tie-b', '12345678.90'],
    ])
    expect(ada?.posts[2]?.at).toStrictEqual(new Date('2026-02-01T10:00:00.000000Z'))
    // …and an empty relation is still `[]`, not null: `coalesce(…, '[]'::jsonb)`.
    expect(rows.find((r) => r.email === 'cyd@example.com')?.posts).toStrictEqual([])
  })

  it('R3: all(), and a relation nested inside a relation, decode identically too', async () => {
    const of = (distinct: boolean) => {
      const base = live.db.from(h().posts, 'p')
      const src = distinct ? base.distinct() : base
      return src
        .select((t) => ({
          title: t.p.title,
          everything: t.p.comments.all(),
          deep: t.p.comments.many((sub) =>
            sub.select((c) => ({ id: c.id, post: c.post.one((s) => s.select((x) => ({ amount: x.amount }))) })),
          ),
        }))
        .orderBy((t) => q.asc(t.p.title))
    }
    const rows = await of(true).execute()
    expect(rows).toStrictEqual(await of(false).execute())

    const first = rows.find((r) => r.title === 'first')
    expect(first?.everything).toHaveLength(3)
    expect(first?.everything[0]?.id).toBeGreaterThan(0n)
    expect(first?.deep.map((d) => d.post.amount)).toStrictEqual(['0.00', '0.00', '0.00'])
    // The inner relation stays `json` and is coerced into the outer `jsonb` object; the value is
    // the same either way, which is the whole reason the inner one is left alone.
    const sql = of(true).compile().sql
    expect(sql).toContain('jsonb_agg')
    expect(sql).toContain('json_build_object')
  })

  it('R4: the same statement built with json is 42883 on this very server', async () => {
    // The negative control for the whole mechanism (R13: SQLSTATE, not message text). Without the
    // variant switch this is the statement the builder emitted, and it is still rejected.
    const err = await live
      .raw(
        `select distinct u.email, coalesce(json_agg(json_build_object('id', p.id::text)), ` +
          `'[]'::json) from ${ns()}.users u left join ${ns()}.posts p on p.author_id = u.id ` +
          `group by u.email, u.id`,
      )
      .catch((e: unknown) => e)
    expect(sqlState(err)).toBe('42883')

    // …and the jsonb spelling of the same thing is accepted, so 42883 is about the type and not
    // about the query.
    const ok = await live.raw(
      `select distinct u.email, coalesce(jsonb_agg(jsonb_build_object('id', p.id::text)), ` +
        `'[]'::jsonb) from ${ns()}.users u left join ${ns()}.posts p on p.author_id = u.id ` +
        `group by u.email, u.id`,
    )
    expect(ok.length).toBeGreaterThan(0)
  })

  it('distinct actually deduplicates the relation column, which is what needed the operator', async () => {
    // Two rows that differ only in their relation value must stay two; two that agree must
    // collapse. `union` of a query with itself is the cheapest way to make an exact duplicate.
    const one = () =>
      live.db.from(h().users, 'u').select((t) => ({
        posts: t.u.posts.many((sub) => sub.select((p) => ({ id: p.id })).orderBy((p) => q.asc(p.id))),
      }))
    const all = await one().execute()
    const deduped = await one().distinct().execute()
    // Ada has 5 posts, Bob 1, and everyone else none — so four users share the value `[]`.
    expect(all).toHaveLength(6)
    expect(deduped).toHaveLength(3)
  })
})

