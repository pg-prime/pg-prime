/**
 * `select` — the projection algebra (design/04 §2.1).
 *
 * The claim under test: `Project<P>` is exact. Not `Partial`, not widened, not dehydrated, and
 * the same whether the value came from a column, an aggregate, a `sql` fragment or a `nest(...)`.
 */
import { expectTypeOf } from 'expect-type'
import { numericCodec } from '../../../src/codec/index.js'
import type { Executor, RowOf } from '../../../src/query/types.js'
import { fn, gt, nest, sql } from '../../../src/query/types.js'
import type { UserId, UserPrefs } from '../../schema/fixture.js'
import { defineSchema, pgTable } from '../../../src/schema/index.js'
import { schema } from '../../schema/fixture.js'
import type { Assert, Eq } from './kit.js'

declare const db: Executor

// ── positive: one key per projection entry, each with its own exact type ─────
const q = db.from(schema.h.users, 'u').select((t) => ({
  id: t.u.id,
  email: t.u.email,
  name: t.u.displayName,
  views: t.u.views,
  prefs: t.u.prefs,
  tags: t.u.tags,
  role: t.u.role,
  birthday: t.u.birthday,
  balance: t.u.balance,
  createdAt: t.u.createdAt,
}))

expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{
  id: UserId
  email: string
  name: string | null
  views: bigint
  prefs: UserPrefs
  tags: string[]
  role: 'owner' | 'admin' | 'member'
  birthday: import('../../../src/schema/index.js').DateString | null
  balance: string
  createdAt: Date
}>()

/** Nothing is optional, and nothing is `| undefined`. Prisma-grade, not `Partial`. */
type _Exact = Assert<
  Eq<
    RowOf<typeof q>,
    {
      id: UserId
      email: string
      name: string | null
      views: bigint
      prefs: UserPrefs
      tags: string[]
      role: 'owner' | 'admin' | 'member'
      birthday: import('../../../src/schema/index.js').DateString | null
      balance: string
      createdAt: Date
    }
  >
>

// ── mixed sources: column + aggregate + sql-with-codec + nest ────────────────
const mixed = db
  .from(schema.h.users, 'u')
  .where((t) => gt(t.u.views, 0n))
  .select((t) => ({
    email: t.u.email,
    n: fn.count(),
    bal: sql`coalesce(${t.u.balance}, '0')`.as(numericCodec),
    group: nest({ name: t.u.displayName, at: t.u.createdAt }),
  }))
type _Mixed = Assert<
  Eq<
    RowOf<typeof mixed>,
    { email: string; n: bigint; bal: string; group: { name: string | null; at: Date } }
  >
>

// ── selectAll is the whole row, and it is the table's cached [SEL] slot ──────
const all = db.from(schema.h.comments, 'c').selectAll('c')
type _All = Assert<Eq<RowOf<typeof all>, { id: string; postId: string; body: string }>>

// ── nesting composes: a nest inside a nest ──────────────────────────────────
const deep = db
  .from(schema.h.users, 'u')
  .select((t) => ({ a: nest({ b: nest({ c: t.u.email }) }) }))
type _Deep = Assert<Eq<RowOf<typeof deep>, { a: { b: { c: string } } }>>

// ─────────────────────────────────────────────────────────────────────────────
// Negative controls (R4/R7b). Each is TS2578 — "unused '@ts-expect-error'" — the moment the
// mechanism above it stops working, which is the only reason these probes are worth compiling.
// ─────────────────────────────────────────────────────────────────────────────

// @ts-expect-error a misspelled column is a plain property-access error, with a "did you mean"
db.from(schema.h.users, 'u').select((t) => ({ e: t.u.emial }))

// @ts-expect-error a column of an alias that is not in scope
db.from(schema.h.users, 'u').select((t) => ({ x: t.p.title }))

// @ts-expect-error a bare `sql` fragment is not Projectable — it must choose a codec first
db.from(schema.h.users, 'u').select((t) => ({ x: sql`now()` }))

// @ts-expect-error a bare object literal is not a projection entry — grouping goes through nest()
db.from(schema.h.users, 'u').select((t) => ({ g: { a: t.u.email } }))

// @ts-expect-error a plain JS value is not projectable either
db.from(schema.h.users, 'u').select(() => ({ x: 1 }))

/**
 * A schema that declares **no relations at all** must still reject a misspelling.
 *
 * `RelsAt<Sc, N>` of an absent key is `never`, and `keyof never` is `string | number | symbol` —
 * so a mapped type over it produces an *index signature*, which intersected into the scope would
 * make every property name legal and silently delete column checking for the whole schema. Every
 * table in `fixture.ts` has relations, so nothing else in the suite would notice.
 */
const bare = defineSchema({
  logs: pgTable('logs', (t) => ({ id: t.uuid().primaryKey(), msg: t.text() })),
})
db.from(bare.h.logs, 'l').select((t) => ({ ok: t.l.msg }))
// @ts-expect-error no such column, on a schema with no relations
db.from(bare.h.logs, 'l').select((t) => ({ x: t.l.nope }))
