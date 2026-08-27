/**
 * Window functions, tier 0 (design/09 WS4; `03` §2.8).
 *
 * `03` §2.8 spells these as a method — `fn.sum(p.amount).over('byAuthor')`. WS4 ships them as a
 * free function, `over(fn.sum(p.amount), 'byAuthor')`, for fork F1's measured reason (09 §3.0):
 * a method on an expression costs +105 instantiations per table where the free function costs
 * zero, and at runtime an `Expr` *is* a frozen AST node, so `.over()` would mean a wrapper
 * allocation on the hot path. The deviation is recorded in 09 §3.4 and amended into `03` §2.8.
 *
 * What is pinned here is the SQL, because a window clause is where an emitter quietly gets the
 * frame wrong: `rows unbounded preceding` and `rows between unbounded preceding and current row`
 * are different frames, and only one of them is what a running total means.
 */

import { describe, expect, it } from 'vitest'
import { refsOf } from '../../src/query/ref.js'
import { compileOnly } from '../../src/query/run.js'
import * as q from '../../src/query/types.js'
import { buildWindow, toWindowDef } from '../../src/query/window.js'
import type { WindowSpec } from '../../src/query/window.js'
import { BuilderError } from '../../src/sql/errors.js'
import { posts, schema } from './_schema.js'

const db = compileOnly(schema)
const sqlOf = (b: { compile(): { sql: string } }) => b.compile().sql

/** The first line of `select over(sum(amount), w => w.<frame>)` — the whole window, alone. */
const frame = (f: q.FrameOpts): string =>
  sqlOf(
    db
      .from(schema.h.posts)
      .select(({ posts: p }) => ({ v: q.over(q.fn.sum(p.amount), (w) => w.rows(f)) })),
  ).split('\n')[0]!

describe('§2.8 — inline and named windows', () => {
  it('the §2.8 example, whole', () => {
    const built = db
      .from(schema.h.posts)
      .select(({ posts: p }) => ({
        id: p.id,
        n: q.over(q.fn.rowNumber(), (w) => w.partitionBy(p.authorId).orderBy(q.desc(p.createdAt))),
        total: q.over(q.fn.sum(p.amount), 'byAuthor'),
        run: q.over(q.fn.sum(p.amount), (w) =>
          w
            .partitionBy(p.authorId)
            .orderBy(q.asc(p.createdAt))
            .rows({ from: 'unbounded preceding', to: 'current row' }),
        ),
        dense: q.over(q.fn.denseRank(), 'byAuthor'),
      }))
      .window('byAuthor', ({ posts: p }) => ({
        partitionBy: [p.authorId],
        orderBy: [q.desc(p.amount)],
      }))

    expect(sqlOf(built)).toBe(
      [
        'select "posts"."id" as "id", ' +
          'row_number() over (partition by "posts"."author_id" order by "posts"."created_at" desc) as "n", ' +
          'sum("posts"."amount") over "byAuthor" as "total", ' +
          'sum("posts"."amount") over (partition by "posts"."author_id" ' +
          'order by "posts"."created_at" asc rows between unbounded preceding and current row) as "run", ' +
          'dense_rank() over "byAuthor" as "dense"',
        'from "public"."posts" as "posts"',
        'window "byAuthor" as (partition by "posts"."author_id" order by "posts"."amount" desc)',
      ].join('\n'),
    )
  })

  it('the window clause sits between HAVING and ORDER BY', () => {
    const built = db
      .from(schema.h.posts)
      .select(({ posts: p }) => ({ id: p.id, n: q.over(q.fn.rank(), 'w') }))
      .window('w', ({ posts: p }) => ({ orderBy: [q.asc(p.id)] }))
      .orderBy(({ posts: p }) => q.asc(p.id))
      .limit(1)
    const lines = sqlOf(built).split('\n')
    expect(lines.map((l) => l.split(' ')[0])).toStrictEqual([
      'select',
      'from',
      'window',
      'order',
      'limit',
    ])
  })

  it('every frame spelling', () => {
    expect(frame({ from: 'unbounded preceding' })).toContain('over (rows unbounded preceding)')
    expect(frame({ from: 'unbounded preceding', to: 'current row' })).toContain(
      'over (rows between unbounded preceding and current row)',
    )
    expect(frame({ from: { preceding: 3 }, to: { following: 1 } })).toContain(
      'over (rows between 3 preceding and 1 following)',
    )
    expect(frame({ from: 'current row', to: 'unbounded following', exclude: 'ties' })).toContain(
      'over (rows between current row and unbounded following exclude ties)',
    )
  })

  it('range and groups modes', () => {
    const built = db.from(schema.h.posts).select(({ posts: p }) => ({
      a: q.over(q.fn.sum(p.amount), (w) => w.orderBy(q.asc(p.id)).range({ from: 'current row' })),
      b: q.over(q.fn.sum(p.amount), (w) => w.orderBy(q.asc(p.id)).groups({ from: 'current row' })),
    }))
    expect(sqlOf(built)).toContain('order by "posts"."id" asc range current row')
    expect(sqlOf(built)).toContain('order by "posts"."id" asc groups current row')
  })

  it('a frame offset is a literal, not a parameter — one plan, not N', () => {
    const built = db
      .from(schema.h.posts)
      .select(({ posts: p }) => ({
        v: q.over(q.fn.sum(p.amount), (w) => w.rows({ from: { preceding: 7 } })),
      }))
    expect(built.compile().binds).toStrictEqual([])
    expect(() =>
      db.from(schema.h.posts).select(({ posts: p }) => ({
        v: q.over(q.fn.sum(p.amount), (w) => w.rows({ from: { preceding: -1 } })),
      })),
    ).toThrowError(/non-negative safe integer/)
  })

  it('over() on something that is not a function is refused', () => {
    expect(() =>
      db.from(schema.h.posts).select(({ posts: p }) => ({ v: q.over(p.amount as never, 'w') })),
    ).toThrowError(BuilderError)
    expect(() =>
      db.from(schema.h.posts).select(({ posts: p }) => ({ v: q.over(p.amount as never, 'w') })),
    ).toThrowError(/PostgreSQL has no OVER on a plain expression/)
  })
})

describe('§2.8 — .window() accepts both documented spellings', () => {
  it('the callback form `w => …` builds the definition, not an EMPTY window', () => {
    // `window.ts`'s own docblock spells the named form `t => w => …`. The callback fell into the
    // literal branch, where a function has no partitionBy/orderBy/frame, and produced
    // `window "w" as ()` — legal SQL, a whole-partition frame, and a silently wrong rank for
    // every row. The oracle is the definition the *builder* spelling produces, which is the one
    // `over(agg, w => …)` has always used and which `test/compile` verified.
    const refs = refsOf(posts, 'posts')
    const spec = (w: WindowSpec) => w.partitionBy(refs.authorId).orderBy(q.desc(refs.amount))
    expect(toWindowDef(spec)).toStrictEqual(buildWindow(spec))
    expect(toWindowDef(spec)).toStrictEqual({
      partitionBy: [refs.authorId],
      orderBy: [{ e: refs.amount, dir: 'desc', nulls: undefined }],
    })
  })

  it('the literal form still works', () => {
    const built = db
      .from(schema.h.posts)
      .window('byAuthor', ({ posts: p }) => ({ partitionBy: [p.authorId] }))
      .select(() => ({ r: q.over(q.fn.rowNumber(), 'byAuthor') }))
    expect(sqlOf(built)).toBe(
      [
        'select row_number() over "byAuthor" as "r"',
        'from "public"."posts" as "posts"',
        'window "byAuthor" as (partition by "posts"."author_id")',
      ].join('\n'),
    )
  })

  it('an empty window definition is refused rather than emitted', () => {
    expect(() => db.from(schema.h.posts).window('w', () => ({}))).toThrowError(BuilderError)
    expect(() => toWindowDef({})).toThrowError(BuilderError)
  })

  it('two windows may not share a name', () => {
    expect(() =>
      db
        .from(schema.h.posts)
        .window('w', ({ posts: p }) => ({ partitionBy: [p.authorId] }))
        .window('w', ({ posts: p }) => ({ partitionBy: [p.id] })),
    ).toThrowError(BuilderError)
  })
})

