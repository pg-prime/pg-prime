/**
 * `$call` and reusable fragments (design/03 §1.5, §2.4).
 *
 * kysely.md §1.8(9) documents that a Kysely helper generic over the table parameter **does not
 * typecheck at all**, because `ReferenceExpression<DB, TB>` cannot be evaluated for an unresolved
 * `TB`, and §1.8(10) that such helpers poison `.d.ts` with ~800-character unresolved conditionals.
 * design/03 §2.4 claims this falls out of D3 (references are values) at no cost. This file is
 * that claim, written down: three shapes of helper, all ordinary structural typing, no `DB` and
 * no `TB` generic anywhere.
 */
import { expectTypeOf } from 'expect-type'
import type { AnyRef, Ref } from '../../../src/schema/index.js'
import type { Executor, Expr, Query, RowOf, Sources } from '../../../src/query/types.js'
import { and, eq, gt, isNull } from '../../../src/query/types.js'
import type { UserId } from '../../schema/fixture.js'
import { schema } from '../../schema/fixture.js'
import type { Assert, Eq } from './kit.js'

declare const db: Executor

// ── 1. a builder-level helper: type-preserving, reusable, `.d.ts`-clean ──────
const paginate =
  (page: number, size: number) =>
  <S extends Sources, O, N>(q: Query<S, O, N>): Query<S, O, N> =>
    q.limit(size).offset(page * size)

const q = db
  .from(schema.h.users, 'u')
  .select((t) => ({ id: t.u.id, email: t.u.email }))
  .$call(paginate(2, 20))

expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{ id: UserId; email: string }>()
type _Q = Assert<Eq<RowOf<typeof q>, { id: UserId; email: string }>>

/** `$call` can also change the shape — it is type-preserving in `S`, not in `O`. */
const projected = db
  .from(schema.h.users, 'u')
  .select((t) => ({ id: t.u.id }))
  .$call((x) => x.select((t) => ({ email: t.u.email })))
type _Projected = Assert<Eq<RowOf<typeof projected>, { email: string }>>

// ── 2. a fragment generic over one column's PG type class ───────────────────
const recent = (c: Ref<string, string, { t: Date; pg: 'timestamptz'; opt: boolean; ro: boolean; pk: boolean }>) =>
  gt(c, new Date())

db.from(schema.h.users, 'u').where((t) => recent(t.u.createdAt))
db.from(schema.h.posts, 'p').where((t) => recent(t.p.createdAt))

// ── 3. a fragment generic over "any scope that has a `createdAt`" ───────────
//      Plain structural typing. This is the one Kysely cannot express at all.
const alive = <T extends { birthday: AnyRef }>(t: T): Expr<boolean> => isNull(t.birthday)

db.from(schema.h.users, 'u').where((t) => and(alive(t.u), recent(t.u.createdAt)))

// ── 4. the two compose, and the result type is still exact ──────────────────
const composed = db
  .from(schema.h.users, 'u')
  .where((t) => and(alive(t.u), eq(t.u.role, 'admin')))
  .select((t) => ({ id: t.u.id }))
  .$call(paginate(0, 10))
type _Composed = Assert<Eq<RowOf<typeof composed>, { id: UserId }>>

// ─────────────────────────────────────────────────────────────────────────────
// Negative controls
// ─────────────────────────────────────────────────────────────────────────────

const callable = db.from(schema.h.users, 'u').select((t) => ({ id: t.u.id }))
// @ts-expect-error the callback must return a query over the same sources
callable.$call(() => 1)

// @ts-expect-error `alive` demands a `birthday` ref; `posts` has none
db.from(schema.h.posts, 'p').where((t) => alive(t.p))

// @ts-expect-error `recent` demands a timestamptz; `balance` is numeric
db.from(schema.h.users, 'u').where((t) => recent(t.u.balance))
