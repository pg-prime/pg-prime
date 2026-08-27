/**
 * WS3's own type decisions (design/09 §3.3). The cross-class gate itself is pinned in
 * `../query.probe.ts`; this file pins the four things WS3 had to *decide* and one it had to fix.
 *
 * Every `@ts-expect-error` is load-bearing: an unused directive is TS2578, so a decision that
 * silently reverses fails `test/query/typecheck.test.ts` rather than passing quietly (R7b).
 */

import { expectTypeOf } from 'expect-type'
import {
  jsonCodecJson,
  jsonbCodec,
  numericCodec,
  textCodec,
  tsqueryCodec,
  tsvectorCodec,
} from '../../../src/codec/index.js'
import type { Executor, RowOf } from '../../../src/query/types.js'
import {
  and,
  asc,
  desc,
  eq,
  fn,
  gt,
  hasKey,
  ilike,
  isDistinctFrom,
  isNull,
  jsonGetText,
  jsonPathText,
  matches,
  sql,
} from '../../../src/query/types.js'
import { schema } from '../../schema/fixture.js'
import type { Assert, Eq } from './kit.js'

declare const db: Executor

// ─────────────────────────────────────────────────────────────────────────────
// DECISION 1 — `eq(a, null)` is a type error, not `IS NULL`
//
// `a = NULL` is NULL, so the query returns nothing. `isNull` and `isDistinctFrom` say the two
// things a caller could have meant, and both stay open to `null`. See `NullOperandError` in
// `src/sql/errors.ts` for why this is a rejection and not a silent rewrite.
// ─────────────────────────────────────────────────────────────────────────────

db.from(schema.h.users, 'u').where((t) => isNull(t.u.birthday))
db.from(schema.h.users, 'u').where((t) => isDistinctFrom(t.u.birthday, null))
// @ts-expect-error `eq(x, null)` would compile to `x = NULL`, which is never true
db.from(schema.h.users, 'u').where((t) => eq(t.u.birthday, null))
// @ts-expect-error same for the negation
db.from(schema.h.users, 'u').where((t) => eq(t.u.displayName, null))

/** A NULLABLE column is still a legal operand — it is the literal `null` that is rejected. */
db.from(schema.h.users, 'u').where((t) => eq(t.u.displayName, t.u.email))

// ─────────────────────────────────────────────────────────────────────────────
// DECISION 2 — operands are typed by the codec's `TOut`, never its `TIn`
//
// `timestamptz.encode` accepts `Date | string`, so `TIn` would let a comparison take a string.
// It would ALSO let a `timestamptz` be compared to a `text` column, because `Expr<string>` is
// assignable to `ExprOf<Date | string>` — which is the actual harm, and why the decision is
// `TOut`. Writing a value (insert / update) still uses `TIn`; that surface is unambiguous.
// ─────────────────────────────────────────────────────────────────────────────

db.from(schema.h.users, 'u').where((t) => gt(t.u.createdAt, new Date('2026-01-01')))
// @ts-expect-error a timestamptz is compared to a Date, not to its wire spelling
db.from(schema.h.users, 'u').where((t) => gt(t.u.createdAt, '2026-01-01'))
// @ts-expect-error and never to a text column
db.from(schema.h.users, 'u').where((t) => gt(t.u.createdAt, t.u.email))
// @ts-expect-error `numeric` decodes to string, but it is not a text-class operand
db.from(schema.h.users, 'u').where((t) => ilike(t.u.balance, '1%'))

// ─────────────────────────────────────────────────────────────────────────────
// DECISION 3 — a typed `sql` fragment IS a class-specific operand
//
// This is `09` §3.0's one open item ("the gate reads `[META]`, which only a `Ref` carries …
// WS3 must close it"). It closes because `.as(codec)` republishes the codec's own `name` in the
// `pg` slot. `asUnsafe` deliberately does not: its slot is `'unknown'`, which is in no gate.
// ─────────────────────────────────────────────────────────────────────────────

db.from(schema.h.users, 'u').where((t) => ilike(sql`lower(${t.u.email})`.as(textCodec), 'a%'))
db.from(schema.h.users, 'u').where((t) => hasKey(sql`${t.u.prefs}`.as(jsonbCodec), 'theme'))
db.from(schema.h.posts, 'p').where(() =>
  matches(
    sql`to_tsvector('english', 'x')`.as(tsvectorCodec),
    sql`websearch_to_tsquery('english', 'x')`.as(tsqueryCodec),
  ),
)
// @ts-expect-error `asUnsafe` gives up the codec, and with it the type class
db.from(schema.h.users, 'u').where((t) => ilike(sql`lower(${t.u.email})`.asUnsafe<string>(), 'a%'))
// @ts-expect-error a bare fragment is not Projectable at all — 04 §2.2
db.from(schema.h.users, 'u').where((t) => ilike(sql`lower(${t.u.email})`, 'a%'))
// @ts-expect-error the codec is the gate: `numeric` is not text, however it decodes
db.from(schema.h.users, 'u').where(() => ilike(sql`sum(1)`.as(numericCodec), 'a%'))

/** An operator's RESULT is an operand too, so gated operators chain. */
db.from(schema.h.users, 'u').where((t) => ilike(jsonPathText(t.u.prefs, ['theme']), 'da%'))
db.from(schema.h.users, 'u').where((t) => ilike(jsonGetText(t.u.prefs, 'theme'), 'da%'))

// ─────────────────────────────────────────────────────────────────────────────
// DECISION 4 — `json` and `jsonb` are different classes for everything but the accessors
//
// PostgreSQL has `json -> text` but no `json @> json`. Splitting the gate turns a 42883 into a
// compile error.
//
// The column DSL has no `t.json()` builder (WS5 owns the DSL's remaining types), and it does not
// need one here: now that the hole above is closed, a `json`-classed operand is one `.as(codec)`
// away. That is the closure paying for itself.
// ─────────────────────────────────────────────────────────────────────────────

db.from(schema.h.users, 'u').where((t) => hasKey(t.u.prefs, 'theme'))
db.from(schema.h.users, 'u').select((t) => ({ v: jsonGetText(t.u.prefs, 'theme') }))
/** Accessors take either. */
db.from(schema.h.users, 'u').select((t) => ({
  v: jsonGetText(sql`${t.u.prefs}::json`.as(jsonCodecJson), 'theme'),
}))
// @ts-expect-error `json @> json` does not exist; containment is jsonb-only
db.from(schema.h.users, 'u').where((t) => hasKey(sql`${t.u.prefs}::json`.as(jsonCodecJson), 'k'))

// ─────────────────────────────────────────────────────────────────────────────
// The aggregates PostgreSQL widens (03 §2.9's own headline claim)
// ─────────────────────────────────────────────────────────────────────────────

const agg = db.from(schema.h.users, 'u').select((t) => ({
  n: fn.count(),
  views: fn.sum(t.u.views), // int8  → numeric → string
  ages: fn.sum(t.u.age), // int4  → int8    → bigint
  avgAge: fn.avg(t.u.age), // int4  → numeric → string
  latest: fn.max(t.u.createdAt), // same codec
}))
expectTypeOf<RowOf<typeof agg>>().toEqualTypeOf<{
  n: bigint
  views: string | null
  ages: bigint | null
  avgAge: string | null
  latest: Date | null
}>()
type _Agg = Assert<
  Eq<
    RowOf<typeof agg>,
    { n: bigint; views: string | null; ages: bigint | null; avgAge: string | null; latest: Date | null }
  >
>
void and

// ─────────────────────────────────────────────────────────────────────────────
// `asc`/`desc` are sort directions, not values
// ─────────────────────────────────────────────────────────────────────────────

db.from(schema.h.users, 'u').orderBy((t) => [desc(t.u.createdAt), asc(t.u.email, 'last')])
// @ts-expect-error a sort direction is not a projectable value
db.from(schema.h.users, 'u').select((t) => ({ x: desc(t.u.createdAt) }))
