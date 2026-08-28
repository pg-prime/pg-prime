/**
 * Relation accessors — the tier-0 goldens (design/09 WS5; `03` §2.3, §4.1).
 *
 * Every query here goes through the public builder (R11) and is pinned as byte-exact SQL plus
 * byte-exact binds (R2). The one thing a golden cannot prove is that PostgreSQL agrees these
 * mean what we think; `test/live-query/relations.test.ts` does that, against hand-written SQL.
 *
 * The generated aliases (`_r0`, `_r1`, …) are part of the golden on purpose. They are assigned
 * left-to-right by `planSelect` and shared between occurrences that common-subexpression
 * elimination collapsed, so a change in *which* alias appears where is a change in the plan —
 * exactly the thing a reviewer should be shown rather than have normalised away.
 */

import { describe, expect, it } from 'vitest'
import { numericCodec } from '../../src/codec/index.js'
import { buildDecoder } from '../../src/compile/decode.js'
import { SchemaError } from '../../src/sql/errors.js'
import {
  defineRelations,
  defineSchema,
  foreignKey,
  pgTable,
  REFS,
  resolveRelations,
} from '../../src/schema/index.js'
import type { RefLike } from '../../src/schema/index.js'
import { compileOnly } from '../../src/query/run.js'
import { add, desc, eq, fn, gt, isNull, isTrue, nest, over, sql } from '../../src/query/types.js'
import type { RefsAtAlias } from '../../src/query/ref.js'
import { makeFixture } from '../live/fixture.js'
import { schema } from './_schema.js'

const db = compileOnly(schema)

const fx = makeFixture('ns')
const live = compileOnly(fx.schema)

const values = (c: { binds: readonly unknown[] }): unknown[] =>
  c.binds.map((b) => (b as { encoded?: unknown }).encoded)

// ─────────────────────────────────────────────────────────────────────────────
// 03 §2.3 — the feed query, byte-exact from the builder
// ─────────────────────────────────────────────────────────────────────────────

describe('the 03 §2.3 feed query', () => {
  const feed = db
    .from(schema.h.users, 'users')
    .select((t) => ({
      id: t.users.id,
      email: t.users.email,
      postCount: t.users.posts.count(),
      revenue: t.users.posts.sum((p) => p.amount),
      revenueRank: over(fn.rank(), (w) => w.orderBy(desc(t.users.posts.sum((p) => p.amount)))),
      latestPosts: t.users.posts.many((q) =>
        q
          .select((p) => ({
            id: p.id,
            title: p.title,
            commentCount: p.comments.count(),
            author: p.author.one((a) => a.select((u) => ({ id: u.id, email: u.email }))),
          }))
          .where((p) => isTrue(p.published))
          .orderBy((p) => desc(p.createdAt))
          .limit(3),
      ),
    }))
    .where((t) => t.users.posts.some((p) => isTrue(p.published)))
    .orderBy((t) => desc(t.users.createdAt))
    .limit(20)

  it('compiles to exactly the SQL design/03 §2.3 shows', async () => {
    await expect(feed.compile().sql).toMatchFileSnapshot('./__sql__/feed.sql')
  })

  it('numbers the per-parent LIMIT before the parent LIMIT', () => {
    // `$n` is a single left-to-right textual pass over the already-hoisted tree, and the JOIN
    // clause precedes the LIMIT clause — so the relation's `limit 3` is `$1` and the query's own
    // `limit 20` is `$2`, with no numbering logic anywhere in the hoist. Exactly what 03 §2.3's
    // golden shows, and what `test/compile/nested.test.ts` pins at the AST level.
    expect(values(feed.compile())).toEqual(['3', '20'])
  })

  it('decodes each leaf through its own codec at every depth (R5, from the builder)', () => {
    const shape = feed.compile().shape as unknown as {
      fields: { key: string; k: string; idx?: number; codec?: { name: string }; plan?: unknown }[]
    }
    expect(shape.fields.map((f) => [f.key, f.k, f.codec?.name])).toEqual([
      ['id', 'col', 'int8'],
      ['email', 'col', 'varchar'],
      ['postCount', 'col', 'int8'],
      ['revenue', 'col', 'numeric'],
      ['revenueRank', 'col', 'int8'],
      ['latestPosts', 'json', undefined],
    ])
    expect(shape.fields[5]?.plan).toMatchObject({
      k: 'arr',
      item: {
        k: 'obj',
        fields: [
          { key: 'id', plan: { k: 'leaf', codec: { name: 'int8' } } },
          { key: 'title', plan: { k: 'leaf', codec: { name: 'text' } } },
          { key: 'commentCount', plan: { k: 'leaf', codec: { name: 'int8' } } },
          { key: 'author', plan: { k: 'obj', nullable: false } },
        ],
      },
    })
  })

  it('names every table it reads, including the ones only a relation reaches', () => {
    expect(
      feed
        .compile()
        .meta.reads.map((r) => r.name)
        .sort(),
    ).toEqual(['comments', 'posts', 'posts', 'posts', 'posts', 'users', 'users'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 03 §2.3 point 6 — the compiler's only common-subexpression elimination
// ─────────────────────────────────────────────────────────────────────────────

describe('shared relation aggregates', () => {
  it('emits one lateral for two identical aggregates and references it twice', () => {
    const c = db
      .from(schema.h.users, 'users')
      .select((t) => ({
        revenue: t.users.posts.sum((p) => p.amount),
        rank: over(fn.rank(), (w) => w.orderBy(desc(t.users.posts.sum((p) => p.amount)))),
      }))
      .compile()
    expect(c.sql.match(/left join lateral/g)).toHaveLength(1)
    expect(c.sql.split('\n')[0]).toBe(
      'select "_r0"."v" as "revenue", rank() over (order by "_r0"."v" desc) as "rank"',
    )
  })

  it('does NOT share two aggregates that differ in their predicate', () => {
    const c = db
      .from(schema.h.users, 'users')
      .select((t) => ({
        a: t.users.posts.sum((p) => p.amount),
        b: t.users.posts.count(),
      }))
      .compile()
    expect(c.sql.match(/left join lateral/g)).toHaveLength(2)
  })

  it('shares two aggregates that are structurally identical, however they were written', () => {
    const c = db
      .from(schema.h.users, 'users')
      .select((t) => ({ a: t.users.posts.count(), b: t.users.posts.count() }))
      .compile()
    expect(c.sql.match(/left join lateral/g)).toHaveLength(1)
    expect(c.sql.split('\n')[0]).toBe('select "_r0"."v" as "a", "_r0"."v" as "b"')
  })

  it('does NOT share two aggregates that differ only in a bind VALUE', () => {
    // The digest carries the *encoded parameter value*, not just the shape. Without that,
    // `sum(amount + 1)` and `sum(amount + 2)` would be the same string, collapse into one
    // lateral, and one of the two answers would be silently wrong — the worst failure mode this
    // whole mechanism can have, and the reason `scalar()` refuses to serialise a value it cannot
    // represent rather than emitting a placeholder for it.
    const c = db
      .from(schema.h.users, 'users')
      .select((t) => ({
        a: t.users.posts.sum((p) => add(p.amount, '1')),
        b: t.users.posts.sum((p) => add(p.amount, '2')),
      }))
      .compile()
    expect(c.sql.match(/left join lateral/g)).toHaveLength(2)
    expect(values(c)).toEqual(['1', '2'])
  })

  it('refuses to share anything containing a raw fragment — the volatility guard', () => {
    // `sql` is the escape hatch, so its contents are opaque: it could be `random()`, `nextval()`,
    // or a function this process has never heard of. Two occurrences therefore stay two laterals,
    // which is the safe direction — a duplicated subquery is slower, a wrongly shared one is
    // wrong. The digest returns `null` for a `raw` node and for every unrecognised node kind.
    const c = db
      .from(schema.h.users, 'users')
      .select((t) => ({
        a: t.users.posts.sum((p) => sql`${p.amount} + 0`.as(numericCodec)),
        b: t.users.posts.sum((p) => sql`${p.amount} + 0`.as(numericCodec)),
      }))
      .compile()
    expect(c.sql.match(/left join lateral/g)).toHaveLength(2)
  })

  it('keeps the aggregate usable in WHERE, where a lateral is still equivalent', () => {
    // `left join lateral … on true` never adds or removes a parent row, so lifting the aggregate
    // out of the WHERE clause cannot change which rows come back.
    const c = db
      .from(schema.h.users, 'users')
      .select((t) => ({ id: t.users.id }))
      .where((t) => gt(t.users.posts.count(), 3n))
      .compile()
    expect(c.sql).toBe(
      [
        'select "users"."id" as "id"',
        'from "public"."users" as "users"',
        'left join lateral (',
        '  select count(*) as "v"',
        '  from "public"."posts" as "posts"',
        '  where "posts"."author_id" = "users"."id"',
        ') as "_r0" on true',
        'where "_r0"."v" > $1',
      ].join('\n'),
    )
    expect(values(c)).toEqual(['3'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Relation filters (03 §2.3, ported from MikroORM's $some/$none/$every)
// ─────────────────────────────────────────────────────────────────────────────

describe('some / none / every / exists', () => {
  const whereOf = (c: { sql: string }): string => c.sql.split('\nwhere ')[1] as string
  const q = () => live.from(fx.schema.h.users, 'u').select((t) => ({ id: t.u.id }))

  it('some is EXISTS', () => {
    expect(
      whereOf(
        q()
          .where((t) => t.u.posts.some((p) => isTrue(p.published)))
          .compile(),
      ),
    ).toBe(
      [
        'exists (',
        '  select 1 as "v"',
        '  from "ns"."posts" as "posts"',
        '  where ("posts"."author_id" = "u"."id" and "posts"."published" is true)',
        ')',
      ].join('\n'),
    )
  })

  it('none is NOT EXISTS over the same body', () => {
    const some = whereOf(
      q()
        .where((t) => t.u.posts.some((p) => isTrue(p.published)))
        .compile(),
    )
    const none = whereOf(
      q()
        .where((t) => t.u.posts.none((p) => isTrue(p.published)))
        .compile(),
    )
    expect(none).toBe(`not ${some}`)
  })

  it('every is a null-safe double negation — `is not true`, not `not`', () => {
    // The difference is a related row whose predicate is NULL. `not (p)` is NULL, so
    // `not exists (… and not p)` would count that row as satisfying `every`; `(p) is not true`
    // does not. It is also vacuously true on a parent with no related rows at all, which is what
    // `NOT EXISTS` gives and what 03 §2.3 pins.
    expect(
      whereOf(
        q()
          .where((t) => t.u.posts.every((p) => isTrue(p.published)))
          .compile(),
      ),
    ).toBe(
      [
        'not exists (',
        '  select 1 as "v"',
        '  from "ns"."posts" as "posts"',
        '  where ("posts"."author_id" = "u"."id" and ("posts"."published" is true) is not true)',
        ')',
      ].join('\n'),
    )
  })

  it('exists() is some() with no predicate', () => {
    expect(
      whereOf(
        q()
          .where((t) => t.u.posts.exists())
          .compile(),
      ),
    ).toBe(
      [
        'exists (',
        '  select 1 as "v"',
        '  from "ns"."posts" as "posts"',
        '  where "posts"."author_id" = "u"."id"',
        ')',
      ].join('\n'),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// m2m and composite keys (03 §4.1 hard asks #2 and #3)
// ─────────────────────────────────────────────────────────────────────────────

describe('m2m through a junction', () => {
  it('joins the junction inside the lateral rather than nesting a second one', () => {
    const c = live
      .from(fx.schema.h.posts, 'p')
      .select((t) => ({
        tags: t.p.tags.many((q) => q.select((g) => ({ name: g.name })).orderBy((g) => g.name)),
      }))
      .compile()
    expect(c.sql).toBe(
      [
        'select "_r0"."v" as "tags"',
        'from "ns"."posts" as "p"',
        'left join lateral (',
        '  select coalesce(json_agg("x"."o" order by "x"."k0" asc), \'[]\'::json) as "v"',
        '  from (',
        '    select json_build_object(\'name\', "tags"."name") as "o", "tags"."name" as "k0"',
        '    from "ns"."tags" as "tags"',
        '    inner join "ns"."post_tags" as "post_tags" on "post_tags"."tag_id" = "tags"."id"',
        '    where "post_tags"."post_id" = "p"."id"',
        '    order by "tags"."name" asc',
        '  ) as "x"',
        ') as "_r0" on true',
      ].join('\n'),
    )
  })

  it('counts through the junction too', () => {
    const c = live
      .from(fx.schema.h.posts, 'p')
      .select((t) => ({ n: t.p.tags.count() }))
      .compile()
    expect(c.sql).toContain(
      'inner join "ns"."post_tags" as "post_tags" on "post_tags"."tag_id" = "tags"."id"',
    )
    expect(c.sql).toContain('where "post_tags"."post_id" = "p"."id"')
  })
})

describe('composite keys', () => {
  it('pairs the columns positionally and ANDs them', () => {
    const c = live
      .from(fx.schema.h.posts, 'p')
      .select((t) => ({ kv: t.p.kv.all() }))
      .compile()
    expect(c.sql).toContain('where ("kv"."k1" = "p"."k1" and "kv"."k2" = "p"."k2")')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Shapes and options
// ─────────────────────────────────────────────────────────────────────────────

describe('all / one / strategy / variant', () => {
  it('all() projects every column of the child, in declaration order', () => {
    const c = db
      .from(schema.h.users, 'users')
      .select((t) => ({ posts: t.users.posts.all() }))
      .compile()
    expect(c.sql).toContain(
      'json_build_object(\'id\', "posts"."id"::text, \'authorId\', "posts"."author_id"::text, ' +
        '\'title\', "posts"."title", \'amount\', "posts"."amount"::text, \'published\', ' +
        '"posts"."published", \'createdAt\', "posts"."created_at")',
    )
  })

  it('a required `one` decodes non-null; a `maybeOne` decodes `| null`', () => {
    const required = db
      .from(schema.h.posts, 'posts')
      .select((t) => ({ a: t.posts.author.all() }))
      .compile()
    const optional = live
      .from(fx.schema.h.posts, 'p')
      .select((t) => ({ kv: t.p.kv.all() }))
      .compile()
    expect(
      (required.shape as unknown as { fields: { nullable?: boolean }[] }).fields[0]?.nullable,
    ).toBe(false)
    expect(
      (optional.shape as unknown as { fields: { nullable?: boolean }[] }).fields[0]?.nullable,
    ).toBe(true)
  })

  it("strategy: 'subquery' emits the same query as a correlated scalar subquery", () => {
    const c = live
      .from(fx.schema.h.posts, 'p')
      .select((t) => ({
        cs: t.p.comments.many((q) => q.select((x) => ({ b: x.body })), { strategy: 'subquery' }),
      }))
      .compile()
    expect(c.sql).not.toContain('left join lateral')
    expect(c.sql).toContain('select coalesce(json_agg("x"."o"), \'[]\'::json) as "v"')
  })

  it("variant: 'jsonb' switches both the builder and the aggregate", () => {
    const c = live
      .from(fx.schema.h.posts, 'p')
      .select((t) => ({
        cs: t.p.comments.many((q) => q.select((x) => ({ b: x.body })), { variant: 'jsonb' }),
      }))
      .compile()
    expect(c.sql).toContain('jsonb_agg')
    expect(c.sql).toContain("'[]'::jsonb")
    expect(c.sql).toContain('jsonb_build_object')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Declaration defaults
// ─────────────────────────────────────────────────────────────────────────────

describe('defaults carried by the declaration (03 §4.1)', () => {
  const t2 = {
    users: pgTable('users', (t) => ({ id: t.bigint().primaryKey() })),
    posts: pgTable('posts', (t) => ({
      id: t.bigint().primaryKey(),
      authorId: t.bigint(),
      createdAt: t.timestamptz(),
      deletedAt: t.timestamptz().nullable(),
    })),
  }
  const s2 = defineSchema(
    t2,
    defineRelations(t2, (r) => ({
      users: {
        posts: r.many.posts({
          from: t2.users[REFS].id,
          to: t2.posts[REFS].authorId,
          where: (p: RefsAtAlias<typeof t2.posts, 'posts'>) => isNull(p.deletedAt),
          orderBy: (p: RefsAtAlias<typeof t2.posts, 'posts'>) => desc(p.createdAt),
        }),
      },
    })),
  )
  const d2 = compileOnly(s2)

  it('ANDs the declared `where` into every accessor, including the aggregates', () => {
    const many = d2
      .from(s2.h.users, 'u')
      .select((t) => ({ p: t.u.posts.all() }))
      .compile()
    const count = d2
      .from(s2.h.users, 'u')
      .select((t) => ({ n: t.u.posts.count() }))
      .compile()
    expect(many.sql).toContain(
      'where ("posts"."author_id" = "u"."id" and "posts"."deleted_at" is null)',
    )
    expect(count.sql).toContain(
      'where ("posts"."author_id" = "u"."id" and "posts"."deleted_at" is null)',
    )
  })

  it('uses the declared `orderBy` when the caller supplies none', () => {
    const c = d2
      .from(s2.h.users, 'u')
      .select((t) => ({ p: t.u.posts.all() }))
      .compile()
    expect(c.sql).toContain('order by "posts"."created_at" desc')
    expect(c.sql).toContain('order by "x"."k0" desc')
  })

  it('a caller `orderBy` replaces the declared one wholesale', () => {
    const c = d2
      .from(s2.h.users, 'u')
      .select((t) => ({ p: t.u.posts.many((q) => q.orderBy((p) => p.id)) }))
      .compile()
    expect(c.sql).toContain('order by "posts"."id" asc')
    expect(c.sql).not.toContain('order by "posts"."created_at" desc')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Aliases
// ─────────────────────────────────────────────────────────────────────────────

describe('child aliases', () => {
  it('binds the child under its own registry key', () => {
    const c = db
      .from(schema.h.users, 'u')
      .select((t) => ({ p: t.u.posts.all() }))
      .compile()
    expect(c.sql).toContain('from "public"."posts" as "posts"')
  })

  it('suffixes only when the child would shadow an ANCESTOR', () => {
    // `users` inside a query already aliased `users` would make the correlation a
    // self-comparison. A *sibling* alias is different: an inner `posts` hiding a joined `posts`
    // is harmless, because a lateral's correlation only ever names an alias further out.
    const c = db
      .from(schema.h.posts, 'users')
      .select((t) => ({ a: t.users.author.all() }))
      .compile()
    expect(c.sql).toContain('from "public"."users" as "users2"')
    expect(c.sql).toContain('where "users2"."id" = "users"."author_id"')
  })
})

describe('avg / min / max over a relation (12 B)', () => {
  it('avg emits the aggregate uncoalesced, hoisted like sum, with numeric as the result codec', () => {
    const c = db
      .from(schema.h.users, 'users')
      .select((t) => ({ avgAmount: t.users.posts.avg((p) => p.amount) }))
      .compile()
    expect(c.sql).toBe(
      [
        'select "_r0"."v" as "avgAmount"',
        'from "public"."users" as "users"',
        'left join lateral (',
        '  select avg("posts"."amount") as "v"',
        '  from "public"."posts" as "posts"',
        '  where "posts"."author_id" = "users"."id"',
        ') as "_r0" on true',
      ].join('\n'),
    )
    // `avg(numeric)` is `numeric`, which decodes to a precision-exact string — never a float.
    expect(buildDecoder(c.shape)([['1.005']])).toStrictEqual([{ avgAmount: '1.005' }])
    expect(buildDecoder(c.shape)([[null]])).toStrictEqual([{ avgAmount: null }])
  })

  it('R4 — sum IS coalesced and avg/min/max are NOT: zero is a sum, never an average', () => {
    const sqlFor = (f: (t: never) => unknown): string =>
      (
        db
          .from(schema.h.users, 'users')
          .select(f as never)
          .compile() as { sql: string }
      ).sql
    expect(
      sqlFor(((t: { users: { posts: { sum: (f: unknown) => unknown } } }) => ({
        v: t.users.posts.sum((p: { amount: unknown }) => p.amount),
      })) as never),
    ).toContain('coalesce(sum("posts"."amount"), 0)')
    for (const name of ['avg', 'min', 'max'] as const) {
      const built = sqlFor(((t: Record<string, never>) => ({
        v: (t['users'] as never as Record<string, Record<string, (f: unknown) => unknown>>)[
          'posts'
        ]?.[name]?.((p: { amount: unknown }) => p.amount),
      })) as never)
      expect(built).toContain(`${name}("posts"."amount") as "v"`)
      expect(built).not.toContain('coalesce')
    }
  })

  it('min / max keep the operand codec, so a bigint stays exact past 2^53', () => {
    const c = db
      .from(schema.h.users, 'users')
      .select((t) => ({
        newest: t.users.posts.max((p) => p.id),
        oldest: t.users.posts.min((p) => p.id),
      }))
      .compile()
    expect(c.sql).toContain('max("posts"."id") as "v"')
    expect(c.sql).toContain('min("posts"."id") as "v"')
    expect(buildDecoder(c.shape)([['9007199254740993', '1']])).toStrictEqual([
      { newest: 9007199254740993n, oldest: 1n },
    ])
  })

  it('they share a lateral with an identical sibling and not with a different one', () => {
    const shared = db
      .from(schema.h.users, 'users')
      .select((t) => ({
        a: t.users.posts.avg((p) => p.amount),
        rank: over(fn.rank(), (w) => w.orderBy(desc(t.users.posts.avg((p) => p.amount)))),
      }))
      .compile()
    expect(shared.sql.match(/left join lateral/g)).toHaveLength(1)
    expect(shared.sql.split('\n')[0]).toBe(
      'select "_r0"."v" as "a", rank() over (order by "_r0"."v" desc) as "rank"',
    )
    const distinctAggs = db
      .from(schema.h.users, 'users')
      .select((t) => ({
        a: t.users.posts.avg((p) => p.amount),
        b: t.users.posts.min((p) => p.amount),
        c: t.users.posts.max((p) => p.amount),
      }))
      .compile()
    expect(distinctAggs.sql.match(/left join lateral/g)).toHaveLength(3)
  })

  it('the declared `where` reaches them, and they work in a RETURNING list', () => {
    const c = live
      .update(fx.schema.h.posts)
      .set(() => ({ title: 'x' }))
      .where((t) => eq(t.posts.id, 1n))
      .returning((t) => ({ newest: t.posts.comments.max((x) => x.id) }))
      .compile()
    // No FROM clause to hang a lateral on, so it stays the correlated subquery it always was.
    expect(c.sql).toContain('returning (\n  select max("comments"."id") as "v"')
    expect(c.sql).not.toContain('lateral')
  })

  it('an operand that is not an expression is refused, naming the accessor and the relation', () => {
    expect(() =>
      db
        .from(schema.h.users, 'users')
        .select((t) => ({ v: t.users.posts.avg(() => 1 as never) }))
        .compile(),
    ).toThrowError(/avg\(\) on relation "users\.posts"/)
  })
})

describe('FK inference (12 decision 18)', () => {
  const orgs = pgTable('orgs', (t) => ({ id: t.bigint().primaryKey() }))
  const people = pgTable('people', (t) => ({
    id: t.bigint().primaryKey(),
    orgId: t.bigint().references(() => orgs[REFS].id),
  }))

  it('a `one` follows the child own foreign key to its parent', () => {
    const tables = { orgs, people }
    const s = defineSchema(
      tables,
      defineRelations(tables, (r) => ({ people: { org: r.one.orgs() } })),
    )
    expect(resolveRelations(s.tables, s.rels)['people']?.['org']).toMatchObject({
      from: ['orgId'],
      to: ['id'],
      kind: 'one',
    })
    expect(
      compileOnly(s)
        .from(s.h.people)
        .select((t) => ({ o: t.people.org.one((x) => x.select((y) => ({ id: y.id }))) }))
        .compile().sql,
    ).toContain('where "orgs"."id" = "people"."org_id"')
  })

  it('a `many` follows the inverse, and the inferred pair is the same pair', () => {
    const tables = { orgs, people }
    const s = defineSchema(
      tables,
      defineRelations(tables, (r) => ({ orgs: { people: r.many.people() } })),
    )
    expect(resolveRelations(s.tables, s.rels)['orgs']?.['people']).toMatchObject({
      from: ['id'],
      to: ['orgId'],
      kind: 'many',
    })
  })

  it('an explicit from/to always wins, even when a foreign key exists', () => {
    const tables = { orgs, people }
    const s = defineSchema(
      tables,
      defineRelations(tables, (r) => ({
        people: { org: r.one.orgs({ from: people[REFS].id, to: orgs[REFS].id }) },
      })),
    )
    expect(resolveRelations(s.tables, s.rels)['people']?.['org']).toMatchObject({ from: ['id'] })
  })

  it('two foreign keys to the same table are refused, with both candidates named', () => {
    const twoFks = pgTable('memberships', (t) => ({
      id: t.bigint().primaryKey(),
      orgId: t.bigint().references(() => orgs[REFS].id),
      parentOrgId: t.bigint().references(() => orgs[REFS].id),
    }))
    const tables = { orgs, memberships: twoFks }
    const build = (): unknown =>
      defineSchema(
        tables,
        defineRelations(tables, (r) => ({ memberships: { org: r.one.orgs() } })),
      )
    expect(build).toThrowError(SchemaError)
    expect(build).toThrowError(/could be inferred from 2 foreign keys/)
    expect(build).toThrowError(
      /memberships\.orgId -> orgs\.id, memberships\.parentOrgId -> orgs\.id/,
    )
  })

  it('a composite `foreignKey(...)` extra is inferred, and pairs positionally', () => {
    const parent = pgTable('pairs', (t) => ({ a: t.bigint(), b: t.text() }))
    const child = pgTable(
      'kids',
      (t) => ({ id: t.bigint().primaryKey(), pa: t.bigint(), pb: t.text() }),
      (t) => [
        foreignKey({ columns: [t.pa, t.pb], references: () => [parent[REFS].a, parent[REFS].b] }),
      ],
    )
    const tables = { pairs: parent, kids: child }
    const s = defineSchema(
      tables,
      defineRelations(tables, (r) => ({ kids: { parent: r.one.pairs() } })),
    )
    expect(resolveRelations(s.tables, s.rels)['kids']?.['parent']).toMatchObject({
      from: ['pa', 'pb'],
      to: ['a', 'b'],
    })
  })

  it('a column-level and an equivalent table-level key are ONE candidate, not an ambiguity', () => {
    const child = pgTable(
      'dupes',
      (t) => ({ id: t.bigint().primaryKey(), orgId: t.bigint().references(() => orgs[REFS].id) }),
      (t) => [foreignKey({ columns: [t.orgId], references: () => [orgs[REFS].id] })],
    )
    const tables = { orgs, dupes: child }
    expect(() =>
      defineSchema(
        tables,
        defineRelations(tables, (r) => ({ dupes: { org: r.one.orgs() } })),
      ),
    ).not.toThrow()
  })

  it('a self-referencing key resolves in both directions', () => {
    const nodes = pgTable('nodes', (t) => ({
      id: t.bigint().primaryKey(),
      parentId: t
        .bigint()
        .nullable()
        .references((): RefLike => nodes[REFS].id),
    }))
    const tables = { nodes }
    const s = defineSchema(
      tables,
      defineRelations(tables, (r) => ({
        nodes: { parent: r.maybeOne.nodes(), children: r.many.nodes() },
      })),
    )
    const rels = resolveRelations(s.tables, s.rels)['nodes']
    expect(rels?.['parent']).toMatchObject({ from: ['parentId'], to: ['id'] })
    expect(rels?.['children']).toMatchObject({ from: ['id'], to: ['parentId'] })
  })

  it('a foreign key is matched schema-first: two tables of the same name do not collide', () => {
    // `RefRuntime` carries the schema for exactly this case (`11` §3 K2a's cross-schema FK test).
    // Matching on the table name alone would resolve `kids.orgId` against whichever `orgs` the
    // relation happens to name — a correlation between two tables with no foreign key at all.
    const orgsA = pgTable('orgs', (t) => ({ id: t.bigint().primaryKey() }), undefined, {
      schema: 'tenant_a',
    })
    const orgsB = pgTable('orgs', (t) => ({ id: t.bigint().primaryKey() }), undefined, {
      schema: 'tenant_b',
    })
    const kids = pgTable('kids', (t) => ({
      id: t.bigint().primaryKey(),
      orgId: t.bigint().references(() => orgsA[REFS].id),
    }))
    const tables = { orgsA, orgsB, kids }
    const build = (to: 'orgsA' | 'orgsB') =>
      defineSchema(
        tables,
        defineRelations(tables, (r) => ({ kids: { org: r.one[to]() } })),
      )
    expect(
      resolveRelations(build('orgsA').tables, build('orgsA').rels)['kids']?.['org'],
    ).toMatchObject({ from: ['orgId'], to: ['id'], target: 'orgsA' })
    expect(() => build('orgsB')).toThrowError(/nothing in "kids" references "orgs"/)
  })

  it('the m2m `through` form infers both hops from the junction table alone', () => {
    const left = pgTable('lefts', (t) => ({ id: t.bigint().primaryKey() }))
    const right = pgTable('rights', (t) => ({ id: t.bigint().primaryKey() }))
    const junction = pgTable('link', (t) => ({
      leftId: t.bigint().references(() => left[REFS].id),
      rightId: t.bigint().references(() => right[REFS].id),
    }))
    const tables = { lefts: left, rights: right, link: junction }
    const s = defineSchema(
      tables,
      defineRelations(tables, (r) => ({ lefts: { rights: r.many.rights({ through: junction }) } })),
    )
    expect(resolveRelations(s.tables, s.rels)['lefts']?.['rights']).toMatchObject({
      from: ['id'],
      to: ['id'],
      through: { from: ['leftId'], to: ['rightId'] },
    })
    expect(
      compileOnly(s)
        .from(s.h.lefts)
        .select((t) => ({ rs: t.lefts.rights.all() }))
        .compile().sql,
    ).toContain('inner join "public"."link" as "link" on "link"."right_id" = "rights"."id"')
  })

  it('a `through` with only one hop declared is refused', () => {
    const left = pgTable('lefts', (t) => ({ id: t.bigint().primaryKey() }))
    const right = pgTable('rights', (t) => ({ id: t.bigint().primaryKey() }))
    const junction = pgTable('link', (t) => ({
      leftId: t.bigint().references(() => left[REFS].id),
      rightId: t.bigint().references(() => right[REFS].id),
    }))
    const tables = { lefts: left, rights: right, link: junction }
    expect(() =>
      defineSchema(
        tables,
        defineRelations(tables, (r) => ({
          lefts: {
            rights: r.many.rights({ through: { table: junction, from: junction[REFS].leftId } }),
          },
        })),
      ),
    ).toThrowError(/declares `through.from` without `through.to`/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// defineSchema rejects (03 §4.1's hard asks, at definition time)
// ─────────────────────────────────────────────────────────────────────────────

describe('defineSchema validation', () => {
  const users = pgTable('users', (t) => ({ id: t.bigint().primaryKey(), posts: t.text() }))
  const posts = pgTable('posts', (t) => ({ id: t.bigint().primaryKey(), authorId: t.bigint() }))

  it('rejects a relation whose name collides with a column (hard ask #1)', () => {
    const tables = { users, posts }
    expect(() =>
      defineSchema(
        tables,
        defineRelations(tables, (r) => ({
          users: { posts: r.many.posts({ from: users[REFS].id, to: posts[REFS].authorId }) },
        })),
      ),
    ).toThrow(SchemaError)
    expect(() =>
      defineSchema(
        tables,
        defineRelations(tables, (r) => ({
          users: { posts: r.many.posts({ from: users[REFS].id, to: posts[REFS].authorId }) },
        })),
      ),
    ).toThrow(/same name as a column/)
  })

  it('rejects a relation with no from/to and no foreign key to infer one from', () => {
    const tables = { users, posts }
    // `posts.authorId` carries no `.references()`, so there is nothing to infer and nothing
    // declared. The sentence has to name both fixes, because either one is a legitimate answer.
    expect(() =>
      defineSchema(
        tables,
        defineRelations(tables, (r) => ({ posts: { author: r.one.users() } })),
      ),
    ).toThrow(/no foreign key to infer them from/)
    expect(() =>
      defineSchema(
        tables,
        defineRelations(tables, (r) => ({ posts: { author: r.one.users() } })),
      ),
    ).toThrow(/nothing in "posts" references "users"/)
  })

  it('rejects `from` without `to`', () => {
    const tables = { users, posts }
    expect(() =>
      defineSchema(
        tables,
        defineRelations(tables, (r) => ({
          posts: { author: r.one.users({ from: posts[REFS].authorId }) },
        })),
      ),
    ).toThrow(/declares `from` without `to`/)
  })

  it('rejects a from/to arity mismatch', () => {
    const tables = { users, posts }
    expect(() =>
      defineSchema(
        tables,
        defineRelations(tables, (r) => ({
          posts: {
            author: r.one.users({
              from: [posts[REFS].id, posts[REFS].authorId],
              to: users[REFS].id,
            }),
          },
        })),
      ),
    ).toThrow(/same length/)
  })

  it('rejects a column reference that belongs to the wrong table', () => {
    const tables = { users, posts }
    expect(() =>
      defineSchema(
        tables,
        defineRelations(tables, (r) => ({
          posts: { author: r.one.users({ from: posts[REFS].authorId, to: posts[REFS].id }) },
        })),
      ),
    ).toThrow(/must be a column of "users"/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// RETURNING (03 §2.5 + §2.3)
// ─────────────────────────────────────────────────────────────────────────────

describe('relations in RETURNING', () => {
  it('a relation aggregate stays a correlated subquery, which RETURNING accepts', () => {
    const c = live
      .update(fx.schema.h.posts)
      .set(() => ({ title: 'x' }))
      .where((t) => eq(t.posts.id, 1n))
      .returning((t) => ({ id: t.posts.id, n: t.posts.comments.count() }))
      .compile()
    // The target's own columns are unqualified — RETURNING implicitly names the target — but the
    // correlated subquery has its own FROM clause, so *its* columns must be qualified or
    // `comments.post_id = posts.id` degenerates into comparing two columns of `comments`.
    expect(c.sql).toContain('returning "id" as "id", (')
    expect(c.sql).toContain('  where "comments"."post_id" = "posts"."id"')
  })

  it('a relation projection needs the subquery strategy, and says so', () => {
    expect(() =>
      live
        .update(fx.schema.h.posts)
        .set(() => ({ title: 'x' }))
        .allRows()
        .returning((t) => ({ cs: t.posts.comments.all() }))
        .compile(),
    ).toThrow(/strategy: 'subquery'/)
  })

  it('…and works with it', () => {
    const c = live
      .update(fx.schema.h.posts)
      .set(() => ({ title: 'x' }))
      .allRows()
      .returning((t) => ({ cs: t.posts.comments.all({ strategy: 'subquery' }) }))
      .compile()
    expect(c.sql).toContain('returning (')
    expect(c.sql).toContain('json_agg')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A declaration's own scope lambdas run at CALL time, both of them
// ─────────────────────────────────────────────────────────────────────────────

describe('a declared relation `where` is evaluated per use, like `orderBy`', () => {
  const parents = pgTable('parents', (t) => ({ id: t.bigint().primaryKey() }))
  const children = pgTable('children', (t) => ({
    id: t.bigint().primaryKey(),
    parentId: t.bigint(),
    tenant: t.text(),
  }))
  const tables = { parents, children }

  let tenant = 'acme'
  const scoped = defineSchema(
    tables,
    defineRelations(tables, (r) => ({
      parents: {
        children: r.many.children({
          from: parents[REFS].id,
          to: children[REFS].parentId,
          where: (c: RefsAtAlias<typeof children, 'children'>) => eq(c.tenant, tenant),
        }),
      },
    })),
  )
  const scopedDb = compileOnly(scoped)

  const count = () =>
    scopedDb
      .from(scoped.h.parents)
      .select((t) => ({ n: t.parents.children.count() }))
      .compile()

  it('the second use sees the second tenant, not the first one for ever', () => {
    // `rel.where` used to be folded into a `Correlated` memoised on the accessor object, and the
    // accessor lives in the per-(registry, handle, alias) scope cache — i.e. for the process's
    // lifetime. `rel.orderBy` was already re-evaluated on every use, so the two halves of one
    // declaration disagreed about when they ran.
    expect(values(count())).toStrictEqual(['acme'])
    tenant = 'globex'
    expect(values(count())).toStrictEqual(['globex'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A relation's child alias avoids every alias the statement binds, not just its ancestors
// ─────────────────────────────────────────────────────────────────────────────

describe('a relation sub-query does not shadow a SIBLING alias', () => {
  it('the child is suffixed when it collides with a joined alias', () => {
    // With `users JOIN posts`, the relation's child was ALSO called "posts", so the sub-query's
    // own scope hid the joined one: `gt(c.id, t.posts.id)` compiled to `"posts"."id" >
    // "posts"."id"` — false for every row, no error, an empty array for every parent.
    const built = db
      .from(schema.h.users)
      .innerJoin(schema.h.posts, (t) => eq(t.posts.authorId, t.users.id))
      .select((t) => ({
        pid: t.posts.id,
        later: t.users.posts.many((sq) =>
          sq.select((c) => ({ id: c.id })).where((c) => gt(c.id, t.posts.id)),
        ),
      }))
    expect(built.compile().sql).toBe(
      [
        'select "posts"."id" as "pid", "_r0"."v" as "later"',
        'from "public"."users" as "users"',
        'inner join "public"."posts" as "posts" on "posts"."author_id" = "users"."id"',
        'left join lateral (',
        '  select coalesce(json_agg("x"."o"), \'[]\'::json) as "v"',
        '  from (',
        '    select json_build_object(\'id\', "posts2"."id"::text) as "o"',
        '    from "public"."posts" as "posts2"',
        '    where ("posts2"."author_id" = "users"."id" and "posts2"."id" > "posts"."id")',
        '  ) as "x"',
        ') as "_r0" on true',
      ].join('\n'),
    )
  })

  it('with no sibling to collide with, the child keeps its own name', () => {
    const built = db
      .from(schema.h.users)
      .select((t) => ({ mine: t.users.posts.many((sq) => sq.select((c) => ({ id: c.id }))) }))
    expect(built.compile().sql).toContain('from "public"."posts" as "posts"')
    expect(built.compile().sql).not.toContain('posts2')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 03 §2.3 point 5, AS BUILT 2026-08-27 — jsonb when the statement compares rows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `json` has no equality operator, so `select distinct` over a relation column is
 * `42883 could not identify an equality operator for type json` at execute time (WS7 fuzz seeds
 * 2802423309 and 3300751089). `jsonb` has one, the value is the same value, and the decode plan
 * does not change — so the variant switches itself, and only where equality is actually needed.
 *
 * The negative controls are half of this block: the *non*-distinct forms must stay byte-identical
 * `json`, or "only where it is needed" is a claim with nothing behind it.
 */
describe('a relation column under distinct is jsonb', () => {
  it('select distinct: json_agg → jsonb_agg, json_build_object → jsonb_build_object', () => {
    const built = db
      .from(schema.h.users, 'users')
      .distinct()
      .select((t) => ({
        id: t.users.id,
        posts: t.users.posts.many((sq) => sq.select((p) => ({ id: p.id, amount: p.amount }))),
      }))
    expect(built.compile().sql).toBe(
      [
        'select distinct "users"."id" as "id", "_r0"."v" as "posts"',
        'from "public"."users" as "users"',
        'left join lateral (',
        '  select coalesce(jsonb_agg("x"."o"), \'[]\'::jsonb) as "v"',
        '  from (',
        '    select jsonb_build_object(\'id\', "posts"."id"::text, \'amount\', ' +
          '"posts"."amount"::text) as "o"',
        '    from "public"."posts" as "posts"',
        '    where "posts"."author_id" = "users"."id"',
        '  ) as "x"',
        ') as "_r0" on true',
      ].join('\n'),
    )
  })

  it('without distinct it is json, byte for byte — the switch is not unconditional', () => {
    const sql = db
      .from(schema.h.users, 'users')
      .select((t) => ({
        id: t.users.id,
        posts: t.users.posts.many((sq) => sq.select((p) => ({ id: p.id, amount: p.amount }))),
      }))
      .compile().sql
    expect(sql).toContain('coalesce(json_agg("x"."o"), \'[]\'::json)')
    expect(sql).not.toContain('jsonb')
  })

  it('distinct ON stays json — only its own keys are compared, not the whole row', () => {
    const sql = db
      .from(schema.h.users, 'users')
      .distinctOn((t) => t.users.email)
      .select((t) => ({
        id: t.users.id,
        posts: t.users.posts.many((sq) => sq.select((p) => ({ id: p.id }))),
      }))
      .compile().sql
    expect(sql).toContain('coalesce(json_agg("x"."o"), \'[]\'::json)')
    expect(sql).not.toContain('jsonb')
  })

  it('the decode plan is identical either way — the variant never reaches a codec', () => {
    const plain = db
      .from(schema.h.users, 'users')
      .select((t) => ({
        id: t.users.id,
        posts: t.users.posts.many((sq) => sq.select((p) => ({ id: p.id, amount: p.amount }))),
      }))
      .compile().shape
    const distinct = db
      .from(schema.h.users, 'users')
      .distinct()
      .select((t) => ({
        id: t.users.id,
        posts: t.users.posts.many((sq) => sq.select((p) => ({ id: p.id, amount: p.amount }))),
      }))
      .compile().shape
    expect(distinct).toStrictEqual(plain)
  })

  it('a relation inside a nest({...}) group is a row column too, so it switches as well', () => {
    const sql = db
      .from(schema.h.users, 'users')
      .distinct()
      .select((t) => ({
        id: t.users.id,
        g: nest({ posts: t.users.posts.many((sq) => sq.select((p) => ({ id: p.id }))) }),
      }))
      .compile().sql
    expect(sql).toContain('jsonb_agg')
    expect(sql).not.toContain('coalesce(json_agg')
  })

  /**
   * A relation *inside* a relation is a member of the enclosing json object, not a column of the
   * row, so nothing compares it: the outer aggregate is `jsonb`, the inner stays `json` and
   * `jsonb_build_object` coerces it on the way in. Pinned because "make everything jsonb" is the
   * tempting over-correction, and it would move every nested golden for nothing.
   */
  it('a relation nested inside a relation keeps json — only the row column needs equality', () => {
    const sql = db
      .from(schema.h.users, 'users')
      .distinct()
      .select((t) => ({
        id: t.users.id,
        posts: t.users.posts.many((sq) =>
          sq.select((p) => ({
            id: p.id,
            comments: p.comments.many((s2) => s2.select((c) => ({ id: c.id }))),
          })),
        ),
      }))
      .compile().sql
    expect(sql).toContain('jsonb_agg("x"."o")')
    expect(sql).toContain('coalesce(json_agg("x"."o"), \'[]\'::json)')
  })

  it("an explicit { variant: 'json' } under distinct is refused, not silently overridden", () => {
    let message = ''
    try {
      db.from(schema.h.users, 'users')
        .distinct()
        .select((t) => ({
          id: t.users.id,
          posts: t.users.posts.many((sq) => sq.select((p) => ({ id: p.id })), { variant: 'json' }),
        }))
        .compile()
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toBe(
      'pg-prime: relation "posts" asks for { variant: \'json\' } in a statement that compares ' +
        'whole rows (distinct, union, intersect, except), and PostgreSQL cannot compare json ' +
        '(42883). Drop the option — jsonb is used there automatically — or drop the distinct.',
    )
    // D9 (design/04 §4): one line, under 300 characters.
    expect(message).not.toContain('\n')
    expect(message.length).toBeLessThan(300)
  })

  it("an explicit { variant: 'jsonb' } under distinct is simply what happens anyway", () => {
    expect(() =>
      db
        .from(schema.h.users, 'users')
        .distinct()
        .select((t) => ({
          id: t.users.id,
          posts: t.users.posts.many((sq) => sq.select((p) => ({ id: p.id })), { variant: 'jsonb' }),
        }))
        .compile(),
    ).not.toThrow()
  })
})
