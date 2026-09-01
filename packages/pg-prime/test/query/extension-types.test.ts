/**
 * Extension types, tier 0 — `definePgType()` and its two reference users (design/01 §3 rows
 * 44-`citext`, 61, 62 · design/14 V).
 *
 * Everything here is checkable without a server, and each block is a claim that would otherwise
 * only be caught in tier 2 against a container that has pgvector installed:
 *
 *  - the descriptor's four DERIVATIONS (`oid`, `paramOid`, `jsonEncode`, `decodeJson`) — the
 *    pending window, and R5's depth-0/depth-3 equality;
 *  - the two codecs' wire forms, which are the one thing a type could get silently wrong: a
 *    `vector` is `[1,2,3]`, which is neither `{1,2,3}` nor JSON;
 *  - `codecFor`'s typmod strip, i.e. that `vector(1536)` and `varchar(50)` are still `vector` and
 *    `varchar` to the registry;
 *  - `arrayCodec`'s leaf rule for a `vector` element, which is a two-dimensional-array bug
 *    waiting to happen and cannot be seen in the type system;
 *  - the DSL's two refusals.
 */

import { describe, expect, it } from 'vitest'
import {
  arrayCodec,
  citextCodec,
  createRegistry,
  definePgType,
  EXTENSION_CODECS,
  PgDecodeError,
  PgEncodeError,
  vectorCodec,
} from '../../src/codec/index.js'
import type { AnyCodec, CodecContext } from '../../src/codec/index.js'
import { codecFor, metaOf } from '../../src/query/meta.js'
import { pgTable, VECTOR_MAX_DIMENSIONS } from '../../src/schema/index.js'
import { SchemaError } from '../../src/sql/errors.js'

const registry = createRegistry()
const ctx = (): CodecContext => ({ typmod: -1, registry, serverParameters: {} })

describe('definePgType() — the descriptor and its four derivations', () => {
  it('produces a codec with NO OID: 02 §4.6 is the whole reason this API exists', () => {
    expect(vectorCodec.oid).toBeUndefined()
    expect(vectorCodec.paramOid).toBeUndefined()
    expect(citextCodec.oid).toBeUndefined()
    // …and a fresh registry knows both by NAME, so `t.citext()` resolves before any connection.
    expect(registry.byName('citext')).toBe(citextCodec)
    expect(registry.byName('vector')).toBe(vectorCodec)
    // …but never by OID, which is the invariant that makes the pending window safe: `planFor`
    // must not be able to answer a RowDescription with a codec that has not met this database.
    expect(EXTENSION_CODECS.every((c) => c.oid === undefined)).toBe(true)
  })

  it("`jsonEncode` is 'text', so `decodeJson` equals `decodeText` by construction (R5)", () => {
    for (const c of EXTENSION_CODECS) expect(c.jsonEncode).toBe('text')
    expect(registry.jsonCastFor(vectorCodec as unknown as AnyCodec)).toBe('::text')
    // depth 0 and depth 3 are the same string, so the two decoders cannot disagree.
    expect(vectorCodec.decodeJson('[1,2,3]', ctx())).toStrictEqual(
      vectorCodec.decodeText('[1,2,3]', ctx()),
    )
    expect(citextCodec.decodeJson('AbC', ctx())).toBe(citextCodec.decodeText('AbC', ctx()))
  })

  it('a JSON payload that is not the ::text rendering is a PgDecodeError, not a coercion', () => {
    expect(() => vectorCodec.decodeJson([1, 2, 3], ctx())).toThrow(PgDecodeError)
  })

  it('`schema` qualifies the cast the compiler splices, and nothing else', () => {
    expect(vectorCodec.sqlName).toBe('"vector"')
    const elsewhere = definePgType({
      name: 'vector',
      schema: 'extensions',
      encode: (v: string) => v,
      decode: (raw) => raw,
    })
    expect(elsewhere.sqlName).toBe('"extensions"."vector"')
  })

  it('refuses a descriptor that cannot be a codec', () => {
    expect(() => definePgType({ name: '', encode: (v: string) => v, decode: (r) => r })).toThrow(
      /needs a PostgreSQL type name/,
    )
    expect(() =>
      definePgType({ name: 'x', encode: undefined as never, decode: (r: string) => r }),
    ).toThrow(/encode and a decode/)
  })

  it("defaults `typeClass` to 'other' and takes the one it is given", () => {
    expect(definePgType({ name: 'x', encode: (v: string) => v, decode: (r) => r }).typeClass).toBe(
      'other',
    )
    expect(citextCodec.typeClass).toBe('string')
    expect(vectorCodec.typeClass).toBe('vector')
  })
})

describe('citext', () => {
  it('round-trips verbatim — the case-insensitivity is in the operators, not the storage', () => {
    expect(citextCodec.encode('AbC')).toBe('AbC')
    expect(citextCodec.decodeText('AbC', ctx())).toBe('AbC')
  })
  it('refuses a non-string with PgEncodeError (02 §4.2)', () => {
    expect(() => citextCodec.encode(7 as never)).toThrow(PgEncodeError)
  })
})

describe('vector', () => {
  it("encodes to pgvector's bracket form, not a PostgreSQL array literal and not JSON", () => {
    expect(vectorCodec.encode([1, 2, 3])).toBe('[1,2,3]')
    expect(vectorCodec.encode([1.5, -2, 0])).toBe('[1.5,-2,0]')
    expect(vectorCodec.encode([])).toBe('[]')
  })
  it('decodes the same form back to numbers', () => {
    expect(vectorCodec.decodeText('[1,2,3]', ctx())).toStrictEqual([1, 2, 3])
    expect(vectorCodec.decodeText('[1.5,-2,0]', ctx())).toStrictEqual([1.5, -2, 0])
    expect(vectorCodec.decodeText('[]', ctx())).toStrictEqual([])
  })
  it('refuses NaN and ±Infinity by index, rather than letting the server say 22000', () => {
    expect(() => vectorCodec.encode([1, Number.NaN, 3])).toThrow(/finite number at index 1/)
    expect(() => vectorCodec.encode([Number.POSITIVE_INFINITY])).toThrow(PgEncodeError)
    expect(() => vectorCodec.encode('[1,2,3]' as never)).toThrow(/an array of numbers/)
  })
  it('refuses a wire form it did not expect, naming the component', () => {
    expect(() => vectorCodec.decodeText('{1,2,3}', ctx())).toThrow(/bracket form/)
    expect(() => vectorCodec.decodeText('[1,x,3]', ctx())).toThrow(/component 1/)
  })

  /**
   * The bug this exists to prevent has no type-level signal at all: `vector` decodes to
   * `number[]`, so `writeArrayLiteral`'s structural `Array.isArray` check would read
   * `[[1,2],[3,4]]` as a 2-D array of four numbers and emit `{{1,2},{3,4}}` — which PostgreSQL
   * accepts as a `vector[]` of *four* one-dimensional… no, it does not: it fails, or worse it
   * stores something else. `typeClass: 'vector'` is what makes the element a LEAF.
   */
  it('an ARRAY of vectors is two vectors, not a two-dimensional array of numbers', () => {
    const vecArray = arrayCodec(vectorCodec, undefined)
    expect(
      vecArray.encode([
        [1, 2],
        [3, 4],
      ]),
    ).toBe('{"[1,2]","[3,4]"}')
    expect(vecArray.decodeText('{"[1,2]","[3,4]"}', ctx())).toStrictEqual([
      [1, 2],
      [3, 4],
    ])
  })
})

describe('the column factories', () => {
  it('`t.citext()` and `t.vector(n)` declare the DDL type, typmod included', () => {
    const t = pgTable('docs', (c) => ({
      title: c.citext(),
      embedding: c.vector(1536),
      loose: c.vector(),
      tags: c.citext().array(),
    }))
    expect(t.$.column('title')?.ddl.pgType).toBe('citext')
    expect(t.$.column('embedding')?.ddl.pgType).toBe('vector(1536)')
    expect(t.$.column('loose')?.ddl.pgType).toBe('vector')
    expect(t.$.column('tags')?.ddl.pgType).toBe('citext[]')
  })

  it('a typmod is not a type: `vector(1536)` still resolves to the `vector` codec', () => {
    const t = pgTable('docs', (c) => ({
      embedding: c.vector(1536),
      // design/05 §5.3's escape hatch, which used to declare a column `metaOf` refused to build
      // a codec for at all.
      short: c.raw('varchar(50)'),
      money: c.raw('numeric(10,2)'),
    }))
    const m = metaOf(t, registry)
    expect(m.byKey['embedding']?.codec.name).toBe('vector')
    expect(m.byKey['short']?.codec.name).toBe('varchar')
    expect(m.byKey['money']?.codec.name).toBe('numeric')
  })

  it('a type the registry has never heard of is still a NoCodecError naming definePgType', () => {
    const t = pgTable('x', (c) => ({ h: c.raw('hstore') }))
    expect(() => codecFor(t.$.column('h')!.ddl, registry, 'x', 'h')).toThrow(/definePgType/)
  })

  it('refuses a dimension PostgreSQL or pgvector would refuse, at the line that declared it', () => {
    expect(() => pgTable('x', (c) => ({ e: c.vector(0) }))).toThrow(SchemaError)
    expect(() => pgTable('x', (c) => ({ e: c.vector(1.5) }))).toThrow(/positive integer/)
    expect(() => pgTable('x', (c) => ({ e: c.vector(VECTOR_MAX_DIMENSIONS + 1) }))).toThrow(
      /exceeds pgvector's limit of 16000/,
    )
  })
})
