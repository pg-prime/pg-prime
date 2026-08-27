/**
 * SELECT goldens — exact SQL, exact binds (03 §1.1(4), Appendix A).
 *
 * No database is involved: the compiler is pure, which is the whole point of `.compile()`
 * returning a plain value.
 */

import { describe, expect, it } from 'vitest'
import { compile } from '../../src/compile/compiler.js'
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inAny,
  inList,
  inQuery,
  isNull,
  isTrue,
  not,
  or,
  param,
  projection,
  select,
  table,
} from '../../src/compile/nodes.js'
import { arrayCodecOf, int4Codec, int8Codec, numericCodec, textCodec, timestamptzCodec, unknownCodec } from '../../src/codec/index.js'
import { sql, toNode } from '../../src/sql/fragment.js'
import {
  p,
  postsCols,
  postsFrom,
  postsTable,
  u,
  usersCols,
  usersFrom,
  usersTable,
} from '../sql/_helpers.js'

/** `text[]` — the codec the spike called `textArray`. */
const textArrayCodec = arrayCodecOf(textCodec)

const vals = (c: { binds: readonly { k: string }[] }) =>
  c.binds.map((b) => (b as { encoded?: unknown }).encoded)

describe('§2.1 — select / where / order / limit', () => {
  it('matches design/03 Appendix A byte for byte', () => {
    const compiled = compile(
      select({
        projection: [
          projection('id', u('id')),
          projection('email', u('email')),
          projection('joined', u('createdAt')),
        ],
        from: usersFrom,
        where: and(
          isNull(u('deletedAt')),
          inAny(u('role'), param(['admin', 'owner'], textArrayCodec)),
        ),
        orderBy: [desc(u('createdAt')), asc(u('id'))],
        limit: param(20, int4Codec),
      }),
    )

    expect(compiled.sql).toBe(
      [
        'select "users"."id" as "id", "users"."email" as "email", "users"."created_at" as "joined"',
        'from "public"."users" as "users"',
        'where ("users"."deleted_at" is null and "users"."role" = any($1))',
        'order by "users"."created_at" desc, "users"."id" asc',
        'limit $2',
      ].join('\n'),
    )
    // WS2: the real `text[]` codec quotes an element only when PostgreSQL's own literal grammar
    // requires it (`test/codec/array-literal.test.ts` pins the rule against a live server); the
    // spike quoted unconditionally. `{admin,owner}` is byte-for-byte what PG emits for this value.
    expect(vals(compiled)).toEqual(['{admin,owner}', '20'])
    expect(compiled.meta.kind).toBe('select')
    expect(compiled.meta.reads).toEqual([{ schema: 'public', name: 'users' }])
    expect(compiled.meta.writes).toEqual([])
    expect(compiled.meta.usedUnsafeRaw).toBe(false)
  })

  it('carries the positional decode shape with codecs attached', () => {
    const compiled = compile(
      select({
        projection: [projection('id', u('id')), projection('amount', p('amount'))],
        from: usersFrom,
      }),
    )
    expect(compiled.shape).toEqual({
      k: 'row',
      fields: [
        { key: 'id', k: 'col', idx: 0, codec: int8Codec },
        { key: 'amount', k: 'col', idx: 1, codec: numericCodec },
      ],
    })
  })
})

describe('predicates', () => {
  const q = (where: Parameters<typeof select>[0]['where']) =>
    compile(select({ projection: [projection('id', p('id'))], from: postsFrom, where }))

  it('eq / gt / gte against a parameter', () => {
    expect(q(eq(p('id'), param(1n, int8Codec))).sql).toContain(
      'where "posts"."id" = $1',
    )
    expect(q(gt(p('amount'), param('100.00', numericCodec))).sql).toContain(
      'where "posts"."amount" > $1',
    )
    expect(q(gte(p('createdAt'), param(new Date(0), timestamptzCodec))).sql).toContain(
      'where "posts"."created_at" >= $1',
    )
  })

  it('eq against another column needs no whereRef', () => {
    expect(q(eq(p('authorId'), u('id'))).sql).toContain(
      'where "posts"."author_id" = "users"."id"',
    )
  })

  it('and / or nest with one paren pair each, n-ary not right-leaning', () => {
    expect(q(and(isTrue(p('published')), isNull(p('title')), eq(p('id'), p('authorId')))).sql)
      .toContain(
        'where ("posts"."published" is true and "posts"."title" is null and ' +
          '"posts"."id" = "posts"."author_id")',
      )
    expect(q(or(isTrue(p('published')), and(isNull(p('title')), isNull(p('amount'))))).sql)
      .toContain(
        'where ("posts"."published" is true or ("posts"."title" is null and "posts"."amount" is null))',
      )
  })

  it('and() / or() have defined identities', () => {
    expect(q(and()).sql).toContain('where true')
    expect(q(or()).sql).toContain('where false')
    expect(q(and(isTrue(p('published')))).sql).toContain('where "posts"."published" is true')
  })

  it('not parenthesises its operand', () => {
    expect(q(not(isTrue(p('published')))).sql).toContain('where not ("posts"."published" is true)')
    expect(q(not(and(isTrue(p('published')), isNull(p('title'))))).sql).toContain(
      'where not ("posts"."published" is true and "posts"."title" is null)',
    )
  })

  it('in (list) emits one parameter per item', () => {
    const c = q(
      inList(p('id'), [param(1n, int8Codec), param(2n, int8Codec), param(3n, int8Codec)]),
    )
    expect(c.sql).toContain('where "posts"."id" in ($1, $2, $3)')
    expect(vals(c)).toEqual(['1', '2', '3'])
  })

  it('in ([]) compiles to a constant, by construction — no plugin needed', () => {
    expect(q(inList(p('id'), [])).sql).toContain('where false')
    expect(q(inList(p('id'), [], true)).sql).toContain('where true')
    expect(q(inList(p('id'), [])).binds).toEqual([])
  })

  it('= any($1) is the bulk form: one parameter, no plan-cache pollution', () => {
    const c = q(inAny(p('id'), param(['1', '2', '3'], textArrayCodec)))
    expect(c.sql).toContain('where "posts"."id" = any($1)')
    expect(c.binds).toHaveLength(1)
    expect(q(inAny(p('id'), param([], textArrayCodec), true)).sql).toContain(
      'where "posts"."id" <> all($1)',
    )
  })

  it('in (subquery)', () => {
    const sub = select({ projection: [projection('id', u('id'))], from: usersFrom })
    expect(q(inQuery(p('authorId'), sub)).sql).toBe(
      [
        'select "posts"."id" as "id"',
        'from "public"."posts" as "posts"',
        'where "posts"."author_id" in (',
        '  select "users"."id" as "id"',
        '  from "public"."users" as "users"',
        ')',
      ].join('\n'),
    )
  })

  it('a sql fragment is a first-class predicate and is parenthesised defensively', () => {
    // A fragment's internal precedence is opaque to the compiler, so `or` inside one cannot
    // silently rebind against an enclosing `and`.
    const c = q(and(isTrue(p('published')), toNode(sql`a or b`)))
    expect(c.sql).toContain('where ("posts"."published" is true and (a or b))')
  })
})

describe('order by / limit / offset / distinct / locking', () => {
  const base = { projection: [projection('id', p('id'))], from: postsFrom } as const

  it('emits direction and nulls placement', () => {
    const c = compile(
      select({
        ...base,
        orderBy: [desc(p('createdAt'), 'last'), asc(p('id'), 'first')],
      }),
    )
    expect(c.sql).toContain(
      'order by "posts"."created_at" desc nulls last, "posts"."id" asc nulls first',
    )
  })

  it('limit and offset are parameters, in emission order', () => {
    const c = compile(
      select({ ...base, limit: param(10, int4Codec), offset: param(20, int4Codec) }),
    )
    expect(c.sql.endsWith('limit $1\noffset $2')).toBe(true)
    expect(vals(c)).toEqual(['10', '20'])
  })

  it('distinct on is PG-only and free for us', () => {
    const c = compile(
      select({
        ...base,
        distinct: { on: [p('authorId')] },
        orderBy: [asc(p('authorId')), desc(p('createdAt'))],
      }),
    )
    expect(c.sql.startsWith('select distinct on ("posts"."author_id") "posts"."id" as "id"')).toBe(
      true,
    )
  })

  it('row locking', () => {
    const c = compile(
      select({ ...base, locking: { strength: 'update', of: ['posts'], wait: 'skip locked' } }),
    )
    expect(c.sql.endsWith('for update of "posts" skip locked')).toBe(true)
  })
})

describe('sql fragments inside the projection', () => {
  it('a bare fragment decodes dynamically; .as(codec) pins the decoder', () => {
    const c = compile(
      select({
        projection: [
          projection('id', u('id')),
          projection('lowered', toNode(sql`lower(${u('email')})`.as(textCodec))),
          projection('untyped', toNode(sql`now()`)),
        ],
        from: usersFrom,
      }),
    )
    expect(c.sql).toBe(
      [
        'select "users"."id" as "id", lower("users"."email") as "lowered", now() as "untyped"',
        'from "public"."users" as "users"',
      ].join('\n'),
    )
    expect(c.shape).toEqual({
      k: 'row',
      fields: [
        { key: 'id', k: 'col', idx: 0, codec: int8Codec },
        { key: 'lowered', k: 'col', idx: 1, codec: textCodec },
        { key: 'untyped', k: 'col', idx: 2, codec: unknownCodec },
      ],
    })
  })

  it('a fragment carrying values numbers alongside everything else', () => {
    const c = compile(
      select({
        projection: [projection('d', toNode(sql`${p('amount')} - ${'1.5'}`))],
        from: postsFrom,
        where: gt(p('amount'), param('0', numericCodec)),
        limit: param(1, int4Codec),
      }),
    )
    expect(c.sql).toBe(
      [
        'select "posts"."amount" - $1 as "d"',
        'from "public"."posts" as "posts"',
        'where "posts"."amount" > $2',
        'limit $3',
      ].join('\n'),
    )
    expect(vals(c)).toEqual(['1.5', '0', '1'])
  })

  it('result aliases go through the same fuzzed identifier sanitizer', () => {
    const c = compile(select({ projection: [projection('a"b', u('id'))], from: usersFrom }))
    expect(c.sql.startsWith('select "users"."id" as "a""b"')).toBe(true)
    expect(() => compile(select({ projection: [projection('', u('id'))] }))).toThrowError(
      /empty/,
    )
  })
})

describe('aliasing and self-joins', () => {
  it('a second alias for the same table is just a different alias', () => {
    const c = compile(
      select({
        projection: [projection('a', u('id')), projection('b', u('id', 'u2'))],
        from: usersFrom,
        joins: [
          {
            k: 'join',
            type: 'inner',
            item: table(usersTable, 'u2'),
            on: eq(u('id'), u('id', 'u2')),
          },
        ],
      }),
    )
    expect(c.sql).toBe(
      [
        'select "users"."id" as "a", "u2"."id" as "b"',
        'from "public"."users" as "users"',
        'inner join "public"."users" as "u2" on "users"."id" = "u2"."id"',
      ].join('\n'),
    )
    expect(c.meta.reads).toEqual([
      { schema: 'public', name: 'users' },
      { schema: 'public', name: 'users' },
    ])
  })
})

describe('the schema seam is pre-quoted', () => {
  it('table and column metadata quote once, at build time', () => {
    expect(usersTable.qualified).toBe('"public"."users"')
    expect(postsTable.qualified).toBe('"public"."posts"')
    expect(usersCols.createdAt.quoted).toBe('"created_at"')
    expect(postsCols.authorId.quoted).toBe('"author_id"')
  })
})
