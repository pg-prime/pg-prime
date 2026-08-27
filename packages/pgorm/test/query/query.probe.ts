/**
 * Type probes for the query surface. Two things, both of them things a mutation proved nothing
 * else was checking (R10): the **type-class gate** on the operator vocabulary, and **relation
 * cardinality** in the result type.
 *
 * WS3 replaced the declaration-only arm with the implemented one, so these now run against the
 * shipped `src/query/ops.ts`. The pgvector row moved out (vector is an extension type with no
 * codec — see `OPS`'s `deferred` entries) and a `net` row took its place; WS3's own decisions —
 * `eq(x, null)`, `TOut`-typed operands, the json/jsonb split, the fragment gate — are pinned
 * separately in `./types/ops.probe.ts`.
 *
 * The gate is the amendment that makes WS0's F1 decision valid (design/09 §3.0, design/03 §2.9).
 *
 * design/03 §2.9 puts operators on refs *specifically* so that the column's type class decides
 * which operators exist, fixing the Kysely defect in `kysely.md` §5.2(3) — an operand typed from
 * the column rather than from the operator. WS0 chose free functions instead, on cost. Free
 * functions typed the obvious way lose the gate: when this suite was first written, four of the
 * seven pairings below **compiled**, each one a 42883 waiting to happen at runtime.
 *
 * So every `@ts-expect-error` here is load-bearing. An unused `@ts-expect-error` is TS2578, so a
 * *lost* rejection fails `test/query/typecheck.test.ts` — which is the only reason this file is
 * worth having (R4: the negative control is the test).
 */

import type { Executor, RowOf } from '../../src/query/types.js'
import {
  and,
  cast,
  concat,
  containsNet,
  eq,
  gt,
  has,
  hasKey,
  ilike,
  isNull,
  jsonContains,
  jsonPathText,
  matches,
  overlaps,
  rangeOverlaps,
  startsWith,
} from '../../src/query/types.js'
import { textCodec } from '../../src/codec/index.js'
import { schema } from '../schema/fixture.js'

declare const db: Executor

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

// ── positive controls: every operator on a column of its own class ───────────
db.from(schema.h.users, 'u').where((t) =>
  and(
    ilike(t.u.email, '%@acme.com'),
    startsWith(t.u.email, 'a'),
    overlaps(t.u.tags, ['vip']),
    has(t.u.tags, 'vip'),
    hasKey(t.u.prefs, 'theme'),
    jsonContains(t.u.prefs, { theme: 'dark' }),
    eq(jsonPathText(t.u.prefs, ['digest']), 'daily'),
    gt(t.u.views, 0n),
    isNull(t.u.birthday),
  ),
)

// ── negative controls, the ones that ONLY a class gate can catch ─────────────
// These columns' TS types are `string`, so a signature that merely asked for "something that
// yields a string" would accept every one of them. PostgreSQL has no `numeric ~~* text`, no
// `member_role ~~* text` and no `uuid ~~* text`: each is a 42883. Verified by mutation (R10) —
// widening `ilike`'s operand back to `ExprOf<string>` turns these three, and only these three,
// from TS2345 into TS2578 unused-directive failures.
// @ts-expect-error a text operator on numeric
db.from(schema.h.users, 'u').where((t) => ilike(t.u.balance, 'x'))
// @ts-expect-error a text operator on an enum column
db.from(schema.h.users, 'u').where((t) => ilike(t.u.role, 'x'))
// @ts-expect-error a text operator on uuid
db.from(schema.h.users, 'u').where((t) => startsWith(t.u.id, 'x'))

// ── negative controls: the operator does not belong to the column's class ────
// @ts-expect-error a text operator on jsonb
db.from(schema.h.users, 'u').where((t) => ilike(t.u.prefs, 'x'))
// @ts-expect-error an array operator on a scalar text column
db.from(schema.h.users, 'u').where((t) => has(t.u.email, 'x'))
// @ts-expect-error a jsonb containment operator on a text column
db.from(schema.h.users, 'u').where((t) => jsonContains(t.u.email, {}))
// @ts-expect-error a jsonb key operator on an integer column
db.from(schema.h.users, 'u').where((t) => hasKey(t.u.age, 'k'))
// @ts-expect-error tsvector `@@` on a text column
db.from(schema.h.users, 'u').where((t) => matches(t.u.email, t.u.displayName))
// @ts-expect-error a range operator on timestamptz
db.from(schema.h.users, 'u').where((t) => rangeOverlaps(t.u.createdAt, t.u.createdAt))
// @ts-expect-error a network operator on a text column (`inet >> inet`, not `text >> text`)
db.from(schema.h.users, 'u').where((t) => containsNet(t.u.email, '10.0.0.0/8'))

// ── the operand comes from the OPERATOR, not the column ──────────────────────
// @ts-expect-error `ilike` takes a pattern, not a number
db.from(schema.h.users, 'u').where((t) => ilike(t.u.email, 1))
// @ts-expect-error `has` takes an ELEMENT of the array, not another array
db.from(schema.h.users, 'u').where((t) => has(t.u.tags, ['vip']))
// @ts-expect-error `eq` ties the right operand to the left's output type
db.from(schema.h.users, 'u').where((t) => eq(t.u.views, 'not a bigint'))

// ─────────────────────────────────────────────────────────────────────────────
// Relation cardinality reaches the result type (design/04 §2.4's `RelOut`).
//
// `bench/types` only ever projects a `many` relation, so it cannot tell `RelOut<M, O>` from a
// hard-coded `O[]` — verified by mutation (R10): replacing the picker's return with `Expr<O[]>`
// left the whole bench green. These three lines are what makes that mutation fail.
// ─────────────────────────────────────────────────────────────────────────────

const rel = db.from(schema.h.users, 'u').select((t) => ({
  posts: t.u.posts.many((q) => q.select((p) => ({ id: p.id }))),
  latest: t.u.latest.one((q) => q.select((p) => ({ id: p.id }))),
}))
type _Many = Assert<
  Eq<RowOf<typeof rel>, { posts: { id: string }[]; latest: { id: string } | null }>
>

const relOne = db
  .from(schema.h.posts, 'p')
  .select((t) => ({ author: t.p.author.one((q) => q.select((u) => ({ email: u.email }))) }))
/** A required `one` is NOT nullable — the distinction `maybeOne` exists to make. */
type _One = Assert<Eq<RowOf<typeof relOne>, { author: { email: string } }>>

// ─────────────────────────────────────────────────────────────────────────────
// Nullability survives cast() and concat() (design/09 audit D22).
//
// `NULL::text` is NULL and `NULL || 'x'` is NULL, so an operator that changes the *type* of an
// operand must not change whether it can be absent. Dropping the `| null` made a left-joined or
// `.nullable()` column read as non-nullable in the result type, which is the one thing this layer
// is for. Verified by mutation (R10): removing `Extract<A[OUT], null>` from either signature turns
// the two `_Nullable*` assertions below red.
// ─────────────────────────────────────────────────────────────────────────────

const casts = db.from(schema.h.users, 'u').select((t) => ({
  nullableCast: cast(t.u.displayName, textCodec),
  notNullCast: cast(t.u.email, textCodec),
  nullableConcat: concat(t.u.displayName, '!'),
  notNullConcat: concat(t.u.email, '!'),
}))
type _NullableCast = Assert<
  Eq<
    RowOf<typeof casts>,
    {
      nullableCast: string | null
      notNullCast: string
      nullableConcat: string | null
      notNullConcat: string
    }
  >
>

