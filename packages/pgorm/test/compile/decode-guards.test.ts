/**
 * Decoder guards (`src/compile/decode.ts`) — the three ways a plan could hand back a value that
 * the types say is impossible.
 *
 *  - A **required** relation that returned no row used to decode as `{}`, typed as the full row:
 *    every field of it reads back `undefined`, arbitrarily far from the query that caused it.
 *  - A nullable `nest()` group with no sentinel used a `many` relation's column as its witness,
 *    and `coalesce(json_agg(…), '[]')` is *never* NULL — so the group was never judged null.
 *  - `obj[key] = …` with `key === '__proto__'` replaces the row's prototype instead of setting
 *    a property.
 *
 * The oracle is the ResultShape contract itself (`src/compile/contract.ts`), which the decoder is
 * the only consumer of, so these are hand-written plans rather than compiled ones.
 */

import { describe, expect, it } from 'vitest'
import { PgDecodeError, int8Codec, jsonCodecJson, textCodec } from '../../src/codec/index.js'
import type { ResultShape } from '../../src/compile/contract.js'
import { buildDecoder } from '../../src/compile/decode.js'
import { DecodePlanError } from '../../src/sql/errors.js'

describe('a required relation that returned no row is an error, never `{}`', () => {
  const shape = (nullable: boolean): ResultShape => ({
    k: 'row',
    fields: [
      { key: 'id', k: 'col', idx: 0, codec: int8Codec },
      {
        key: 'author',
        k: 'json',
        idx: 1,
        nullable,
        plan: {
          k: 'obj',
          nullable,
          fields: [{ key: 'name', plan: { k: 'leaf', codec: textCodec } }],
        },
      },
    ],
  })

  it('throws a PgDecodeError naming the column, instead of fabricating an empty object', () => {
    const decode = buildDecoder(shape(false))
    let thrown: unknown
    try {
      decode([['1', null]])
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(PgDecodeError)
    expect((thrown as Error).message).toContain('author')
    expect((thrown as Error).message).toContain('no row')
  })

  it('…and the same for a required relation nested INSIDE a present JSON document', () => {
    // `author` came back, but the `author.city` it is required to carry is JSON null.
    const decode = buildDecoder<{ author: unknown }>({
      k: 'row',
      fields: [
        {
          key: 'author',
          k: 'json',
          idx: 0,
          nullable: false,
          plan: {
            k: 'obj',
            nullable: false,
            fields: [
              {
                key: 'city',
                plan: {
                  k: 'obj',
                  nullable: false,
                  fields: [{ key: 'name', plan: { k: 'leaf', codec: textCodec } }],
                },
              },
            ],
          },
        },
      ],
    })
    expect(() => decode([['{"city":null}']])).toThrow(/city/)
    expect(() => decode([['{"city":null}']])).toThrow(PgDecodeError)
  })

  it('NEGATIVE CONTROL — an OPTIONAL relation decodes the same NULL as null', () => {
    const decode = buildDecoder<{ author: unknown }>(shape(true))
    expect(decode([['1', null]])[0]?.author).toBeNull()
    expect(decode([['1', '{"name":"Ada"}']])[0]?.author).toEqual({ name: 'Ada' })
  })

  it('NEGATIVE CONTROL — a `many` relation still decodes NULL as [], not as an error', () => {
    // `coalesce(json_agg(…), '[]')` should never produce NULL; if it somehow does, an empty list
    // is the honest answer and the one 03 §2.3 promises.
    const decode = buildDecoder<{ posts: unknown }>({
      k: 'row',
      fields: [
        {
          key: 'posts',
          k: 'json',
          idx: 0,
          nullable: false,
          plan: { k: 'arr', item: { k: 'obj', nullable: false, fields: [] } },
        },
      ],
    })
    expect(decode([[null]])[0]?.posts).toEqual([])
  })
})

describe('the witness for a nullable nest() group', () => {
  /** `nest({ name, posts })` where `posts` is a `many` relation column. */
  const shape = (witnesses?: readonly number[]): ResultShape => ({
    k: 'row',
    fields: [
      {
        key: 'author',
        k: 'group',
        nullable: true,
        sentinel: undefined,
        witnesses,
        fields: [
          { key: 'name', k: 'col', idx: 0, codec: textCodec },
          {
            key: 'posts',
            k: 'json',
            idx: 1,
            nullable: false,
            plan: { k: 'arr', item: { k: 'obj', nullable: false, fields: [] } },
          },
        ],
      },
    ],
  })

  it('ignores a relation column, which is `[]` and therefore never NULL', () => {
    const decode = buildDecoder<{ author: unknown }>(shape())
    // The left join found no author: the column is NULL and the relation aggregated to `[]`.
    expect(decode([[null, '[]']])[0]?.author).toBeNull()
    expect(decode([['Ada', '[]']])[0]?.author).toEqual({ name: 'Ada', posts: [] })
  })

  it('an explicit witness list overrides the heuristic', () => {
    // The builder knows which columns are NOT NULL and whether the group came from an outer join;
    // this is the seam it plugs into. `[]` means "never null".
    const decode = buildDecoder<{ author: unknown }>(shape([]))
    expect(decode([[null, '[]']])[0]?.author).toEqual({ name: null, posts: [] })
  })

  it('NEGATIVE CONTROL — a sentinel still wins over both', () => {
    const decode = buildDecoder<{ author: unknown }>({
      k: 'row',
      fields: [
        {
          key: 'author',
          k: 'group',
          nullable: true,
          sentinel: 1,
          fields: [
            { key: 'name', k: 'col', idx: 0, codec: textCodec },
            { key: 'id', k: 'col', idx: 1, codec: int8Codec },
          ],
        },
      ],
    })
    expect(decode([['Ada', null]])[0]?.author).toBeNull()
    expect(decode([[null, '7']])[0]?.author).toEqual({ name: null, id: 7n })
  })
})

describe("'__proto__' can never become a result key", () => {
  it('a column plan with that key is refused when the decoder is built', () => {
    expect(() =>
      buildDecoder({
        k: 'row',
        fields: [{ key: '__proto__', k: 'col', idx: 0, codec: textCodec }],
      }),
    ).toThrow(DecodePlanError)
  })

  it('…and so are the nested spellings: a group member and a JSON field', () => {
    expect(() =>
      buildDecoder({
        k: 'row',
        fields: [
          {
            key: 'g',
            k: 'group',
            nullable: false,
            sentinel: undefined,
            fields: [{ key: '__proto__', k: 'col', idx: 0, codec: textCodec }],
          },
        ],
      }),
    ).toThrow(DecodePlanError)
    expect(() =>
      buildDecoder({
        k: 'row',
        fields: [
          {
            key: 'rel',
            k: 'json',
            idx: 0,
            nullable: false,
            plan: {
              k: 'obj',
              nullable: false,
              fields: [{ key: '__proto__', plan: { k: 'leaf', codec: jsonCodecJson } }],
            },
          },
        ],
      }),
    ).toThrow(DecodePlanError)
  })

  it('NEGATIVE CONTROL — every other awkward key is still just a key', () => {
    const decode = buildDecoder<Record<string, unknown>>({
      k: 'row',
      fields: [
        { key: 'constructor', k: 'col', idx: 0, codec: textCodec },
        { key: 'toString', k: 'col', idx: 1, codec: textCodec },
      ],
    })
    const row = decode([['a', 'b']])[0] as Record<string, unknown>
    expect(row['constructor']).toBe('a')
    expect(row['toString']).toBe('b')
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype)
  })
})
