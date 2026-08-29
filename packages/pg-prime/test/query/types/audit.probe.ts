/**
 * The WS-L audit findings on the query type surface.
 *
 * Compiled (not run) on TS 5.9.3 and 7.0.2 by `test/query/typecheck.test.ts`; every
 * `@ts-expect-error` below is a gate, because an *unused* suppression is itself an error.
 */
import { expectTypeOf } from 'expect-type'
import { dateCodec, int8Codec, textCodec } from '../../../src/codec/index.js'
import type { PgDateString } from '../../../src/codec/index.js'
import type { OUT } from '../../../src/schema/index.js'
import type { Executor, RowOf } from '../../../src/query/types.js'
import { eq, val } from '../../../src/query/types.js'
import { schema } from '../../schema/fixture.js'
import type { UserId } from '../../schema/fixture.js'
import type { Assert, Eq } from './kit.js'

declare const db: Executor

const selected = db.from(schema.h.users, 'u').select((t) => ({ id: t.u.id }))

// ─────────────────────────────────────────────────────────────────────────────
// E2 — `$if(boolean, …)` may not claim a column the branch drops
//
// `select()` REPLACES. Kysely's `O & Partial<Omit<O2, keyof O>>` is only honest when the branch
// keeps every key the query already has; when it does not, the boolean case resolves to the
// sentence instead of to a row type that promises a column the SQL will not return.
// ─────────────────────────────────────────────────────────────────────────────

declare const flag: boolean

const additive = selected.$if(flag, (q) => q.select((t) => ({ id: t.u.id, email: t.u.email })))
type _Additive = Assert<Eq<RowOf<typeof additive>, { id: UserId; email?: string }>>

const replacing = selected.$if(flag, (q) => q.select((t) => ({ email: t.u.email })))
// @ts-expect-error — the branch drops `id`, so this is `OrmTypeError<…>`, not a query
replacing.execute()

// The two literal-condition overloads stay exact and are *not* guarded: with `false` the branch
// never runs, and with `true` the branch's own shape is the whole answer.
const replacingTrue = selected.$if(true, (q) => q.select((t) => ({ email: t.u.email })))
type _True = Assert<Eq<RowOf<typeof replacingTrue>, { email: string }>>
const replacingFalse = selected.$if(false, (q) => q.select((t) => ({ email: t.u.email })))
type _False = Assert<Eq<RowOf<typeof replacingFalse>, { id: UserId }>>

// ─────────────────────────────────────────────────────────────────────────────
// E4 — set operations and `$if` take a SELECT, not any row source
// ─────────────────────────────────────────────────────────────────────────────

const otherSelect = db.from(schema.h.posts, 'p').select((t) => ({ id: t.p.id }))
const insertReturning = db
  .insertInto(schema.h.posts)
  .values({ authorId: 'a', title: 't' })
  .returning((t) => ({ id: t.posts.id }))

// A select branch with the same columns is fine…
const sameShape = db.from(schema.h.users, 'v').select((t) => ({ id: t.v.id }))
selected.union(sameShape).execute()

// …an InsertQuery is not: it satisfies `RowSource` structurally, but `select … union insert …` is
// not a statement. Return-position sentinel (measured: the parameter-position spelling prints the
// whole `InsertQuery<Handle<Schema<…>>>` and costs 1 055 characters against D9's 300).
// @ts-expect-error
selected.union(insertReturning).execute()

// @ts-expect-error — nor is a DELETE … RETURNING, even though it does yield rows
selected.union(db.deleteFrom(schema.h.posts).allRows().returning((t) => ({ id: t.posts.id }))).execute()

// @ts-expect-error — `$if` must not hand back a `Query<S, …>` built over a foreign scope
selected.$if(flag, () => insertReturning)

// @ts-expect-error — …nor a query over a different table's scope
selected.$if(flag, () => otherSelect)

// ─────────────────────────────────────────────────────────────────────────────
// E5 — one date brand, so codec-typed values reach a `date()` column
// ─────────────────────────────────────────────────────────────────────────────

declare const rawDate: PgDateString

// `val(…, dateCodec)` yields the codec's brand; `users.birthday` is a `date()` column. These used
// to be two different nominal types, and each of the three lines below was a TS2345/TS2322.
const dateWhere = db
  .from(schema.h.users, 'u')
  .where((t) => eq(t.u.birthday, val(rawDate, dateCodec)))
  .select((t) => ({ b: t.u.birthday }))
type _DateWhere = Assert<Eq<RowOf<typeof dateWhere>, { b: PgDateString | null }>>

db.update(schema.h.users).set(() => ({ birthday: rawDate })).allRows()
db.update(schema.h.users).set(() => ({ birthday: val(rawDate, dateCodec) })).allRows()

// @ts-expect-error — negative control: a bare string is still not a `date`
db.update(schema.h.users).set(() => ({ birthday: '2026-01-01' })).allRows()

// ─────────────────────────────────────────────────────────────────────────────
// E10 — a scalar subquery over zero rows is NULL
// ─────────────────────────────────────────────────────────────────────────────

const scalar = db.from(schema.h.posts, 'p').select((t) => ({ id: t.p.id })).asScalar()
expectTypeOf<(typeof scalar)[typeof OUT]>().toEqualTypeOf<string | null>()
type _Scalar = Assert<Eq<(typeof scalar)[typeof OUT], string | null>>

// ─────────────────────────────────────────────────────────────────────────────
// E13 — `FOR UPDATE OF` names aliases in scope
// ─────────────────────────────────────────────────────────────────────────────

selected.forUpdate({ of: ['u'], wait: 'skip locked' })

// @ts-expect-error — "users" is the table, not the alias this query gave it
selected.forUpdate({ of: ['users'] })

// ─────────────────────────────────────────────────────────────────────────────
// E14 — bulk rows are homogeneous, and `fromValues` rows are typed by their codecs
// ─────────────────────────────────────────────────────────────────────────────

db.insertInto(schema.h.posts).valuesMany([
  { authorId: 'a', title: 't' },
  { authorId: 'b', title: 'u' },
])

// Rows that differ only in the VALUE of a union-typed column — `boolean` is `true | false`, and an
// enum column is a union of its labels — are one batch. The first spelling of the guard asked
// whether `R` came out a union and refused these; design/12 §4 D found it while writing the
// getting-started page.
db.insertInto(schema.h.posts).valuesMany([
  { authorId: 'a', title: 't', published: true },
  { authorId: 'b', title: 'u', published: false },
])

// One statement, one column list: a heterogeneous batch is not insertable. Return-position
// sentinel again, so the gate lands where the result is used.
const hetero = db.insertInto(schema.h.posts).valuesMany([
  { authorId: 'a', title: 't' },
  { authorId: 'b', title: 'u', body: 'x' },
])
// @ts-expect-error
hetero.compileAll()

db.update(schema.h.posts)
  .fromValues([{ id: 'p1', title: 't' }], { id: textCodec, title: textCodec })
  .set((t, v) => ({ title: v.title }))
  .allRows()

db.update(schema.h.posts)
  // @ts-expect-error — `id` is declared `int8Codec`, whose input is bigint|number|string
  .fromValues([{ id: true }], { id: int8Codec })
  .set(() => ({ title: 'x' }))
  .allRows()

db.update(schema.h.posts)
  // @ts-expect-error — …and every declared codec needs a value in every row
  .fromValues([{}], { id: int8Codec })
  .set(() => ({ title: 'x' }))
  .allRows()

// ─────────────────────────────────────────────────────────────────────────────
// E16 — nothing runs, and no set operation starts, before there is a projection
// ─────────────────────────────────────────────────────────────────────────────

const unselected = db.from(schema.h.users, 'u')

// @ts-expect-error — `select *` is exactly the shape the positional decoder cannot decode
unselected.execute()

// A set operation over an unprojected branch has no column list to align, on either side. Like
// `SetResult`'s own mismatch sentences this is a RETURN-position sentinel (measured: checking in
// parameter position prints the whole `Query<Schema<…>>` twice), so the gate lands on the use.
// @ts-expect-error
unselected.union(selected).execute()

// @ts-expect-error
selected.union(unselected).execute()

// @ts-expect-error — a grouped query is no different
unselected.groupBy((t) => t.u.id).execute()

export type _Unused = [
  typeof additive,
  typeof replacing,
  typeof replacingTrue,
  typeof replacingFalse,
  typeof scalar,
  typeof dateWhere,
  typeof hetero,
  _Additive,
  _True,
  _False,
  _Scalar,
  _DateWhere,
]
