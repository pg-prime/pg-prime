/**
 * `.with()` — CTEs (design/03 §2.7).
 *
 * The claim design/03 makes against Kysely: **codecs flow through the CTE**, because the CTE's
 * row shape is our own projection type rather than a column list re-parsed out of a string. So a
 * `numeric` selected into a CTE still reads `string` on the other side, an `int8` still reads
 * `bigint`, and a `timestamptz` still reads `Date`.
 *
 * A CTE is modelled as a handle over a synthetic one-table schema, which is what lets `RefsAt`,
 * `ScopeOf`, `innerJoin` and every operator work on it with **no conditional added to the hot
 * path** to ask "is this alias a CTE?".
 */
import { expectTypeOf } from 'expect-type'
import type { Executor, RowOf } from '../../../src/query/types.js'
import { eq, fn, gt, ilike, nest } from '../../../src/query/types.js'
import type { UserId } from '../../schema/fixture.js'
import { schema } from '../../schema/fixture.js'
import type { Assert, Eq } from './kit.js'

declare const db: Executor

// ── positive: the codec survives the round trip ─────────────────────────────
const d = db.with('recent', (x) =>
  x
    .from(schema.h.users, 'u')
    .where((t) => gt(t.u.views, 0n))
    .select((t) => ({
      id: t.u.id, // uuid + $type<UserId>
      bal: t.u.balance, // numeric  → string, not number
      views: t.u.views, // int8     → bigint, not number
      at: t.u.createdAt, // timestamptz → Date
      name: t.u.displayName, // nullable stays nullable
    })),
)

const q = d.fromCte('recent', 'r').select((t) => ({
  id: t.r.id,
  bal: t.r.bal,
  views: t.r.views,
  at: t.r.at,
  name: t.r.name,
}))

expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{
  id: UserId
  bal: string
  views: bigint
  at: Date
  name: string | null
}>()
type _Q = Assert<
  Eq<RowOf<typeof q>, { id: UserId; bal: string; views: bigint; at: Date; name: string | null }>
>

/** A CTE joins like any other source, because it *is* an ordinary handle. */
const joined = d
  .fromCte('recent', 'r')
  .innerJoin(schema.h.posts, 'p', (t) => eq(t.p.authorId, t.r.id))
  .select((t) => ({ title: t.p.title, who: nest({ bal: t.r.bal }) }))
type _Joined = Assert<Eq<RowOf<typeof joined>, { title: string; who: { bal: string } }>>

/** Without an alias, the CTE is in scope under its own name. */
const unaliased = d.fromCte('recent').select((t) => ({ b: t.recent.bal }))
type _Unaliased = Assert<Eq<RowOf<typeof unaliased>, { b: string }>>

/** Several CTEs chain, and earlier ones are visible to later ones. */
const two = db
  .with('a', (x) => x.from(schema.h.posts, 'p').select((t) => ({ id: t.p.id })))
  .with('b', (x) => x.fromCte('a', 'z').select((t) => ({ id: t.z.id })))
two.fromCte('b', 'y').select((t) => ({ id: t.y.id }))

/** `.cte` exposes the handles, so a second CTE joins with the ordinary `innerJoin`. */
two.fromCte('a', 'z').innerJoin(two.cte.b, 'y', (t) => eq(t.z.id, t.y.id))

/** A left-joined CTE nullifies exactly like a table. */
const ljCte = db
  .from(schema.h.posts, 'p')
  .leftJoin(d.cte.recent, 'r', (t) => eq(t.p.authorId, t.r.id))
  .select((t) => ({ bal: t.r.bal }))
type _LjCte = Assert<Eq<RowOf<typeof ljCte>, { bal: string | null }>>

// ─────────────────────────────────────────────────────────────────────────────
// Negative controls
// ─────────────────────────────────────────────────────────────────────────────

// @ts-expect-error no such CTE
d.fromCte('nope')

// @ts-expect-error no such column on the CTE's row
d.fromCte('recent', 'r').select((t) => ({ x: t.r.email }))

// @ts-expect-error a CTE has no relations, so no relation accessor exists on it
d.fromCte('recent', 'r').select((t) => ({ x: t.r.posts }))

// @ts-expect-error the CTE name is already taken (return-position sentinel: it lands on `.cte`)
d.with('recent', (x) => x.from(schema.h.posts, 'p').select((t) => ({ id: t.p.id }))).cte

/**
 * **A documented gap, pinned so it cannot change silently.** The operator type-class gate reads
 * `[META]['pg']`, and a CTE column's PG type is not recoverable from the row type alone — it
 * would need the projection record `P`, i.e. a fourth `Query` type parameter carried through
 * every method. So `pg` is `any` on a CTE ref, and the gate degrades from "class *and* shape" to
 * "shape only": `ilike` on a CTE column that is really a `numeric` compiles here, where the same
 * call on the base table is correctly rejected because `numeric` is not a text class.
 *
 * Contained two ways: the TS type is still exact, so the decoded *value* cannot be wrong; and the
 * shape half of the gate still holds (`ilike(t.r.views, …)` on a `bigint` is still an error). Only
 * the class half is lost, and PostgreSQL rejects the resulting SQL at prepare time.
 *
 * **WS4 revisited it and kept it** (design/09 §3.4). Recovering the class needs the projection
 * record on `Query`, which is a fourth type parameter threaded through every method — the one
 * shape design/04 §1.3 rules out, and the per-query budget has no room for it. The cost is
 * measured and bounded, and it is written out below.
 */
d.fromCte('recent', 'r').where((t) => ilike(t.r.bal, 'x%'))
// @ts-expect-error ...and on the base table, the same call is correctly rejected
db.from(schema.h.users, 'u').where((t) => ilike(t.u.balance, 'x%'))
// @ts-expect-error the *shape* half of the gate still holds on a CTE ref
d.fromCte('recent', 'r').where((t) => ilike(t.r.views, 'x%'))

/**
 * The second consequence, found in WS4: an aggregate whose result type is a *function of the
 * operand's PG type* cannot narrow over a CTE column, because `P` is `any` and every branch of
 * `SumPg`/`SumOut` is therefore live at once.
 *
 * `sum(numeric)` is `numeric`, so the runtime value is a precision-exact `string` — the widening
 * is purely in the type. On the base table the same call narrows exactly, which is the negative
 * control that keeps this honest: if the base-table case ever widens too, `_SumOnTable` fails.
 */
const sumCte = d.fromCte('recent', 'r').select((t) => ({ v: fn.sum(t.r.bal) }))
type _SumOnCte = Assert<Eq<RowOf<typeof sumCte>, { v: string | number | bigint | null }>>

const sumTable = db.from(schema.h.users, 'u').select((t) => ({ v: fn.sum(t.u.balance) }))
type _SumOnTable = Assert<Eq<RowOf<typeof sumTable>, { v: string | null }>>
