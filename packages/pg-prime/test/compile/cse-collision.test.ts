/**
 * The CSE digest must be **injective**: two subqueries that serialise to the same string are
 * collapsed into one lateral, so a collision does not produce slower SQL — it produces *different*
 * SQL, with one of the two queries silently replaced by the other and its bind parameters gone.
 *
 * `cse.test.ts` proves what is shared. This file proves what is NOT, with the two collision
 * classes the digest actually had: an unescaped separator inside a parameter value, and a list or
 * optional clause whose boundary was not written down at all.
 */

import { describe, expect, it } from 'vitest'
import { int8Codec, textCodec } from '../../src/codec/index.js'
import type { Expr } from '../../src/compile/ast.js'
import { compile } from '../../src/compile/compiler.js'
import {
  countStar,
  eq,
  inList,
  param,
  projection,
  scalarSubquery,
  select,
} from '../../src/compile/nodes.js'
import { p, postsFrom, u, usersFrom } from '../sql/_helpers.js'

/** `(select count(*) as "v" from posts where <where> [group by <groupBy>])`, marked for sharing. */
const marked = (opts: { where?: Expr; groupBy?: readonly Expr[] }) =>
  scalarSubquery(
    select({
      projection: [projection('v', countStar())],
      from: postsFrom,
      where: opts.where,
      groupBy: opts.groupBy,
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
const encoded = (c: { binds: readonly { k: string }[] }) =>
  c.binds.map((b) => (b as { encoded?: unknown }).encoded)

describe('a parameter value cannot forge the tokens of another subtree', () => {
  // The separator the digest joined tokens with. A value containing it used to be able to spell
  // out `<sep>text<sep>param<sep>s<second value>` and thereby impersonate a SECOND parameter.
  const SEP = '\u0001'
  const correlation = eq(p('authorId'), u('id'))

  const twoParams = marked({
    where: inList(p('title'), [param('x', textCodec), param('y', textCodec)]),
  })
  const oneForgedParam = marked({
    where: inList(p('title'), [param(`x${SEP}text${SEP}param${SEP}sy`, textCodec)]),
  })

  it('two in-lists of different length are two different queries', () => {
    const c = over({ a: twoParams, b: oneForgedParam })
    expect(laterals(c.sql)).toBe(2)
    // The decisive assertion: THREE binds survive. Sharing dropped the forged query's parameter
    // entirely, so the server saw a query that filtered on someone else's values.
    expect(encoded(c)).toEqual(['x', 'y', `x${SEP}text${SEP}param${SEP}sy`])
  })

  it('NEGATIVE CONTROL — two genuinely identical subqueries still collapse into one', () => {
    const c = over({ a: marked({ where: correlation }), b: marked({ where: correlation }) })
    expect(laterals(c.sql)).toBe(1)
    expect(c.sql.split('\n')[0]).toBe('select "_r0"."v" as "a", "_r0"."v" as "b"')
  })
})

describe('a clause boundary is written down, so two clauses cannot be re-cut into one', () => {
  const pred = eq(p('authorId'), u('id'))

  it('`where <pred>` and `group by <pred>` are not the same query', () => {
    // Both used to serialise to just the tokens of `<pred>`: an absent optional clause wrote
    // nothing, and a list wrote no length, so the two were indistinguishable.
    const c = over({ a: marked({ where: pred }), b: marked({ groupBy: [pred] }) })
    expect(laterals(c.sql)).toBe(2)
    expect(c.sql).toContain('where "posts"."author_id" = "users"."id"')
    expect(c.sql).toContain('group by "posts"."author_id" = "users"."id"')
  })

  it('NEGATIVE CONTROL — the same clause in the same place still shares', () => {
    const c = over({ a: marked({ groupBy: [pred] }), b: marked({ groupBy: [pred] }) })
    expect(laterals(c.sql)).toBe(1)
  })
})
