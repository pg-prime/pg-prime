/**
 * `sql` tag guards (03 §3) — the holes where a *mistake* used to compile into a valid-looking
 * query, plus two allocation/ownership rules that are easy to regress.
 *
 * The tag's job is to make the SQL/data decision nominal and total. "Total" is the part under
 * test here: a value that is neither SQL nor data (`undefined`), and a node that is registered but
 * is not an expression (an order item, a statement), both used to slip through — the first as a
 * silent `NULL`, the second as an error from deep inside the emitter naming a node kind the caller
 * had never heard of.
 */

import { describe, expect, it } from 'vitest'
import { int4Codec, textCodec } from '../../src/codec/index.js'
import { compileExpr } from '../../src/compile/compiler.js'
import { asc, projection, select, table, tableMeta } from '../../src/compile/nodes.js'
import { InvalidFragmentError } from '../../src/sql/errors.js'
import { sql, toNode } from '../../src/sql/fragment.js'
import { render, u, usersFrom, values } from './_helpers.js'

describe('undefined in a template hole is a mistake, not a NULL', () => {
  it('throws, naming the hole', () => {
    // `param(undefined)` encoded to SQL NULL, so `where "email" = ${row.emial}` compiled to
    // `= NULL`, which is never true: the query returned zero rows and nothing said why.
    const missing = ({ email: 'a@b' } as { email: string; emial?: string }).emial
    let thrown: unknown
    try {
      sql`x = ${missing}`
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(InvalidFragmentError)
    expect((thrown as Error).message).toContain('hole 0')
    expect((thrown as Error).message).toContain('undefined')
  })

  it('NEGATIVE CONTROL — null is the explicit spelling and still binds', () => {
    const r = render(sql`x = ${null}`)
    expect(r.sql).toBe('x = $1')
    expect(values(r.binds)).toEqual([null])
  })
})

describe('a registered node that is not an expression is refused at the tag', () => {
  it('an order item names itself, instead of failing later as node kind `undefined`', () => {
    let thrown: unknown
    try {
      sql`order by ${asc(u('id'))}`
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(InvalidFragmentError)
    expect((thrown as Error).message).toContain('hole 0')
  })

  it('…and so does a statement and a FROM item', () => {
    expect(() => sql`${select({ projection: [projection('id', u('id'))], from: usersFrom })}`)
      .toThrow(InvalidFragmentError)
    expect(() => sql`${table(tableMeta('public', 'users'))}`).toThrow(InvalidFragmentError)
  })

  it('NEGATIVE CONTROL — every expression node, and every fragment, still composes', () => {
    const r = render(sql`${u('id')} = ${1} and ${sql`lower(${'A'})`}`)
    expect(r.sql).toBe('"users"."id" = $1 and lower($2)')
    expect(values(r.binds)).toEqual(['1', 'A'])
    expect(compileExpr(toNode(sql.ident('a', 'b'))).sql).toBe('"a"."b"')
  })
})

describe('ownership and allocation', () => {
  it('sql.ident copies the caller’s array instead of freezing it', () => {
    const parts: [string, ...string[]] = ['public', 'users']
    sql.ident(parts)
    expect(Object.isFrozen(parts)).toBe(false)
    parts.push('extra')
    expect(parts).toEqual(['public', 'users', 'extra'])
  })

  it('join() reuses one default separator rather than allocating per call', () => {
    const a = sql`1`
    const b = sql`2`
    expect(render(sql.join([a, b])).sql).toBe('1, 2')
    expect(render(sql.join([a, b], sql` or `)).sql).toBe('1 or 2')
    // Two calls, same separator instance: the only way to observe it is that repeated joins are
    // still byte-identical and no state leaks between them.
    expect(render(sql.join([a, b])).sql).toBe(render(sql.join([a, b])).sql)
  })

  it('a fragment is reusable across positions and queries — $n is assigned by the compiler', () => {
    const f = sql`${'x'}`
    const r = render(sql`${f} , ${f}`)
    expect(r.sql).toBe('$1 , $2')
    expect(values(r.binds)).toEqual(['x', 'x'])
  })
})

describe('literals and identifiers keep their existing contracts', () => {
  it('NEGATIVE CONTROL — sql.lit and sql.ident are unchanged', () => {
    expect(render(sql.lit(-1)).sql).toBe('-1')
    expect(render(sql.ident(['a.b'])).sql).toBe('"a.b"')
    expect(compileExpr(toNode(sql`${1}::int4`)).sql).toBe('$1::int4')
    expect(values(render(sql`${42}`).binds)).toEqual(['42'])
    expect(int4Codec.name).toBe('int4')
    expect(textCodec.name).toBe('text')
  })
})
