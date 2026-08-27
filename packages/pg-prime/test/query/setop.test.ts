/**
 * Set operations, tier 0 (design/09 WS4; `03` §2.8).
 *
 * The type-level half — a mismatched branch resolving to `OrmTypeError<'union branch 2 has no
 * column "kind"'>` — is WS1's and is pinned in `tools/type-errors/__golden__/setop-*.txt`. This
 * file is the runtime half: what the SQL looks like, where the parentheses go, and the one thing
 * a reader is most likely to get wrong — that `ORDER BY` / `LIMIT` apply to the whole result and
 * name the *output* column, not a scope.
 */

import { describe, expect, it } from 'vitest'
import { textCodec } from '../../src/codec/index.js'
import { compileOnly } from '../../src/query/run.js'
import * as q from '../../src/query/types.js'
import { schema } from './_schema.js'

const db = compileOnly(schema)
const sqlOf = (b: { compile(): { sql: string } }) => b.compile().sql

const users = () =>
  db.from(schema.h.users).select(({ users: u }) => ({ id: u.id, kind: q.val('user', textCodec) }))
const posts = () =>
  db.from(schema.h.posts).select(({ posts: p }) => ({ id: p.id, kind: q.val('post', textCodec) }))

describe('§2.8 — the six set operations', () => {
  it('union all, then order/limit on the whole result', () => {
    const built = users().unionAll(posts()).orderBy((r) => q.asc(r.id)).limit(50)
    expect(sqlOf(built)).toBe(
      [
        'select "users"."id" as "id", $1 as "kind"',
        'from "public"."users" as "users"',
        'union all',
        'select "posts"."id" as "id", $2 as "kind"',
        'from "public"."posts" as "posts"',
        'order by "id" asc',
        'limit $3',
      ].join('\n'),
    )
  })

  it('the ORDER BY names the OUTPUT column, unqualified', () => {
    // `order by "users"."id"` after a UNION is a syntax error; the result set has no alias.
    expect(sqlOf(users().unionAll(posts()).orderBy((r) => q.desc(r.kind)))).toContain(
      '\norder by "kind" desc',
    )
  })

  it('all six spellings emit their own keyword', () => {
    const ops = ['union', 'unionAll', 'intersect', 'intersectAll', 'except', 'exceptAll'] as const
    const expected = ['union', 'union all', 'intersect', 'intersect all', 'except', 'except all']
    ops.forEach((op, i) => {
      const built = users()[op](posts())
      expect(sqlOf(built).split('\n')).toContain(expected[i])
    })
  })

  it('the result shape is the LEFT-most branch’s, with its codecs', () => {
    const compiled = users().unionAll(posts()).compile()
    expect(compiled.meta.kind).toBe('setop')
    expect(compiled.shape).toMatchObject({
      fields: [
        { key: 'id', k: 'col', idx: 0, codec: { name: 'int8' } },
        { key: 'kind', k: 'col', idx: 1, codec: { name: 'text' } },
      ],
    })
  })

  it('a branch carrying its own order/limit is parenthesised; a plain one is not', () => {
    const plain = sqlOf(users().unionAll(posts()))
    expect(plain).not.toContain('(\n  select')
    const inner = sqlOf(users().unionAll(posts().limit(3)))
    expect(inner).toContain('union all\n(\n  select "posts"."id" as "id"')
    expect(inner).toContain('  limit $3\n)')
  })

  it('chaining names branch 3 correctly and nests left', () => {
    const built = users().unionAll(posts()).unionAll(posts())
    const lines = sqlOf(built).split('\n')
    // The nested branch is emitted inside a block, so its keyword is indented — which is exactly
    // the visual cue that the left operand is itself a set operation.
    expect(lines.filter((l) => l.trim() === 'union all')).toHaveLength(2)
    // The left operand of the second union is the first union, and it is parenthesised because a
    // nested set operation's precedence is not the same at every keyword.
    expect(sqlOf(built).startsWith('(\n  select "users"."id"')).toBe(true)
  })

  it('a set operation is a CTE body and a derived table like anything else', () => {
    const both = users().unionAll(posts()).as('both')
    expect(sqlOf(db.from(both).select(({ both: b }) => ({ id: b.id })))).toContain(
      'from (\n  select "users"."id"',
    )
    const cte = db
      .with('both', () => users().unionAll(posts()))
      .fromCte('both')
      .select(({ both: b }) => ({ id: b.id, kind: b.kind }))
    expect(sqlOf(cte)).toContain('with "both" as (')
    expect(cte.compile().shape).toMatchObject({ fields: [{ codec: { name: 'int8' } }, { codec: { name: 'text' } }] })
  })
})

describe('a branch that carries a WITH', () => {
  // `… union with "recent" as (…) select …` is 42601: WITH may only open a *parenthesised*
  // branch. Each branch therefore keeps the CTEs it references and is parenthesised, which is
  // self-contained — hoisting them onto the left-most select would put the declaration inside
  // parentheses the other branch cannot see.
  const cteSide = () =>
    db
      .with('recent', (d) => d.from(schema.h.posts).select(({ posts: p }) => ({ id: p.id })))
      .fromCte('recent')
      .select(({ recent: r }) => ({ id: r.id }))
  const plain = () => db.from(schema.h.users).select(({ users: u }) => ({ id: u.id }))

  const parenthesised = [
    '(',
    '  with "recent" as (',
    '    select "posts"."id" as "id"',
    '    from "public"."posts" as "posts"',
    '  )',
    '  select "recent"."id" as "id"',
    '  from "recent" as "recent"',
    ')',
  ]
  const bare = ['select "users"."id" as "id"', 'from "public"."users" as "users"']

  it('on the left', () => {
    expect(sqlOf(cteSide().union(plain()))).toBe([...parenthesised, 'union', ...bare].join('\n'))
  })

  it('on the right', () => {
    expect(sqlOf(plain().union(cteSide()))).toBe([...bare, 'union', ...parenthesised].join('\n'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AS BUILT 2026-08-27 — a distinct set operation compares whole rows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `union` / `intersect` / `except` deduplicate, and PostgreSQL cannot compare `json` — so a branch
 * carrying a relation projection is `42883 could not identify an equality operator for type json`
 * exactly as a `select distinct` is. The `… all` spellings need no equality and must be left
 * alone: they are the negative control, and half of what this block exists to pin.
 *
 * The flag reaches a branch from the *operator*, not from the branch, and it **inherits
 * downwards** — the last test is the one that matters, because `(a union all b) except c` compares
 * rows `a` produced.
 */
describe('a relation column under a DISTINCT set operation is jsonb', () => {
  const rel = () =>
    db.from(schema.h.users).select(({ users: u }) => ({
      id: u.id,
      posts: u.posts.many((sq) => sq.select((p) => ({ id: p.id }))),
    }))

  const aggOf = (sql: string): string[] => sql.match(/jsonb?_agg/g) ?? []

  it('union: both branches switch to jsonb', () => {
    expect(aggOf(sqlOf(rel().union(rel())))).toEqual(['jsonb_agg', 'jsonb_agg'])
  })

  it('intersect and except switch too — every deduplicating operator does', () => {
    expect(aggOf(sqlOf(rel().intersect(rel())))).toEqual(['jsonb_agg', 'jsonb_agg'])
    expect(aggOf(sqlOf(rel().except(rel())))).toEqual(['jsonb_agg', 'jsonb_agg'])
  })

  it('union all does NOT — it compares nothing, so nothing has to change', () => {
    expect(aggOf(sqlOf(rel().unionAll(rel())))).toEqual(['json_agg', 'json_agg'])
    expect(sqlOf(rel().unionAll(rel()))).not.toContain('jsonb')
  })

  it('the flag inherits downwards: `(a union all b) except c` makes a and b jsonb too', () => {
    // The `except` compares the rows the inner `union all` produced, so all three branches need a
    // comparable column — reading only the nearest operator would have left two of them as json.
    expect(aggOf(sqlOf(rel().unionAll(rel()).except(rel())))).toEqual([
      'jsonb_agg',
      'jsonb_agg',
      'jsonb_agg',
    ])
  })

  it('the result shape is the left branch’s, and the variant did not disturb it', () => {
    expect(rel().union(rel()).compile().shape).toStrictEqual(rel().unionAll(rel()).compile().shape)
  })
})

