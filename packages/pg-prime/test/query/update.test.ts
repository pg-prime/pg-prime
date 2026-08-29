/**
 * UPDATE, tier 0 (design/09 WS4; `03` §2.5–2.6, Appendix A).
 *
 * The clause this file exists for is `fromValues`: one statement that applies N different patches,
 * where the alternative is N round trips or a `CASE` per column. Its two strategies mirror the
 * bulk insert's for the same reason, and both are pinned here with their `::type` casts, because
 * an uncast `VALUES` join source is `text` and `"posts"."id" = "v"."id"` is then a 42883 at
 * runtime — a failure no amount of type-checking can catch.
 */

import { describe, expect, it } from 'vitest'
import { int8Codec, numericCodec } from '../../src/codec/index.js'
import { compileOnly } from '../../src/query/run.js'
import { defineSchema, pgTable } from '../../src/schema/index.js'
import * as q from '../../src/query/types.js'
import { schema } from './_schema.js'

const db = compileOnly(schema)
const sqlOf = (b: { compile(): { sql: string } }) => b.compile().sql
const vals = (b: { compile(): { binds: readonly unknown[] } }) =>
  b.compile().binds.map((x) => (x as { encoded?: unknown }).encoded)

describe('§2.5 — set / where / returning', () => {
  it('set targets are unqualified, set values are qualified', () => {
    const built = db
      .update(schema.h.posts)
      .set(({ posts: p }) => ({ published: true, amount: q.add(p.amount, '1') }))
      .where(({ posts: p }) => q.and(q.eq(p.authorId, 7n), q.isFalse(p.published)))
      .returning(({ posts: p }) => ({ id: p.id }))

    expect(sqlOf(built)).toBe(
      [
        'update "public"."posts" as "posts"',
        'set "amount" = "posts"."amount" + $1, "published" = $2',
        'where ("posts"."author_id" = $3 and "posts"."published" is false)',
        'returning "id" as "id"',
      ].join('\n'),
    )
    expect(vals(built)).toStrictEqual(['1', 't', '7'])
    expect(built.compile().meta.writes).toStrictEqual([{ schema: 'public', name: 'posts' }])
  })

  it('the SET list is in table order, so two spellings are one statement', () => {
    const a = db
      .update(schema.h.posts)
      .set(() => ({ published: true, title: 'x' }))
      .allRows()
    const b = db
      .update(schema.h.posts)
      .set(() => ({ title: 'x', published: true }))
      .allRows()
    expect(sqlOf(a)).toBe(sqlOf(b))
  })

  it('an update with no .set() is refused rather than emitted', () => {
    expect(() =>
      db
        .update(schema.h.posts)
        .where(({ posts: p }) => q.isNull(p.title))
        .toAst(),
    ).toThrowError(/needs a \.set\(\{\.\.\.\}\)/)
  })

  it('a column the table does not have is named', () => {
    expect(() =>
      db
        .update(schema.h.posts)
        .set(() => ({ nope: 1 }) as never)
        .toAst(),
    ).toThrowError(/names column\(s\) \[nope\]/)
  })
})

describe('§2.6 — bulk update by key', () => {
  const patches = [
    { id: 1n, amount: '1.00' },
    { id: 2n, amount: '2.00' },
  ]
  const codecs = { id: int8Codec, amount: numericCodec }

  it('matches Appendix A: values source, casts on the first row only', () => {
    const built = db
      .update(schema.h.posts)
      .fromValues(patches, codecs)
      .set((_t, v) => ({ amount: v.amount, createdAt: q.fn.now() }))
      .where(({ posts: p }, v) => q.eq(p.id, v.id))

    expect(sqlOf(built)).toBe(
      [
        'update "public"."posts" as "posts"',
        'set "amount" = "v"."amount", "created_at" = now()',
        'from (values ($1::bigint, $2::numeric), ($3, $4)) as "v"("id", "amount")',
        'where "posts"."id" = "v"."id"',
      ].join('\n'),
    )
    expect(vals(built)).toStrictEqual(['1', '1.00', '2', '2.00'])
  })

  it('the unnest strategy is one parameter per column', () => {
    const built = db
      .update(schema.h.posts)
      .fromValues(patches, codecs, { strategy: 'unnest' })
      .set((_t, v) => ({ amount: v.amount }))
      .where(({ posts: p }, v) => q.eq(p.id, v.id))

    expect(sqlOf(built)).toBe(
      [
        'update "public"."posts" as "posts"',
        'set "amount" = "v"."amount"',
        'from unnest($1::bigint[], $2::numeric[]) as "v"("id", "amount")',
        'where "posts"."id" = "v"."id"',
      ].join('\n'),
    )
    expect(vals(built)).toStrictEqual(['{1,2}', '{1.00,2.00}'])
    expect(built.compile().binds).toHaveLength(2)
  })

  it('the values refs carry their declared codecs into the result shape', () => {
    const built = db
      .update(schema.h.posts)
      .fromValues(patches, codecs)
      .set((_t, v) => ({ amount: v.amount }))
      .where(({ posts: p }, v) => q.eq(p.id, v.id))
      .returning(({ posts: p }) => ({ id: p.id, amount: p.amount }))
    expect(built.compile().shape).toMatchObject({
      fields: [
        { key: 'id', codec: { name: 'int8' } },
        { key: 'amount', codec: { name: 'numeric' } },
      ],
    })
  })

  it('a patch missing a declared key is named, not NULLed', () => {
    expect(() =>
      db
        .update(schema.h.posts)
        .fromValues([{ id: 1n }] as never, codecs)
        .set((_t, v) => ({ amount: v.amount }))
        .toAst(),
    ).toThrowError(/row 0 of fromValues\(\) does not set "amount"/)
  })

  it('an empty patch list is refused: it would match no rows', () => {
    expect(() => db.update(schema.h.posts).fromValues([], codecs)).toThrowError(
      /would match no rows/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// `.$onUpdate()` — design/05 §6.2, and design/12 §4 D finding a
// ─────────────────────────────────────────────────────────────────────────────

/** Local, for the same reason `insert.test.ts`'s `defaulted` is: `_schema.ts` is a twin. */
const STAMP = new Date('2020-01-02T03:04:05.000Z')
let stamps = 0
const touched = pgTable('touched', (t) => ({
  id: t.integer().primaryKey(),
  title: t.text(),
  updatedAt: t.timestamptz().$onUpdate(() => {
    stamps += 1
    return STAMP
  }),
}))
const uSchema = defineSchema({ touched })
const uDb = compileOnly(uSchema)

describe('`.$onUpdate()` is applied on update (05 §6.2; design/12 §4 D finding a)', () => {
  it('appends the column the caller did not set', () => {
    stamps = 0
    const built = uDb
      .update(uSchema.h.touched)
      .set(() => ({ title: 'x' }))
      .where(({ touched: t }) => q.eq(t.id, 1))
    expect(sqlOf(built)).toBe(
      [
        'update "public"."touched" as "touched"',
        'set "title" = $1, "updated_at" = $2',
        'where "touched"."id" = $3',
      ].join('\n'),
    )
    expect(vals(built)).toStrictEqual(['x', '2020-01-02 03:04:05.000Z', '1'])
    expect(stamps).toBe(1)
  })

  it('an explicit assignment wins — and is not assigned twice (42701)', () => {
    // Doing this in `.set()` rather than at `toAst()` would have produced two assignments to one
    // column, which is exactly the error `.set()` raises by hand for a `$if` that overlaps.
    stamps = 0
    const built = uDb
      .update(uSchema.h.touched)
      .set(() => ({ updatedAt: new Date('1999-01-01T00:00:00.000Z') }))
      .allRows()
    expect(sqlOf(built)).toBe(
      ['update "public"."touched" as "touched"', 'set "updated_at" = $1'].join('\n'),
    )
    expect(vals(built)).toStrictEqual(['1999-01-01 00:00:00.000Z'])
    expect(stamps).toBe(0)
  })

  it('runs once per builder however many times it is compiled', () => {
    stamps = 0
    const built = uDb
      .update(uSchema.h.touched)
      .set(() => ({ title: 'x' }))
      .allRows()
    built.toAst()
    built.compile()
    built.toSQL()
    expect(stamps).toBe(1)
  })

  it('does not create an UPDATE out of nothing: `.set({})` is still refused', () => {
    expect(() =>
      uDb
        .update(uSchema.h.touched)
        .set(() => ({}))
        .allRows()
        .toAst(),
    ).toThrowError(/needs a \.set\(\{\.\.\.\}\)/)
  })

  it('is NOT applied to onConflict().doUpdate(): that list is the caller’s conflict action', () => {
    stamps = 0
    const built = uDb
      .insertInto(uSchema.h.touched)
      .values({ id: 1, title: 'x', updatedAt: STAMP })
      .onConflict((c) => c.columns(({ id }) => id).doUpdate((_t, ex) => ({ title: ex.title })))
    expect(sqlOf(built)).toContain('do update set "title" = "excluded"."title"')
    expect(stamps).toBe(0)
  })
})
