/**
 * The SELECT builder, tier 0 (design/09 WS4; `03` §2.1–2.2, §2.8).
 *
 * The *equivalence* to the already-verified compiler lives in `./ast-equivalence.test.ts`. This
 * file covers what that oracle cannot reach: the builder's own contract — immutability, the
 * compile memo, when scope lambdas run, `nest`'s decode plan, `$if`/`$call`, and the clauses
 * `03` §2.8 adds that no hand-built AST in `test/compile` exercises.
 *
 * Every SQL assertion pins bytes (R2). Every decode assertion pairs a plan with a decoded value,
 * because a `FieldPlan` that looks right and decodes wrong is the failure this whole layer exists
 * to prevent.
 */

import { describe, expect, it } from 'vitest'
import { textCodec } from '../../src/codec/index.js'
import { buildDecoder } from '../../src/compile/decode.js'
import { BuilderError } from '../../src/sql/errors.js'
import { compileOnly } from '../../src/query/run.js'
import * as q from '../../src/query/types.js'
import { schema } from './_schema.js'

const db = compileOnly(schema)
const sqlOf = (b: { compile(): { sql: string } }) => b.compile().sql
const vals = (b: { compile(): { binds: readonly unknown[] } }) =>
  b.compile().binds.map((x) => (x as { encoded?: unknown }).encoded)

describe('§2.1 — the shape of a select', () => {
  it('projects in key order and aliases every column', () => {
    expect(
      sqlOf(
        db.from(schema.h.users).select(({ users: u }) => ({
          id: u.id,
          email: u.email,
          joined: u.createdAt,
        })),
      ),
    ).toBe(
      [
        'select "users"."id" as "id", "users"."email" as "email", "users"."created_at" as "joined"',
        'from "public"."users" as "users"',
      ].join('\n'),
    )
  })

  it('selectAll is SELECT * with an exact column list, in declaration order', () => {
    expect(sqlOf(db.from(schema.h.posts).selectAll('posts'))).toBe(
      [
        'select "posts"."id" as "id", "posts"."author_id" as "authorId", ' +
          '"posts"."title" as "title", "posts"."amount" as "amount", ' +
          '"posts"."published" as "published", "posts"."created_at" as "createdAt"',
        'from "public"."posts" as "posts"',
      ].join('\n'),
    )
  })

  it('the limit bind is int4, not text', () => {
    const binds = db.from(schema.h.users).select(({ users: u }) => ({ id: u.id })).limit(20).compile()
      .binds
    expect(binds).toStrictEqual([{ k: 'value', encoded: '20', oid: 23 }])
  })

  it('.select() is required, and says so — there is no implicit `select *`', () => {
    // The type layer refuses `.execute()` on an unprojected query outright (`Selected<O, …>` in
    // `src/query/types.ts`), so the runtime backstop is reached through `.compile()`, which is
    // where a JavaScript caller lands.
    expect(() => db.from(schema.h.users).compile()).toThrowError(BuilderError)
    expect(() => db.from(schema.h.users).compile()).toThrowError(/\.select\(\) is required/)
  })

  it('.execute() without an executor names the fix rather than crashing', async () => {
    await expect(
      db.from(schema.h.users).select(({ users: u }) => ({ id: u.id })).execute(),
    ).rejects.toThrowError(/no executor/)
  })

  it('a second .where() ANDs; a second .orderBy() appends', () => {
    const built = db
      .from(schema.h.users)
      .select(({ users: u }) => ({ id: u.id }))
      .where(({ users: u }) => q.isNull(u.deletedAt))
      .where(({ users: u }) => q.eq(u.role, 'admin'))
      .orderBy(({ users: u }) => q.desc(u.createdAt))
      .orderBy(({ users: u }) => q.asc(u.id))
    expect(sqlOf(built)).toContain('where ("users"."deleted_at" is null and "users"."role" = $1)')
    expect(sqlOf(built)).toContain('order by "users"."created_at" desc, "users"."id" asc')
  })

  it('an alias already in scope is a named error, not a silent overwrite', () => {
    expect(() =>
      db
        .from(schema.h.users)
        .innerJoin(schema.h.users, ({ users: u }) => q.eq(u.id, u.id)),
    ).toThrowError(/alias "users" is already in scope/)
  })

  it('a bare value in a projection is refused: sql<T> must carry a codec (03 §3.2)', () => {
    expect(() =>
      db.from(schema.h.users).select(() => ({ x: 'user' } as never)),
    ).toThrowError(/has no PostgreSQL type and pgorm will not guess one/)
    // …and the two supported spellings both work.
    expect(sqlOf(db.from(schema.h.users).select(() => ({ x: q.val('user', textCodec) })))).toContain(
      '$1 as "x"',
    )
  })
})

describe('immutability and the compile memo (03 §1.4a)', () => {
  const base = db.from(schema.h.users).select(({ users: u }) => ({ id: u.id }))

  it('deriving twice leaves the base untouched and the two derivations different', () => {
    const baseSql = sqlOf(base)
    const filtered = base.where(({ users: u }) => q.isNull(u.deletedAt))
    const limited = base.limit(3)

    expect(sqlOf(base)).toBe(baseSql)
    expect(sqlOf(filtered)).toBe(`${baseSql}\nwhere "users"."deleted_at" is null`)
    expect(sqlOf(limited)).toBe(`${baseSql}\nlimit $1`)
    expect(sqlOf(filtered)).not.toBe(sqlOf(limited))
    // …and the base still has no binds, so nothing leaked backwards.
    expect(base.compile().binds).toStrictEqual([])
  })

  it('compile() memoises on the instance and a derived builder gets its own', () => {
    expect(base.compile()).toBe(base.compile())
    expect(base.limit(1).compile()).not.toBe(base.compile())
    // toAst() is memoised too, and is the same tree every time — determinism (03 §1.3).
    expect(base.toAst()).toBe(base.toAst())
  })

  it('a scope lambda runs once, at call time, not at compile time', () => {
    let calls = 0
    const built = db.from(schema.h.users).select(({ users: u }) => {
      calls += 1
      return { id: u.id }
    })
    expect(calls).toBe(1)
    built.compile()
    built.compile()
    sqlOf(built.limit(2))
    expect(calls).toBe(1)
  })
})

describe('§2.2 — joins and nest()', () => {
  it('nest() is pure grouping: byte-identical SQL to the flat spelling', () => {
    const flat = db
      .from(schema.h.posts)
      .innerJoin(schema.h.users, 'u', ({ posts: p, u }) => q.eq(p.authorId, u.id))
      .select(({ posts: p, u }) => ({ id: p.id, 'author.id': u.id, 'author.name': u.name }))
    const nested = db
      .from(schema.h.posts)
      .innerJoin(schema.h.users, 'u', ({ posts: p, u }) => q.eq(p.authorId, u.id))
      .select(({ posts: p, u }) => ({ id: p.id, author: q.nest({ id: u.id, name: u.name }) }))
    expect(sqlOf(nested)).toBe(sqlOf(flat))
    expect(sqlOf(nested)).toBe(
      [
        'select "posts"."id" as "id", "u"."id" as "author.id", "u"."name" as "author.name"',
        'from "public"."posts" as "posts"',
        'inner join "public"."users" as "u" on "posts"."author_id" = "u"."id"',
      ].join('\n'),
    )
  })

  it('the group is assembled positionally, and two joined `id`s do not clobber', () => {
    const compiled = db
      .from(schema.h.posts)
      .innerJoin(schema.h.users, 'u', ({ posts: p, u }) => q.eq(p.authorId, u.id))
      .select(({ posts: p, u }) => ({ id: p.id, author: q.nest({ id: u.id, name: u.name }) }))
      .compile()
    expect(buildDecoder(compiled.shape)([['1', '7', 'Ada']])).toStrictEqual([
      { id: 1n, author: { id: 7n, name: 'Ada' } },
    ])
  })

  it('nestNullable nulls the WHOLE object, witnessed by a NOT NULL column', () => {
    const compiled = db
      .from(schema.h.posts)
      .leftJoin(schema.h.users, 'u', ({ posts: p, u }) => q.eq(p.authorId, u.id))
      .select(({ posts: p, u }) => ({ id: p.id, author: q.nestNullable({ id: u.id, name: u.name }) }))
      .compile()

    // `sentinel` is `users.id`, declared NOT NULL — a null there can only mean "no joined row".
    expect(compiled.shape).toMatchObject({
      k: 'row',
      fields: [{ key: 'id' }, { key: 'author', k: 'group', nullable: true, sentinel: 1 }],
    })
    expect(buildDecoder(compiled.shape)([['1', '7', 'Ada'], ['2', null, null]])).toStrictEqual([
      { id: 1n, author: { id: 7n, name: 'Ada' } },
      { id: 2n, author: null },
    ])
  })

  it('R4 — plain nest() does NOT null the object: one null field stays one null field', () => {
    const compiled = db
      .from(schema.h.posts)
      .leftJoin(schema.h.users, 'u', ({ posts: p, u }) => q.eq(p.authorId, u.id))
      .select(({ posts: p, u }) => ({ id: p.id, author: q.nest({ id: u.id, name: u.name }) }))
      .compile()
    expect(compiled.shape).toMatchObject({ fields: [{ key: 'id' }, { nullable: false }] })
    expect(buildDecoder(compiled.shape)([['2', null, null]])).toStrictEqual([
      { id: 2n, author: { id: null, name: null } },
    ])
  })

  /**
   * T2 (audit 2026-08-26). The witness is chosen by JOIN, not by key order.
   *
   * `posts p` drives and `users u` is left-joined, so `p.id` — NOT NULL, and present on every
   * row the query can return — is not evidence of anything. Picking "the first NOT NULL member
   * in key order" made the group `never` null here, and merely swapping the two keys changed the
   * answer. Only a member whose alias was LEFT JOINed can witness the join's absence.
   */
  it('T2 — a driving-side NOT NULL column never witnesses, whichever key comes first', () => {
    const build = (reversed: boolean) =>
      db
        .from(schema.h.posts, 'p')
        .leftJoin(schema.h.users, 'u', ({ p, u }) => q.eq(p.authorId, u.id))
        .select(({ p, u }) =>
          reversed
            ? { grp: q.nestNullable({ email: u.email, pid: p.id }) }
            : { grp: q.nestNullable({ pid: p.id, email: u.email }) },
        )
        .compile()

    // Grouping still costs nothing: same SQL either way, only the column ORDER differs.
    const sqlOfCompiled = (c: { sql: string }) => c.sql
    expect(sqlOfCompiled(build(false))).toBe(
      [
        'select "p"."id" as "grp.pid", "u"."email" as "grp.email"',
        'from "public"."posts" as "p"',
        'left join "public"."users" as "u" on "p"."author_id" = "u"."id"',
      ].join('\n'),
    )
    expect(sqlOfCompiled(build(true))).toBe(
      [
        'select "u"."email" as "grp.email", "p"."id" as "grp.pid"',
        'from "public"."posts" as "p"',
        'left join "public"."users" as "u" on "p"."author_id" = "u"."id"',
      ].join('\n'),
    )

    // `witnesses` is the left-joined `u.email` in BOTH orders — index 1 declared first, index 0
    // declared second. `sentinel` still says whatever key order said; `witnesses` overrides it.
    expect(build(false).shape).toMatchObject({ fields: [{ key: 'grp', witnesses: [1] }] })
    expect(build(true).shape).toMatchObject({ fields: [{ key: 'grp', witnesses: [0] }] })

    // row 1: the join matched → the object. row 2: it missed → null, not `{ pid, email: null }`.
    expect(
      buildDecoder(build(false).shape)([
        ['1', 'ada@example.com'],
        ['2', null],
      ]),
    ).toStrictEqual([
      { grp: { pid: 1n, email: 'ada@example.com' } },
      { grp: null },
    ])
    // Reversed keys: same verdict per row, only the field order in the row differs.
    expect(
      buildDecoder(build(true).shape)([
        ['ada@example.com', '1'],
        [null, '2'],
      ]),
    ).toStrictEqual([
      { grp: { email: 'ada@example.com', pid: 1n } },
      { grp: null },
    ])
  })

  it('T2 — with nothing left-joined the group is never null, not "all fields null"', () => {
    // An inner join produces a row or no row at all, so there is no absence to report. The old
    // all-null fallback would have called a genuine row of NULLs a missing object.
    const compiled = db
      .from(schema.h.posts, 'p')
      .innerJoin(schema.h.users, 'u', ({ p, u }) => q.eq(p.authorId, u.id))
      .select(({ u }) => ({ grp: q.nestNullable({ del: u.deletedAt }) }))
      .compile()
    expect(compiled.shape).toMatchObject({ fields: [{ key: 'grp', witnesses: [] }] })
    expect(buildDecoder(compiled.shape)([[null]])).toStrictEqual([{ grp: { del: null } }])
  })

  it('a group spanning TWO left-joined aliases is null only when BOTH missed', () => {
    // Under-determined by construction, and since T2 decided without reference to key order.
    //
    // `u.id` and `reply.title` are both NOT NULL columns of left-joined aliases, so both witness,
    // and the group is null when every witness is null — when neither join produced a row.
    //
    // This used to read "the subject alias is `u`, whatever `reply` did". The only thing making
    // `u` the subject was that it came first in the record: swapping the two keys moved the
    // sentinel to `reply.title` and inverted every answer below. Key order is a caller's
    // formatting choice and must not decide nullability, so the tie is resolved by ANDing the
    // witnesses instead of by taking the first one.
    //
    // The residue is honest and pinned by row 2: a group mixing two outer-joined aliases has no
    // single "did my row exist?" question, so one of them can still hand back an object with a
    // null in a field the schema declares NOT NULL. `nestNullable` is for the single-alias case
    // the two tests above pin exactly; per-alias groups say what this shape cannot.
    const build = (reversed: boolean) =>
      db
        .from(schema.h.posts)
        .leftJoin(schema.h.users, 'u', ({ posts: p, u }) => q.eq(p.authorId, u.id))
        .leftJoin(schema.h.posts, 'reply', ({ posts: p, reply: r }) => q.eq(r.authorId, p.id))
        .select(({ posts: p, u, reply: r }) => ({
          id: p.id,
          author: reversed
            ? q.nestNullable({ replyTitle: r.title, id: u.id })
            : q.nestNullable({ id: u.id, replyTitle: r.title }),
        }))
        .compile()

    expect(build(false).shape).toMatchObject({
      fields: [{ key: 'id' }, { key: 'author', k: 'group', nullable: true, witnesses: [1, 2] }],
    })
    // Reversed keys: the same two ROW indexes, so the same verdict — that is the whole point.
    expect(build(true).shape).toMatchObject({
      fields: [{ key: 'id' }, { key: 'author', k: 'group', nullable: true, witnesses: [1, 2] }],
    })

    // row 1: `u` matched, `reply` did not → the object, with a null field
    // row 2: `u` missed,  `reply` matched → the object; the surviving join is evidence of a row
    // row 3: both missed                  → null
    const rows: (string | null)[][] = [
      ['1', '7', null],
      ['2', null, 'a reply'],
      ['3', null, null],
    ]
    expect(buildDecoder(build(false).shape)(rows)).toStrictEqual([
      { id: 1n, author: { id: 7n, replyTitle: null } },
      { id: 2n, author: { id: null, replyTitle: 'a reply' } },
      { id: 3n, author: null },
    ])
  })

  it('a group with no NOT NULL column falls back to "every field is null"', () => {
    const compiled = db
      .from(schema.h.users)
      .leftJoin(schema.h.users, 'u2', ({ users: a, u2: b }) => q.eq(a.id, b.id))
      .select(({ users: a, u2: b }) => ({
        id: a.id,
        other: q.nestNullable({ deletedAt: b.deletedAt }),
      }))
      .compile()
    expect(compiled.shape).toMatchObject({ fields: [{ key: 'id' }, { sentinel: undefined }] })
    expect(buildDecoder(compiled.shape)([['1', null]])).toStrictEqual([{ id: 1n, other: null }])
  })
})

describe('§2.8 — distinct on, locking, composition', () => {
  const from = () => db.from(schema.h.posts).select(({ posts: p }) => ({ id: p.id }))

  it('distinct and distinct on', () => {
    expect(sqlOf(from().distinct())).toContain('select distinct "posts"."id"')
    expect(sqlOf(from().distinctOn(({ posts: p }) => [p.authorId]))).toContain(
      'select distinct on ("posts"."author_id") "posts"."id" as "id"',
    )
  })

  it('forUpdate defaults to `for update` and takes of/wait', () => {
    expect(sqlOf(from().forUpdate())).toContain('\nfor update')
    expect(sqlOf(from().forUpdate({ of: ['posts'], wait: 'skip locked' }))).toContain(
      '\nfor update of "posts" skip locked',
    )
    expect(sqlOf(from().forUpdate({ strength: 'share', wait: 'nowait' }))).toContain(
      '\nfor share nowait',
    )
  })

  it('$call composes and $if is type-preserving at runtime too', () => {
    const paginate = (page: number, size: number) => (x: typeof base) => x.limit(size).offset(page * size)
    const base = from()
    expect(sqlOf(base.$call(paginate(2, 20)))).toContain('limit $1\noffset $2')
    expect(vals(base.$call(paginate(2, 20)))).toStrictEqual(['20', '40'])
    expect(sqlOf(base.$if(false, (x) => x.limit(1)))).toBe(sqlOf(base))
    expect(sqlOf(base.$if(true, (x) => x.limit(1)))).toContain('limit $1')
  })

  it('a derived table is an ordinary source, with the sub-select’s codecs', () => {
    const recent = db
      .from(schema.h.posts)
      .select(({ posts: p }) => ({ id: p.id, authorId: p.authorId }))
      .as('recent')
    const built = db.from(recent).select(({ recent: r }) => ({ id: r.id }))
    expect(sqlOf(built)).toBe(
      [
        'select "recent"."id" as "id"',
        'from (',
        '  select "posts"."id" as "id", "posts"."author_id" as "authorId"',
        '  from "public"."posts" as "posts"',
        ') as "recent"',
      ].join('\n'),
    )
    expect(built.compile().shape).toMatchObject({
      fields: [{ key: 'id', k: 'col', idx: 0, codec: { name: 'int8' } }],
    })
  })

  it('asScalar carries the single column’s codec into the outer projection', () => {
    const built = db.from(schema.h.users).select(({ users: u }) => ({
      last: db
        .from(schema.h.posts)
        .select(({ posts: p }) => ({ v: q.fn.max(p.createdAt) }))
        .where(({ posts: p }) => q.eq(p.authorId, u.id))
        .asScalar(),
    }))
    expect(sqlOf(built)).toBe(
      [
        'select (',
        '  select max("posts"."created_at") as "v"',
        '  from "public"."posts" as "posts"',
        '  where "posts"."author_id" = "users"."id"',
        ') as "last"',
        'from "public"."users" as "users"',
      ].join('\n'),
    )
    expect(built.compile().shape).toMatchObject({
      fields: [{ key: 'last', codec: { name: 'timestamptz' } }],
    })
  })

  it('asScalar refuses a projection that is not exactly one column', () => {
    expect(() =>
      db.from(schema.h.users).select(({ users: u }) => ({ a: u.id, b: u.email })).asScalar(),
    ).toThrowError(/exactly one column \(got 2\)/)
  })
})
