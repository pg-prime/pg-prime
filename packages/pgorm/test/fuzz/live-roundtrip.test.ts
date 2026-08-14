/**
 * End-to-end proof against a live PostgreSQL: compile → execute (`rowMode: 'array'`) →
 * decode, and check that the values that come back are the values the *types* promise.
 *
 * This is the only test in the suite that closes the loop on R5. The golden tests prove the
 * compiler emits `::text` for `int8`/`numeric` inside `json_build_object`; this one proves
 * PostgreSQL agrees and that `decodeJson` reconstructs a `bigint` past 2^53 and a
 * precision-exact `numeric` string at nesting depth 2.
 */

import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Compiled } from '../../src/compile/contract.js'
import { compile } from '../../src/compile/compiler.js'
import { buildDecoder } from '../../src/compile/decode.js'
import {
  and,
  desc,
  eq,
  isNull,
  isTrue,
  jsonGetText,
  jsonPathText,
  nested,
  param,
  projection,
  select,
} from '../../src/compile/nodes.js'
import { spikeCodecs } from '../../src/sql/codec.js'
import { connect } from './_pg.js'
import { makeFixture } from './fixture.js'

let client: pg.Client

/** This file owns its own schema; see the note in fixture.ts. */
const fx = makeFixture('pgorm_fz_rt')
const { c, p, u, commentsFrom, postsFrom, usersFrom } = fx

/**
 * Neutralise `pg`'s per-OID type parsers so every field arrives as raw text — the contract
 * agent 06's adapter implements, and the input `decodeText`/`decodeJson` are written against.
 */
const TEXT_ONLY = { getTypeParser: () => (v: string) => v }

async function run<Row>(compiled: Compiled<Row>): Promise<Row[]> {
  const res = await client.query({
    text: compiled.sql,
    values: compiled.binds.map((b) => (b.k === 'value' ? b.encoded : null)),
    rowMode: 'array',
    types: TEXT_ONLY as never,
  })
  return buildDecoder<Row>(compiled.shape)(res.rows as unknown[][])
}

beforeAll(async () => {
  client = await connect()
  await client.query(fx.ddl)
  await client.query(fx.seed)
  await client.query(
    `update ${fx.schema}.users set meta = '{"billing":{"country":"DE"},"secret":"do-not-leak"}'::jsonb`,
  )
}, 60_000)

afterAll(async () => {
  await client?.query(fx.drop)
  await client?.end()
})

interface Feed {
  id: bigint
  email: string
  latestPosts: {
    id: bigint
    title: string
    amount: string
    createdAt: Date
    comments: { id: bigint; body: string }[]
  }[]
}

const feed = compile<Feed>(
  select({
    projection: [
      projection('id', u('id')),
      projection('email', u('email')),
      nested('latestPosts', {
        kind: 'many',
        alias: 'lp',
        query: select({
          projection: [
            projection('id', p('id')),
            projection('title', p('title')),
            projection('amount', p('amount')),
            projection('createdAt', p('created_at')),
            nested('comments', {
              kind: 'many',
              alias: 'cm',
              query: select({
                projection: [projection('id', c('id')), projection('body', c('body'))],
                from: commentsFrom,
                where: eq(c('post_id'), p('id')),
                orderBy: [desc(c('id'))],
              }),
            }),
          ],
          from: postsFrom,
          where: and(eq(p('author_id'), u('id')), isTrue(p('published'))),
          orderBy: [desc(p('created_at'))],
          limit: param(3, spikeCodecs.int4),
        }),
      }),
    ],
    from: usersFrom,
    where: isNull(u('deleted_at')),
    orderBy: [desc(u('id'))],
  }),
)

describe('the LATERAL nesting golden, executed for real', () => {
  it('PostgreSQL accepts the compiled SQL', async () => {
    await expect(client.query(`explain (generic_plan) ${feed.sql}`)).resolves.toBeDefined()
  })

  it('uses LEFT JOIN LATERAL, not a correlated scalar subquery', () => {
    expect(feed.sql).toContain('left join lateral (')
    expect(feed.sql).toContain(') as "lp" on true')
    expect(feed.sql).toContain(') as "cm" on true')
  })

  it('decodes int8 as bigint past 2^53 at depth 0 AND depth 2', async () => {
    const rows = await run(feed)
    const ada = rows.find((r) => r.email === 'ada@example.com')
    expect(ada).toBeDefined()
    const a = ada as Feed

    // Depth 0: a real int8 that a JSON number could not carry.
    expect(a.id).toBe(9007199254740993n)
    expect(typeof a.id).toBe('bigint')

    // Depth 2: same codec, same type, no precision loss — because of `::text`.
    expect(a.latestPosts[0]?.id).toBe(9007199254740995n)
    expect(typeof a.latestPosts[0]?.id).toBe('bigint')
  })

  it('decodes numeric as a precision-exact string at depth 2', async () => {
    const [ada] = await run(feed)
    const amounts = (ada as Feed).latestPosts.map((x) => x.amount)
    expect(amounts).toEqual(['1234.56', '0.10', '99999999.99'])
    for (const amt of amounts) expect(typeof amt).toBe('string')
  })

  it('honours per-parent LIMIT, ORDER BY and the relation predicate', async () => {
    const [ada] = await run(feed)
    const posts = (ada as Feed).latestPosts
    expect(posts).toHaveLength(3) // limit 3, applied INSIDE the lateral
    expect(posts.map((x) => x.title)).toEqual(['newest', 'older', 'oldest'])
    expect(posts.map((x) => x.title)).not.toContain('draft') // published = false
  })

  it('decodes timestamptz as a Date at depth 2 without a day shift', async () => {
    const [ada] = await run(feed)
    const first = (ada as Feed).latestPosts[0]
    expect(first?.createdAt).toBeInstanceOf(Date)
    expect(first?.createdAt.toISOString()).toBe('2026-08-14T12:00:00.000Z')
  })

  it('nests three levels: comments inside posts inside users', async () => {
    const [ada] = await run(feed)
    const comments = (ada as Feed).latestPosts[0]?.comments
    expect(comments).toEqual([
      { id: 101n, body: 'second' },
      { id: 100n, body: 'first' },
    ])
    expect(typeof comments?.[0]?.id).toBe('bigint')
  })

  it('an empty relation comes back as [], never null', async () => {
    const rows = await run(feed)
    const cyd = rows.find((r) => r.email === 'cyd@example.com')
    expect(cyd).toBeDefined()
    // coalesce(json_agg(...), '[]'::json) — the detail everyone gets wrong once.
    expect((cyd as Feed).latestPosts).toEqual([])
  })
})

describe('the Kysely CVE corpus, live and inert', () => {
  /** GHSA-pv5w: attacker-controlled path legs traversing into a sibling JSON field. */
  const TRAVERSALS = [
    '0"].sibling["0',
    '"].secret["',
    'billing"]["country',
    `a'); drop table ${fx.schema}.users; --`,
    '$.**',
    '*',
  ]

  it('a traversal payload reads no sibling field — it is just a missing key', async () => {
    for (const payload of TRAVERSALS) {
      const q = compile<{ v: string | null }>(
        select({
          projection: [projection('v', jsonGetText(u('meta'), payload))],
          from: usersFrom,
          limit: param(1, spikeCodecs.int4),
        }),
      )
      expect(q.sql).toBe(
        [
          'select "users"."meta" ->> $1 as "v"',
          `from "${fx.schema}"."users" as "users"`,
          'limit $2',
        ].join('\n'),
      )
      const [row] = await run(q)
      expect(row?.v, `payload ${JSON.stringify(payload)} leaked`).toBeNull()
    }
  })

  it('#>> with a hostile leg cannot escape the path it was given', async () => {
    const legit = compile<{ v: string | null }>(
      select({
        projection: [projection('v', jsonPathText(u('meta'), ['billing', 'country']))],
        from: usersFrom,
        limit: param(1, spikeCodecs.int4),
      }),
    )
    expect((await run(legit))[0]?.v).toBe('DE')

    for (const payload of TRAVERSALS) {
      const q = compile<{ v: string | null }>(
        select({
          projection: [projection('v', jsonPathText(u('meta'), ['billing', payload]))],
          from: usersFrom,
          limit: param(1, spikeCodecs.int4),
        }),
      )
      const [row] = await run(q)
      expect(row?.v).toBeNull()
    }
  })

  it('the users table is still there afterwards', async () => {
    const res = await client.query<{ n: string }>(`select count(*) as n from ${fx.schema}.users`)
    expect((res.rows[0] as { n: string }).n).toBe('3')
  })
})
