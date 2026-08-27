/**
 * Sharing a correlated subquery between its occurrences — `03` §2.3 point 6, the compiler's only
 * common-subexpression elimination (design/09 WS5).
 *
 * These are hand-built ASTs on purpose. The builder can only produce *relation* aggregates, and
 * two of the properties that matter most here — what happens to a volatile function, and what
 * happens to a node kind the digest does not recognise — are not reachable through it. A guard
 * that cannot be reached cannot be tested, and an untested guard is the one that quietly stops
 * working; so the test lives at the layer where the input can be written directly.
 *
 * The rule the whole mechanism rests on: **sharing may change the plan, never the answer.** Every
 * case below is either "these two are the same expression, prove it collapses" or "these two are
 * not, prove it does not".
 */

import { describe, expect, it } from 'vitest'
import { float8Codec, int8Codec, textCodec, timestamptzCodec } from '../../src/codec/index.js'
import type { Expr } from '../../src/compile/ast.js'
import { compile } from '../../src/compile/compiler.js'
import { planSelect } from '../../src/compile/hoist.js'
import {
  countStar,
  eq,
  fn,
  param,
  projection,
  raw,
  scalarSubquery,
  select,
} from '../../src/compile/nodes.js'
import { p, postsFrom, u, usersFrom } from '../sql/_helpers.js'

/** `(select <value> as "v" from posts where posts.author_id = users.id)`, marked for sharing. */
const marked = (value: Expr = countStar()) =>
  scalarSubquery(
    select({
      projection: [projection('v', value)],
      from: postsFrom,
      where: eq(p('authorId'), u('id')),
    }),
    int8Codec,
    true,
  )

const over = (parts: Record<string, Expr>) =>
  compile(
    select({
      projection: Object.entries(parts).map(([k, v]) => projection(k, v)),
      from: usersFrom,
    }),
  )

const laterals = (sql: string): number => sql.match(/left join lateral/g)?.length ?? 0

describe('what is shared', () => {
  it('two structurally identical marked subqueries become one lateral, referenced twice', () => {
    const c = over({ a: marked(), b: marked() })
    expect(laterals(c.sql)).toBe(1)
    expect(c.sql.split('\n')[0]).toBe('select "_r0"."v" as "a", "_r0"."v" as "b"')
  })

  it('a marked subquery used once is still lifted — the lateral is the shape, not the saving', () => {
    // `03` §2.3 point 1: `LEFT JOIN LATERAL` rather than a scalar subquery in the select list,
    // because for large fan-outs it plans better. Sharing is a consequence of hoisting, not the
    // reason for it, so a single occurrence hoists too.
    expect(laterals(over({ a: marked() }).sql)).toBe(1)
  })

  it('`now()` is shared: it is transaction_timestamp(), constant for the statement', () => {
    const nowAgg = () => fn('max', [fn('now', [], timestamptzCodec)], timestamptzCodec)
    expect(laterals(over({ a: marked(nowAgg()), b: marked(nowAgg()) }).sql)).toBe(1)
  })
})

describe('what is NOT shared', () => {
  it('two subqueries differing only in a bind VALUE', () => {
    const withBind = (v: string) =>
      scalarSubquery(
        select({
          projection: [projection('v', countStar())],
          from: postsFrom,
          where: eq(p('title'), param(v, textCodec)),
        }),
        int8Codec,
        true,
      )
    const c = over({ a: withBind('x'), b: withBind('y') })
    expect(laterals(c.sql)).toBe(2)
    expect(c.binds.map((b) => (b as { encoded?: unknown }).encoded)).toEqual(['x', 'y'])
  })

  it('anything containing a volatile function', () => {
    // The case the whole `VOLATILE` list exists for, and the one the builder cannot reach today:
    // `fn` ships no volatile function, so without this test the list would be dead code that
    // stops working the day someone adds `fn.random()`. Two calls to `random()` are two different
    // numbers; collapsing them into one lateral would make the two projected columns equal.
    const rnd = () => fn('avg', [fn('random', [], float8Codec)], float8Codec)
    expect(laterals(over({ a: marked(rnd()), b: marked(rnd()) }).sql)).toBe(2)
  })

  it('anything containing a `sql` fragment, whose contents are opaque', () => {
    const frag = () => raw(['random()'], [], float8Codec)
    expect(laterals(over({ a: marked(frag()), b: marked(frag()) }).sql)).toBe(2)
  })

  it('a subquery the relation layer did not mark', () => {
    const plain = () =>
      scalarSubquery(
        select({
          projection: [projection('v', countStar())],
          from: postsFrom,
          where: eq(p('authorId'), u('id')),
        }),
        int8Codec,
      )
    const c = over({ a: plain(), b: plain() })
    expect(laterals(c.sql)).toBe(0)
    expect(c.sql).toContain('select (')
  })
})

describe('the identity fast path survives', () => {
  it('planSelect returns the SAME node when nothing is marked and nothing is nested', () => {
    const node = select({ projection: [projection('id', u('id'))], from: usersFrom })
    expect(planSelect(node).node).toBe(node)
  })
})
