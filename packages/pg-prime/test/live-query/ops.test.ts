/**
 * The operator vocabulary, tier 1 — **PostgreSQL is the oracle, twice** (design/09 WS3, R1).
 *
 * Tier 0 pins the tokens we emit. It cannot tell you whether those tokens *mean* what we say, and
 * it cannot tell you the one thing a user never sees and the docs get wrong: what type comes back.
 * So every row of the `OPS` manifest is checked here two ways, both against the server.
 *
 * ── 1. The result-codec differential ──────────────────────────────────────────────────────────
 *
 *     select <expr> as v from users u limit 0     ⇒   fields[0].dataTypeID === codecOf(expr).oid
 *
 * The expected value is not hand-written: it is read off the expression's OWN result codec, the
 * same one the decoder and `assertShape` will use. So the assertion is literally "the codec this
 * operator claims is the type PostgreSQL produces". This is where `sum(int8) → numeric` (not
 * int8), `avg(float8) → float8` (not numeric — `03` §2.9 said otherwise) and `ts_rank → float4`
 * (not float8) are established rather than assumed.
 *
 * ── 2. The semantic differential ──────────────────────────────────────────────────────────────
 *
 *     select id from users u where <builder predicate>   vs   … where <hand-written SQL>
 *
 * The right-hand side is written by a human, in this file, and is the oracle. Both id sets must be
 * identical, AND the count must match the number in the table — without that third number a case
 * where both sides return nothing would pass while proving nothing.
 *
 * Both tables are keyed by operator name and both are checked against `CONFIRMABLE`, so an
 * operator cannot be added without both differentials, and neither differential can be written
 * for an operator that is not in the manifest.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  boolCodec,
  float4Codec,
  float8Codec,
  inetCodec,
  int2Codec,
  int4Codec,
  int4rangeCodec,
  int8Codec,
  numericCodec,
  Registry,
  textCodec,
} from '../../src/codec/index.js'
import type { AnyCodec } from '../../src/codec/index.js'
import type { Expr } from '../../src/compile/ast.js'
import { compileExpr } from '../../src/compile/compiler.js'
import { paramTypesOf } from '../../src/compile/contract.js'
import { codecOf } from '../../src/compile/hoist.js'
import { projection, select, table } from '../../src/compile/nodes.js'
import type { PgConnection } from '../../src/driver/index.js'
import { metaOf } from '../../src/query/meta.js'
import { CONFIRMABLE, OPS } from '../../src/query/ops.manifest.js'
import { refsOf } from '../../src/query/ref.js'
import * as q from '../../src/query/types.js'
import { makeHarness, type Harness } from '../live/_harness.js'
import { makeFixture } from '../live/fixture.js'

const fx = makeFixture('pgprime_q_ops')

let h: Harness
let conn: PgConnection
let registry: Registry

beforeAll(async () => {
  h = await makeHarness()
  conn = await h.driver.acquire()
  await conn.execute({ text: fx.drop, params: [], mode: 'simple' })
  await conn.execute({ text: fx.ddl, params: [], mode: 'simple' })
  await conn.execute({ text: fx.seed, params: [], mode: 'simple' })
  registry = new Registry()
  registry.setServerParameters(conn.serverParameters)
  await registry.resolveDynamic(conn, [
    { schema: fx.ns, name: 'user_role', kind: 'enum', enumLabels: ['admin', 'owner', 'member'] },
  ])
}, 120_000)

afterAll(async () => {
  if (conn) {
    await conn.execute({ text: fx.drop, params: [], mode: 'simple' })
    await h.driver.release(conn)
  }
  await h?.end()
})

// ─────────────────────────────────────────────────────────────────────────────
// Scope
// ─────────────────────────────────────────────────────────────────────────────

const u = () => refsOf(fx.users, 'u', registry)
const p = () => refsOf(fx.posts, 'p', registry)

/**
 * `select author_id from posts` and its correlated form.
 *
 * `select({...})` is the one hand-built node in this file: statement construction is WS4's, and
 * `inQuery` / `exists` / `notExists` take a query. Everything *inside* it — the refs, the
 * predicate — goes through the public surface.
 */
function postAuthors() {
  return select({
    projection: [projection('author_id', p().authorId as unknown as Expr)],
    from: table(metaOf(fx.posts, registry).table, 'p'),
  })
}
function postsOfUser() {
  return select({
    projection: [projection('one', p().id as unknown as Expr)],
    from: table(metaOf(fx.posts, registry).table, 'p'),
    where: q.eq(p().authorId, u().id) as unknown as Expr,
  })
}

const TSV = () => q.fn.toTsvector('english', u().name)
const TSQ = () => q.fn.websearchToTsquery('english', 'Ada')
const R = () => q.val('[1,5)', int4rangeCodec)
const NET = () => q.val('10.0.0.0/8', inetCodec)

/**
 * A three-valued boolean over the fixture, for `isTrue` and friends.
 *
 * `users` has no `bool` column, and a two-valued one would not exercise the operators anyway:
 * the whole reason `a is true` exists is that it answers `false` where `a = true` answers NULL.
 * TRUE for u4 (soft-deleted), FALSE for u1 (has a birthday), NULL for the other four — so all four
 * predicates below return a non-empty, *different* set, and none of them can pass vacuously.
 */
const BOOL3 = () =>
  q.sql`case when ${u().deletedAt} is not null then true when ${u().birthday} is not null then false else null end`.as(
    boolCodec,
  )
const BOOL3_SQL =
  `case when u.deleted_at is not null then true when u.birthday is not null then false else null end`

// ─────────────────────────────────────────────────────────────────────────────
// The table
// ─────────────────────────────────────────────────────────────────────────────

interface Case {
  /** The expression whose RESULT CODEC the server confirms. */
  readonly expr: () => unknown
  /** The boolean expression the semantic differential runs. */
  readonly pred: () => unknown
  /** Hand-written SQL for the same predicate. THIS is the oracle (R1). */
  readonly oracle: string
  /** How many of the six seeded users must match. Guards against a two-sided zero. */
  readonly rows: number
  /**
   * `select <this>` instead of `select <expr>`, for the two operators that are not standalone
   * expressions. Hand-written SQL asking the server the same question.
   */
  readonly selectAs?: string
}

const CASES: Readonly<Record<string, Case>> = {
  // ── every class ──────────────────────────────────────────────────────────
  eq: {
    expr: () => q.eq(u().email, 'bob@example.com'),
    pred: () => q.eq(u().email, 'bob@example.com'),
    oracle: `u.email = 'bob@example.com'`,
    rows: 1,
  },
  neq: {
    expr: () => q.neq(u().email, 'bob@example.com'),
    pred: () => q.neq(u().email, 'bob@example.com'),
    oracle: `u.email <> 'bob@example.com'`,
    rows: 5,
  },
  lt: {
    expr: () => q.lt(u().createdAt, new Date('2026-01-03T00:00:00Z')),
    pred: () => q.lt(u().createdAt, new Date('2026-01-03T00:00:00Z')),
    oracle: `u.created_at < timestamptz '2026-01-03 00:00:00+00'`,
    rows: 2,
  },
  lte: {
    expr: () => q.lte(u().createdAt, new Date('2026-01-03T00:00:00Z')),
    pred: () => q.lte(u().createdAt, new Date('2026-01-03T00:00:00Z')),
    oracle: `u.created_at <= timestamptz '2026-01-03 00:00:00+00'`,
    rows: 3,
  },
  gt: {
    expr: () => q.gt(u().createdAt, new Date('2026-01-03T00:00:00Z')),
    pred: () => q.gt(u().createdAt, new Date('2026-01-03T00:00:00Z')),
    oracle: `u.created_at > timestamptz '2026-01-03 00:00:00+00'`,
    rows: 3,
  },
  gte: {
    expr: () => q.gte(u().createdAt, new Date('2026-01-03T00:00:00Z')),
    pred: () => q.gte(u().createdAt, new Date('2026-01-03T00:00:00Z')),
    oracle: `u.created_at >= timestamptz '2026-01-03 00:00:00+00'`,
    rows: 4,
  },
  isNull: {
    expr: () => q.isNull(u().deletedAt),
    pred: () => q.isNull(u().deletedAt),
    oracle: `u.deleted_at is null`,
    rows: 5,
  },
  isNotNull: {
    expr: () => q.isNotNull(u().deletedAt),
    pred: () => q.isNotNull(u().deletedAt),
    oracle: `u.deleted_at is not null`,
    rows: 1,
  },
  isDistinctFrom: {
    expr: () => q.isDistinctFrom(u().deletedAt, null),
    pred: () => q.isDistinctFrom(u().deletedAt, null),
    oracle: `u.deleted_at is distinct from null`,
    rows: 1,
  },
  isNotDistinctFrom: {
    expr: () => q.isNotDistinctFrom(u().birthday, null),
    pred: () => q.isNotDistinctFrom(u().birthday, null),
    oracle: `u.birthday is not distinct from null`,
    rows: 5,
  },
  between: {
    expr: () => q.between(u().balance, '1.00', '100.00'),
    pred: () => q.between(u().balance, '1.00', '100.00'),
    oracle: `u.balance between numeric '1.00' and numeric '100.00'`,
    rows: 2,
  },
  inList: {
    expr: () => q.inList(u().email, ['ada@example.com', 'cyd@example.com']),
    pred: () => q.inList(u().email, ['ada@example.com', 'cyd@example.com']),
    oracle: `u.email = any(array['ada@example.com','cyd@example.com']::text[])`,
    rows: 2,
  },
  notInList: {
    expr: () => q.notInList(u().email, ['ada@example.com', 'cyd@example.com']),
    pred: () => q.notInList(u().email, ['ada@example.com', 'cyd@example.com']),
    oracle: `u.email <> all(array['ada@example.com','cyd@example.com']::text[])`,
    rows: 4,
  },
  inQuery: {
    expr: () => q.inQuery(u().id, postAuthors()),
    pred: () => q.inQuery(u().id, postAuthors()),
    oracle: `u.id in (select p.author_id from ${fx.ns}.posts p)`,
    rows: 2,
  },
  coalesce: {
    expr: () => q.coalesce(u().deletedAt, new Date('2000-01-01T00:00:00Z')),
    pred: () =>
      q.gt(
        q.coalesce(u().deletedAt, new Date('2000-01-01T00:00:00Z')),
        new Date('2026-01-01T00:00:00Z'),
      ),
    oracle: `coalesce(u.deleted_at, timestamptz '2000-01-01 00:00:00+00') > timestamptz '2026-01-01 00:00:00+00'`,
    rows: 1,
  },
  cast: {
    expr: () => q.cast(u().balance, textCodec),
    pred: () => q.eq(q.cast(u().balance, textCodec), '10.50'),
    oracle: `u.balance::text = '10.50'`,
    rows: 1,
  },
  val: {
    expr: () => q.val('bob@example.com', textCodec),
    pred: () => q.eq(u().email, q.val('bob@example.com', textCodec)),
    oracle: `u.email = 'bob@example.com'::text`,
    rows: 1,
  },

  // ── text ─────────────────────────────────────────────────────────────────
  like: {
    expr: () => q.like(u().name, 'A%'),
    pred: () => q.like(u().name, 'A%'),
    oracle: `u.name like 'A%'`,
    rows: 1,
  },
  ilike: {
    expr: () => q.ilike(u().name, 'a%'),
    pred: () => q.ilike(u().name, 'a%'),
    oracle: `u.name ilike 'a%'`,
    rows: 1,
  },
  notLike: {
    expr: () => q.notLike(u().name, 'A%'),
    pred: () => q.notLike(u().name, 'A%'),
    oracle: `u.name not like 'A%'`,
    rows: 5,
  },
  notILike: {
    expr: () => q.notILike(u().name, 'a%'),
    pred: () => q.notILike(u().name, 'a%'),
    oracle: `u.name not ilike 'a%'`,
    rows: 5,
  },
  startsWith: {
    expr: () => q.startsWith(u().email, 'ada'),
    pred: () => q.startsWith(u().email, 'ada'),
    oracle: `u.email ^@ 'ada'`,
    rows: 1,
  },
  regex: {
    expr: () => q.regex(u().name, '^[A-C]'),
    pred: () => q.regex(u().name, '^[A-C]'),
    oracle: `u.name ~ '^[A-C]'`,
    rows: 3,
  },
  iregex: {
    expr: () => q.iregex(u().name, '^a'),
    pred: () => q.iregex(u().name, '^a'),
    oracle: `u.name ~* '^a'`,
    rows: 1,
  },
  notRegex: {
    expr: () => q.notRegex(u().name, '^[A-C]'),
    pred: () => q.notRegex(u().name, '^[A-C]'),
    oracle: `u.name !~ '^[A-C]'`,
    rows: 3,
  },
  notIRegex: {
    expr: () => q.notIRegex(u().name, '^a'),
    pred: () => q.notIRegex(u().name, '^a'),
    oracle: `u.name !~* '^a'`,
    rows: 5,
  },
  similarTo: {
    expr: () => q.similarTo(u().name, '(Ada|Bob)'),
    pred: () => q.similarTo(u().name, '(Ada|Bob)'),
    oracle: `u.name similar to '(Ada|Bob)'`,
    rows: 2,
  },
  concat: {
    expr: () => q.concat(u().name, '!'),
    pred: () => q.eq(q.concat(u().name, '!'), 'Ada!'),
    oracle: `(u.name || '!') = 'Ada!'`,
    rows: 1,
  },

  // ── array ────────────────────────────────────────────────────────────────
  overlaps: {
    expr: () => q.overlaps(u().tags, ['vip']),
    pred: () => q.overlaps(u().tags, ['vip']),
    oracle: `u.tags && array['vip']::text[]`,
    rows: 3,
  },
  arrayContains: {
    expr: () => q.arrayContains(u().tags, ['vip', 'beta']),
    pred: () => q.arrayContains(u().tags, ['vip', 'beta']),
    oracle: `u.tags @> array['vip','beta']::text[]`,
    rows: 2,
  },
  arrayContainedBy: {
    expr: () => q.arrayContainedBy(u().tags, ['vip', 'beta']),
    pred: () => q.arrayContainedBy(u().tags, ['vip', 'beta']),
    oracle: `u.tags <@ array['vip','beta']::text[]`,
    rows: 6,
  },
  has: {
    expr: () => q.has(u().tags, 'beta'),
    pred: () => q.has(u().tags, 'beta'),
    oracle: `'beta' = any(u.tags)`,
    rows: 3,
  },
  hasAll: {
    expr: () => q.hasAll(u().tags, ['beta']),
    pred: () => q.hasAll(u().tags, ['beta']),
    oracle: `u.tags @> array['beta']::text[]`,
    rows: 3,
  },
  arrayLength: {
    expr: () => q.arrayLength(u().tags),
    pred: () => q.eq(q.arrayLength(u().tags), 2),
    oracle: `array_length(u.tags, 1) = 2`,
    rows: 2,
  },
  arrayConcat: {
    expr: () => q.arrayConcat(u().tags, ['x']),
    pred: () => q.eq(q.arrayLength(q.arrayConcat(u().tags, ['x'])), 3),
    oracle: `array_length(u.tags || array['x']::text[], 1) = 3`,
    rows: 2,
  },
  anyOf: {
    expr: () => q.anyOf(u().tags),
    // `any(x)` is only legal to the right of a comparison, so the codec claim is confirmed
    // against the array's own element instead — hand-written SQL asking the same question.
    selectAs: `(u.tags)[1]`,
    pred: () => q.eq(q.val('vip', textCodec), q.anyOf(u().tags)),
    oracle: `'vip'::text = any(u.tags)`,
    rows: 3,
  },
  allOf: {
    expr: () => q.allOf(u().tags),
    selectAs: `(u.tags)[1]`,
    pred: () => q.neq(q.val('vip', textCodec), q.allOf(u().tags)),
    oracle: `'vip'::text <> all(u.tags)`,
    rows: 3,
  },

  // ── jsonb — every key below is a PARAMETER, several of them adversarial ──
  jsonGet: {
    expr: () => q.jsonGet(u().meta, 'billing'),
    pred: () => q.isNotNull(q.jsonGet(u().meta, 'billing')),
    oracle: `(u.meta -> 'billing') is not null`,
    rows: 1,
  },
  jsonGetText: {
    // a key that IS a PostgreSQL operator. Spliced, it would change the expression's meaning.
    expr: () => q.jsonGetText(u().meta, 'a->b'),
    pred: () => q.eq(q.jsonGetText(u().meta, 'a->b'), '2'),
    oracle: `(u.meta ->> 'a->b') = '2'`,
    rows: 1,
  },
  jsonPath: {
    expr: () => q.jsonPath(u().meta, ['billing', 'country']),
    pred: () => q.isNotNull(q.jsonPath(u().meta, ['billing', 'country'])),
    oracle: `(u.meta #> array['billing','country']) is not null`,
    rows: 1,
  },
  jsonPathText: {
    expr: () => q.jsonPathText(u().meta, ['billing', 'country']),
    pred: () => q.eq(q.jsonPathText(u().meta, ['billing', 'country']), 'DE'),
    oracle: `(u.meta #>> array['billing','country']) = 'DE'`,
    rows: 1,
  },
  jsonContains: {
    expr: () => q.jsonContains(u().meta, { billing: { country: 'DE' } }),
    pred: () => q.jsonContains(u().meta, { billing: { country: 'DE' } }),
    oracle: `u.meta @> '{"billing":{"country":"DE"}}'::jsonb`,
    rows: 1,
  },
  jsonContainedBy: {
    expr: () => q.jsonContainedBy(u().meta, {}),
    pred: () => q.jsonContainedBy(u().meta, {}),
    oracle: `u.meta <@ '{}'::jsonb`,
    rows: 4,
  },
  hasKey: {
    // a key containing a double quote — the array-literal and JSON escaping zoo in one string
    expr: () => q.hasKey(u().meta, 'k"ey'),
    pred: () => q.hasKey(u().meta, 'k"ey'),
    oracle: `u.meta ? 'k"ey'`,
    rows: 1,
  },
  hasAnyKey: {
    expr: () => q.hasAnyKey(u().meta, ['a->b', 'zz']),
    pred: () => q.hasAnyKey(u().meta, ['a->b', 'zz']),
    oracle: `u.meta ?| array['a->b','zz']`,
    rows: 1,
  },
  hasAllKeys: {
    expr: () => q.hasAllKeys(u().meta, ['billing', 'a->b']),
    pred: () => q.hasAllKeys(u().meta, ['billing', 'a->b']),
    oracle: `u.meta ?& array['billing','a->b']`,
    rows: 1,
  },
  jsonPathExists: {
    expr: () => q.jsonPathExists(u().meta, '$.billing.country'),
    pred: () => q.jsonPathExists(u().meta, '$.billing.country'),
    oracle: `u.meta @? '$.billing.country'::jsonpath`,
    rows: 1,
  },
  jsonPathMatch: {
    expr: () => q.jsonPathMatch(u().meta, '$.billing.country == "DE"'),
    pred: () => q.jsonPathMatch(u().meta, '$.billing.country == "DE"'),
    oracle: `u.meta @@ '$.billing.country == "DE"'::jsonpath`,
    rows: 1,
  },
  // `jsonb || jsonb`, `- text` and `#- text[]` raise 22023 on a jsonb SCALAR, and user `eve`
  // holds JSON `null`. Both sides carry the same guard so the differential is still the operator's.
  jsonConcat: {
    expr: () => q.jsonConcat(u().meta, { zz: 1 }),
    pred: () =>
      q.and(q.hasKey(u().meta, 'billing'), q.hasKey(q.jsonConcat(u().meta, { zz: 1 }), 'zz')),
    oracle: `u.meta ? 'billing' and (u.meta || '{"zz":1}'::jsonb) ? 'zz'`,
    rows: 1,
  },
  jsonDelete: {
    expr: () => q.jsonDelete(u().meta, 'billing'),
    pred: () =>
      q.and(
        q.hasKey(u().meta, 'billing'),
        q.not(q.hasKey(q.jsonDelete(u().meta, 'billing'), 'billing')),
      ),
    oracle: `u.meta ? 'billing' and not ((u.meta - 'billing') ? 'billing')`,
    rows: 1,
  },
  jsonDeletePath: {
    expr: () => q.jsonDeletePath(u().meta, ['billing', 'country']),
    pred: () =>
      q.and(
        q.hasKey(u().meta, 'billing'),
        q.isNull(q.jsonPath(q.jsonDeletePath(u().meta, ['billing', 'country']), ['billing', 'country'])),
      ),
    oracle: `u.meta ? 'billing' and ((u.meta #- array['billing','country']) #> array['billing','country']) is null`,
    rows: 1,
  },

  // ── numeric ──────────────────────────────────────────────────────────────
  add: {
    expr: () => q.add(u().balance, '1.00'),
    pred: () => q.eq(q.add(u().balance, '1.00'), '11.50'),
    oracle: `(u.balance + numeric '1.00') = numeric '11.50'`,
    rows: 1,
  },
  sub: {
    expr: () => q.sub(u().balance, '0.50'),
    pred: () => q.eq(q.sub(u().balance, '0.50'), '10.00'),
    oracle: `(u.balance - numeric '0.50') = numeric '10.00'`,
    rows: 1,
  },
  mul: {
    expr: () => q.mul(u().balance, '2'),
    pred: () => q.eq(q.mul(u().balance, '2'), '21.00'),
    oracle: `(u.balance * numeric '2') = numeric '21.00'`,
    rows: 1,
  },
  div: {
    expr: () => q.div(u().balance, '2'),
    pred: () => q.eq(q.div(u().balance, '2'), '5.25'),
    oracle: `(u.balance / numeric '2') = numeric '5.25'`,
    rows: 1,
  },
  mod: {
    expr: () => q.mod(u().id, 2n),
    pred: () => q.eq(q.mod(u().id, 2n), 0n),
    oracle: `(u.id % bigint '2') = 0`,
    rows: 3,
  },
  abs: {
    expr: () => q.abs(u().balance),
    pred: () => q.gt(q.abs(u().balance), '0'),
    oracle: `abs(u.balance) > numeric '0'`,
    rows: 4,
  },

  // ── tsvector ─────────────────────────────────────────────────────────────
  matches: {
    expr: () => q.matches(TSV(), TSQ()),
    pred: () => q.matches(TSV(), TSQ()),
    oracle: `to_tsvector('english', u.name) @@ websearch_to_tsquery('english', 'Ada')`,
    rows: 1,
  },
  tsRank: {
    expr: () => q.tsRank(TSV(), TSQ()),
    pred: () => q.gt(q.tsRank(TSV(), TSQ()), 0.05),
    oracle: `ts_rank(to_tsvector('english', u.name), websearch_to_tsquery('english', 'Ada')) > 0.05`,
    rows: 1,
  },
  tsRankCd: {
    expr: () => q.tsRankCd(TSV(), TSQ()),
    pred: () => q.gt(q.tsRankCd(TSV(), TSQ()), 0),
    oracle: `ts_rank_cd(to_tsvector('english', u.name), websearch_to_tsquery('english', 'Ada')) > 0`,
    rows: 1,
  },

  // ── range: constant operands, so a passing case must return ALL SIX rows ──
  rangeOverlaps: {
    expr: () => q.rangeOverlaps(R(), '[4,9)'),
    pred: () => q.rangeOverlaps(R(), '[4,9)'),
    oracle: `'[1,5)'::int4range && '[4,9)'::int4range`,
    rows: 6,
  },
  rangeContains: {
    expr: () => q.rangeContains(R(), '[2,3)'),
    pred: () => q.rangeContains(R(), '[2,3)'),
    oracle: `'[1,5)'::int4range @> '[2,3)'::int4range`,
    rows: 6,
  },
  rangeContainedBy: {
    expr: () => q.rangeContainedBy(R(), '[0,9)'),
    pred: () => q.rangeContainedBy(R(), '[0,9)'),
    oracle: `'[1,5)'::int4range <@ '[0,9)'::int4range`,
    rows: 6,
  },
  strictlyLeft: {
    expr: () => q.strictlyLeft(R(), '[9,10)'),
    pred: () => q.strictlyLeft(R(), '[9,10)'),
    oracle: `'[1,5)'::int4range << '[9,10)'::int4range`,
    rows: 6,
  },
  strictlyRight: {
    expr: () => q.strictlyRight(q.val('[9,10)', int4rangeCodec), '[1,5)'),
    pred: () => q.strictlyRight(q.val('[9,10)', int4rangeCodec), '[1,5)'),
    oracle: `'[9,10)'::int4range >> '[1,5)'::int4range`,
    rows: 6,
  },
  adjacent: {
    expr: () => q.adjacent(R(), '[5,9)'),
    pred: () => q.adjacent(R(), '[5,9)'),
    oracle: `'[1,5)'::int4range -|- '[5,9)'::int4range`,
    rows: 6,
  },
  rangeUnion: {
    expr: () => q.rangeUnion(R(), '[5,9)'),
    pred: () => q.eq(q.cast(q.rangeUnion(R(), '[5,9)'), textCodec), '[1,9)'),
    oracle: `('[1,5)'::int4range + '[5,9)'::int4range)::text = '[1,9)'`,
    rows: 6,
  },
  rangeIntersection: {
    expr: () => q.rangeIntersection(R(), '[3,9)'),
    pred: () => q.eq(q.cast(q.rangeIntersection(R(), '[3,9)'), textCodec), '[3,5)'),
    oracle: `('[1,5)'::int4range * '[3,9)'::int4range)::text = '[3,5)'`,
    rows: 6,
  },
  rangeLower: {
    expr: () => q.rangeLower(R()),
    pred: () => q.eq(q.rangeLower(R()), 1),
    oracle: `lower('[1,5)'::int4range) = 1`,
    rows: 6,
  },
  rangeUpper: {
    expr: () => q.rangeUpper(R()),
    pred: () => q.eq(q.rangeUpper(R()), 5),
    oracle: `upper('[1,5)'::int4range) = 5`,
    rows: 6,
  },

  // ── net: `<<` and `>>` again, meaning the OPPOSITE of what they mean above ─
  containsNet: {
    expr: () => q.containsNet(NET(), '10.1.2.3'),
    pred: () => q.containsNet(NET(), '10.1.2.3'),
    oracle: `'10.0.0.0/8'::inet >> '10.1.2.3'::inet`,
    rows: 6,
  },
  containedByNet: {
    expr: () => q.containedByNet(q.val('10.1.2.3', inetCodec), '10.0.0.0/8'),
    pred: () => q.containedByNet(q.val('10.1.2.3', inetCodec), '10.0.0.0/8'),
    oracle: `'10.1.2.3'::inet << '10.0.0.0/8'::inet`,
    rows: 6,
  },
  overlapsNet: {
    expr: () => q.overlapsNet(NET(), '10.1.0.0/16'),
    pred: () => q.overlapsNet(NET(), '10.1.0.0/16'),
    oracle: `'10.0.0.0/8'::inet && '10.1.0.0/16'::inet`,
    rows: 6,
  },

  // ── boolean ──────────────────────────────────────────────────────────────
  and: {
    expr: () => q.and(q.eq(u().role, 'member'), q.isNull(u().deletedAt)),
    pred: () => q.and(q.eq(u().role, 'member'), q.isNull(u().deletedAt)),
    oracle: `(u.role = 'member' and u.deleted_at is null)`,
    rows: 4,
  },
  or: {
    expr: () => q.or(q.eq(u().email, 'ada@example.com'), q.eq(u().email, 'bob@example.com')),
    pred: () => q.or(q.eq(u().email, 'ada@example.com'), q.eq(u().email, 'bob@example.com')),
    oracle: `(u.email = 'ada@example.com' or u.email = 'bob@example.com')`,
    rows: 2,
  },
  not: {
    expr: () => q.not(q.isNull(u().deletedAt)),
    pred: () => q.not(q.isNull(u().deletedAt)),
    oracle: `not (u.deleted_at is null)`,
    rows: 1,
  },
  isTrue: {
    expr: () => q.isTrue(BOOL3()),
    pred: () => q.isTrue(BOOL3()),
    oracle: `(${BOOL3_SQL}) is true`,
    rows: 1,
  },
  isNotTrue: {
    expr: () => q.isNotTrue(BOOL3()),
    pred: () => q.isNotTrue(BOOL3()),
    oracle: `(${BOOL3_SQL}) is not true`,
    rows: 5,
  },
  isFalse: {
    expr: () => q.isFalse(BOOL3()),
    pred: () => q.isFalse(BOOL3()),
    oracle: `(${BOOL3_SQL}) is false`,
    rows: 1,
  },
  isNotFalse: {
    expr: () => q.isNotFalse(BOOL3()),
    pred: () => q.isNotFalse(BOOL3()),
    oracle: `(${BOOL3_SQL}) is not false`,
    rows: 5,
  },
  exists: {
    expr: () => q.exists(postsOfUser()),
    pred: () => q.exists(postsOfUser()),
    oracle: `exists (select 1 from ${fx.ns}.posts p where p.author_id = u.id)`,
    rows: 2,
  },
  notExists: {
    expr: () => q.notExists(postsOfUser()),
    pred: () => q.notExists(postsOfUser()),
    oracle: `not exists (select 1 from ${fx.ns}.posts p where p.author_id = u.id)`,
    rows: 4,
  },

  // ── aggregates / full text: confirmed as expressions, exercised as predicates ─
  'fn.count': {
    expr: () => q.fn.count(),
    selectAs: 'count(*)',
    pred: () => q.gt(u().id, 0n),
    oracle: `u.id > 0`,
    rows: 6,
  },
  'fn.sum': {
    expr: () => q.fn.sum(u().balance),
    selectAs: 'sum(u.balance)',
    pred: () => q.gt(u().balance, '0'),
    oracle: `u.balance > numeric '0'`,
    rows: 4,
  },
  'fn.avg': {
    expr: () => q.fn.avg(u().balance),
    selectAs: 'avg(u.balance)',
    pred: () => q.gte(u().balance, '0'),
    oracle: `u.balance >= numeric '0'`,
    rows: 6,
  },
  'fn.min': {
    expr: () => q.fn.min(u().createdAt),
    selectAs: 'min(u.created_at)',
    pred: () => q.isNotNull(u().createdAt),
    oracle: `u.created_at is not null`,
    rows: 6,
  },
  'fn.max': {
    expr: () => q.fn.max(u().createdAt),
    selectAs: 'max(u.created_at)',
    pred: () => q.isNotNull(u().createdAt),
    oracle: `u.created_at is not null`,
    rows: 6,
  },
  'fn.toTsvector': {
    expr: () => q.fn.toTsvector('english', u().name),
    pred: () => q.isNotNull(q.fn.toTsvector('english', u().name)),
    oracle: `to_tsvector('english', u.name) is not null`,
    rows: 6,
  },
  'fn.toTsquery': {
    expr: () => q.fn.toTsquery('english', 'ada'),
    pred: () => q.matches(TSV(), q.fn.toTsquery('english', 'ada')),
    oracle: `to_tsvector('english', u.name) @@ to_tsquery('english', 'ada')`,
    rows: 1,
  },
  'fn.plaintoTsquery': {
    expr: () => q.fn.plaintoTsquery('english', 'ada'),
    pred: () => q.matches(TSV(), q.fn.plaintoTsquery('english', 'ada')),
    oracle: `to_tsvector('english', u.name) @@ plainto_tsquery('english', 'ada')`,
    rows: 1,
  },
  'fn.phrasetoTsquery': {
    expr: () => q.fn.phrasetoTsquery('english', 'ada'),
    pred: () => q.matches(TSV(), q.fn.phrasetoTsquery('english', 'ada')),
    oracle: `to_tsvector('english', u.name) @@ phraseto_tsquery('english', 'ada')`,
    rows: 1,
  },
  'fn.websearchToTsquery': {
    expr: () => q.fn.websearchToTsquery('english', 'ada'),
    pred: () => q.matches(TSV(), q.fn.websearchToTsquery('english', 'ada')),
    oracle: `to_tsvector('english', u.name) @@ websearch_to_tsquery('english', 'ada')`,
    rows: 1,
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Running them
// ─────────────────────────────────────────────────────────────────────────────

function compiled(e: unknown): { sql: string; params: (string | Uint8Array | null)[]; oids: readonly number[] } {
  const out = compileExpr(e as Expr)
  return {
    sql: out.sql,
    params: out.binds.map((b) => (b.k === 'value' ? b.encoded : null)),
    oids: paramTypesOf(out.binds),
  }
}

/** `select <expr>` — the RowDescription is the whole point, so no rows are needed. */
async function resultOid(expr: unknown, selectAs?: string): Promise<number> {
  const c = selectAs
    ? { sql: selectAs, params: [], oids: [] as readonly number[] }
    : compiled(expr)
  const r = await conn.execute({
    text: `select ${c.sql} as v from ${fx.ns}.users as u limit 0`,
    params: c.params,
    paramTypes: c.oids,
  })
  return r.fields[0]!.dataTypeID
}

async function idsWhere(where: string, params: readonly (string | Uint8Array | null)[], oids: readonly number[]): Promise<string[]> {
  const r = await conn.execute({
    text: `select u.id::text from ${fx.ns}.users as u where ${where} order by u.id`,
    params: [...params],
    paramTypes: oids,
  })
  return r.rows.map((row) => String(row[0]))
}

describe('result-codec differential — the server confirms every operator\'s claimed OID', () => {
  for (const spec of CONFIRMABLE) {
    const kase = CASES[spec.name]
    it(`${spec.name} → ${spec.result}`, async () => {
      expect(kase, `no live case for ${spec.name}`).toBeDefined()
      const expr = kase!.expr()
      const claimed = codecOf(expr as Expr)
      // The claim comes off the expression itself — the same codec the decoder will use.
      expect(claimed.oid, `${spec.name}: codec '${claimed.name}' has no OID`).toBeDefined()
      expect(await resultOid(expr, kase!.selectAs)).toBe(claimed.oid)
    })
  }
})

describe('semantic differential — the builder predicate and hand-written SQL agree', () => {
  for (const spec of CONFIRMABLE) {
    const kase = CASES[spec.name]
    it(spec.name, async () => {
      const c = compiled(kase!.pred())
      const mine = await idsWhere(c.sql, c.params, c.oids)
      const theirs = await idsWhere(kase!.oracle, [], [])
      expect(mine).toStrictEqual(theirs)
      // Without this, a case where BOTH sides match nothing would pass and prove nothing.
      expect(mine).toHaveLength(kase!.rows)
    })
  }
})

describe('the manifest is the contract, here too', () => {
  it('every confirmable operator has both differentials', () => {
    const missing = CONFIRMABLE.map((o) => o.name).filter((n) => !(n in CASES))
    expect(missing).toStrictEqual([])
    const extra = Object.keys(CASES).filter((n) => !CONFIRMABLE.some((o) => o.name === n))
    expect(extra).toStrictEqual([])
  })

  it('`fn.rank` claims int8, confirmed against hand-written `rank() over ()`', async () => {
    // Deferred from the loop because `rank()` is only legal inside OVER (…), which the emitter
    // does not build until WS4 — but the CODEC claim is checkable today, and this is how.
    const r = await conn.execute({
      text: `select rank() over () as v from ${fx.ns}.users limit 0`,
      params: [],
    })
    expect(r.fields[0]!.dataTypeID).toBe(int8Codec.oid)
    expect(codecOf(q.fn.rank() as unknown as Expr).oid).toBe(int8Codec.oid)
  })
})

/**
 * The aggregate row of `OPS` is ONE row, and `sum`/`avg` do six different things depending on the
 * operand — which is precisely `03` §2.9's headline claim ("`count()` is `bigint` and
 * `sum(numeric)` is `string` — one exact type, no generic to supply") and precisely what Kysely
 * cannot do (kysely.md §5.2(2)).
 *
 * Found by R10: mutating `SUM_RESULT.int8` from `numeric` to `int8` left the whole suite green,
 * because the single `fn.sum` case above happens to use a `numeric` column. One row per operand
 * type closes that, and it is also where the correction to `03` §2.9's "avg(anything) → numeric"
 * is established — `avg(float8)` is `float8`, and the server says so.
 */
describe('sum / avg / min / max widen exactly as PostgreSQL does, per operand type', () => {
  const SAMPLES: readonly (readonly [AnyCodec, unknown])[] = [
    [int2Codec as AnyCodec, 1],
    [int4Codec as AnyCodec, 1],
    [int8Codec as AnyCodec, 1n],
    [numericCodec as AnyCodec, '1.00'],
    [float4Codec as AnyCodec, 1.5],
    [float8Codec as AnyCodec, 1.5],
  ]
  // One entry per aggregate rather than `fn[agg]`: the four signatures are deliberately
  // different (`sum` widens, `min` does not), so a union of them is not callable — which is the
  // type system telling the truth about the thing this block exists to test.
  const AGGS = {
    sum: (a: unknown) => q.fn.sum(a as never),
    avg: (a: unknown) => q.fn.avg(a as never),
    min: (a: unknown) => q.fn.min(a as never),
    max: (a: unknown) => q.fn.max(a as never),
  }
  for (const [codec, sample] of SAMPLES) {
    for (const [agg, call] of Object.entries(AGGS)) {
      it(`${agg}(${codec.name})`, async () => {
        const e = call(q.val(sample as never, codec))
        const claimed = codecOf(e as unknown as Expr)
        expect(await resultOid(e)).toBe(claimed.oid)
      })
    }
  }

  it('the two rows `03` §2.9 got wrong', async () => {
    // `sum(int8)` is numeric, not int8 — the doc's own example, and true.
    expect(codecOf(q.fn.sum(q.val(1n, int8Codec)) as unknown as Expr).name).toBe('numeric')
    // `avg(float8)` is float8, NOT numeric — the doc said "avg(anything) → numeric".
    expect(codecOf(q.fn.avg(q.val(1.5, float8Codec)) as unknown as Expr).name).toBe('float8')
    expect(await resultOid(q.fn.avg(q.val(1.5, float8Codec)))).toBe(float8Codec.oid)
    expect(await resultOid(q.fn.avg(q.val(1, int4Codec)))).toBe(numericCodec.oid)
  })
})

describe('the cases `03` §2.9 names by hand', () => {
  it('`in([])` is `false` and returns nothing; `in([x])` is one parameter', async () => {
    const empty = compiled(q.inList(u().email, []))
    expect(empty.sql).toBe('false')
    expect(await idsWhere(empty.sql, empty.params, empty.oids)).toStrictEqual([])
    const one = compiled(q.inList(u().email, ['ada@example.com']))
    expect(one.params).toHaveLength(1)
    expect(await idsWhere(one.sql, one.params, one.oids)).toHaveLength(1)
  })

  it('an array operand containing NULL behaves as PostgreSQL says, not as we hope', async () => {
    // `x = any('{a,NULL}')` is NULL, not false, for a non-matching x — so the row is excluded
    // either way and the differential is the only way to know we did not "fix" it.
    const c = compiled(q.inList(u().email, ['ada@example.com', null as never]))
    const mine = await idsWhere(c.sql, c.params, c.oids)
    const theirs = await idsWhere(`u.email = any(array['ada@example.com',null]::text[])`, [], [])
    expect(mine).toStrictEqual(theirs)
    expect(mine).toHaveLength(1)
  })

  it('a NULL operand makes a predicate NULL, and NULL is not true', async () => {
    const c = compiled(q.isDistinctFrom(u().deletedAt, null))
    expect(c.params).toStrictEqual([null])
    // The parameter is still DECLARED with the column's type, so PostgreSQL sees a typed NULL.
    expect(c.oids).toStrictEqual([1184])
    expect(await idsWhere(c.sql, c.params, c.oids)).toHaveLength(1)
  })

  it('the GHSA payloads survive as jsonb KEYS: no error, no match, no SQL', async () => {
    // GHSA-wmrf-hv6w-mr66 / GHSA-pv5w-4p9q-p3v2, verbatim, in the position the CVEs exploited.
    const payloads = [`')-- `, `"].sibling["`, `a->b`, `\\`, `'; drop table ${fx.ns}.users; --`]
    for (const key of payloads) {
      const c = compiled(q.hasKey(u().meta, key))
      expect(c.sql).toBe('"u"."meta" ? $1')
      expect(c.params).toStrictEqual([key])
      // `a->b` IS a key in Ada's document, so it must match exactly one row; the rest match none.
      const ids = await idsWhere(c.sql, c.params, c.oids)
      expect(ids).toHaveLength(key === 'a->b' ? 1 : 0)
    }
    // …and the table is still there.
    const still = await conn.execute({ text: `select count(*) from ${fx.ns}.users`, params: [] })
    expect(String(still.rows[0]![0])).toBe('6')
  })

  it('a jsonb path whose members contain quotes and backslashes is one text[] parameter', async () => {
    const path = [`a"b`, `c\\d`, `e'f`]
    const c = compiled(q.jsonPathText(u().meta, path))
    expect(c.sql).toBe('"u"."meta" #>> $1')
    expect(c.params).toHaveLength(1)
    const mine = await idsWhere(`${c.sql} is null`, c.params, c.oids)
    const theirs = await idsWhere(
      `(u.meta #>> array['a"b','c\\d','e''f']) is null`,
      [],
      [],
    )
    expect(mine).toStrictEqual(theirs)
    expect(mine).toHaveLength(6)
  })

  it('the vocabulary is covered end to end', () => {
    expect(CONFIRMABLE.length).toBe(OPS.length - OPS.filter((o) => o.deferred || o.kind === 'order').length)
    expect(CONFIRMABLE.length).toBeGreaterThan(75)
  })
})
