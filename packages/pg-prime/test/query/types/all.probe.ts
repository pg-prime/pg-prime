/**
 * `$all` — every column of an alias, as a plain record (design/03 §2.1, §4.2 form (b); `12` B).
 *
 * Three claims, and the third is the one a `SELECT *` in any other builder cannot make:
 *
 *  1. `{ ...u.$all }` is the table's exact select row — same keys, same types, in declaration
 *     order — so it is `selectAll` with the ergonomics of a spread.
 *  2. It is a **plain record**, so `omit` is a one-line userland function rather than a second
 *     projection language (Prisma needs `select` *and* `omit` and forbids combining them).
 *  3. It is a **spread, not a group**: under a LEFT JOIN each column carries its own `| null`,
 *     where `nestNullable({...})` would have nulled the whole object. Both are right; they are
 *     different questions, and `03` §2.2's whole-object rule belongs to the group.
 */
import { expectTypeOf } from 'expect-type'
import type { Executor, RowOf } from '../../../src/query/types.js'
import { eq, omit } from '../../../src/query/types.js'
import type { UserId, UserPrefs } from '../../schema/fixture.js'
import { schema } from '../../schema/fixture.js'
import type { Assert, Eq } from './kit.js'

declare const db: Executor

type CommentRow = { id: string; postId: string; body: string }

// ── 1. the exact select row ──────────────────────────────────────────────────
const spread = db.from(schema.h.comments, 'c').select((t) => ({ ...t.c.$all }))
expectTypeOf<RowOf<typeof spread>>().toEqualTypeOf<CommentRow>()
type _Spread = Assert<Eq<RowOf<typeof spread>, CommentRow>>

/** …and it is the same row `selectAll` produces, which is what "one mechanism" means. */
const viaSelectAll = db.from(schema.h.comments, 'c').selectAll('c')
type _Same = Assert<Eq<RowOf<typeof spread>, RowOf<typeof viaSelectAll>>>

/** Every column keeps its own decoded type, brands and all — this is not `Record<string, unknown>`. */
const wide = db.from(schema.h.users, 'u').select((t) => ({ ...t.u.$all }))
expectTypeOf<RowOf<typeof wide>['id']>().toEqualTypeOf<UserId>()
expectTypeOf<RowOf<typeof wide>['prefs']>().toEqualTypeOf<UserPrefs>()
expectTypeOf<RowOf<typeof wide>['displayName']>().toEqualTypeOf<string | null>()
type _Tags = Assert<Eq<RowOf<typeof wide>['tags'], string[]>>

// ── 2. a plain record: omit, and composition with other keys ────────────────
const dropped = db.from(schema.h.comments, 'c').select((t) => ({ ...omit(t.c.$all, 'body') }))
type _Dropped = Assert<Eq<RowOf<typeof dropped>, { id: string; postId: string }>>

const droppedTwo = db
  .from(schema.h.comments, 'c')
  .select((t) => ({ ...omit(t.c.$all, 'body', 'postId') }))
type _DroppedTwo = Assert<Eq<RowOf<typeof droppedTwo>, { id: string }>>

const mixed = db
  .from(schema.h.comments, 'c')
  .select((t) => ({ ...t.c.$all, alsoBody: t.c.body }))
type _Mixed = Assert<Eq<RowOf<typeof mixed>, { id: string; postId: string; body: string; alsoBody: string }>>

// @ts-expect-error `omit` only takes keys the record has
omit(db.from(schema.h.comments, 'c'), 'nope')

// ── 3. a spread, not a group: per-column nullability under a LEFT JOIN ──────
const leftJoined = db
  .from(schema.h.posts, 'p')
  .leftJoin(schema.h.comments, 'c', (t) => eq(t.c.postId, t.p.id))
  .select((t) => ({ ...t.c.$all }))
type _Left = Assert<
  Eq<RowOf<typeof leftJoined>, { id: string | null; postId: string | null; body: string | null }>
>

/** The driving side is untouched by the same join. */
const drivingSide = db
  .from(schema.h.posts, 'p')
  .leftJoin(schema.h.comments, 'c', (t) => eq(t.c.postId, t.p.id))
  .select((t) => ({ ...t.p.$all }))
expectTypeOf<RowOf<typeof drivingSide>['id']>().toEqualTypeOf<string>()

// ── negative controls ───────────────────────────────────────────────────────

/** `$all` is columns only: a relation accessor is not in it, and never was. */
db.from(schema.h.users, 'u').select((t) => ({
  // @ts-expect-error `posts` is a relation, and `$all` carries columns
  x: t.u.$all.posts,
}))

/** It is a record, not a projectable value, so it cannot be a column of its own. */
// @ts-expect-error a record of refs is not one ref
db.from(schema.h.users, 'u').select((t) => ({ x: t.u.$all }))

/** There is no `$all` on the sub-scope of a relation *aggregate* operand — that wants one column. */
db.from(schema.h.users, 'u').select((t) => ({
  // @ts-expect-error `sum` takes a numeric column, not the whole record
  n: t.u.posts.sum((p) => p.$all),
}))

/** …but a relation sub-QUERY projection is an ordinary projection, so the spread works there. */
const nested = db.from(schema.h.users, 'u').select((t) => ({
  posts: t.u.posts.many((q) => q.select((p) => ({ ...p.$all }))),
}))
expectTypeOf<RowOf<typeof nested>['posts'][number]['title']>().toEqualTypeOf<string>()
