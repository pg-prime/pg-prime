/**
 * The `GROUP BY` guard (design/03 §2.3, last paragraph).
 *
 * A relation *row-set* projection compiles to `LEFT JOIN LATERAL … ON TRUE` correlated on the
 * parent's primary key, so after a `GROUP BY` that key must still be in the grouping list or the
 * parent row is not identifiable. design/03 calls this "the one place where the unified API needs
 * a guard rail, and it is a compile-time one".
 *
 * Three properties this file pins, because each is a place the guard could be wrong:
 *
 *  · it fires — grouping a non-key column blocks the accessor with a sentence;
 *  · it does **not** over-fire — grouping the key leaves the accessor exactly as it was;
 *  · it is biased safe — a table whose primary key is not visible at the type level (a
 *    table-level `primaryKey(a, b)`, which is runtime-only) is *allowed*, never falsely rejected.
 */
import { expectTypeOf } from 'expect-type'
import type { Executor, RowOf } from '../../../src/query/types.js'
import { eq, fn, gt } from '../../../src/query/types.js'
import { defineRelations, defineSchema, pgTable, primaryKey, REFS } from '../../../src/schema/index.js'
import type { UserId } from '../../schema/fixture.js'
import { schema } from '../../schema/fixture.js'
import type { Assert, Eq } from './kit.js'

declare const db: Executor

// ── positive: the primary key is in the grouping list, so nothing changes ────
const ok = db
  .from(schema.h.users, 'u')
  .groupBy((t) => [t.u.id])
  .select((t) => ({
    id: t.u.id,
    n: fn.count(),
    posts: t.u.posts.many((q) => q.select((p) => ({ id: p.id, title: p.title }))),
  }))

expectTypeOf<RowOf<typeof ok>>().toEqualTypeOf<{
  id: UserId
  n: bigint
  posts: { id: string; title: string }[]
}>()
type _Ok = Assert<
  Eq<RowOf<typeof ok>, { id: UserId; n: bigint; posts: { id: string; title: string }[] }>
>

/** A single ref, not an array, is the same thing. */
db.from(schema.h.users, 'u')
  .groupBy((t) => t.u.id)
  .select((t) => ({ posts: t.u.posts.many((q) => q.select((p) => ({ id: p.id }))) }))

/** Extra grouping columns alongside the key are fine. */
db.from(schema.h.users, 'u')
  .groupBy((t) => [t.u.id, t.u.email, t.u.role])
  .select((t) => ({ posts: t.u.posts.many((q) => q.select((p) => ({ id: p.id }))) }))

/** `having` lives on the grouped stage, and takes the same guarded scope. */
const withHaving = db
  .from(schema.h.users, 'u')
  .groupBy((t) => t.u.id)
  .having(() => gt(fn.count(), 1n))
  .select((t) => ({ id: t.u.id, n: fn.count() }))
type _Having = Assert<Eq<RowOf<typeof withHaving>, { id: UserId; n: bigint }>>

/** Plain columns are never guarded — only relation row-set accessors are. */
db.from(schema.h.users, 'u')
  .groupBy((t) => t.u.email)
  .select((t) => ({ e: t.u.email, n: fn.count() }))

/**
 * Biased safe: `attempts` declares its key with the table-level `primaryKey(...)` extra, which is
 * runtime-only, so `PkOf` is `never` and `[never] extends [anything]` is true. An unmodelled key
 * therefore produces a *missed* rejection, never a false one — and PostgreSQL still catches it
 * (`column "…" must appear in the GROUP BY clause`).
 */
const t2 = {
  attempts: pgTable(
    'attempts',
    (t) => ({ userId: t.uuid(), day: t.date(), n: t.integer() }),
    (t) => [primaryKey(t.userId, t.day)],
  ),
  events: pgTable('events', (t) => ({ id: t.uuid().primaryKey(), attemptUser: t.uuid() })),
}
const s2 = defineSchema(
  t2,
  defineRelations(t2, (r) => ({
    attempts: {
      events: r.many.events({ from: t2.attempts[REFS].userId, to: t2.events[REFS].attemptUser }),
    },
  })),
)
db.from(s2.h.attempts, 'a')
  .groupBy((t) => t.a.n)
  .select((t) => ({ ev: t.a.events.many((q) => q.select((e) => ({ id: e.id }))) }))

// ─────────────────────────────────────────────────────────────────────────────
// Negative controls
// ─────────────────────────────────────────────────────────────────────────────

const grouped = db.from(schema.h.users, 'u').groupBy((t) => [t.u.email])

// @ts-expect-error relation projection needs the parent primary key in groupBy()
grouped.select((t) => ({ posts: t.u.posts.many((q) => q.select((p) => ({ id: p.id }))) }))

// @ts-expect-error the same guard applies to `having`
grouped.having((t) => t.u.posts.many((q) => q.select((p) => ({ id: p.id }))))

/** Grouping by *another table's* key does not unlock this one. */
const wrongKey = db
  .from(schema.h.users, 'u')
  .innerJoin(schema.h.posts, 'p', (t) => eq(t.p.authorId, t.u.id))
  .groupBy((t) => [t.p.id])
// @ts-expect-error `posts.id` is grouped; `users.id` is not
wrongKey.select((t) => ({ posts: t.u.posts.many((q) => q.select((p) => ({ id: p.id }))) }))

/** The grouped stage is a stage: joining after `groupBy` is not part of the v1 surface. */
// @ts-expect-error no `innerJoin` after `groupBy`
grouped.innerJoin(schema.h.posts, 'p', (t) => eq(t.p.authorId, t.u.id))
