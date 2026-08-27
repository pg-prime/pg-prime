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
import { SchemaError } from '../../src/sql/errors.js'
import { defineRelations, defineSchema, pgTable, REFS } from '../../src/schema/index.js'
import { compileOnly } from '../../src/query/run.js'
import { add, desc, eq, fn, gt, isNull, isTrue, over, sql } from '../../src/query/types.js'
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
    expect(feed.compile().meta.reads.map((r) => r.name).sort()).toEqual([
      'comments',
      'posts',
      'posts',
      'posts',
      'posts',
      'users',
      'users',
    ])
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
    expect(whereOf(q().where((t) => t.u.posts.some((p) => isTrue(p.published))).compile())).toBe(
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
    const some = whereOf(q().where((t) => t.u.posts.some((p) => isTrue(p.published))).compile())
    const none = whereOf(q().where((t) => t.u.posts.none((p) => isTrue(p.published))).compile())
    expect(none).toBe(`not ${some}`)
  })

  it('every is a null-safe double negation — `is not true`, not `not`', () => {
    // The difference is a related row whose predicate is NULL. `not (p)` is NULL, so
    // `not exists (… and not p)` would count that row as satisfying `every`; `(p) is not true`
    // does not. It is also vacuously true on a parent with no related rows at all, which is what
    // `NOT EXISTS` gives and what 03 §2.3 pins.
    expect(whereOf(q().where((t) => t.u.posts.every((p) => isTrue(p.published))).compile())).toBe(
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
    expect(whereOf(q().where((t) => t.u.posts.exists()).compile())).toBe(
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
    expect(c.sql).toContain('inner join "ns"."post_tags" as "post_tags" on "post_tags"."tag_id" = "tags"."id"')
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
      "json_build_object('id', \"posts\".\"id\"::text, 'authorId', \"posts\".\"author_id\"::text, " +
        "'title', \"posts\".\"title\", 'amount', \"posts\".\"amount\"::text, 'published', " +
        '"posts"."published", \'createdAt\', "posts"."created_at")',
    )
  })

  it("a required `one` decodes non-null; a `maybeOne` decodes `| null`", () => {
    const required = db
      .from(schema.h.posts, 'posts')
      .select((t) => ({ a: t.posts.author.all() }))
      .compile()
    const optional = live
      .from(fx.schema.h.posts, 'p')
      .select((t) => ({ kv: t.p.kv.all() }))
      .compile()
    expect((required.shape as unknown as { fields: { nullable?: boolean }[] }).fields[0]?.nullable).toBe(false)
    expect((optional.shape as unknown as { fields: { nullable?: boolean }[] }).fields[0]?.nullable).toBe(true)
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
    const many = d2.from(s2.h.users, 'u').select((t) => ({ p: t.u.posts.all() })).compile()
    const count = d2.from(s2.h.users, 'u').select((t) => ({ n: t.u.posts.count() })).compile()
    expect(many.sql).toContain('where ("posts"."author_id" = "u"."id" and "posts"."deleted_at" is null)')
    expect(count.sql).toContain('where ("posts"."author_id" = "u"."id" and "posts"."deleted_at" is null)')
  })

  it('uses the declared `orderBy` when the caller supplies none', () => {
    const c = d2.from(s2.h.users, 'u').select((t) => ({ p: t.u.posts.all() })).compile()
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
    const c = db.from(schema.h.users, 'u').select((t) => ({ p: t.u.posts.all() })).compile()
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

  it('rejects a relation with no explicit from/to, naming what to write', () => {
    const tables = { users, posts }
    expect(() =>
      defineSchema(
        tables,
        // The config is required at the type level now, so the untyped route (a schema built
        // from JSON, or plain JavaScript) is what still reaches the runtime check.
        defineRelations(tables, (r) => ({
          posts: { author: r.one.users(JSON.parse('{}') as never) },
        })),
      ),
    ).toThrow(/needs explicit `from` and `to`/)
  })

  it('rejects a from/to arity mismatch', () => {
    const tables = { users, posts }
    expect(() =>
      defineSchema(
        tables,
        defineRelations(tables, (r) => ({
          posts: {
            author: r.one.users({ from: [posts[REFS].id, posts[REFS].authorId], to: users[REFS].id }),
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

  it("…and works with it", () => {
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

