/**
 * The builder's **boundary checks**, tier 0.
 *
 * Everything here is a value that the type layer already rejects and that arrives anyway, because
 * it came from JSON: a config file, a request body, a saved "view" definition. So no test below
 * casts the public API — each one gets its untyped value from `JSON.parse`, which is both how the
 * value reaches a real program and the reason `as never` would prove nothing (design/09 §1: no
 * casts of the public surface).
 *
 * Two kinds of assertion, and both are needed:
 *
 *  - the **rejection** — a named `BuilderError` (or `NullOperandError`), never a message match on
 *    something the compiler happened to say three layers down;
 *  - the **negative control** — the legal spelling next to it still compiles, byte for byte, so a
 *    guard that rejected everything would fail just as loudly as one that rejected nothing.
 */

import { describe, expect, it } from 'vitest'
import { int8Codec } from '../../src/codec/index.js'
import {
  col,
  projection,
  select as selectNode,
  table as tableFrom,
  tableMeta,
} from '../../src/compile/nodes.js'
import { BuilderError, NullOperandError } from '../../src/sql/errors.js'
import { refsOf } from '../../src/query/ref.js'
import { compileOnly } from '../../src/query/run.js'
import * as q from '../../src/query/types.js'
import { defineSchema, pgTable } from '../../src/schema/index.js'
import { posts, schema, users } from './_schema.js'

const db = compileOnly(schema)
/** The same frozen ref objects a scope hands a callback — `refsOf` is what `scopeFor` calls. */
const u = refsOf(users, 'users')
const p = refsOf(posts, 'posts')
const sqlOf = (b: { compile(): { sql: string } }) => b.compile().sql

/** An untyped value, exactly as a config file or a request body delivers one. */
const fromJson = (text: string): never => JSON.parse(text) as never

// ─────────────────────────────────────────────────────────────────────────────
// D2 — every keyword the emitter splices is checked against a closed set
// ─────────────────────────────────────────────────────────────────────────────

describe('SQL keywords that reach the text verbatim', () => {
  const users = () => db.from(schema.h.users).select(({ users: u }) => ({ id: u.id }))

  it('forUpdate refuses a wait mode it does not know, and keeps the three it does', () => {
    expect(() =>
      users().forUpdate(fromJson('{"wait":"nowait; drop table users --"}')),
    ).toThrowError(BuilderError)
    expect(() => users().forUpdate(fromJson('{"strength":"update of pg_authid"}'))).toThrowError(
      BuilderError,
    )
    expect(sqlOf(users().forUpdate({ strength: 'key share', wait: 'skip locked' }))).toBe(
      [
        'select "users"."id" as "id"',
        'from "public"."users" as "users"',
        'for key share skip locked',
      ].join('\n'),
    )
  })

  it('asc/desc refuse a NULLS position they do not know', () => {
    const evil = fromJson('"last limit 1 offset 3"')
    expect(() => db.from(schema.h.users).orderBy(({ users: u }) => q.asc(u.id, evil))).toThrowError(
      BuilderError,
    )
    expect(() =>
      db.from(schema.h.users).orderBy(({ users: u }) => q.desc(u.id, evil)),
    ).toThrowError(BuilderError)
    expect(
      sqlOf(
        db
          .from(schema.h.users)
          .select(({ users: u }) => ({ id: u.id }))
          .orderBy(({ users: u }) => q.desc(u.deletedAt, 'last')),
      ),
    ).toBe(
      [
        'select "users"."id" as "id"',
        'from "public"."users" as "users"',
        'order by "users"."deleted_at" desc nulls last',
      ].join('\n'),
    )
  })

  it('a window frame refuses an unknown mode, bound keyword or exclusion', () => {
    // The named-window spelling, which is the one that takes a literal (03 §2.8).
    const win = (spec: never) => db.from(schema.h.posts).window('w', () => spec)
    expect(() =>
      win(fromJson('{"frame":{"mode":"rows) as x, (select 1","from":"current row"}}')),
    ).toThrowError(BuilderError)
    expect(() =>
      win(fromJson('{"frame":{"mode":"rows","from":"unbounded preceding; drop table users --"}}')),
    ).toThrowError(BuilderError)
    expect(() =>
      win(
        fromJson(
          '{"frame":{"mode":"rows","from":"current row","exclude":"ties) union select 1 --"}}',
        ),
      ),
    ).toThrowError(BuilderError)
  })

  it('a frame offset must be a SAFE integer — 1e21 is an integer and is not one', () => {
    const frame = (n: number) =>
      db.from(schema.h.posts).select(({ posts: pp }) => ({
        v: q.over(q.fn.sum(pp.amount), (w) => w.rows({ from: { preceding: n } })),
      }))
    expect(() => frame(1e21)).toThrowError(BuilderError)
    expect(() => frame(Number.NaN)).toThrowError(BuilderError)
    expect(sqlOf(frame(3))).toBe(
      [
        'select sum("posts"."amount") over (rows 3 preceding) as "v"',
        'from "public"."posts" as "posts"',
      ].join('\n'),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D9 / D5 — an operand is an expression, and never a silent NULL bind
// ─────────────────────────────────────────────────────────────────────────────

describe('operands', () => {
  it('and()/or()/not() refuse a non-expression instead of binding it as NULL', () => {
    const missing = fromJson('null')
    expect(() => q.and(missing, missing)).toThrowError(BuilderError)
    expect(() => q.or(fromJson('42'))).toThrowError(BuilderError)
    expect(() => q.not(fromJson('"published"'))).toThrowError(BuilderError)
  })

  it('desc("id") is an error, not an ORDER BY on a constant', () => {
    expect(() => q.desc(fromJson('"id"'))).toThrowError(BuilderError)
  })

  it('fn.count() is count(*); fn.count(undefined) is a typo and says so', () => {
    expect(sqlOf(db.from(schema.h.users).select(() => ({ n: q.fn.count() })))).toBe(
      ['select count(*) as "n"', 'from "public"."users" as "users"'].join('\n'),
    )
    expect(() => q.fn.count(fromJson('null'))).toThrowError(BuilderError)
  })

  it('every ordered comparison rejects NULL, not just eq/neq', () => {
    const nothing = fromJson('null')
    for (const op of [q.lt, q.lte, q.gt, q.gte] as const) {
      expect(() => op(u.id as never, nothing)).toThrowError(NullOperandError)
    }
    expect(() => q.like(u.email as never, nothing)).toThrowError(NullOperandError)
    expect(() => q.ilike(u.email as never, nothing)).toThrowError(NullOperandError)
  })

  it('between() is an expression — usable in .where() and inside and()', () => {
    expect(
      sqlOf(
        db
          .from(schema.h.posts)
          .select(({ posts: pp }) => ({ id: pp.id }))
          .where(({ posts: pp }) => q.between(pp.id, 1n, 5n)),
      ),
    ).toBe(
      [
        'select "posts"."id" as "id"',
        'from "public"."posts" as "posts"',
        'where "posts"."id" between $1 and $2',
      ].join('\n'),
    )
    expect(
      sqlOf(
        db
          .from(schema.h.posts)
          .select(({ posts: pp }) => ({ id: pp.id }))
          .where(({ posts: pp }) => q.and(q.between(pp.id, 1n, 5n), q.isTrue(pp.published))),
      ),
    ).toBe(
      [
        'select "posts"."id" as "id"',
        'from "public"."posts" as "posts"',
        'where ("posts"."id" between $1 and $2 and "posts"."published" is true)',
      ].join('\n'),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D12 — "is this a query?" is a nominal question
// ─────────────────────────────────────────────────────────────────────────────

describe('a query is a query nominally, not structurally', () => {
  // The shape below is what a `JSON.parse` of a saved query definition looks like. Before the
  // nominal gate it reached the emitter and `chunks` was spliced into the SQL text.
  const forgery = () =>
    fromJson(
      JSON.stringify({
        k: 'select',
        projection: [{ key: 'x', expr: { k: 'raw', chunks: ['1) or true; drop table users --'] } }],
      }),
    )

  it('exists / notExists / inQuery refuse it', () => {
    expect(() => q.exists(forgery())).toThrowError(BuilderError)
    expect(() => q.notExists(forgery())).toThrowError(BuilderError)
    expect(() => q.exists(fromJson('42'))).toThrowError(BuilderError)
    expect(() => q.inQuery(u.id as never, fromJson('"garbage"'))).toThrowError(BuilderError)
  })

  it('union / fromSelect / with refuse it', () => {
    const base = db.from(schema.h.users).select(({ users: u }) => ({ id: u.id }))
    expect(() => base.union(forgery())).toThrowError(BuilderError)
    expect(() => db.insertInto(schema.h.users).fromSelect(forgery())).toThrowError(BuilderError)
    expect(() => db.with('x', () => forgery())).toThrowError(BuilderError)
  })

  it('a hand-built node from src/compile/nodes.ts is still accepted', () => {
    // The negative control: the gate is nominal, not "must be a builder". `test/compile` builds
    // ASTs directly and 03 §1.2 documents them as the layer below the builder.
    const node = selectNode({
      projection: [projection('id', col('users', 'id', int8Codec))],
      from: tableFrom(tableMeta('public', 'users'), 'users'),
    })
    expect(
      sqlOf(
        db
          .from(schema.h.posts)
          .select(({ posts: pp }) => ({ id: pp.id }))
          .where(() => q.exists(node)),
      ),
    ).toBe(
      [
        'select "posts"."id" as "id"',
        'from "public"."posts" as "posts"',
        'where exists (',
        '  select "users"."id" as "id"',
        '  from "public"."users" as "users"',
        ')',
      ].join('\n'),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D11 — an unconditional UPDATE / DELETE is opt-in
// ─────────────────────────────────────────────────────────────────────────────

describe('a write with no WHERE says so out loud', () => {
  it('deleteFrom without .where() is refused; .allRows() is the opt-in', () => {
    expect(() => db.deleteFrom(schema.h.posts).toAst()).toThrowError(BuilderError)
    expect(sqlOf(db.deleteFrom(schema.h.posts).allRows())).toBe(
      'delete from "public"."posts" as "posts"',
    )
  })

  it('update without .where() is refused; .allRows() is the opt-in', () => {
    const set = () => db.update(schema.h.posts).set(() => ({ title: 'x' }))
    expect(() => set().toAst()).toThrowError(BuilderError)
    expect(sqlOf(set().allRows())).toBe(
      ['update "public"."posts" as "posts"', 'set "title" = $1'].join('\n'),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D16 — asScalar and the missing projection
// ─────────────────────────────────────────────────────────────────────────────

describe('a projection is required, and asScalar needs one column', () => {
  it('.compile() without .select() is an error, not `select *`', () => {
    expect(() => db.from(schema.h.users).toAst()).toThrowError(BuilderError)
    expect(() =>
      db
        .from(schema.h.users)
        .union(db.from(schema.h.posts).select(({ posts: p }) => ({ id: p.id }))),
    ).toThrowError(BuilderError)
  })

  it('asScalar refuses a nest() group — it is several columns, not one value', () => {
    expect(() =>
      db
        .from(schema.h.users)
        .select(({ users: u }) => ({ who: q.nest({ id: u.id, email: u.email }) }))
        .asScalar(),
    ).toThrowError(BuilderError)
    // The control: one real column still works.
    expect(
      db
        .from(schema.h.users)
        .select(({ users: u }) => ({ id: u.id }))
        .asScalar(),
    ).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D17 — alias collisions
// ─────────────────────────────────────────────────────────────────────────────

describe('alias collisions', () => {
  it('.using() will not silently overwrite an alias already in scope', () => {
    expect(() => db.deleteFrom(schema.h.posts).using(schema.h.posts)).toThrowError(BuilderError)
    expect(
      sqlOf(
        db
          .deleteFrom(schema.h.posts)
          .using(schema.h.posts, 'other')
          .where(({ posts: pp, other }) => q.eq(pp.authorId, other.authorId)),
      ),
    ).toBe(
      [
        'delete from "public"."posts" as "posts"',
        'using "public"."posts" as "other"',
        'where "posts"."author_id" = "other"."author_id"',
      ].join('\n'),
    )
  })

  it('fromValues() will not shadow an alias already in scope', () => {
    expect(() =>
      db.update(schema.h.posts).fromValues([{ id: 1n }], { id: int8Codec }, { alias: 'posts' }),
    ).toThrowError(BuilderError)
  })

  it('.set() twice may not assign one column twice — PostgreSQL rejects that (42701)', () => {
    expect(() =>
      db
        .update(schema.h.posts)
        .set(() => ({ title: 'a' }))
        .set(() => ({ title: 'b' })),
    ).toThrowError(BuilderError)
    // Disjoint patches still merge, which is what `$if` composition needs.
    expect(
      sqlOf(
        db
          .update(schema.h.posts)
          .set(() => ({ title: 'a' }))
          .set(() => ({ published: true }))
          .allRows(),
      ),
    ).toBe(['update "public"."posts" as "posts"', 'set "title" = $1, "published" = $2'].join('\n'))
  })

  it('a user alias may not look like a compiler-generated one (_r1, _r2, …)', () => {
    expect(() => db.from(schema.h.users, '_r1')).toThrowError(BuilderError)
    expect(() => db.from(schema.h.posts, '_r12')).toThrowError(BuilderError)
    expect(() =>
      db.from(schema.h.users).innerJoin(schema.h.posts, '_r2', () => q.isNull(u.deletedAt)),
    ).toThrowError(BuilderError)
    // `_rx` and `_r` are not in the generated shape and stay legal.
    expect(sqlOf(db.from(schema.h.users, '_rx').select(({ _rx }) => ({ id: _rx.id })))).toContain(
      'as "_rx"',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D20 / D21 — keys that are properties of every object
// ─────────────────────────────────────────────────────────────────────────────

describe('keys that Object.prototype already has', () => {
  it('a CTE may be called "toString"', () => {
    const built = db
      .with('toString', (d) => d.from(schema.h.users).select(({ users: u }) => ({ id: u.id })))
      .fromCte('toString')
      .select((t) => ({ id: t.toString.id }))
    expect(sqlOf(built)).toBe(
      [
        'with "toString" as (',
        '  select "users"."id" as "id"',
        '  from "public"."users" as "users"',
        ')',
        'select "toString"."id" as "id"',
        'from "toString" as "toString"',
      ].join('\n'),
    )
  })

  it('a bulk row setting "toString" is a wrong-column error, not a silent accept', () => {
    expect(() =>
      db.insertInto(schema.h.comments).valuesMany(fromJson('[{"body":"a"},{"toString":"b"}]')),
    ).toThrowError(BuilderError)
  })

  it('"__proto__" is refused as a projection key, an insert column and a SET key', () => {
    expect(() =>
      db.from(schema.h.users).select(({ users: t }) => {
        const proj: Record<string, unknown> = {}
        Object.defineProperty(proj, '__proto__', { value: t.id, enumerable: true })
        return proj as never
      }),
    ).toThrowError(BuilderError)
    expect(() => db.insertInto(schema.h.users).values(protoRow('a@b.c'))).toThrowError(BuilderError)
    expect(() => db.update(schema.h.users).set(() => protoRow('x'))).toThrowError(BuilderError)
  })
})

/** `{ __proto__: v }` as an OWN property — what `JSON.parse` produces and a literal does not. */
function protoRow(v: string): never {
  return JSON.parse(`{"__proto__":${JSON.stringify(v)}}`) as never
}

// ─────────────────────────────────────────────────────────────────────────────
// D6 / D8 — bulk options
// ─────────────────────────────────────────────────────────────────────────────

const tagged = pgTable('tagged', (t) => ({
  id: t.bigint().primaryKey().generatedAlways(),
  name: t.text(),
  tags: t.text().array(),
}))
const bulkSchema = defineSchema({ tagged })
const bulkDb = compileOnly(bulkSchema)

describe('bulk options are checked at the boundary', () => {
  it('chunkSize must be a positive integer — 0 used to hang the process', () => {
    const rows = [{ body: 'a' }, { body: 'b' }]
    for (const size of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        db.insertInto(schema.h.comments).valuesMany(rows, { chunkSize: size }),
      ).toThrowError(BuilderError)
    }
    expect(
      db.insertInto(schema.h.comments).valuesMany(rows, { chunkSize: 1 }).compileAll(),
    ).toHaveLength(2)
  })

  it('an unknown strategy is named rather than silently treated as `values`', () => {
    expect(() =>
      db
        .insertInto(schema.h.comments)
        .valuesMany([{ body: 'a' }], fromJson('{"strategy":"bogus"}')),
    ).toThrowError(BuilderError)
  })

  it("an array column cannot go through 'unnest', and 'auto' does not send it there", () => {
    const rows = [{ name: 'a', tags: ['x'] }]
    expect(() =>
      bulkDb.insertInto(bulkSchema.h.tagged).valuesMany(rows, { strategy: 'unnest' }).compileAll(),
    ).toThrowError(BuilderError)
    // `auto` falls back to `values`: one parameter per cell, and the cast comes from `sqlName`.
    expect(sqlOf(bulkDb.insertInto(bulkSchema.h.tagged).valuesMany(rows))).toBe(
      'insert into "public"."tagged" ("name", "tags") values ($1, $2)',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D13 — a marker in a write position is an error, not a JSON bind
// ─────────────────────────────────────────────────────────────────────────────

describe('projection markers cannot be written as values', () => {
  it('values({ meta: nest({...}) }) is refused rather than bound as the plan object', () => {
    expect(() =>
      db
        .insertInto(schema.h.users)
        .values({
          email: 'a@b.c',
          name: 'Ada',
          role: 'admin',
          meta: q.nest({ id: u.id as never }) as never,
        })
        .toAst(),
    ).toThrowError(BuilderError)
  })

  it('a Date is still data and still becomes one bind', () => {
    const built = db
      .insertInto(schema.h.posts)
      .values({ authorId: 1n, title: 't', amount: '1', published: true, createdAt: new Date(0) })
    expect(built.compile().binds).toHaveLength(5)
    expect(sqlOf(built)).toBe(
      'insert into "public"."posts" ("author_id", "title", "amount", "published", "created_at") ' +
        'values ($1, $2, $3, $4, $5)',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D19 — the ON CONFLICT arbiter names the target's own columns
// ─────────────────────────────────────────────────────────────────────────────

describe('onConflict().columns()', () => {
  it('refuses a ref that belongs to another table, even with the same column name', () => {
    // `posts.id` and `users.id` are the same DB column NAME, so resolving by name accepted it and
    // arbitrated on an index of the wrong table.
    expect(() =>
      db
        .insertInto(schema.h.users)
        .values({ email: 'a@b.c', name: 'Ada', role: 'admin' })
        .onConflict((c) => c.columns(() => [p.id] as never)),
    ).toThrowError(BuilderError)
  })

  it('accepts the target scope’s own ref', () => {
    expect(
      sqlOf(
        db
          .insertInto(schema.h.users)
          .values({ email: 'a@b.c', name: 'Ada', role: 'admin' })
          .onConflict((c) => c.columns((t) => [t.email]).doNothing()),
      ),
    ).toBe(
      [
        'insert into "public"."users" ("email", "name", "role") values ($1, $2, $3)',
        'on conflict ("email")',
        'do nothing',
      ].join('\n'),
    )
  })
})
