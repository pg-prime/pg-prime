/**
 * Relation accessors at the type level (design/09 WS5; `03` §2.3, §4.2).
 *
 * The claim under test is the product thesis stated as a type: **a column's type is the same
 * whether you read it at the top level or three relations deep.** Kysely models the JSON round
 * trip honestly and so must degrade `Date` to `string` inside `json_agg` (kysely.md §1.7); we own
 * the codecs, so the degradation does not happen — and the only way to keep it from happening by
 * accident is to write the depth-3 literal down and let `expectTypeOf` fail when it drifts.
 *
 * The negative controls are the other half. A to-many has no `.one()` and a to-one has no
 * `.many()`, because `RelAccessor` splits on `kind` before either interface is instantiated; a
 * relation projection cannot name a column the child does not have; and — the one that matters
 * for `03` §4.2's signature form — a result that loaded `posts` is *assignable* to
 * `Loaded<usersH, 'posts'>` with no cast and no wrapper.
 */
import { expectTypeOf } from 'expect-type'
import type { Executor, RowOf } from '../../../src/query/types.js'
import { desc, isTrue } from '../../../src/query/types.js'
import type { Loaded } from '../../../src/schema/index.js'
import type { UserId, UserPrefs, UsersH } from '../../schema/fixture.js'
import { schema } from '../../schema/fixture.js'
import type { Assert, Eq } from './kit.js'
import type { DateString } from '../../../src/schema/index.js'

declare const db: Executor

// ─────────────────────────────────────────────────────────────────────────────
// Depth 3, exact
// ─────────────────────────────────────────────────────────────────────────────

const deep = db.from(schema.h.users, 'u').select((t) => ({
  id: t.u.id,
  posts: t.u.posts.many((q) =>
    q
      .select((p) => ({
        id: p.id,
        title: p.title,
        comments: p.comments.many((q2) => q2.select((c) => ({ id: c.id, body: c.body }))),
        author: p.author.one((q2) => q2.select((a) => ({ id: a.id, birthday: a.birthday }))),
      }))
      .where((p) => isTrue(p.published))
      .orderBy((p) => desc(p.createdAt))
      .limit(3),
  ),
}))

type Deep = {
  id: UserId
  posts: {
    id: string
    title: string
    comments: { id: string; body: string }[]
    // `author` is declared `r.one`, so it is **not** nullable — no `| null`, no `?`.
    author: { id: UserId; birthday: DateString | null }
  }[]
}
expectTypeOf<RowOf<typeof deep>>().toEqualTypeOf<Deep>()
type _Deep = Assert<Eq<RowOf<typeof deep>, Deep>>

// ─────────────────────────────────────────────────────────────────────────────
// Nullability comes from the declaration, not from the query
// ─────────────────────────────────────────────────────────────────────────────

/** `latest` is `r.maybeOne`, so the whole object is `| null` — never a record of nullable fields. */
const maybe = db
  .from(schema.h.users, 'u')
  .select((t) => ({ latest: t.u.latest.one((q) => q.select((p) => ({ id: p.id }))) }))
type _Maybe = Assert<Eq<RowOf<typeof maybe>, { latest: { id: string } | null }>>

/** A to-many is an array and is never null: `coalesce(json_agg(…), '[]')` guarantees it. */
const many = db
  .from(schema.h.users, 'u')
  .select((t) => ({ posts: t.u.posts.many((q) => q.select((p) => ({ id: p.id }))) }))
type _Many = Assert<Eq<RowOf<typeof many>, { posts: { id: string }[] }>>

/** `.all()` is the whole row of the child, with every column's own type. */
const all = db.from(schema.h.posts, 'p').select((t) => ({ author: t.p.author.all() }))
type _AllId = Assert<Eq<RowOf<typeof all>['author']['id'], UserId>>
type _AllPrefs = Assert<Eq<RowOf<typeof all>['author']['prefs'], UserPrefs>>
type _AllTags = Assert<Eq<RowOf<typeof all>['author']['tags'], string[]>>

// ─────────────────────────────────────────────────────────────────────────────
// Aggregates
// ─────────────────────────────────────────────────────────────────────────────

const aggs = db.from(schema.h.users, 'u').select((t) => ({
  n: t.u.posts.count(),
  // `coalesce(sum(x), 0)` — never null, which is what 03 §2.3 types `revenue` as.
  hasAny: t.u.posts.exists(),
}))
type _Aggs = Assert<Eq<RowOf<typeof aggs>, { n: bigint; hasAny: boolean }>>

/** A filter accessor is an ordinary boolean expression, so it composes in `where`. */
db.from(schema.h.users, 'u')
  .select((t) => ({ id: t.u.id }))
  .where((t) => t.u.posts.some((p) => isTrue(p.published)))
db.from(schema.h.users, 'u')
  .select((t) => ({ id: t.u.id }))
  .where((t) => t.u.posts.every((p) => isTrue(p.published)))

// ─────────────────────────────────────────────────────────────────────────────
// 03 §4.2 — the signature form
// ─────────────────────────────────────────────────────────────────────────────

declare function render(u: Loaded<UsersH, 'posts'>): void

const loaded = db.from(schema.h.users, 'u').select((t) => ({
  id: t.u.id,
  email: t.u.email,
  displayName: t.u.displayName,
  age: t.u.age,
  views: t.u.views,
  active: t.u.active,
  prefs: t.u.prefs,
  tags: t.u.tags,
  role: t.u.role,
  birthday: t.u.birthday,
  balance: t.u.balance,
  createdAt: t.u.createdAt,
  updatedAt: t.u.updatedAt,
  seq: t.u.seq,
  slug: t.u.slug,
  posts: t.u.posts.all(),
}))
declare const rows: RowOf<typeof loaded>[]
// No cast, no `Collection`, no `Ref` — the projection form *is* the load state.
render(rows[0]!)

// ─────────────────────────────────────────────────────────────────────────────
// Negative controls
// ─────────────────────────────────────────────────────────────────────────────

// @ts-expect-error a to-many has no `.one()`
db.from(schema.h.users, 'u').select((t) => ({ x: t.u.posts.one((q) => q.select((p) => ({ id: p.id }))) }))

// @ts-expect-error a to-one has no `.many()`
db.from(schema.h.posts, 'p').select((t) => ({ x: t.p.author.many((q) => q.select((u) => ({ id: u.id }))) }))

// @ts-expect-error no such relation
db.from(schema.h.users, 'u').select((t) => ({ x: t.u.nope.all() }))

db.from(schema.h.users, 'u').select((t) => ({
  // @ts-expect-error no such column on the child
  x: t.u.posts.many((q) => q.select((p) => ({ id: p.nope }))),
}))

// @ts-expect-error the relation sub-query has no `.innerJoin()` — a relation is not a join
db.from(schema.h.users, 'u').select((t) => ({ x: t.u.posts.many((q) => q.innerJoin()) }))

// @ts-expect-error `sum` is class-gated like every other numeric operator
db.from(schema.h.users, 'u').select((t) => ({ x: t.u.posts.sum((p) => p.title) }))

// @ts-expect-error a column the projection did not select is not on the result
rows[0]!.posts[0]!.nope
