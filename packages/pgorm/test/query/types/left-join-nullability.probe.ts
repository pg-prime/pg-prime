/**
 * `leftJoin` nullability (design/03 §2.2 — the Drizzle PORT).
 *
 * Two separate claims, and the second is the one nearly every builder gets wrong:
 *
 *  1. every column read off a left-joined alias gains `| null`;
 *  2. a *group* built from that alias is `{…} | null` **as a whole**, with its fields keeping
 *     their own nullability — `author: { id: UserId } | null`, never
 *     `author: { id: UserId | null } | null`. The second is sound and useless: after
 *     `if (row.author)` you would still be holding `UserId | null`.
 *
 * Claim 2 is why `NullRef` keeps the column's original `[META]` — `M['t']` is the pre-join type,
 * and `nestNullable` peels the join's `| null` back off exactly once.
 */
import { expectTypeOf } from 'expect-type'
import type { Executor, RowOf } from '../../../src/query/types.js'
import { eq, nest, nestNullable } from '../../../src/query/types.js'
import type { UserId } from '../../schema/fixture.js'
import { schema } from '../../schema/fixture.js'
import type { Assert, Eq } from './kit.js'

declare const db: Executor

const q = db
  .from(schema.h.posts, 'p')
  .leftJoin(schema.h.users, 'u', (t) => eq(t.p.authorId, t.u.id))
  .select((t) => ({
    // claim 1 — the joined alias's columns are nullable, the driving alias's are not
    id: t.p.id,
    email: t.u.email,
    // an already-nullable column does not become `| null | null`
    name: t.u.displayName,
    // claim 2 — whole-object
    author: nestNullable({ id: t.u.id, email: t.u.email, name: t.u.displayName }),
    // and the opposite spelling stays per-field, which is the honest answer for `nest`
    perField: nest({ id: t.u.id }),
  }))

expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{
  id: string
  email: string | null
  name: string | null
  author: { id: UserId; email: string; name: string | null } | null
  perField: { id: UserId | null }
}>()
type _Q = Assert<
  Eq<
    RowOf<typeof q>,
    {
      id: string
      email: string | null
      name: string | null
      author: { id: UserId; email: string; name: string | null } | null
      perField: { id: UserId | null }
    }
  >
>

/** `selectAll` of a left-joined alias nullifies the whole row, column by column. */
const all = db
  .from(schema.h.posts, 'p')
  .leftJoin(schema.h.comments, 'c', (t) => eq(t.c.postId, t.p.id))
  .selectAll('c')
type _All = Assert<
  Eq<RowOf<typeof all>, { id: string | null; postId: string | null; body: string | null }>
>

/** …and `selectAll` of an alias that was *not* left-joined is untouched. */
const allDriving = db
  .from(schema.h.comments, 'c')
  .leftJoin(schema.h.posts, 'p', (t) => eq(t.c.postId, t.p.id))
  .selectAll('c')
type _AllDriving = Assert<Eq<RowOf<typeof allDriving>, { id: string; postId: string; body: string }>>

/** Nullability survives further joins: `u` stays nullable after another inner join is added. */
const later = db
  .from(schema.h.posts, 'p')
  .leftJoin(schema.h.users, 'u', (t) => eq(t.p.authorId, t.u.id))
  .innerJoin(schema.h.comments, 'c', (t) => eq(t.c.postId, t.p.id))
  .select((t) => ({ e: t.u.email, b: t.c.body }))
type _Later = Assert<Eq<RowOf<typeof later>, { e: string | null; b: string }>>

/** A left join's operands are the *real* columns inside `ON` — nulling happens after the join. */
db.from(schema.h.posts, 'p').leftJoin(schema.h.users, 'u', (t) => eq(t.p.authorId, t.u.id))

// ─────────────────────────────────────────────────────────────────────────────
// Negative controls. Each directive sits directly above the line that must fail — an
// `@ts-expect-error` only covers the next *line*, so a multi-line chain would suppress nothing
// and still report clean.
// ─────────────────────────────────────────────────────────────────────────────

declare function needsString(s: string): void
declare function needsAuthor(a: { id: UserId }): void
declare function needsUserId(u: UserId): void

const lj = db
  .from(schema.h.posts, 'p')
  .leftJoin(schema.h.users, 'u', (t) => eq(t.p.authorId, t.u.id))
  .select((t) => ({ e: t.u.email, author: nestNullable({ id: t.u.id }) }))
declare const ljRow: RowOf<typeof lj>

// @ts-expect-error claim 1: a left-joined column is `string | null`, not `string`
needsString(ljRow.e)

// @ts-expect-error claim 2: the group is nullable as a whole
needsAuthor(ljRow.author)

/** …and once narrowed, the field inside is NOT nullable. This is the whole point of claim 2. */
if (ljRow.author) needsUserId(ljRow.author.id)
