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
import { boolCodec, textCodec } from '../../src/codec/index.js'
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
    ).toThrowError(/has no PostgreSQL type and pg-prime will not guess one/)
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

describe('§2.1 — `$all` (12 B)', () => {
  it('a `$all` spread is byte-identical to selectAll of the same alias', () => {
    const spread = db.from(schema.h.posts).select(({ posts: p }) => ({ ...p.$all }))
    expect(sqlOf(spread)).toBe(sqlOf(db.from(schema.h.posts).selectAll('posts')))
  })

  it('it is a plain record, so it composes with other keys and keeps key order', () => {
    expect(
      sqlOf(
        db.from(schema.h.comments).select(({ comments: c }) => ({
          ...c.$all,
          shouted: q.concat(c.body, q.val('!', textCodec)),
        })),
      ),
    ).toBe(
      [
        'select "comments"."id" as "id", "comments"."post_id" as "postId", ' +
          '"comments"."body" as "body", "comments"."body" || $1 as "shouted"',
        'from "public"."comments" as "comments"',
      ].join('\n'),
    )
  })

  it('omit() drops columns and does NOT mutate the shared scope record', () => {
    const dropped = db
      .from(schema.h.comments)
      .select(({ comments: c }) => ({ ...q.omit(c.$all, 'body') }))
    expect(sqlOf(dropped)).toBe(
      [
        'select "comments"."id" as "id", "comments"."post_id" as "postId"',
        'from "public"."comments" as "comments"',
      ].join('\n'),
    )
    // The scope object is cached per (registry, handle, alias), so a mutating `omit` would have
    // deleted `body` from every later query too. The next query is the negative control.
    expect(sqlOf(db.from(schema.h.comments).select(({ comments: c }) => ({ ...c.$all })))).toContain(
      '"comments"."body" as "body"',
    )
  })

  it('a relation accessor is not a column, so `$all` carries columns only', () => {
    // `users` declares a `posts` relation. If the spread carried it, the projection would hold an
    // object of methods and the SQL would grow a lateral.
    const built = db.from(schema.h.users).select(({ users: u }) => ({ ...u.$all }))
    expect((built.toAst().projection ?? []).map((i) => i.key)).toStrictEqual([
      'id',
      'email',
      'name',
      'role',
      'meta',
      'createdAt',
      'deletedAt',
    ])
    expect(sqlOf(built)).not.toContain('json_agg')
  })

  it('under a LEFT JOIN it is a spread, not a group: each column nulls on its own', () => {
    const compiled = db
      .from(schema.h.posts, 'p')
      .leftJoin(schema.h.comments, 'c', ({ p, c }) => q.eq(c.postId, p.id))
      .select(({ c }) => ({ ...c.$all }))
      .compile()
    // No `group` field: `03` §2.2's whole-object rule is nest()/nestNullable()'s, and a spread
    // has no object to null.
    expect(compiled.shape).toMatchObject({
      k: 'row',
      fields: [{ key: 'id' }, { key: 'postId' }, { key: 'body' }],
    })
    expect(buildDecoder(compiled.shape)([[null, null, null]])).toStrictEqual([
      { id: null, postId: null, body: null },
    ])
  })
})

describe('§2.2 — right / full / cross joins (12 B)', () => {
  it('right join', () => {
    expect(
      sqlOf(
        db
          .from(schema.h.posts, 'p')
          .rightJoin(schema.h.users, 'u', ({ p, u }) => q.eq(p.authorId, u.id))
          .select(({ p, u }) => ({ id: u.id, title: p.title })),
      ),
    ).toBe(
      [
        'select "u"."id" as "id", "p"."title" as "title"',
        'from "public"."posts" as "p"',
        'right join "public"."users" as "u" on "p"."author_id" = "u"."id"',
      ].join('\n'),
    )
  })

  it('full join', () => {
    expect(
      sqlOf(
        db
          .from(schema.h.posts, 'p')
          .fullJoin(schema.h.users, 'u', ({ p, u }) => q.eq(p.authorId, u.id))
          .select(({ p, u }) => ({ id: u.id, title: p.title })),
      ),
    ).toBe(
      [
        'select "u"."id" as "id", "p"."title" as "title"',
        'from "public"."posts" as "p"',
        'full join "public"."users" as "u" on "p"."author_id" = "u"."id"',
      ].join('\n'),
    )
  })

  it('cross join takes no ON, in both the aliased and the bare spelling', () => {
    expect(
      sqlOf(
        db.from(schema.h.posts, 'p').crossJoin(schema.h.users, 'u').select(({ u }) => ({ id: u.id })),
      ),
    ).toBe(
      [
        'select "u"."id" as "id"',
        'from "public"."posts" as "p"',
        'cross join "public"."users" as "u"',
      ].join('\n'),
    )
    expect(
      sqlOf(
        db.from(schema.h.posts, 'p').crossJoin(schema.h.users).select(({ users: u }) => ({ id: u.id })),
      ),
    ).toContain('cross join "public"."users" as "users"')
  })

  it('a right join nulls the aliases bound BEFORE it, which is what witnesses the group', () => {
    const compiled = db
      .from(schema.h.posts, 'p')
      .rightJoin(schema.h.users, 'u', ({ p, u }) => q.eq(p.authorId, u.id))
      .select(({ p, u }) => ({ email: u.email, post: q.nestNullable({ id: p.id, title: p.title }) }))
      .compile()
    // `p.id` is NOT NULL *and* on the nulled side, so it is the sentinel (index 1 of the row:
    // `u.email` is 0) — the mirror of the left-join case, where it would have been one of `u`'s.
    expect(compiled.shape).toMatchObject({
      fields: [{ key: 'email' }, { key: 'post', k: 'group', nullable: true, sentinel: 1 }],
    })
    expect(buildDecoder(compiled.shape)([['a@b', '1', 'x'], ['c@d', null, null]])).toStrictEqual([
      { email: 'a@b', post: { id: 1n, title: 'x' } },
      { email: 'c@d', post: null },
    ])
  })

  it('R4 — the same group under an INNER join is witnessed by nothing', () => {
    const compiled = db
      .from(schema.h.posts, 'p')
      .innerJoin(schema.h.users, 'u', ({ p, u }) => q.eq(p.authorId, u.id))
      .select(({ p, u }) => ({ email: u.email, post: q.nestNullable({ id: p.id, title: p.title }) }))
      .compile()
    expect(compiled.shape).toMatchObject({ fields: [{ key: 'email' }, { witnesses: [] }] })
  })

  it('a full join nulls both sides; a cross join nulls neither', () => {
    const witnessesOf = (c: { shape: unknown }): readonly number[] | undefined =>
      (c.shape as unknown as { fields: { witnesses?: readonly number[] }[] }).fields[1]?.witnesses
    const full = db
      .from(schema.h.posts, 'p')
      .fullJoin(schema.h.users, 'u', ({ p, u }) => q.eq(p.authorId, u.id))
      .select(({ p, u }) => ({ e: u.email, g: q.nestNullable({ id: p.id, uid: u.id }) }))
      .compile()
    const cross = db
      .from(schema.h.posts, 'p')
      .crossJoin(schema.h.users, 'u')
      .select(({ p, u }) => ({ e: u.email, g: q.nestNullable({ id: p.id, uid: u.id }) }))
      .compile()
    // Row indices: `e` is 0, so the group's two members are 1 and 2.
    expect(witnessesOf(full)).toStrictEqual([1, 2])
    expect(witnessesOf(cross)).toStrictEqual([])
  })

  it('a right join after .select() is refused, naming the order to write', () => {
    const built = db.from(schema.h.posts, 'p').select(({ p }) => ({ id: p.id }))
    const late = built as unknown as {
      rightJoin: (h: unknown, a: string, on: () => unknown) => unknown
      fullJoin: (h: unknown, a: string, on: () => unknown) => unknown
    }
    const on = (): unknown => q.val(true, boolCodec)
    expect(() => late.rightJoin(schema.h.users, 'u', on)).toThrowError(BuilderError)
    expect(() => late.rightJoin(schema.h.users, 'u', on)).toThrowError(
      /right join .* cannot be added after \.select\(\)/,
    )
    expect(() => late.fullJoin(schema.h.users, 'u', on)).toThrowError(/full join/)
    // A LEFT join after `.select()` is still fine: it can only null the alias it adds, which the
    // projection cannot already mention.
    expect(() =>
      built.leftJoin(schema.h.users, 'u', ({ p, u }) => q.eq(p.authorId, u.id)).compile(),
    ).not.toThrow()
  })
})

describe('§2.2 — lateral joins (12 B)', () => {
  it('inner join lateral, correlated on an outer ref, with ON TRUE by default', () => {
    expect(
      sqlOf(
        db
          .from(schema.h.users)
          .innerJoinLateral(
            (t) =>
              db
                .from(schema.h.posts)
                .where(({ posts: p }) => q.eq(p.authorId, t.users.id))
                .select(({ posts: p }) => ({ id: p.id, title: p.title }))
                .limit(3),
            'r',
          )
          .select(({ users: u, r }) => ({ id: u.id, title: r.title })),
      ),
    ).toBe(
      [
        'select "users"."id" as "id", "r"."title" as "title"',
        'from "public"."users" as "users"',
        'inner join lateral (',
        '  select "posts"."id" as "id", "posts"."title" as "title"',
        '  from "public"."posts" as "posts"',
        '  where "posts"."author_id" = "users"."id"',
        '  limit $1',
        ') as "r" on true',
      ].join('\n'),
    )
  })

  it('left join lateral takes an explicit ON when one is wanted', () => {
    const sql = sqlOf(
      db
        .from(schema.h.users)
        .leftJoinLateral(
          (t) =>
            db
              .from(schema.h.posts)
              .where(({ posts: p }) => q.eq(p.authorId, t.users.id))
              .select(({ posts: p }) => ({ id: p.id, title: p.title }))
              .limit(3),
          'r',
          ({ r }) => q.isNotNull(r.title),
        )
        .select(({ users: u, r }) => ({ id: u.id, title: r.title })),
    )
    expect(sql).toContain('left join lateral (')
    expect(sql.endsWith(') as "r" on "r"."title" is not null')).toBe(true)
  })

  it('the lateral binds before the outer clauses, so $n stays a left-to-right pass', () => {
    expect(
      vals(
        db
          .from(schema.h.users)
          .innerJoinLateral(
            (t) =>
              db
                .from(schema.h.posts)
                .where(({ posts: p }) => q.eq(p.authorId, t.users.id))
                .select(({ posts: p }) => ({ id: p.id, title: p.title }))
                .limit(3),
            'r',
          )
          .select(({ users: u }) => ({ id: u.id }))
          .limit(20),
      ),
    ).toStrictEqual(['3', '20'])
  })

  it('a left lateral marks its own alias nullable, and only its own', () => {
    const compiled = db
      .from(schema.h.users)
      .leftJoinLateral(
        (t) =>
          db
            .from(schema.h.posts)
            .where(({ posts: p }) => q.eq(p.authorId, t.users.id))
            .select(({ posts: p }) => ({ id: p.id, title: p.title })),
        'r',
      )
      .select(({ users: u, r }) => ({
        u: q.nestNullable({ id: u.id }),
        r: q.nestNullable({ id: r.id }),
      }))
      .compile()
    const fields = (compiled.shape as unknown as { fields: { witnesses?: readonly number[] }[] })
      .fields
    expect(fields[0]?.witnesses).toStrictEqual([])
    // A derived column is never declared NOT NULL, so the group falls to rule 2 — every
    // left-joined member — which for a one-column group is that column.
    expect(fields[1]?.witnesses).toStrictEqual([1])
  })

  it('a lateral sub-query may be a plain builder, with no outer reference at all', () => {
    expect(
      sqlOf(
        db
          .from(schema.h.users)
          .innerJoinLateral(
            db.from(schema.h.comments).select(({ comments: c }) => ({ n: c.id })),
            'l',
          )
          .select(({ l }) => ({ n: l.n })),
      ),
    ).toContain('inner join lateral (')
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

  /**
   * The emitted `ORDER BY` leads with the `DISTINCT ON` expressions — `03` §2.8's AS BUILT note of
   * 2026-08-27, and the whole of it in four goldens.
   *
   * PostgreSQL answers `42P10 SELECT DISTINCT ON expressions must match initial ORDER BY
   * expressions` otherwise, and `.orderBy()` appends, so before this the builder emitted a
   * statement it could have known was invalid. Every case below is byte-exact because the point is
   * *where* the keys land, and a `toContain` would not see it.
   */
  describe('distinct on leads the ORDER BY', () => {
    const on1 = () => from().distinctOn(({ posts: p }) => [p.authorId])

    it('with no orderBy at all, the keys become the ordering', () => {
      expect(sqlOf(on1())).toBe(
        [
          'select distinct on ("posts"."author_id") "posts"."id" as "id"',
          'from "public"."posts" as "posts"',
          'order by "posts"."author_id" asc',
        ].join('\n'),
      )
    })

    it('an orderBy on other columns is appended AFTER the keys, not before', () => {
      expect(sqlOf(on1().orderBy(({ posts: p }) => [q.desc(p.createdAt), q.asc(p.id)]))).toBe(
        [
          'select distinct on ("posts"."author_id") "posts"."id" as "id"',
          'from "public"."posts" as "posts"',
          'order by "posts"."author_id" asc, "posts"."created_at" desc, "posts"."id" asc',
        ].join('\n'),
      )
    })

    it('a list that already leads with the keys is untouched, direction and nulls included', () => {
      const built = on1().orderBy(({ posts: p }) => [
        q.desc(p.authorId, 'first'),
        q.desc(p.createdAt),
      ])
      expect(sqlOf(built)).toBe(
        [
          'select distinct on ("posts"."author_id") "posts"."id" as "id"',
          'from "public"."posts" as "posts"',
          'order by "posts"."author_id" desc nulls first, "posts"."created_at" desc',
        ].join('\n'),
      )
      // …and the AST is the caller's, unchanged: the reconciliation is a compile-time transform,
      // so `toAst()` still says exactly what was written (the WS4 equivalence oracle depends on it).
      expect(built.toAst().orderBy).toHaveLength(2)
    })

    /**
     * Keys the caller ordered by in a *different* order.
     *
     * PostgreSQL forces the DISTINCT ON list to come first, so the caller's priority is not
     * achievable; what is achievable is not silently dropping the ordering they wrote. Both survive
     * — the keys lead, the caller's list follows in full — and the repeated items are a no-op for
     * the server (a tie-break on a column already fully determined). Deliberately redundant SQL
     * beats a discarded clause.
     */
    it('keys in a different order than the leading items: keys first, caller’s list intact', () => {
      const built = from()
        .distinctOn(({ posts: p }) => [p.authorId, p.title])
        .orderBy(({ posts: p }) => [q.desc(p.title), q.asc(p.authorId)])
      expect(sqlOf(built)).toBe(
        [
          'select distinct on ("posts"."author_id", "posts"."title") "posts"."id" as "id"',
          'from "public"."posts" as "posts"',
          'order by "posts"."author_id" asc, "posts"."title" asc, ' +
            '"posts"."title" desc, "posts"."author_id" asc',
        ].join('\n'),
      )
    })

    it('a partial match keeps the matched item’s direction and inserts only what is missing', () => {
      expect(
        sqlOf(
          from()
            .distinctOn(({ posts: p }) => [p.authorId, p.title])
            .orderBy(({ posts: p }) => [q.desc(p.authorId), q.asc(p.createdAt)]),
        ),
      ).toBe(
        [
          'select distinct on ("posts"."author_id", "posts"."title") "posts"."id" as "id"',
          'from "public"."posts" as "posts"',
          'order by "posts"."author_id" desc, "posts"."title" asc, "posts"."created_at" asc',
        ].join('\n'),
      )
    })
  })

  /**
   * `select distinct` + an `ORDER BY` the projection does not carry is refused at compile time.
   *
   * `42P10 for SELECT DISTINCT, ORDER BY expressions must appear in select list`. Unlike the
   * `DISTINCT ON` rule above there is no reconciliation: widening the projection would change the
   * row shape *and* which rows a DISTINCT returns, so every repair is a different query.
   */
  describe('distinct refuses an ORDER BY it cannot satisfy', () => {
    const distinctById = () =>
      db
        .from(schema.h.posts)
        .distinct()
        .select(({ posts: p }) => ({ id: p.id }))

    it('throws a BuilderError naming the expression and the fix', () => {
      const built = distinctById().orderBy(({ posts: p }) => q.desc(p.createdAt))
      expect(() => built.compile()).toThrow(BuilderError)
      let message = ''
      try {
        built.compile()
      } catch (e) {
        message = (e as Error).message
      }
      expect(message).toBe(
        'pg-prime: .distinct() cannot order by "posts"."created_at" — PostgreSQL requires every ' +
          'ORDER BY expression of a SELECT DISTINCT to appear in the select list (42P10). Order ' +
          'by a selected column, or add it to select().',
      )
      // D9 (design/04 §4): one line, under 300 characters.
      expect(message).not.toContain('\n')
      expect(message.length).toBeLessThan(300)
    })

    it('…and accepts the same ordering once the column is projected', () => {
      expect(
        sqlOf(
          db
            .from(schema.h.posts)
            .distinct()
            .select(({ posts: p }) => ({ id: p.id, at: p.createdAt }))
            .orderBy(({ posts: p }) => q.desc(p.createdAt)),
        ),
      ).toBe(
        [
          'select distinct "posts"."id" as "id", "posts"."created_at" as "at"',
          'from "public"."posts" as "posts"',
          'order by "posts"."created_at" desc',
        ].join('\n'),
      )
    })

    it('a nest({...}) member counts as projected — the check runs on the FLATTENED list', () => {
      expect(() =>
        db
          .from(schema.h.posts)
          .distinct()
          .select(({ posts: p }) => ({ id: p.id, g: q.nest({ at: p.createdAt }) }))
          .orderBy(({ posts: p }) => q.desc(p.createdAt))
          .compile(),
      ).not.toThrow()
    })

    it('an expression the digest cannot describe is allowed through — unknown is not different', () => {
      // A `sql` fragment is opaque, so refusing it would be a guess. PostgreSQL decides.
      expect(() =>
        db
          .from(schema.h.posts)
          .distinct()
          .select(({ posts: p }) => ({ id: p.id }))
          .orderBy(() => q.desc(q.sql`random()`.asUnsafe<number>()))
          .compile(),
      ).not.toThrow()
    })

    it('distinct ON is not subject to the rule — only its own keys need comparing', () => {
      expect(() =>
        db
          .from(schema.h.posts)
          .distinctOn(({ posts: p }) => [p.authorId])
          .select(({ posts: p }) => ({ id: p.id }))
          .orderBy(({ posts: p }) => q.desc(p.createdAt))
          .compile(),
      ).not.toThrow()
    })
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
