/**
 * **The AST-equivalence oracle** (design/09 WS4, R11's one sanctioned exception).
 *
 * The compiler was verified in its own suite against hand-built ASTs and byte-exact goldens. This
 * file makes the *builder* inherit all of that at zero new oracle cost: for each AST that
 * `test/compile/**` already pins, write the builder expression that means the same thing and
 * assert three things at once —
 *
 *   1. `toStrictEqual` on the tree. Not "equivalent": identical, including which optional keys
 *      exist at all, because `toStrictEqual` distinguishes `{ joins: undefined }` from `{}` and a
 *      builder that set every key to `undefined` would be a different tree that happens to compile
 *      the same way today.
 *   2. Byte-equal SQL.
 *   3. Byte-equal binds — `$1` in the right place with the wrong encoded value is the more
 *      dangerous bug (R2).
 *
 * `assertSame` does all three, so a case cannot accidentally check only the cheap one.
 *
 * **Relation projections joined in WS5.** Two of `test/compile/nested.test.ts`'s trees are
 * reproduced below. The rest are not reachable from any builder and are not meant to be: one
 * selects a relation out of a *derived table* (`from (select …) as author_src`), which is a shape
 * a relation declaration cannot describe. They stay covered by the compiler suite, which is where
 * a hand-built AST belongs.
 *
 * One field is excluded from the tree comparison for relation cases the same way `$` is:
 * `NestedPlan.alias`. A hand-built node names its own lateral; a builder-generated one cannot,
 * because the accessor that creates it does not know how many siblings precede it, so the planner
 * assigns `_r0`, `_r1`, … left to right. The hand-built trees below therefore omit the alias, and
 * the SQL half of the assertion still pins the generated names byte for byte.
 */

import { describe, expect, it } from 'vitest'
import { arrayCodecOf, int4Codec, int8Codec, numericCodec, textCodec, varcharCodec } from '../../src/codec/index.js'
import type { Statement } from '../../src/compile/ast.js'
import { compile } from '../../src/compile/compiler.js'
import {
  and,
  asc,
  desc,
  eq as eqNode,
  gt as gtNode,
  inAny,
  inList as inListNode,
  insert,
  isNull as isNullNode,
  isTrue as isTrueNode,
  nested,
  not as notNode,
  or,
  param,
  projection,
  select,
  table,
} from '../../src/compile/nodes.js'
import { sql, toNode } from '../../src/sql/fragment.js'
import * as q from '../../src/query/types.js'
import { compileOnly } from '../../src/query/run.js'
import {
  p,
  postsFrom,
  u,
  usersCols,
  usersFrom,
  usersTable,
} from '../sql/_helpers.js'
import { schema } from './_schema.js'

const db = compileOnly(schema)
const textArrayCodec = arrayCodecOf(textCodec)

/** A builder, or anything with `.toAst()`. */
type Built = { toAst(): Statement; compile(): ReturnType<typeof compile> }

/**
 * Drop the one key a builder ref carries that a hand-built `col()` does not: `$`, the schema
 * `RefRuntime` (design/05 D2).
 *
 * It is deliberately not part of the equivalence claim, because it is deliberately not part of the
 * tree the compiler reads — `emitExpr`'s `col` case touches `q` and `qn` and nothing else. What it
 * *is* for is the schema-facing question `nest` asks ("is this column NOT NULL?"), which has no
 * SQL consequence. Codecs are kept by reference: two structurally identical codecs with different
 * `encode` closures are a real difference and `toStrictEqual` should catch it.
 */
function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip)
  if (typeof v !== 'object' || v === null) return v
  if (typeof (v as { encode?: unknown }).encode === 'function') return v
  const out: Record<string, unknown> = {}
  const isNestedPlan = 'kind' in v && 'query' in v
  for (const k of Object.keys(v)) {
    if (k === '$') continue
    // The lateral alias is generated, not authored — see the module docblock.
    if (isNestedPlan && k === 'alias') continue
    out[k] = strip((v as Record<string, unknown>)[k])
  }
  return out
}

/**
 * The oracle. Three assertions, one call, so no case can check only the cheap one.
 *
 * The SQL/binds halves are not redundant with the tree half: `toStrictEqual` would pass for two
 * trees that differ only in a key the emitter ignores, and byte-equality would pass for two trees
 * that happen to render alike. Together they pin both the shape and the output.
 */
function assertSame(built: Built, hand: Statement): void {
  expect(strip(built.toAst())).toStrictEqual(strip(hand))
  const a = built.compile()
  const b = compile(hand)
  expect(a.sql).toBe(b.sql)
  expect(a.binds).toStrictEqual(b.binds)
}

// ─────────────────────────────────────────────────────────────────────────────
// test/compile/select.test.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('select.test.ts — every hand-built tree, from the builder', () => {
  it('§2.1 select / where / order / limit', () => {
    assertSame(
      db
        .from(schema.h.users)
        .select(({ users: t }) => ({ id: t.id, email: t.email, joined: t.createdAt }))
        .where(({ users: t }) => q.and(q.isNull(t.deletedAt), q.inList(t.role, ['admin', 'owner'])))
        .orderBy(({ users: t }) => [q.desc(t.createdAt), q.asc(t.id)])
        .limit(20) as unknown as Built,
      select({
        projection: [
          projection('id', u('id')),
          projection('email', u('email')),
          projection('joined', u('createdAt')),
        ],
        from: usersFrom,
        where: and(
          isNullNode(u('deletedAt')),
          inAny(u('role'), param(['admin', 'owner'], textArrayCodec)),
        ),
        orderBy: [desc(u('createdAt')), asc(u('id'))],
        limit: param(20, int4Codec),
      }),
    )
  })

  it('the decode shape carries the codecs, from the builder', () => {
    const built = db
      .from(schema.h.users)
      .select(({ users: t }) => ({ id: t.id }))
      .innerJoin(schema.h.posts, ({ posts: t }) => q.gt(t.amount, '0'))
    // Same projection shape as the hand-built `[u('id'), p('amount')]` case, reached the only way
    // the builder can reach two aliases.
    expect(
      (
        db
          .from(schema.h.users)
          .innerJoin(schema.h.posts, ({ users: a, posts: b }) => q.eq(b.authorId, a.id))
          .select(({ users: a, posts: b }) => ({ id: a.id, amount: b.amount })) as unknown as Built
      ).compile().shape,
    ).toEqual({
      k: 'row',
      fields: [
        { key: 'id', k: 'col', idx: 0, codec: int8Codec },
        { key: 'amount', k: 'col', idx: 1, codec: numericCodec },
      ],
    })
    expect((built as unknown as Built).compile().sql).toContain('inner join')
  })

  const pred = (where: Parameters<typeof select>[0]['where']): Statement =>
    select({ projection: [projection('id', p('id'))], from: postsFrom, where })

  const from = () => db.from(schema.h.posts).select(({ posts: t }) => ({ id: t.id }))

  it('eq / gt / gte against a parameter, and against another column', () => {
    assertSame(
      from().where(({ posts: t }) => q.eq(t.id, 1n)) as unknown as Built,
      pred(eqNode(p('id'), param(1n, int8Codec))),
    )
    assertSame(
      from().where(({ posts: t }) => q.gt(t.amount, '100.00')) as unknown as Built,
      pred(gtNode(p('amount'), param('100.00', numericCodec))),
    )
    assertSame(
      db
        .from(schema.h.posts)
        .innerJoin(schema.h.users, ({ posts: a, users: b }) => q.eq(a.authorId, b.id))
        .select(({ posts: t }) => ({ id: t.id }))
        .where(({ posts: a, users: b }) => q.eq(a.authorId, b.id)) as unknown as Built,
      select({
        projection: [projection('id', p('id'))],
        from: postsFrom,
        joins: [{ k: 'join', type: 'inner', item: usersFrom, on: eqNode(p('authorId'), u('id')) }],
        where: eqNode(p('authorId'), u('id')),
      }),
    )
  })

  it('and / or nest with one paren pair each', () => {
    assertSame(
      from().where(({ posts: t }) =>
        q.and(q.isTrue(t.published), q.isNull(t.title), q.eq(t.id, t.authorId)),
      ) as unknown as Built,
      pred(and(isTrueNode(p('published')), isNullNode(p('title')), eqNode(p('id'), p('authorId')))),
    )
    assertSame(
      from().where(({ posts: t }) =>
        q.or(q.isTrue(t.published), q.and(q.isNull(t.title), q.isNull(t.amount))),
      ) as unknown as Built,
      pred(or(isTrueNode(p('published')), and(isNullNode(p('title')), isNullNode(p('amount'))))),
    )
  })

  it('and() / or() identities and not()', () => {
    assertSame(from().where(() => q.and()) as unknown as Built, pred(and()))
    assertSame(from().where(() => q.or()) as unknown as Built, pred(or()))
    assertSame(
      from().where(({ posts: t }) => q.not(q.isTrue(t.published))) as unknown as Built,
      pred(notNode(isTrueNode(p('published')))),
    )
  })

  it('in ([]) is a constant and = any($1) is the bulk form', () => {
    assertSame(
      from().where(({ posts: t }) => q.inList(t.id, [])) as unknown as Built,
      pred(inListNode(p('id'), [])),
    )
    assertSame(
      from().where(({ posts: t }) => q.inList(t.id, [1n, 2n, 3n])) as unknown as Built,
      pred(inAny(p('id'), param([1n, 2n, 3n], arrayCodecOf(int8Codec)))),
    )
  })

  it('in (subquery)', () => {
    assertSame(
      from().where(({ posts: t }) =>
        q.inQuery(t.authorId, db.from(schema.h.users).select(({ users: x }) => ({ id: x.id }))),
      ) as unknown as Built,
      pred(
        (() => {
          const sub = select({ projection: [projection('id', u('id'))], from: usersFrom })
          return { k: 'in', e: p('authorId'), not: false, set: { k: 'query', query: sub } } as never
        })(),
      ),
    )
  })

  it('a sql fragment is a first-class predicate', () => {
    assertSame(
      from().where(({ posts: t }) => q.and(q.isTrue(t.published), sql`a or b`.asUnsafe<boolean>())) as unknown as Built,
      pred(and(isTrueNode(p('published')), toNode(sql`a or b`))),
    )
  })

  it('order by direction + nulls placement, limit/offset, distinct on, locking', () => {
    const base = { projection: [projection('id', p('id'))], from: postsFrom } as const
    assertSame(
      from().orderBy(({ posts: t }) => [
        q.desc(t.createdAt, 'last'),
        q.asc(t.id, 'first'),
      ]) as unknown as Built,
      select({ ...base, orderBy: [desc(p('createdAt'), 'last'), asc(p('id'), 'first')] }),
    )
    assertSame(
      from().limit(10).offset(20) as unknown as Built,
      select({ ...base, limit: param(10, int4Codec), offset: param(20, int4Codec) }),
    )
    assertSame(
      from()
        .distinctOn(({ posts: t }) => t.authorId)
        .orderBy(({ posts: t }) => [q.asc(t.authorId), q.desc(t.createdAt)]) as unknown as Built,
      select({
        ...base,
        distinct: { on: [p('authorId')] },
        orderBy: [asc(p('authorId')), desc(p('createdAt'))],
      }),
    )
    assertSame(
      from().forUpdate({ of: ['posts'], wait: 'skip locked' }) as unknown as Built,
      select({ ...base, locking: { strength: 'update', of: ['posts'], wait: 'skip locked' } }),
    )
  })

  it('sql fragments in the projection, typed and untyped', () => {
    assertSame(
      db.from(schema.h.users).select(({ users: t }) => ({
        id: t.id,
        lowered: sql`lower(${t.email})`.as(textCodec),
        untyped: sql`now()`.asUnsafe<Date>(),
      })) as unknown as Built,
      select({
        projection: [
          projection('id', u('id')),
          projection('lowered', toNode(sql`lower(${u('email')})`.as(textCodec))),
          projection('untyped', toNode(sql`now()`)),
        ],
        from: usersFrom,
      }),
    )
  })

  it('a second alias for the same table is just a different alias', () => {
    assertSame(
      db
        .from(schema.h.users)
        .innerJoin(schema.h.users, 'u2', ({ users: a, u2: b }) => q.eq(a.id, b.id))
        .select(({ users: a, u2: b }) => ({ a: a.id, b: b.id })) as unknown as Built,
      select({
        projection: [projection('a', u('id')), projection('b', u('id', 'u2'))],
        from: usersFrom,
        joins: [
          { k: 'join', type: 'inner', item: table(usersTable, 'u2'), on: eqNode(u('id'), u('id', 'u2')) },
        ],
      }),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// test/compile/nested.test.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('nested.test.ts — relation projections, from the builder', () => {
  it('the LATERAL nesting golden: users → latestPosts, paginated per parent', () => {
    assertSame(
      db
        .from(schema.h.users)
        .select(({ users: t }) => ({
          id: t.id,
          email: t.email,
          latestPosts: t.posts.many((sub) =>
            sub
              .select((x) => ({
                id: x.id,
                title: x.title,
                amount: x.amount,
                createdAt: x.createdAt,
              }))
              .where((x) => q.isTrue(x.published))
              .orderBy((x) => q.desc(x.createdAt))
              .limit(3),
          ),
        }))
        .where(({ users: t }) => q.isNull(t.deletedAt))
        .orderBy(({ users: t }) => q.desc(t.createdAt))
        .limit(20) as unknown as Built,
      select({
        projection: [
          projection('id', u('id')),
          projection('email', u('email')),
          nested('latestPosts', {
            kind: 'many',
            query: select({
              projection: [
                projection('id', p('id')),
                projection('title', p('title')),
                projection('amount', p('amount')),
                projection('createdAt', p('createdAt')),
              ],
              from: postsFrom,
              where: and(eqNode(p('authorId'), u('id')), isTrueNode(p('published'))),
              orderBy: [desc(p('createdAt'))],
              limit: param(3, int4Codec),
            }),
          }),
        ],
        from: usersFrom,
        where: isNullNode(u('deletedAt')),
        orderBy: [desc(u('createdAt'))],
        limit: param(20, int4Codec),
      }),
    )
  })

  it('a to-one relation, declared required, is a lateral with limit 1', () => {
    assertSame(
      db.from(schema.h.posts).select(({ posts: t }) => ({
        id: t.id,
        author: t.author.one((sub) => sub.select((x) => ({ id: x.id, email: x.email }))),
      })) as unknown as Built,
      select({
        projection: [
          projection('id', p('id')),
          nested('author', {
            kind: 'one',
            required: true,
            query: select({
              projection: [projection('id', u('id')), projection('email', u('email'))],
              from: usersFrom,
              where: eqNode(u('id'), p('authorId')),
            }),
          }),
        ],
        from: postsFrom,
      }),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// test/compile/insert.test.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('insert.test.ts — every hand-built tree, from the builder', () => {
  const into = table(usersTable)
  const cols = [usersCols.email, usersCols.name, usersCols.role]
  const row = (email: string, name: string, role: string) => [
    param(email, varcharCodec),
    param(name, textCodec),
    param(role, textCodec),
  ]

  it('§2.5 single-row insert with RETURNING', () => {
    assertSame(
      db
        .insertInto(schema.h.users)
        .values({ email: 'a@b.c', name: 'Ada', role: 'admin' })
        .returning(({ users: t }) => ({ id: t.id, createdAt: t.createdAt })) as unknown as Built,
      insert({
        into,
        columns: cols,
        source: { k: 'values', rows: [row('a@b.c', 'Ada', 'admin')] },
        returning: [projection('id', u('id')), projection('createdAt', u('createdAt'))],
      }),
    )
  })

  it('no RETURNING => a void shape', () => {
    assertSame(
      db.insertInto(schema.h.users).values({ email: 'a@b.c', name: 'A', role: 'r' }) as unknown as Built,
      insert({ into, columns: cols, source: { k: 'values', rows: [row('a@b.c', 'A', 'r')] } }),
    )
  })

  it('§2.6 multi-row VALUES, castFirstRow on row 1 only', () => {
    assertSame(
      db.insertInto(schema.h.users).valuesMany([
        { email: 'a@x', name: 'A', role: 'admin' },
        { email: 'b@x', name: 'B', role: 'user' },
      ]) as unknown as Built,
      insert({
        into,
        columns: cols,
        castFirstRow: true,
        source: { k: 'values', rows: [row('a@x', 'A', 'admin'), row('b@x', 'B', 'user')] },
      }),
    )
  })

  it('default values', () => {
    assertSame(
      db.insertInto(schema.h.users).defaultValues() as unknown as Built,
      insert({ into, columns: [], source: { k: 'defaults' } }),
    )
  })
})
