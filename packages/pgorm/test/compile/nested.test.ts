/**
 * The differentiator: ONE nested relation projected through
 * `LEFT JOIN LATERAL (select coalesce(json_agg(json_build_object(...)), '[]'::json))`
 * with per-codec JSON casts (03 §2.3 / D4 / R5).
 *
 * The claim being pinned here is the whole product thesis in one sentence: **a column's type
 * is the same whether you read it at the top level or five relations deep.** That is only
 * true if the compiler emits `::text` for `int8`/`numeric` inside `json_build_object` *and*
 * the decode plan routes those leaves through `codec.decodeJson`. Both halves are asserted.
 */

import { describe, expect, it } from 'vitest'
import { compile } from '../../src/compile/compiler.js'
import { buildDecoder } from '../../src/compile/decode.js'
import { jsonCast, planSelect } from '../../src/compile/hoist.js'
import {
  and,
  countStar,
  desc,
  eq,
  isNull,
  isTrue,
  nested,
  param,
  projection,
  select,
  subquery,
} from '../../src/compile/nodes.js'
import {
  arrayCodecOf,
  builtinCodecs,
  int4Codec,
  int8Codec,
  numericCodec,
  textCodec,
  timestamptzCodec,
  varcharCodec,
} from '../../src/codec/index.js'
import { c, commentsFrom, p, postsFrom, u, usersFrom } from '../sql/_helpers.js'

const vals = (x: { binds: readonly { k: string }[] }) =>
  x.binds.map((b) => (b as { encoded?: unknown }).encoded)

/** users → latestPosts (many), paginated per parent, ordered, filtered. */
const latestPosts = select({
  projection: [
    projection('id', p('id')),
    projection('title', p('title')),
    projection('amount', p('amount')),
    projection('createdAt', p('createdAt')),
  ],
  from: postsFrom,
  where: and(eq(p('authorId'), u('id')), isTrue(p('published'))),
  orderBy: [desc(p('createdAt'))],
  limit: param(3, int4Codec),
})

const feed = select({
  projection: [
    projection('id', u('id')),
    projection('email', u('email')),
    nested('latestPosts', { kind: 'many', query: latestPosts, alias: 'lp' }),
  ],
  from: usersFrom,
  where: isNull(u('deletedAt')),
  orderBy: [desc(u('createdAt'))],
  limit: param(20, int4Codec),
})

describe('the LATERAL nesting golden', () => {
  const compiled = compile(feed)

  it('emits exactly this SQL', () => {
    expect(compiled.sql).toBe(
      [
        'select "users"."id" as "id", "users"."email" as "email", "lp"."v" as "latestPosts"',
        'from "public"."users" as "users"',
        'left join lateral (',
        '  select coalesce(json_agg("x"."o" order by "x"."k0" desc), \'[]\'::json) as "v"',
        '  from (',
        '    select json_build_object(\'id\', "posts"."id"::text, \'title\', "posts"."title", ' +
          '\'amount\', "posts"."amount"::text, \'createdAt\', "posts"."created_at") as "o", ' +
          '"posts"."created_at" as "k0"',
        '    from "public"."posts" as "posts"',
        '    where ("posts"."author_id" = "users"."id" and "posts"."published" is true)',
        '    order by "posts"."created_at" desc',
        '    limit $1',
        '  ) as "x"',
        ') as "lp" on true',
        'where "users"."deleted_at" is null',
        'order by "users"."created_at" desc',
        'limit $2',
      ].join('\n'),
    )
  })

  it('numbers the per-parent LIMIT before the parent LIMIT (join precedes limit)', () => {
    // The hoist assigns no parameter numbers; `$n` is a single left-to-right textual pass over
    // the already-hoisted tree, so ordering falls out of clause order.
    expect(vals(compiled)).toEqual(['3', '20'])
  })

  it('produces the positional decode shape', () => {
    expect(compiled.shape).toEqual({
      k: 'row',
      fields: [
        { key: 'id', k: 'col', idx: 0, codec: int8Codec },
        { key: 'email', k: 'col', idx: 1, codec: varcharCodec },
        {
          key: 'latestPosts',
          k: 'json',
          idx: 2,
          nullable: false,
          plan: {
            k: 'arr',
            item: {
              k: 'obj',
              nullable: false,
              fields: [
                { key: 'id', plan: { k: 'leaf', codec: int8Codec } },
                { key: 'title', plan: { k: 'leaf', codec: textCodec } },
                { key: 'amount', plan: { k: 'leaf', codec: numericCodec } },
                { key: 'createdAt', plan: { k: 'leaf', codec: timestamptzCodec } },
              ],
            },
          },
        },
      ],
    })
  })

  it('int8 and numeric are cast to ::text inside the JSON, timestamptz is not', () => {
    expect(compiled.sql).toContain(`'id', "posts"."id"::text`)
    expect(compiled.sql).toContain(`'amount', "posts"."amount"::text`)
    // to_json emits ISO 8601 with offset, so 'native' is already exact for timestamptz.
    expect(compiled.sql).toContain(`'createdAt', "posts"."created_at"`)
    expect(compiled.sql).not.toContain('"posts"."created_at"::text,')
  })

  it('coalesces the empty relation to [] rather than null', () => {
    expect(compiled.sql).toContain(`'[]'::json)`)
  })

  it('re-states ordering explicitly via a hidden key, never relying on json_agg input order', () => {
    expect(compiled.sql).toContain('"posts"."created_at" as "k0"')
    expect(compiled.sql).toContain('json_agg("x"."o" order by "x"."k0" desc)')
    // The hidden key never appears in the JSON, because the object is built from an explicit
    // key list rather than row_to_json.
    expect(compiled.sql).not.toContain(`'k0'`)
  })

  it('meta.reads names both tables', () => {
    // Emission order: the parent FROM, then the hoisted lateral's FROM.
    expect(compiled.meta.reads).toEqual([
      { schema: 'public', name: 'users' },
      { schema: 'public', name: 'posts' },
    ])
  })
})

describe('R5 — no dehydration tax: identical decoding at depth 0 and depth 2', () => {
  it('decodes bigint / numeric-as-string identically at every depth', () => {
    const decode = buildDecoder<{
      id: bigint
      email: string
      latestPosts: { id: bigint; title: string; amount: string; createdAt: Date }[]
    }>(compile(feed).shape)

    // What `rowMode: 'array'` hands us: [int8-as-text, citext-as-text, json-as-text].
    const rows = [
      [
        '9007199254740993', // 2^53 + 1: unrepresentable as a JSON number
        'ada@example.com',
        JSON.stringify([
          {
            id: '9007199254740995',
            title: 'first',
            amount: '1234.56',
            createdAt: '2026-08-14T12:00:00+00:00',
          },
        ]),
      ],
    ]

    const [out] = decode(rows)
    expect(out).toBeDefined()
    const r = out as NonNullable<typeof out>

    // Depth 0.
    expect(r.id).toBe(9007199254740993n)
    expect(typeof r.id).toBe('bigint')
    // Depth 2 — same codec, same TypeScript type, no precision loss.
    expect(r.latestPosts[0]?.id).toBe(9007199254740995n)
    expect(typeof r.latestPosts[0]?.id).toBe('bigint')
    expect(r.latestPosts[0]?.amount).toBe('1234.56')
    expect(r.latestPosts[0]?.createdAt).toBeInstanceOf(Date)
    expect(r.latestPosts[0]?.createdAt.toISOString()).toBe('2026-08-14T12:00:00.000Z')
  })

  it('an empty relation decodes to [] and never to null', () => {
    const decode = buildDecoder<{ latestPosts: unknown[] }>(compile(feed).shape)
    expect(decode([['1', 'a@b', '[]']])[0]?.latestPosts).toEqual([])
    // Defensive: even if the lateral somehow produced SQL NULL.
    expect(decode([['1', 'a@b', null]])[0]?.latestPosts).toEqual([])
  })

  it('the JSON precision hazard is real — this is why ::text is not optional', () => {
    // If int8 were embedded as a JSON *number*, JSON.parse would silently round it. The
    // comparison has to be done on the *text*, because the round-tripped literal in this very
    // source file would suffer the same rounding.
    expect(String((JSON.parse('{"id":9007199254740995}') as { id: number }).id)).toBe(
      '9007199254740996',
    )
    expect((JSON.parse('{"id":"9007199254740995"}') as { id: string }).id).toBe(
      '9007199254740995',
    )
    expect(BigInt('9007199254740995')).toBe(9007199254740995n)
  })
})

describe('nesting inside nesting, and to-one inside to-many', () => {
  const author = select({
    projection: [projection('id', u('id', 'author')), projection('name', u('name', 'author'))],
    from: subquery(
      select({ projection: [projection('id', u('id'))], from: usersFrom }),
      'author_src',
    ),
    where: eq(u('id', 'author'), p('authorId')),
  })

  const withComments = select({
    projection: [
      projection('id', p('id')),
      projection('commentCount', countStar()),
      nested('author', { kind: 'one', query: author, alias: 'au', required: true }),
      nested('comments', {
        kind: 'many',
        alias: 'cm',
        query: select({
          projection: [projection('id', c('id')), projection('body', c('body'))],
          from: commentsFrom,
          where: eq(c('postId'), p('id')),
        }),
      }),
    ],
    from: postsFrom,
  })

  const outer = compile(
    select({
      projection: [
        projection('id', u('id')),
        nested('posts', { kind: 'many', query: withComments, alias: 'lp' }),
      ],
      from: usersFrom,
    }),
  )

  it('recurses: an inner lateral is hoisted onto the INNER select, not the outer one', () => {
    // The `cm` and `au` laterals must attach to the derived posts select inside `lp`.
    const lines = outer.sql.split('\n')
    const lpIdx = lines.findIndex((l) => l.includes(') as "lp" on true'))
    const auIdx = lines.findIndex((l) => l.includes(') as "au" on true'))
    const cmIdx = lines.findIndex((l) => l.includes(') as "cm" on true'))
    expect(auIdx).toBeGreaterThan(-1)
    expect(cmIdx).toBeGreaterThan(-1)
    expect(auIdx).toBeLessThan(lpIdx)
    expect(cmIdx).toBeLessThan(lpIdx)
  })

  it('a to-one relation is a lateral with limit 1 and embeds as a json object', () => {
    expect(outer.sql).toContain('limit 1')
    expect(outer.sql).toContain('"au"."o"')
  })

  it('a nested json value is embedded natively, never double-encoded', () => {
    // No `::text` on "au"."o" or "cm"."v" — they are already json.
    expect(outer.sql).not.toContain('"au"."o"::text')
    expect(outer.sql).not.toContain('"cm"."v"::text')
  })

  it('the decode plan mirrors the nesting exactly', () => {
    expect(outer.shape).toEqual({
      k: 'row',
      fields: [
        { key: 'id', k: 'col', idx: 0, codec: int8Codec },
        {
          key: 'posts',
          k: 'json',
          idx: 1,
          nullable: false,
          plan: {
            k: 'arr',
            item: {
              k: 'obj',
              nullable: false,
              fields: [
                { key: 'id', plan: { k: 'leaf', codec: int8Codec } },
                { key: 'commentCount', plan: { k: 'leaf', codec: int8Codec } },
                {
                  key: 'author',
                  plan: {
                    k: 'obj',
                    nullable: false,
                    fields: [
                      { key: 'id', plan: { k: 'leaf', codec: int8Codec } },
                      { key: 'name', plan: { k: 'leaf', codec: textCodec } },
                    ],
                  },
                },
                {
                  key: 'comments',
                  plan: {
                    k: 'arr',
                    item: {
                      k: 'obj',
                      nullable: false,
                      fields: [
                        { key: 'id', plan: { k: 'leaf', codec: int8Codec } },
                        { key: 'body', plan: { k: 'leaf', codec: textCodec } },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      ],
    })
  })

  it('decodes three levels deep with exact types', () => {
    const decode = buildDecoder<{
      id: bigint
      posts: {
        id: bigint
        commentCount: bigint
        author: { id: bigint; name: string }
        comments: { id: bigint; body: string }[]
      }[]
    }>(outer.shape)
    const [r] = decode([
      [
        '1',
        JSON.stringify([
          {
            id: '10',
            commentCount: '2',
            author: { id: '1', name: 'Ada' },
            comments: [
              { id: '100', body: 'a' },
              { id: '101', body: 'b' },
            ],
          },
        ]),
      ],
    ])
    expect(r?.posts[0]?.comments[1]?.id).toBe(101n)
    expect(r?.posts[0]?.author.id).toBe(1n)
    expect(r?.posts[0]?.commentCount).toBe(2n)
  })
})

describe('optional to-one nullability', () => {
  it('required: false makes the decoded object nullable', () => {
    const q = compile(
      select({
        projection: [
          nested('author', {
            kind: 'one',
            alias: 'au',
            required: false,
            query: select({
              projection: [projection('id', u('id'))],
              from: usersFrom,
              where: eq(u('id'), p('authorId')),
            }),
          }),
        ],
        from: postsFrom,
      }),
    )
    const field = (q.shape as unknown as { fields: { nullable: boolean }[] }).fields[0]
    expect(field?.nullable).toBe(true)
    const decode = buildDecoder<{ author: unknown }>(q.shape)
    expect(decode([[null]])[0]?.author).toBeNull()
  })
})

describe('hoist internals', () => {
  it('planSelect is a no-op on a select with no nested items', () => {
    const flat = select({ projection: [projection('id', u('id'))], from: usersFrom })
    expect(planSelect(flat).node).toBe(flat)
  })

  it('jsonCast honours every jsonEncode mode', () => {
    const e = u('id')
    expect(jsonCast(e, textCodec)).toBe(e) // native: untouched
    expect(jsonCast(e, int8Codec)).toMatchObject({ k: 'cast', to: 'text' })
    expect(jsonCast(e, numericCodec)).toMatchObject({ k: 'cast', to: 'text' })
    expect(jsonCast(e, arrayCodecOf(int8Codec))).toMatchObject({ k: 'cast', to: 'text' })
  })

  /**
   * `jsonCast` is two branches with no `default`, which is only total because `JsonEncode` has
   * exactly two members. 03 §7 sketched a third — a custom `(e: Expr) => Expr` wrapper — which
   * WS2 decided against (a codec building compiler AST inverts the layering; see `JsonEncode` in
   * `src/codec/types.ts`). This is the guard on that decision: if a codec ever ships a third mode,
   * `jsonCast` would silently treat it as 'native' and R5 would break for that type in silence.
   */
  it('every shipped codec declares one of the two jsonEncode modes', () => {
    const modes = new Set(builtinCodecs().map((c) => c.jsonEncode as string))
    expect([...modes].sort()).toEqual(['native', 'text'])
  })
})
