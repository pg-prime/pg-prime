/**
 * `$if` — the literal-condition overloads (kysely.md Appendix B.1, PORT; design/03 §1.5).
 *
 * Kysely's `$if` always returns `Partial`, because it cannot tell a compile-time-known condition
 * from a runtime one. It can be told: three signatures, `true` / `false` / `boolean`. The
 * `boolean` case still has to widen — that is honest, not a defect — but the two literal cases,
 * which is what a feature flag or a `const` almost always is, stay exact.
 *
 * This is the one deliberate exception to design/04 §4's "never overload a hot-path builder
 * method": `$if` is a composition helper, not a hot path, and §1.5 names the three signatures.
 */
import { expectTypeOf } from 'expect-type'
import type { Executor, RowOf } from '../../../src/query/types.js'
import { eq } from '../../../src/query/types.js'
import type { UserId } from '../../schema/fixture.js'
import { schema } from '../../schema/fixture.js'
import type { Assert, Eq } from './kit.js'

declare const db: Executor

const base = db.from(schema.h.users, 'u').select((t) => ({ id: t.u.id }))
const widen = (q: typeof base) => q.select((t) => ({ id: t.u.id, email: t.u.email }))

// ── `true`: exactly the widened shape, no `Partial` ──────────────────────────
const yes = base.$if(true, widen)
expectTypeOf<RowOf<typeof yes>>().toEqualTypeOf<{ id: UserId; email: string }>()
type _Yes = Assert<Eq<RowOf<typeof yes>, { id: UserId; email: string }>>

// ── `false`: exactly the original shape ─────────────────────────────────────
const no = base.$if(false, widen)
type _No = Assert<Eq<RowOf<typeof no>, { id: UserId }>>

// ── a runtime `boolean`: the added keys become OPTIONAL, not `| undefined` ───
declare const flag: boolean
const maybe = base.$if(flag, widen)
type _Maybe = Assert<Eq<RowOf<typeof maybe>, { id: UserId; email?: string }>>

/**
 * The distinction above is the whole reason `kit.ts` uses a strict `Eq` rather than mutual
 * assignability: `{ email?: string }` and `{ email: string | undefined }` are assignable to each
 * other under `exactOptionalPropertyTypes: false` and would compare equal under a looser test.
 */
type _NotUndefinedUnion = Assert<
  Eq<Eq<RowOf<typeof maybe>, { id: UserId; email: string | undefined }>, false>
>

/** A `const` narrows to a literal, so it takes the exact branch. */
const FEATURE = true
const constFlag = base.$if(FEATURE, widen)
type _Const = Assert<Eq<RowOf<typeof constFlag>, { id: UserId; email: string }>>

/** A condition that only filters keeps the shape on every branch. */
const filtered = base.$if(flag, (q) => q.where((t) => eq(t.u.role, 'admin')))
type _Filtered = Assert<Eq<RowOf<typeof filtered>, { id: UserId }>>

// ─────────────────────────────────────────────────────────────────────────────
// Negative controls
// ─────────────────────────────────────────────────────────────────────────────

declare function needsEmail(e: string): void
declare const maybeRow: RowOf<typeof maybe>

// @ts-expect-error the boolean branch made `email` optional — it may be absent
needsEmail(maybeRow.email)

declare const noRow: RowOf<typeof no>
// @ts-expect-error the `false` branch never added `email` at all
noRow.email

// @ts-expect-error the callback has to return a query, not a value
base.$if(true, () => 1)
