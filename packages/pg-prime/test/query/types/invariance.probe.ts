/**
 * Invariance in `O` (kysely.md Appendix B.2, PORT; design/03 §1.5, design/04 §3.3).
 *
 * The bug this exists to prevent, quoted from kysely.md §1.8 pattern 3: with a covariant result
 * type, the ordinary imperative build-up
 *
 *     let q = db.from(users).select(…)
 *     if (needsEmail) q = q.select(…)      // adds a column
 *     const rows = await q.execute()       // ← `email` is NOT in the type. No error anywhere.
 *
 * silently discards the added column from the result type. Not a wrong type — a *missing* one,
 * with no diagnostic, and the value is there at runtime. `readonly [INV]: (o: O) => O` puts `O`
 * in a contravariant position as well as a covariant one, which makes the reassignment a compile
 * error instead.
 *
 * That trade is only acceptable because `$call` and `$if` absorb the pattern, so both of the
 * legal rewrites are exercised below — a guard rail with no gate is just a wall.
 */
import type { Executor, Query, RowOf, Sources } from '../../../src/query/types.js'
import type { INV, ROW } from '../../../src/query/symbols.js'
import { eq } from '../../../src/query/types.js'
import type { UserId } from '../../schema/fixture.js'
import { schema } from '../../schema/fixture.js'
import type { Assert, Eq } from './kit.js'

declare const db: Executor
declare const needsEmail: boolean

const narrow = db.from(schema.h.users, 'u').select((t) => ({ id: t.u.id }))
const wide = db.from(schema.h.users, 'u').select((t) => ({ id: t.u.id, email: t.u.email }))

// ── the rewrite that works: `$if` ───────────────────────────────────────────
const viaIf = narrow.$if(needsEmail, (q) => q.select((t) => ({ id: t.u.id, email: t.u.email })))
type _ViaIf = Assert<Eq<RowOf<typeof viaIf>, { id: UserId; email?: string }>>

// ── the rewrite that works when the branch does not change the shape: `$call` ─
const filter = <S extends Sources, O, N>(q: Query<S, O, N>): Query<S, O, N> => q.limit(1)
const viaCall = narrow.$call(filter)
type _ViaCall = Assert<Eq<RowOf<typeof viaCall>, { id: UserId }>>

// ── and plain re-binding to a NEW const is always fine ──────────────────────
const step1 = db.from(schema.h.users, 'u').where((t) => eq(t.u.role, 'admin'))
const step2 = needsEmail
  ? step1.select((t) => ({ id: t.u.id, email: t.u.email }))
  : step1.select((t) => ({ id: t.u.id, email: t.u.slug }))
type _Ternary = Assert<Eq<RowOf<typeof step2>, { id: UserId; email: string }>>

/**
 * The marker itself, pinned — and this assertion exists because a mutation proved the three
 * negative controls below were not enough (R10).
 *
 * Deleting `readonly [INV]: (o: O) => O` from `Query` leaves all three of them **green**: `SetOps`
 * declares `union<Q extends RowSource<unknown>>(q: Q): SetResult<O, Q, B>`, whose return type is a conditional
 * on `O`, and TypeScript cannot compute variance through a deferred conditional — so it compares
 * structurally, which is invariant. `Query` therefore stays invariant *by accident*.
 *
 * That is a coincidence, not a design: set operations could move to their own stage interface
 * tomorrow and the kysely.md §1.8 pattern-3 bug would come back silently. So the marker is
 * asserted directly as well as behaviourally.
 */
type _Marker = Assert<Eq<(typeof narrow)[typeof INV], (o: { id: UserId }) => { id: UserId }>>

// ─────────────────────────────────────────────────────────────────────────────
// Negative controls — the kysely.md §1.8 pattern 3 bug, in both directions
// ─────────────────────────────────────────────────────────────────────────────

declare let acc: typeof narrow
// @ts-expect-error a WIDER result must not flow into a narrower binding (this is the actual bug)
acc = wide

declare let acc2: typeof wide
// @ts-expect-error and a narrower one must not flow into a wider binding either
acc2 = narrow

/** The same thing through a parameter, which is where it usually reaches a helper. */
declare function takesNarrow(q: typeof narrow): void
// @ts-expect-error invariance applies at every assignment position, not just `=`
takesNarrow(wide)

/**
 * The control (R4): **without** `[INV]`, the first assignment above compiles. `Covariant` is
 * `Query` with the invariance marker removed and nothing else changed, and `wide` flows straight
 * into it — which is exactly the silent column loss described at the top of this file.
 */
interface Covariant<O> {
  readonly [ROW]: O
}
declare let cov: Covariant<{ id: UserId }>
declare const covWide: Covariant<{ id: UserId; email: string }>
cov = covWide
