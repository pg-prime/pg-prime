/**
 * `nest` / `nestNullable`, and the derived table (design/09 WS4; `03` §2.2, §2.8, fork F2).
 *
 * The one claim worth a probe of its own is `03` §2.2's PORT: left-join nullability propagates to
 * the **whole nested object**, not to each field. `author: { id: T } | null` is usable — after
 * `if (row.author)` you are holding a `T`. `author: { id: T | null }` is sound and useless, and is
 * what almost every other builder produces. `nest` deliberately does NOT do it, which is the R4
 * negative control: a grouped ref off a left-joined alias is honestly `T | null` per field when
 * the group as a whole is not marked nullable.
 */
import { expectTypeOf } from 'expect-type'
import { numericCodec } from '../../../src/codec/index.js'
import type { Executor, RowOf } from '../../../src/query/types.js'
import { eq, nest, nestNullable, sql } from '../../../src/query/types.js'
import type { UserId } from '../../schema/fixture.js'
import { schema } from '../../schema/fixture.js'

declare const db: Executor

// ── nest(): pure grouping, exact types ───────────────────────────────────────
const grouped = db
  .from(schema.h.posts, 'p')
  .innerJoin(schema.h.users, 'u', (t) => eq(t.p.authorId, t.u.id))
  .select((t) => ({
    id: t.p.id,
    author: nest({ id: t.u.id, name: t.u.displayName, spend: sql`0`.as(numericCodec) }),
  }))

expectTypeOf<RowOf<typeof grouped>>().toEqualTypeOf<{
  id: string
  author: { id: UserId; name: string | null; spend: string }
}>()

// ── nestNullable(): the WHOLE object is nullable, fields keep their pre-join types ──
const left = db
  .from(schema.h.posts, 'p')
  .leftJoin(schema.h.users, 'u', (t) => eq(t.p.authorId, t.u.id))
  .select((t) => ({ id: t.p.id, author: nestNullable({ id: t.u.id, name: t.u.displayName }) }))

expectTypeOf<RowOf<typeof left>>().toEqualTypeOf<{
  id: string
  author: { id: UserId; name: string | null } | null
}>()

/** After the narrow, `id` is a `UserId` — not `UserId | null`. That is the whole point. */
declare const row: RowOf<typeof left>
if (row.author) expectTypeOf(row.author.id).toEqualTypeOf<UserId>()

// ── R4: plain nest() on a left-joined alias nulls each FIELD, honestly ───────
const leftPlain = db
  .from(schema.h.posts, 'p')
  .leftJoin(schema.h.users, 'u', (t) => eq(t.p.authorId, t.u.id))
  .select((t) => ({ id: t.p.id, author: nest({ id: t.u.id }) }))

expectTypeOf<RowOf<typeof leftPlain>>().toEqualTypeOf<{
  id: string
  author: { id: UserId | null }
}>()

// ── the derived table: a query is a source, with the sub-select's types ─────
const recent = db
  .from(schema.h.posts, 'p')
  .select((t) => ({ id: t.p.id, authorId: t.p.authorId }))
  .as('recent')

const fromDerived = db.from(recent).select((t) => ({ id: t.recent.id }))
expectTypeOf<RowOf<typeof fromDerived>>().toEqualTypeOf<{ id: string }>()

// @ts-expect-error — the derived table exposes only what the sub-select projected
db.from(recent).select((t) => ({ x: t.recent.title }))

// ── a set operation is a source too, and its refs are the result columns ────
const both = db
  .from(schema.h.users, 'u')
  .select((t) => ({ label: t.u.email }))
  .union(db.from(schema.h.posts, 'p').select((t) => ({ label: t.p.title })))

expectTypeOf<RowOf<typeof both>>().toEqualTypeOf<{ label: string }>()

// @ts-expect-error — `ORDER BY` on a set-op result names an output column, not a scope
both.orderBy((r) => r.nope)

export type _Unused = [typeof grouped, typeof leftPlain, typeof fromDerived, typeof both]
