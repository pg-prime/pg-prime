/**
 * Parenthesisation of operands — the emitter's precedence contract (03 §1.1(5), §3.3).
 *
 * The rule the whole file rests on: **the compiler never lets the SQL grammar re-associate a tree
 * the caller built.** Two operand classes can do that if left bare —
 *
 *   1. a **unary** node, because `not` binds tighter than a comparison and `::` binds tighter than
 *      a prefix `-`, so `not a = b` and `-a::text` both parse as something else entirely; and
 *   2. an **opaque `sql` fragment**, whose internal precedence the compiler cannot know.
 *
 * Every golden below is hand-written from the PostgreSQL grammar, not captured from the emitter,
 * and each fires with its negative control: the shapes that must stay byte-identical (`not a and
 * b`, a column operand, a positive literal) are asserted in the same block.
 */

import { describe, expect, it } from 'vitest'
import { boolCodec, int4Codec, int8Codec, textCodec } from '../../src/codec/index.js'
import type { Expr } from '../../src/compile/ast.js'
import { compileExpr } from '../../src/compile/compiler.js'
import {
  and,
  cast,
  eq,
  inList,
  is,
  lit,
  mkNode,
  not,
  or,
  param,
  projection,
  select,
} from '../../src/compile/nodes.js'
import { compile } from '../../src/compile/compiler.js'
import { sql, toNode } from '../../src/sql/fragment.js'
import { p, u, usersFrom } from '../sql/_helpers.js'

/** `-x`, `+x`, `~x` — the unary node kinds `not()` does not cover and no constructor exports. */
const un = (op: '-' | '+' | '~', e: Expr): Expr =>
  mkNode({ k: 'un' as const, op, e, resultCodec: int8Codec })

/** `e between lo and hi`. No constructor exports one yet; the emitter has always handled it. */
const between = (e: Expr, lo: Expr, hi: Expr): Expr =>
  mkNode({ k: 'between' as const, e, lo, hi, symmetric: false, not: false })

const t = (e: Expr): string => compileExpr(e).sql

describe('a unary operand is parenthesised in every position that can re-associate it', () => {
  it('`- -1` never collapses into the line comment `--1`', () => {
    // `--1` is a comment: PostgreSQL would silently drop the rest of the statement. This is the
    // one case in the file where the *old* output was not merely wrong but unparseable.
    expect(t(un('-', lit(-1, int4Codec)))).toBe('-(-1)')
    expect(t(un('-', un('-', u('id'))))).toBe('-(-"users"."id")')
    // Negative control: a positive literal needs nothing.
    expect(t(un('-', lit(1, int4Codec)))).toBe('-1')
    expect(t(un('-', u('id')))).toBe('-"users"."id"')
  })

  it('`~` and `+` glue to a negative literal the same way', () => {
    // `~-` contains `~`, so PostgreSQL lexes it as ONE operator name and fails with 42883.
    expect(t(un('~', lit(-1, int4Codec)))).toBe('~(-1)')
    expect(t(un('+', lit(-1, int4Codec)))).toBe('+(-1)')
  })

  it('a `not` operand of a comparison keeps its own scope', () => {
    // Bare, this is `not ("users"."id" = $1)` to PostgreSQL — the negation moves outwards and the
    // predicate means the opposite of what was built.
    expect(t(eq(not(u('id')), param(1, int4Codec)))).toBe('(not "users"."id") = $1')
  })

  it('…and so does one under `is` / `in` / `between`', () => {
    expect(t(is(not(u('id')), 'distinct from', param(1, int4Codec)))).toBe(
      '(not "users"."id") is distinct from $1',
    )
    expect(t(inList(not(u('id')), [param(1, int4Codec)]))).toBe('(not "users"."id") in ($1)')
    expect(t(between(not(u('id')), lit(1, int4Codec), lit(2, int4Codec)))).toBe(
      '(not "users"."id") between 1 and 2',
    )
  })

  it('a cast binds tighter than a prefix operator, so its operand is wrapped', () => {
    // `-"amount"::text` is `-("amount"::text)`: unary minus applied to TEXT, i.e. 42883.
    expect(t(cast(un('-', p('amount')), 'text', textCodec))).toBe('(-"posts"."amount")::text')
    // `-2147483648::int4` is `-(2147483648::int4)`, and 2147483648 does not fit in int4 (22003).
    expect(t(cast(lit(-2147483648, int4Codec), 'int4', int4Codec))).toBe('(-2147483648)::int4')
    // Negative controls: the two shapes every relation projection emits.
    expect(t(cast(p('amount'), 'text', textCodec))).toBe('"posts"."amount"::text')
    expect(t(cast(lit(1, int4Codec), 'int4', int4Codec))).toBe('1::int4')
  })

  it('NEGATIVE CONTROL — `not` inside and/or stays bare, because it already binds tighter', () => {
    // This is the shape every `.where(not(...))` compiles to; a change here would move goldens
    // across the whole query suite for no semantic gain.
    expect(t(and(not(u('id')), p('published')))).toBe('(not "users"."id" and "posts"."published")')
    expect(t(or(not(u('id')), not(p('published'))))).toBe(
      '(not "users"."id" or not "posts"."published")',
    )
    // And a `bool` that collapses to a single `not` still gets its parens from the position.
    expect(t(eq(and(not(u('id'))), param(1, int4Codec)))).toBe('(not "users"."id") = $1')
  })
})

describe('an opaque fragment is parenthesised in EVERY operand position (the docblock promise)', () => {
  it('the right operand of `is distinct from`', () => {
    // Bare: `a is distinct from b or true` is `(a is distinct from b) or true`, i.e. constantly
    // true — the predicate disappears.
    expect(t(is(u('id'), 'distinct from', toNode(sql`b or true`)))).toBe(
      '"users"."id" is distinct from (b or true)',
    )
  })

  it('an `in` list item, which is comma-delimited', () => {
    expect(t(inList(u('id'), [toNode(sql`1, 2`)]))).toBe('"users"."id" in ((1, 2))')
  })

  it('both bounds of `between`, whose separator is the word `and`', () => {
    expect(t(between(u('id'), toNode(sql`1 and 2`), toNode(sql`3 or 4`)))).toBe(
      '"users"."id" between (1 and 2) and (3 or 4)',
    )
  })

  it('NEGATIVE CONTROL — ordinary operands in those same positions stay bare', () => {
    expect(t(is(u('id'), 'distinct from', param(1, int4Codec)))).toBe(
      '"users"."id" is distinct from $1',
    )
    expect(t(inList(u('id'), [param(1, int4Codec), param(2, int4Codec)]))).toBe(
      '"users"."id" in ($1, $2)',
    )
    expect(t(between(u('id'), lit(1, int4Codec), lit(2, int4Codec)))).toBe(
      '"users"."id" between 1 and 2',
    )
  })
})

describe('the whole statement, not just the expression', () => {
  it('a negated predicate survives a full compile', () => {
    const c = compile(
      select({
        projection: [projection('id', u('id'))],
        from: usersFrom,
        where: eq(not(u('deletedAt')), param(true, boolCodec)),
      }),
    )
    expect(c.sql).toBe(
      [
        'select "users"."id" as "id"',
        'from "public"."users" as "users"',
        'where (not "users"."deleted_at") = $1',
      ].join('\n'),
    )
  })
})
