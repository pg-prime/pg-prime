/**
 * CTEs, including writable ones, tier 0 (design/09 WS4; `03` §2.7, Appendix A).
 *
 * The claim `03` §2.7 makes and Kysely cannot: **codecs flow through the CTE**, because a CTE's
 * row shape is our own `ResultShape` and not a column list re-parsed out of a string. So
 * `recent.amount` is a `numeric` codec five clauses later, and a `bigint` id stays a `bigint`.
 * Every test below that asserts a `shape` is asserting that.
 *
 * The second claim is structural: a CTE is a table handle over a synthetic one-table schema, so
 * `.innerJoin(d.cte.recent, …)` needs no new method and no "is this alias a CTE?" branch exists.
 */

import { describe, expect, it } from 'vitest'
import { compileOnly } from '../../src/query/run.js'
import * as q from '../../src/query/types.js'
import { schema } from './_schema.js'

const db = compileOnly(schema)
const sqlOf = (b: { compile(): { sql: string } }) => b.compile().sql

describe('§2.7 — .with() widens the scope', () => {
  const withRecent = () =>
    db.with('recent', (d) =>
      d
        .from(schema.h.posts)
        .select(({ posts: p }) => ({ id: p.id, authorId: p.authorId, amount: p.amount }))
        .where(({ posts: p }) => q.gt(p.createdAt, new Date('2026-01-01T00:00:00Z'))),
    )

  it('declares the CTE first, so its parameters get the lowest $n', () => {
    const built = withRecent()
      .fromCte('recent')
      .select(({ recent: r }) => ({ id: r.id }))
      .limit(5)
    expect(sqlOf(built)).toBe(
      [
        'with "recent" as (',
        '  select "posts"."id" as "id", "posts"."author_id" as "authorId", "posts"."amount" as "amount"',
        '  from "public"."posts" as "posts"',
        '  where "posts"."created_at" > $1',
        ')',
        'select "recent"."id" as "id"',
        'from "recent" as "recent"',
        'limit $2',
      ].join('\n'),
    )
  })

  it('codecs flow through: numeric stays numeric, int8 stays int8', () => {
    const built = withRecent()
      .fromCte('recent', 'r')
      .select(({ r }) => ({ id: r.id, amount: r.amount }))
    expect(built.compile().shape).toMatchObject({
      fields: [
        { key: 'id', k: 'col', idx: 0, codec: { name: 'int8' } },
        { key: 'amount', k: 'col', idx: 1, codec: { name: 'numeric' } },
      ],
    })
    expect(sqlOf(built)).toContain('from "recent" as "r"')
  })

  it('a CTE handle joins like any other source — no new method', () => {
    const built = withRecent()
      .fromCte('recent', 'r')
      .innerJoin(schema.h.users, 'u', ({ r, u }) => q.eq(r.authorId, u.id))
      .select(({ r, u }) => ({ email: u.email, total: q.fn.sum(r.amount) }))
      .groupBy(({ u }) => [u.email])
      .having(({ r }) => q.gt(q.fn.sum(r.amount), '1000'))
    expect(sqlOf(built)).toContain('inner join "public"."users" as "u" on "r"."authorId" = "u"."id"')
    expect(sqlOf(built)).toContain('group by "u"."email"')
    expect(sqlOf(built)).toContain('having sum("r"."amount") > $2')
  })

  it('MATERIALIZED / NOT MATERIALIZED is one option', () => {
    const body = (d: q.Executor) => d.from(schema.h.posts).select(({ posts: p }) => ({ id: p.id }))
    expect(sqlOf(db.with('x', body, { materialized: true }).fromCte('x').select(({ x }) => ({ id: x.id })))).toContain(
      'with "x" as materialized (',
    )
    expect(sqlOf(db.with('x', body, { materialized: false }).fromCte('x').select(({ x }) => ({ id: x.id })))).toContain(
      'with "x" as not materialized (',
    )
    expect(sqlOf(db.with('x', body).fromCte('x').select(({ x }) => ({ id: x.id })))).toContain(
      'with "x" as (',
    )
  })

  it('two CTEs are comma-separated, in declaration order', () => {
    const built = db
      .with('a', (d) => d.from(schema.h.posts).select(({ posts: p }) => ({ id: p.id })))
      .with('b', (d) => d.from(schema.h.users).select(({ users: u }) => ({ id: u.id })))
      .fromCte('a')
      .select(({ a }) => ({ id: a.id }))
    expect(sqlOf(built)).toContain('), "b" as (')
    expect(sqlOf(built).indexOf('with "a" as (')).toBe(0)
  })

  it('a duplicate CTE name is refused at build time', () => {
    expect(() =>
      db
        .with('x', (d) => d.from(schema.h.posts).select(({ posts: p }) => ({ id: p.id })))
        .with('x', (d) => d.from(schema.h.users).select(({ users: u }) => ({ id: u.id }))),
    ).toThrowError(/a CTE named "x" is already declared/)
  })

  it('naming a CTE that was never declared says which ones exist', () => {
    // Unreachable from TypeScript — `fromCte` only exists on a `CteExecutor` and its key is
    // `keyof C`. This is the untyped-JavaScript backstop, the same category as `NullOperandError`,
    // so the cast is the documented R12 exception rather than a hole in the types.
    const untyped = db as unknown as { fromCte(name: string): unknown }
    expect(() => untyped.fromCte('nope')).toThrowError(/no CTE named "nope" \(have: none\)/)
  })
})

describe('Appendix A — the writable CTE that feeds an INSERT … SELECT', () => {
  it('archive-and-move compiles to one statement', () => {
    const built = db
      .with('moved', (d) =>
        d
          .deleteFrom(schema.h.posts)
          .where(({ posts: p }) => p.published)
          .returning(({ posts: p }) => ({ title: p.title, amount: p.amount })),
      )
      .insertInto(schema.h.posts)
      .fromSelect((d) => d.fromCte('moved').select(({ moved: m }) => ({ title: m.title, amount: m.amount })))
      .returning(({ posts: p }) => ({ id: p.id }))

    expect(sqlOf(built)).toBe(
      [
        'with "moved" as (',
        '  delete from "public"."posts" as "posts"',
        '  where "posts"."published"',
        '  returning "title" as "title", "amount" as "amount"',
        ')',
        'insert into "public"."posts" ("title", "amount")',
        'select "moved"."title" as "title", "moved"."amount" as "amount"',
        'from "moved" as "moved"',
        'returning "id" as "id"',
      ].join('\n'),
    )
    expect(built.compile().meta.kind).toBe('insert')
    expect(built.compile().meta.writes).toStrictEqual([
      { schema: 'public', name: 'posts' },
      { schema: 'public', name: 'posts' },
    ])
  })

  it('the CTE list appears exactly once — the sub-select’s copy is hoisted, not duplicated', () => {
    const sql = sqlOf(
      db
        .with('moved', (d) =>
          d.deleteFrom(schema.h.posts).allRows().returning(({ posts: p }) => ({ title: p.title })),
        )
        .insertInto(schema.h.posts)
        .fromSelect((d) => d.fromCte('moved').select(({ moved: m }) => ({ title: m.title }))),
    )
    expect(sql.match(/with "moved" as \(/g)).toHaveLength(1)
  })

  it('a writable CTE’s columns are its RETURNING list, with real codecs', () => {
    const built = db
      .with('moved', (d) =>
        d
          .deleteFrom(schema.h.posts)
          .allRows()
          .returning(({ posts: p }) => ({ id: p.id, amount: p.amount })),
      )
      .fromCte('moved')
      .select(({ moved: m }) => ({ id: m.id, amount: m.amount }))
    expect(built.compile().shape).toMatchObject({
      fields: [{ codec: { name: 'int8' } }, { codec: { name: 'numeric' } }],
    })
  })
})

describe('§2.7 — a chained .with() does not re-declare the earlier CTEs', () => {
  it('two CTEs, one WITH list, each body declaring only itself', () => {
    // The callback's executor exposes `a` so `d.cte.a` / `d.fromCte('a')` resolve — but the
    // statement it builds copied that list into its OWN with, so `b`'s body re-declared `a`
    // inside itself. Duplicated text and binds here; `0A000 WITH clause containing a
    // data-modifying statement must be at the top level` when `a` is writable.
    const built = db
      .with('a', (d) => d.from(schema.h.users).select(({ users: u }) => ({ id: u.id })))
      .with('b', (d) => d.fromCte('a').select(({ a }) => ({ id: a.id })))
      .fromCte('b')
      .select(({ b }) => ({ id: b.id }))
    expect(sqlOf(built)).toBe(
      [
        'with "a" as (',
        '  select "users"."id" as "id"',
        '  from "public"."users" as "users"',
        '), "b" as (',
        '  select "a"."id" as "id"',
        '  from "a" as "a"',
        ')',
        'select "b"."id" as "id"',
        'from "b" as "b"',
      ].join('\n'),
    )
  })

  it('a CTE the callback declares ITSELF stays nested', () => {
    const built = db
      .with('outer', (d) =>
        d
          .with('inner', (e) => e.from(schema.h.users).select(({ users: u }) => ({ id: u.id })))
          .fromCte('inner')
          .select(({ inner }) => ({ id: inner.id })),
      )
      .fromCte('outer')
      .select(({ outer }) => ({ id: outer.id }))
    expect(sqlOf(built).match(/with "inner" as \(/g)).toHaveLength(1)
    expect(sqlOf(built).indexOf('"inner"')).toBeGreaterThan(sqlOf(built).indexOf('with "outer"'))
  })
})

