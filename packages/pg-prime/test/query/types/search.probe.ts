/**
 * `tsHeadline`, pg_trgm, `jsonbSet` and the tuple comparisons: operand gates, result types, and
 * the arity check of a keyset comparison.
 */

import { expectTypeOf } from 'expect-type'
import { jsonbCodec, tsqueryCodec, tsvectorCodec } from '../../../src/codec/index.js'
import type { Executor, Expr, RowOf } from '../../../src/query/types.js'
import {
  isTrue,
  jsonbSet,
  similarity,
  sql,
  trgmSimilar,
  tsHeadline,
  tupleGt,
  tupleLt,
  wordSimilarity,
} from '../../../src/query/types.js'
import { defineSchema, pgTable } from '../../../src/schema/index.js'

declare const db: Executor

const blocks = pgTable('blocks', (t) => ({
  id: t.uuid().primaryKey(),
  position: t.text(),
  text: t.text(),
  note: t.text().nullable(),
  rev: t.integer(),
  props: t.jsonb().$type<{ title: string }>(),
  path: t.text().array(),
}))
const { h } = defineSchema({ blocks })
const q = sql`websearch_to_tsquery('english', ${'x'})`.as(tsqueryCodec)

// ── tsHeadline ─────────────────────────────────────────────────────────────

const hl = db.from(h.blocks, 'b').select((t) => ({
  a: tsHeadline('english', t.b.text, q, { maxWords: 10, startSel: '<b>' }),
  b: tsHeadline(t.b.note, q),
}))
expectTypeOf<RowOf<typeof hl>>().toEqualTypeOf<{ a: string; b: string | null }>()
// @ts-expect-error the query is a tsquery, not text
db.from(h.blocks, 'b').select((t) => ({ a: tsHeadline(t.b.text, t.b.text) }))
// @ts-expect-error the document is text, not a tsvector
db.from(h.blocks, 'b').select(() => ({ a: tsHeadline(sql`x`.as(tsvectorCodec), q) }))
// @ts-expect-error options are typed
db.from(h.blocks, 'b').select((t) => ({ a: tsHeadline(t.b.text, q, { maxWords: '10' }) }))

// ── pg_trgm ────────────────────────────────────────────────────────────────

const trgm = db.from(h.blocks, 'b').select((t) => ({
  s: similarity(t.b.text, 'helo'),
  n: similarity(t.b.note, t.b.text),
  w: wordSimilarity('helo', t.b.text),
}))
expectTypeOf<RowOf<typeof trgm>>().toEqualTypeOf<{ s: number; n: number | null; w: number }>()
db.from(h.blocks, 'b').where((t) => trgmSimilar(t.b.text, 'helo'))
// A nullable operand makes `%` nullable, so it needs `isTrue` to be a WHERE predicate.
db.from(h.blocks, 'b').where((t) => isTrue(trgmSimilar(t.b.note, 'helo')))
// @ts-expect-error `note % …` is `boolean | null`
db.from(h.blocks, 'b').where((t) => trgmSimilar(t.b.note, 'helo'))
// @ts-expect-error pg_trgm takes text, not an integer column
db.from(h.blocks, 'b').select((t) => ({ s: similarity(t.b.rev, 'x') }))
// @ts-expect-error same for `%`
db.from(h.blocks, 'b').where((t) => trgmSimilar(t.b.rev, 'x'))

// ── jsonbSet ───────────────────────────────────────────────────────────────

db.from(h.blocks, 'b').select((t) => ({
  a: jsonbSet(t.b.props, ['title'], 'x'),
  b: jsonbSet(t.b.props, t.b.path, { nested: [1, null] }, false),
  c: jsonbSet(t.b.props, ['title'], sql`'"x"'`.as(jsonbCodec)),
}))
// @ts-expect-error the value is jsonb or a JSON value, never a text expression
db.from(h.blocks, 'b').select((t) => ({ a: jsonbSet(t.b.props, ['title'], t.b.text) }))
// @ts-expect-error the target is jsonb
db.from(h.blocks, 'b').select((t) => ({ a: jsonbSet(t.b.text, ['title'], 'x') }))
// @ts-expect-error a bigint is not JSON
db.from(h.blocks, 'b').select((t) => ({ a: jsonbSet(t.b.props, ['title'], 1n) }))
// @ts-expect-error the result is `unknown` jsonb; a closed `$type<T>()` column needs a cast
db.update(h.blocks).set((t) => ({ props: jsonbSet(t.blocks.props, ['title'], 'x') }))
db.update(h.blocks).set((t) => ({
  props: jsonbSet(t.blocks.props, ['title'], 'x') as Expr<{ title: string }, 'jsonb'>,
}))

// ── tuple comparisons ──────────────────────────────────────────────────────

db.from(h.blocks, 'b').where((t) => tupleGt([t.b.position, t.b.id], ['a0', 'some-uuid']))
db.from(h.blocks, 'b').where((t) => tupleLt([t.b.position, t.b.rev], [t.b.text, 3]))
// @ts-expect-error one value short
db.from(h.blocks, 'b').where((t) => tupleGt([t.b.position, t.b.id], ['a0']))
// @ts-expect-error one value too many
db.from(h.blocks, 'b').where((t) => tupleGt([t.b.position], ['a0', 'x']))
// @ts-expect-error each value is typed by its own column
db.from(h.blocks, 'b').where((t) => tupleGt([t.b.position, t.b.rev], ['a0', 'x']))
// @ts-expect-error null never compares
db.from(h.blocks, 'b').where((t) => tupleGt([t.b.position, t.b.note], ['a0', null]))
