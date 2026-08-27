/**
 * DELETE, tier 0 (design/09 WS4; `03` §2.5–2.6).
 *
 * Small, and the one thing it must pin is `03` §2.6's claim about bulk delete: `inList` compiles
 * to `= any($1)` and not to an `IN (…)` list, so a hundred different id-list lengths share one
 * prepared plan instead of minting a hundred. That is a PG-only win every list-based builder
 * gives up, and it is invisible in the result — only in the SQL.
 */

import { describe, expect, it } from 'vitest'
import { compileOnly } from '../../src/query/run.js'
import * as q from '../../src/query/types.js'
import { schema } from './_schema.js'

const db = compileOnly(schema)
const sqlOf = (b: { compile(): { sql: string } }) => b.compile().sql
const vals = (b: { compile(): { binds: readonly unknown[] } }) =>
  b.compile().binds.map((x) => (x as { encoded?: unknown }).encoded)

describe('§2.5 — delete with RETURNING', () => {
  it('emits the alias, the predicate and an unqualified RETURNING', () => {
    const built = db
      .deleteFrom(schema.h.posts)
      .where(({ posts: p }) => q.lt(p.createdAt, new Date('2026-01-01T00:00:00Z')))
      .returning(({ posts: p }) => ({ id: p.id }))
    expect(sqlOf(built)).toBe(
      [
        'delete from "public"."posts" as "posts"',
        'where "posts"."created_at" < $1',
        'returning "id" as "id"',
      ].join('\n'),
    )
    expect(vals(built)).toStrictEqual(['2026-01-01 00:00:00.000Z'])
    expect(built.compile().meta.writes).toStrictEqual([{ schema: 'public', name: 'posts' }])
    expect(built.compile().meta.kind).toBe('delete')
  })

  it('no RETURNING is a void shape', () => {
    const built = db.deleteFrom(schema.h.posts).where(({ posts: p }) => q.isNull(p.title))
    expect(built.compile().shape).toStrictEqual({ k: 'void' })
  })

  it('using() widens the scope', () => {
    const built = db
      .deleteFrom(schema.h.posts)
      .using(schema.h.users)
      .where(({ posts: p, users: u }) => q.and(q.eq(p.authorId, u.id), q.isNotNull(u.deletedAt)))
    expect(sqlOf(built)).toBe(
      [
        'delete from "public"."posts" as "posts"',
        'using "public"."users" as "users"',
        'where ("posts"."author_id" = "users"."id" and "users"."deleted_at" is not null)',
      ].join('\n'),
    )
  })
})

describe('§2.6 — bulk delete is `= any($1)`, not an IN list', () => {
  it('one parameter regardless of list length', () => {
    const ids = [1n, 2n, 3n, 4n, 5n]
    const built = db.deleteFrom(schema.h.posts).where(({ posts: p }) => q.inList(p.id, ids))
    expect(sqlOf(built)).toContain('where "posts"."id" = any($1)')
    expect(built.compile().binds).toHaveLength(1)
    expect(vals(built)).toStrictEqual(['{1,2,3,4,5}'])
    // …and a different length is the SAME statement, which is the whole point.
    expect(sqlOf(db.deleteFrom(schema.h.posts).where(({ posts: p }) => q.inList(p.id, [9n])))).toBe(
      sqlOf(built),
    )
  })

  it('the empty list compiles to `false`, with no parameters', () => {
    const built = db.deleteFrom(schema.h.posts).where(({ posts: p }) => q.inList(p.id, []))
    expect(sqlOf(built)).toContain('where false')
    expect(built.compile().binds).toStrictEqual([])
  })
})
