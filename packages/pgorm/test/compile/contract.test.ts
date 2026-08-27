/**
 * The `Compiled` contract itself (03 §1.3): `{ sql, binds, shape, meta }`, plus the decoder.
 *
 * Three properties are load-bearing and asserted here:
 *  - `rowMode: 'array'` positional decode, so two joined tables both exposing `id` cannot
 *    clobber each other;
 *  - codecs travel with the plan, so nothing looks up an OID at decode time;
 *  - compilation is pure — same AST in, byte-identical SQL out, every time.
 */

import { describe, expect, it } from 'vitest'
import { compile } from '../../src/compile/compiler.js'
import { paramTypesOf } from '../../src/compile/contract.js'
import { buildDecoder } from '../../src/compile/decode.js'
import type { Expr } from '../../src/compile/ast.js'
import {
  eq,
  param,
  placeholder,
  projection,
  select,
  table,
} from '../../src/compile/nodes.js'
import { boolCodec, int4Codec, int8Codec, textCodec, timestamptzCodec, varcharCodec } from '../../src/codec/index.js'
import { TooManyParametersError } from '../../src/sql/errors.js'
import { sql, toNode } from '../../src/sql/fragment.js'
import { p, postsFrom, u, usersFrom, usersTable } from '../sql/_helpers.js'

describe('purity and immutability', () => {
  const q = select({
    projection: [projection('id', u('id'))],
    from: usersFrom,
    where: eq(u('email'), param('a@b.c', varcharCodec)),
  })

  it('compiling twice yields byte-identical output', () => {
    const a = compile(q)
    const b = compile(q)
    expect(a.sql).toBe(b.sql)
    expect(a.binds).toEqual(b.binds)
    expect(a.shape).toEqual(b.shape)
  })

  it('the compiled artifact is frozen', () => {
    const c = compile(q)
    expect(Object.isFrozen(c)).toBe(true)
    expect(Object.isFrozen(c.binds)).toBe(true)
    expect(Object.isFrozen(c.meta)).toBe(true)
  })

  it('AST nodes are frozen, so a builder can structurally share them', () => {
    expect(Object.isFrozen(q)).toBe(true)
    expect(Object.isFrozen(q.projection[0])).toBe(true)
    expect(Object.isFrozen(usersFrom)).toBe(true)
  })
})

describe('binds', () => {
  it('a value bind carries the ENCODED wire value, not the JavaScript value', () => {
    const c = compile(
      select({
        projection: [projection('a', param(true, boolCodec))],
        where: eq(u('createdAt'), param(new Date('2020-03-04T05:06:07Z'), timestamptzCodec)),
      }),
    )
    expect(c.binds).toEqual([
      { k: 'value', encoded: 't', oid: 16 },
      { k: 'value', encoded: '2020-03-04 05:06:07.000Z', oid: 1184 },
    ])
  })

  /**
   * WS2: a bind carries the codec's `paramOid` so `Parse` can DECLARE the parameter's type. It is
   * what turns `where "amount" > $1` from a `42P18 indeterminate_datatype` gamble into a resolved
   * operator, and it is the array `paramTypesOf` hands the driver.
   */
  it('paramTypesOf is positional and spells "no declared type" as 0, never as 705', () => {
    const c = compile(
      select({
        projection: [projection('a', param('x', textCodec))],
        where: eq(u('id'), param(1n, int8Codec)),
        limit: placeholder('n', int4Codec),
      }),
    )
    expect(paramTypesOf(c.binds)).toEqual([25, 20, 23])

    const untyped = compile(select({ projection: [projection('a', param('x'))] }))
    expect(paramTypesOf(untyped.binds)).toEqual([0])
  })

  it('a placeholder becomes a slot bind and is listed in meta.placeholders', () => {
    const c = compile(
      select({
        projection: [projection('id', u('id'))],
        from: usersFrom,
        where: eq(u('email'), placeholder('email', varcharCodec)),
        limit: placeholder('n', int4Codec),
      }),
    )
    expect(c.sql).toContain('where "users"."email" = $1')
    expect(c.sql).toContain('limit $2')
    expect(c.binds).toEqual([
      { k: 'slot', name: 'email', codec: varcharCodec },
      { k: 'slot', name: 'n', codec: int4Codec },
    ])
    expect(c.meta.placeholders).toEqual(['email', 'n'])
  })

  it('binds.length always equals the highest $n in the SQL', () => {
    const c = compile(
      select({
        projection: [projection('a', toNode(sql`${1} + ${2} + ${3}`))],
        where: eq(u('id'), param(4n, int8Codec)),
        limit: param(5, int4Codec),
      }),
    )
    const ns = [...c.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))
    expect(Math.max(...ns)).toBe(c.binds.length)
    expect(ns).toEqual([1, 2, 3, 4, 5])
  })

  it('throws TooManyParametersError above the int16 wire ceiling', () => {
    const items: Expr[] = []
    for (let i = 0; i <= 65536; i++) items.push(param(i, int4Codec))
    expect(() =>
      compile(select({ projection: [projection('a', toNode(sql.join(items.map(() => sql`${1}`))))] })),
    ).toThrow(TooManyParametersError)
  })
})

describe('meta', () => {
  it('separates reads from writes so a read-only executor can reject a mutation', () => {
    const read = compile(select({ projection: [projection('id', u('id'))], from: usersFrom }))
    expect(read.meta.reads).toHaveLength(1)
    expect(read.meta.writes).toHaveLength(0)

    const write = compile({
      k: 'insert',
      into: table(usersTable),
      columns: [],
      source: { k: 'defaults' },
    })
    expect(write.meta.writes).toEqual([{ schema: 'public', name: 'users' }])
    expect(write.meta.reads).toHaveLength(0)
  })
})

describe('the decoder is positional (rowMode: array)', () => {
  it('duplicate column names from two joined tables cannot clobber each other', () => {
    const c = compile(
      select({
        projection: [projection('userId', u('id')), projection('postId', p('id'))],
        from: usersFrom,
        joins: [{ k: 'join', type: 'inner', item: postsFrom, on: eq(p('authorId'), u('id')) }],
      }),
    )
    expect(c.sql).toContain('"users"."id" as "userId", "posts"."id" as "postId"')
    const decode = buildDecoder<{ userId: bigint; postId: bigint }>(c.shape)
    expect(decode([['1', '999']])).toEqual([{ userId: 1n, postId: 999n }])
  })

  it('decodes null without calling the codec', () => {
    const c = compile(select({ projection: [projection('d', u('deletedAt'))], from: usersFrom }))
    expect(buildDecoder<{ d: Date | null }>(c.shape)([[null]])).toEqual([{ d: null }])
  })

  it('passes through a value the driver already parsed', () => {
    // `pg`'s default type parsers hand back a Date/number; we must not re-parse a non-string.
    const c = compile(select({ projection: [projection('t', u('createdAt'))], from: usersFrom }))
    const d = new Date('2021-01-01T00:00:00Z')
    expect(buildDecoder<{ t: Date }>(c.shape)([[d]])[0]?.t).toBe(d)
  })

  it('handles the scalar fast path', () => {
    const decode = buildDecoder<bigint>({ k: 'scalar', idx: 0, codec: int8Codec })
    expect(decode([['7'], ['8']])).toEqual([7n, 8n])
  })

  it('handles the void shape', () => {
    expect(buildDecoder({ k: 'void' })([['x']])).toEqual([])
  })

  it('an empty projection produces a void shape', () => {
    expect(compile(select({ projection: [], from: usersFrom })).shape).toEqual({ k: 'void' })
  })
})

describe('the injection audit surface is closed', () => {
  it('no bind VALUE ever appears as a substring of the SQL', () => {
    const nasty = "'; drop table users; --"
    const c = compile(
      select({
        projection: [projection('a', param(nasty, textCodec))],
        from: usersFrom,
        where: eq(u('email'), toNode(sql`${nasty}`)),
      }),
    )
    expect(c.sql).not.toContain('drop')
    expect(c.sql).not.toContain(';')
    expect(c.binds.filter((b) => b.k === 'value')).toHaveLength(2)
  })

  it('the compiled SQL is exactly ONE statement', () => {
    const c = compile(
      select({
        projection: [projection('a', param("a;b;c", textCodec))],
        from: usersFrom,
      }),
    )
    expect(c.sql.split(';')).toHaveLength(1)
  })
})
