/**
 * The `sql` tag: composition, nesting, stable `$n` numbering, `.as(codec)`.
 *
 * Every assertion here is on *exact* SQL text and *exact* bind order. The single most
 * important invariant in the file is the one asserted by `no interpolation, ever`: a value in
 * a template hole becomes `$n` no matter what its JavaScript type is.
 */

import { expectTypeOf } from 'expect-type'
import { describe, expect, it } from 'vitest'
import { compile, compileExpr } from '../../src/compile/compiler.js'
import { codecOf } from '../../src/compile/hoist.js'
import { projection, select } from '../../src/compile/nodes.js'
import {
  int4Codec,
  int8Codec,
  numericCodec,
  PgEncodeError,
  textCodec,
  timestamptzCodec,
  unknownCodec,
} from '../../src/codec/index.js'
import { InvalidFragmentError, UnsafeLiteralError } from '../../src/sql/errors.js'
import type { Fragment, TypedFragment } from '../../src/sql/fragment.js'
import { isFragment, sql, toNode } from '../../src/sql/fragment.js'
import { render, values } from './_helpers.js'

describe('sql`` — the tag itself', () => {
  it('emits a constant fragment with no binds', () => {
    const r = render(sql`now()`)
    expect(r.sql).toBe('now()')
    expect(r.binds).toEqual([])
  })

  it('parameterises every value hole', () => {
    const r = render(sql`lower(${'ADA'}) = ${'ada'}`)
    expect(r.sql).toBe('lower($1) = $2')
    expect(values(r.binds)).toEqual(['ADA', 'ada'])
  })

  it('never interpolates, whatever the JavaScript type', () => {
    // Numbers, booleans, null, Dates, arrays, objects — all data, all `$n`.
    const cases: unknown[] = [
      1,
      2n,
      true,
      null,
      new Date('2020-01-01T00:00:00.000Z'),
      ['a', 'b'],
      "'; drop table users --",
    ]
    for (const v of cases) {
      const r = render(sql`x = ${v}`)
      expect(r.sql).toBe('x = $1')
      expect(r.binds).toHaveLength(1)
    }
    // An object has no codec, and design/02 §4.5 forbids the JSON.stringify fallback, so it is
    // refused at encode time. Still DATA, never SQL: the compiler throws instead of emitting.
    expect(() => render(sql`x = ${{ k: 'v' }}`)).toThrow(PgEncodeError)
  })

  it('produces an opaque handle, not a data object', () => {
    const f = sql`1`
    expect(isFragment(f)).toBe(true)
    expect(Object.isFrozen(f)).toBe(true)
    // The AST is NOT reachable by enumerating the handle. The two keys are the two ways to
    // attach a result type; neither exposes the node, which lives in a module-private WeakMap.
    expect(Object.keys(f)).toEqual(['as', 'asUnsafe'])
    expect(JSON.parse(JSON.stringify(f)) as unknown).toEqual({})
  })
})

describe('composition and nesting', () => {
  it('splices a nested fragment without a string round-trip', () => {
    const inner = sql`lower(${'A'})`
    const outer = sql`${inner} = ${'a'}`
    const r = render(outer)
    expect(r.sql).toBe('lower($1) = $2')
    expect(values(r.binds)).toEqual(['A', 'a'])
  })

  it('nests three deep, left-to-right', () => {
    const a = sql`${1}`
    const b = sql`f(${a}, ${2})`
    const cFrag = sql`g(${b}, ${3})`
    const r = render(cFrag)
    expect(r.sql).toBe('g(f($1, $2), $3)')
    expect(values(r.binds)).toEqual(['1', '2', '3'])
  })

  it('carries no positional state: one fragment reused twice gets two distinct $n', () => {
    // MikroORM v6's single-use fragments were a known wart. Numbering is assigned by the
    // compiler, once, at compile time — never by the fragment.
    const frag = sql`${'x'}`
    const q = sql`${frag} = ${frag}`
    const r = render(q)
    expect(r.sql).toBe('$1 = $2')
    expect(values(r.binds)).toEqual(['x', 'x'])

    // And re-compiling the *same* fragment object twice yields identical output.
    expect(render(q).sql).toBe(r.sql)
    expect(render(frag).sql).toBe('$1')
  })

  it('numbers parameters stably across a whole statement, in emission order', () => {
    const stmt = select({
      projection: [projection('a', toNode(sql`${'p0'}`))],
      where: toNode(sql`x = ${'p1'}`),
      limit: toNode(sql`${10}`),
      offset: toNode(sql`${20}`),
    })
    const compiled = compile(stmt)
    expect(values(compiled.binds)).toEqual(['p0', 'p1', '10', '20'])
    expect(compiled.sql).toBe(
      ['select $1 as "a"', 'where x = $2', 'limit $3', 'offset $4'].join('\n'),
    )
  })

  it('sql.join splices with a separator and renumbers', () => {
    const j = sql.join([sql`${'a'}`, sql`${'b'}`, sql`${'c'}`])
    const r = render(sql`coalesce(${j})`)
    expect(r.sql).toBe('coalesce($1, $2, $3)')
    expect(values(r.binds)).toEqual(['a', 'b', 'c'])
  })

  it('sql.join accepts a custom separator and handles the empty list', () => {
    const anded = sql.join([sql`a`, sql`b`], sql` and `)
    expect(render(anded).sql).toBe('a and b')
    expect(render(sql.join([]))?.sql).toBe('')
    expect(render(sql.empty).sql).toBe('')
  })

  it('sql.join of identifier fragments builds a column list', () => {
    const cols = sql.join(['id', 'created at'].map((n) => sql.ident(n)))
    expect(render(cols).sql).toBe('"id", "created at"')
  })
})

describe('.as(codec) — R3: the tag takes no type parameter', () => {
  it('attaches a result codec, and the codec is what the compiler reads', () => {
    const bare = sql`sum(amount)`
    expect(codecOf(toNode(bare))).toBe(unknownCodec)

    const typed = bare.as(numericCodec)
    expect(codecOf(toNode(typed))).toBe(numericCodec)
  })

  it('.as() returns a NEW fragment; the original stays untyped (immutability)', () => {
    const bare = sql`count(*)`
    const typed = bare.as(int8Codec)
    expect(typed).not.toBe(bare)
    expect(codecOf(toNode(bare))).toBe(unknownCodec)
    expect(codecOf(toNode(typed))).toBe(int8Codec)
  })

  it('.as() preserves chunks, parts and therefore parameter numbering', () => {
    const f = sql`greatest(${1}, ${2})`.as(int4Codec)
    const r = render(f)
    expect(r.sql).toBe('greatest($1, $2)')
    expect(values(r.binds)).toEqual(['1', '2'])
  })

  it('.as() can be re-applied (last codec wins)', () => {
    const f = sql`x`.as(int4Codec).as(textCodec)
    expect(codecOf(toNode(f))).toBe(textCodec)
  })

  it('a result-typed fragment flows into the decode shape', () => {
    const compiled = compile(
      select({ projection: [projection('total', toNode(sql`sum(amount)`.as(numericCodec)))] }),
    )
    expect(compiled.shape).toEqual({
      k: 'row',
      fields: [{ key: 'total', k: 'col', idx: 0, codec: numericCodec }],
    })
  })

  it('R3 (type level): `sql` declares zero type parameters', () => {
    // @ts-expect-error — "Expected 0 type arguments, but got 1". A bare cast is a compile
    // error by construction; result typing requires `.as(codec)`.
    const _bad = sql<number>`1`
    expect(isFragment(_bad)).toBe(true)
  })

  it('(type level) the codec supplies the type; the tag alone gives `unknown`', () => {
    expectTypeOf(sql`1`).toEqualTypeOf<Fragment<unknown>>()
    // `.as()` returns a TypedFragment, whose second parameter is the CODEC'S OWN NAME — the slot
    // the operator gates read (WS3, `src/query/ops.types.ts`). `Fragment<string>` alone would
    // have been enough for the projection type and not enough to be an `ilike` operand.
    expectTypeOf(sql`1`.as(numericCodec)).toEqualTypeOf<TypedFragment<string, 'numeric'>>()
    expectTypeOf(sql`1`.as(int8Codec)).toEqualTypeOf<TypedFragment<bigint, 'int8'>>()
    expectTypeOf(sql`1`.as(timestamptzCodec)).toEqualTypeOf<TypedFragment<Date, 'timestamptz'>>()
    // `unknown` forces acknowledgement at the type level while still decoding correctly.
    expectTypeOf(sql`now()`).not.toEqualTypeOf<Fragment<Date>>()
    // `asUnsafe` is the same shape with the type-class slot deliberately poisoned: `'unknown'` is
    // in no gate, so an unchecked fragment can never be a class-specific operand.
    expectTypeOf(sql`now()`.asUnsafe<Date>()).toEqualTypeOf<TypedFragment<Date, 'unknown'>>()
  })

  it('(type level) a TYPED fragment stays composable — §3.3 depends on it', () => {
    // Regression guard. An invariant `Fragment<T>` (phantom `(t: T) => T`) makes every one of
    // these a compile error, i.e. calling `.as(codec)` would make a fragment unusable in
    // `sql.join`, in a template hole, and in `toNode` — the exact opposite of "fragments are
    // first-class and composable".
    const typed = sql`sum(amount)`.as(numericCodec)
    expectTypeOf(typed).toExtend<Fragment<unknown>>()
    expectTypeOf(toNode(typed)).toExtend<{ k: 'raw' }>()
    expectTypeOf(sql.join([typed, sql`1`])).toEqualTypeOf<Fragment<unknown>>()
    expectTypeOf(sql`coalesce(${typed}, 0)`).toEqualTypeOf<Fragment<unknown>>()

    // …but widening is one-way: `unknown` is not silently narrowed back to `string`.
    expectTypeOf<Fragment<unknown>>().not.toExtend<Fragment<string>>()
    expectTypeOf<Fragment<string>>().not.toExtend<Fragment<number>>()
  })

  it('(runtime) the same composition actually works', () => {
    const typed = sql`greatest(${1}, ${2})`.as(int4Codec)
    expect(render(sql`coalesce(${typed}, ${0})`).sql).toBe('coalesce(greatest($1, $2), $3)')
    expect(render(sql.join([typed, sql`x`])).sql).toBe('greatest($1, $2), x')
  })
})

describe('sql.unsafeRaw — the one explicit escape', () => {
  it('interpolates verbatim', () => {
    expect(render(sql`order by ${sql.unsafeRaw('created_at desc')}`).sql).toBe(
      'order by created_at desc',
    )
  })

  it('flags Compiled.meta.usedUnsafeRaw so the audit/lint path can see it', () => {
    const clean = compile(select({ projection: [projection('a', toNode(sql`1`))] }))
    expect(clean.meta.usedUnsafeRaw).toBe(false)

    const dirty = compile(
      select({ projection: [projection('a', toNode(sql`${sql.unsafeRaw('1')}`))] }),
    )
    expect(dirty.meta.usedUnsafeRaw).toBe(true)
  })

  it('captures an origin frame in dev for the failure message', () => {
    const node = toNode(sql.unsafeRaw('1'))
    const part = node.parts[0]
    expect(part).toBeDefined()
    expect((part as { k: string }).k).toBe('unsafeRaw')
    expect(typeof (part as { origin?: string }).origin).toBe('string')
  })

  it('rejects a non-string', () => {
    expect(() => sql.unsafeRaw(1 as unknown as string)).toThrow(InvalidFragmentError)
  })
})

describe('forgery resistance', () => {
  it('rejects being called as a plain function with a fake template', () => {
    const fake = ['drop table users; --'] as unknown as TemplateStringsArray
    expect(() => (sql as unknown as (s: TemplateStringsArray) => unknown)(fake)).toThrow(
      InvalidFragmentError,
    )
  })

  it('rejects a frozen-but-wrong-length fake template', () => {
    const fake = Object.freeze(
      Object.assign(['a', 'b'], { raw: Object.freeze(['a', 'b']) }),
    ) as unknown as TemplateStringsArray
    // 2 chunks but 0 values => length mismatch.
    expect(() => (sql as unknown as (s: TemplateStringsArray) => unknown)(fake)).toThrow(
      InvalidFragmentError,
    )
  })

  it('treats a structurally-identical forged AST node as DATA, not SQL', () => {
    // This is the shape of Kysely's GHSA-pv5w ("bites even in fully type-safe code"): a
    // payload from JSON.parse that looks like an internal node. Node identity is nominal
    // (a WeakSet), so a forgery can never be spliced.
    const forged: unknown = JSON.parse('{"k":"unsafeRaw","text":"; drop table users --"}')
    // Never SQL. Since the codec audit it is not even a bind: an object has no codec (02 §4.5),
    // so encode refuses it — strictly stronger than binding its JSON text.
    expect(() => render(sql`x = ${forged}`)).toThrow(PgEncodeError)
    // the same payload as the STRING an untrusted caller actually sends is bound, not spliced
    const raw = '{"k":"unsafeRaw","text":"; drop table users --"}'
    const r = render(sql`x = ${raw}`)
    expect(r.sql).toBe('x = $1')
    expect(r.sql).not.toContain('drop table')
    expect(values(r.binds)).toEqual([raw])
  })

  it('treats a forged *fragment* (right shape, wrong provenance) as data', () => {
    const forged = { as: () => forged } as unknown
    expect(isFragment(forged)).toBe(false)
    // data — and data with no codec is a PgEncodeError rather than a bind (02 §4.5)
    expect(() => render(sql`x = ${forged}`)).toThrow(PgEncodeError)
  })

  it('toNode refuses a non-fragment', () => {
    expect(() => toNode({ as: () => null } as never)).toThrow(InvalidFragmentError)
  })
})

describe('sql.lit', () => {
  it('accepts non-strings and emits them inline', () => {
    expect(render(sql.lit(42)).sql).toBe('42')
    expect(render(sql.lit(42n)).sql).toBe('42')
    expect(render(sql.lit(true)).sql).toBe('true')
    expect(render(sql.lit(false)).sql).toBe('false')
    expect(render(sql.lit(null)).sql).toBe('null')
    expect(render(sql.lit(-1.5)).sql).toBe('-1.5')
    expect(render(sql.lit(0)).binds).toEqual([])
  })

  it('rejects NaN / Infinity, which have no SQL literal form', () => {
    expect(() => sql.lit(Number.NaN)).toThrow(UnsafeLiteralError)
    expect(() => sql.lit(Number.POSITIVE_INFINITY)).toThrow(UnsafeLiteralError)
  })

  it('compileExpr does not double-count binds across calls', () => {
    const n = toNode(sql`${'a'} ${'b'}`)
    expect(compileExpr(n).binds).toHaveLength(2)
    expect(compileExpr(n).binds).toHaveLength(2)
  })
})
