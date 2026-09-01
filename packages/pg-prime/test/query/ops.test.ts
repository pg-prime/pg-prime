/**
 * The operator vocabulary, tier 0 — **one byte-exact golden per operator** (design/09 WS3, R2).
 *
 * The table is driven by `OPS` (`src/query/ops.manifest.ts`), and `the manifest is the contract`
 * below asserts the two agree exactly. So an operator added without a golden fails, and a golden
 * written for an operator that is not in the manifest fails — the R5-golden "covers every codec"
 * pattern, applied to the operator surface.
 *
 * What a golden pins, and why each half matters:
 *
 *  - **the SQL**, because operator *tokens* are the one thing no type can check: `?|` vs `?&`,
 *    `<<` vs `>>`, `@>` vs `<@`. A transposition here is a silently wrong query, not an error.
 *  - **the binds**, because `$1` in the right place with the wrong encoding is the more dangerous
 *    bug. Every jsonb key, path and pattern below appears in `binds`, never in `sql` — the
 *    GHSA-wmrf-hv6w-mr66 class made structurally impossible (03 §3.4, D7).
 *
 * Everything goes through the public surface (R11): real `pgTable` columns via `refsOf`, real
 * `sql` fragments, real codecs, no hand-built AST except the one sub-select the two subquery
 * operators need.
 */

import { describe, expect, it } from 'vitest'
import {
  bitCodec,
  inetCodec,
  jsonCodecJson,
  textCodec,
  tsqueryCodec,
  tstzrangeCodec,
  tsvectorCodec,
  vectorCodec,
} from '../../src/codec/index.js'
import type { Expr } from '../../src/compile/ast.js'
import { compileExpr } from '../../src/compile/compiler.js'
import type { Bind } from '../../src/compile/contract.js'
import { col, projection, select } from '../../src/compile/nodes.js'
import { OPS } from '../../src/query/ops.manifest.js'
import { RANGE_ELEMENT_NAMES } from '../../src/query/ops.js'
import { refsOf } from '../../src/query/ref.js'
import * as q from '../../src/query/types.js'
import { pgTable } from '../../src/schema/index.js'
import { NullOperandError } from '../../src/sql/errors.js'
import { toNode } from '../../src/sql/fragment.js'

// ─────────────────────────────────────────────────────────────────────────────
// One table with one column per type class the vocabulary gates on.
// ─────────────────────────────────────────────────────────────────────────────

const t = pgTable('t', (c) => ({
  id: c.bigint().primaryKey(),
  name: c.text(),
  n: c.integer(),
  amount: c.numeric(),
  meta: c.jsonb(),
  tags: c.text().array(),
  at: c.timestamptz(),
  ok: c.boolean().nullable(),
}))

const u = refsOf(t, 'u')
const sql = q.sql

/**
 * Operands the column DSL cannot declare yet — and does not need to, because `.as(codec)` now
 * carries a type class (WS3). This is the closed `09` §3.0 hole doing real work: without it,
 * `tsvector`, `range` and `net` would have no testable operand at all until WS5 grows the DSL.
 */
const tsv = sql`to_tsvector('english', ${u.name})`.as(tsvectorCodec)
const tsq = sql`websearch_to_tsquery('english', ${'x'})`.as(tsqueryCodec)
const rng = sql`${u.at}`.as(tstzrangeCodec)
const net = sql`${u.name}`.as(inetCodec)
const js = sql`${u.meta}`.as(jsonCodecJson)
/**
 * `vector` and `bit` operands, the same way — and here `.as(codec)` earns its keep twice over.
 * `t.vector(3)` exists now, but a `vector` COLUMN in this fixture would make all ninety-five
 * unrelated goldens depend on an extension type; a fragment keeps the blast radius at six rows.
 * Both literals are static template text with no interpolation, so nothing is spliced.
 */
const vec = sql`'[1,2,3]'::vector`.as(vectorCodec)
const bits = sql`'101'::bit(3)`.as(bitCodec)

function render(e: unknown): { sql: string; binds: unknown[] } {
  const out = compileExpr(e as Expr)
  return { sql: out.sql, binds: out.binds.map(encoded) }
}
function encoded(b: Bind): unknown {
  return b.k === 'value' ? b.encoded : `<slot:${b.name}>`
}

/** A tiny sub-select, for the three operators that take one. */
const sub = select({ projection: [projection('id', col('u', 'id', textCodec))] })
const SUB_SQL = 'select "u"."id" as "id"'

// ─────────────────────────────────────────────────────────────────────────────
// The goldens
// ─────────────────────────────────────────────────────────────────────────────

interface Case {
  readonly build: () => unknown
  readonly sql: string
  readonly binds: readonly unknown[]
}
const c = (build: () => unknown, sql: string, binds: readonly unknown[] = []): Case => ({
  build,
  sql,
  binds,
})

const CASES: Readonly<Record<string, Case>> = {
  // ── every class ──────────────────────────────────────────────────────────
  eq: c(() => q.eq(u.name, 'a'), '"u"."name" = $1', ['a']),
  neq: c(() => q.neq(u.name, 'a'), '"u"."name" <> $1', ['a']),
  lt: c(() => q.lt(u.n, 1), '"u"."n" < $1', ['1']),
  lte: c(() => q.lte(u.n, 1), '"u"."n" <= $1', ['1']),
  gt: c(() => q.gt(u.id, 1n), '"u"."id" > $1', ['1']),
  gte: c(() => q.gte(u.id, 1n), '"u"."id" >= $1', ['1']),
  isNull: c(() => q.isNull(u.name), '"u"."name" is null'),
  isNotNull: c(() => q.isNotNull(u.name), '"u"."name" is not null'),
  isDistinctFrom: c(() => q.isDistinctFrom(u.name, null), '"u"."name" is distinct from $1', [null]),
  isNotDistinctFrom: c(
    () => q.isNotDistinctFrom(u.name, 'a'),
    '"u"."name" is not distinct from $1',
    ['a'],
  ),
  between: c(() => q.between(u.n, 1, 9), '"u"."n" between $1 and $2', ['1', '9']),
  // ONE parameter whatever the list length, so a hundred list sizes share one plan (03 §2.6)
  inList: c(() => q.inList(u.name, ['a', 'b']), '"u"."name" = any($1)', ['{a,b}']),
  notInList: c(() => q.notInList(u.name, ['a']), '"u"."name" <> all($1)', ['{a}']),
  inQuery: c(() => q.inQuery(u.id, sub), `"u"."id" in (\n  ${SUB_SQL}\n)`),
  coalesce: c(() => q.coalesce(u.name, 'x'), 'coalesce("u"."name", $1)', ['x']),
  cast: c(() => q.cast(u.id, textCodec), '"u"."id"::text'),
  val: c(() => q.val('x', textCodec), '$1', ['x']),

  // ── text ─────────────────────────────────────────────────────────────────
  like: c(() => q.like(u.name, 'a%'), '"u"."name" like $1', ['a%']),
  ilike: c(() => q.ilike(u.name, 'a%'), '"u"."name" ilike $1', ['a%']),
  notLike: c(() => q.notLike(u.name, 'a%'), '"u"."name" not like $1', ['a%']),
  notILike: c(() => q.notILike(u.name, 'a%'), '"u"."name" not ilike $1', ['a%']),
  startsWith: c(() => q.startsWith(u.name, 'a'), '"u"."name" ^@ $1', ['a']),
  regex: c(() => q.regex(u.name, '^a'), '"u"."name" ~ $1', ['^a']),
  iregex: c(() => q.iregex(u.name, '^a'), '"u"."name" ~* $1', ['^a']),
  notRegex: c(() => q.notRegex(u.name, '^a'), '"u"."name" !~ $1', ['^a']),
  notIRegex: c(() => q.notIRegex(u.name, '^a'), '"u"."name" !~* $1', ['^a']),
  similarTo: c(() => q.similarTo(u.name, 'a%'), '"u"."name" similar to $1', ['a%']),
  concat: c(() => q.concat(u.name, '!'), '"u"."name" || $1', ['!']),

  // ── array ────────────────────────────────────────────────────────────────
  overlaps: c(() => q.overlaps(u.tags, ['vip']), '"u"."tags" && $1', ['{vip}']),
  arrayContains: c(() => q.arrayContains(u.tags, ['vip']), '"u"."tags" @> $1', ['{vip}']),
  arrayContainedBy: c(() => q.arrayContainedBy(u.tags, ['vip']), '"u"."tags" <@ $1', ['{vip}']),
  // the scalar is encoded with the array's ELEMENT codec, not the array's
  has: c(() => q.has(u.tags, 'vip'), '$1 = any("u"."tags")', ['vip']),
  hasAll: c(() => q.hasAll(u.tags, ['a', 'b']), '"u"."tags" @> $1', ['{a,b}']),
  arrayLength: c(() => q.arrayLength(u.tags), 'array_length("u"."tags", 1)'),
  arrayConcat: c(() => q.arrayConcat(u.tags, ['x']), '"u"."tags" || $1', ['{x}']),
  anyOf: c(() => q.anyOf(u.tags), 'any("u"."tags")'),
  allOf: c(() => q.allOf(u.tags), 'all("u"."tags")'),

  // ── jsonb — every key and path is a PARAMETER ────────────────────────────
  jsonGet: c(() => q.jsonGet(u.meta, 'a'), '"u"."meta" -> $1', ['a']),
  jsonGetText: c(() => q.jsonGetText(u.meta, 'a'), '"u"."meta" ->> $1', ['a']),
  jsonPath: c(() => q.jsonPath(u.meta, ['a', 'b']), '"u"."meta" #> $1', ['{a,b}']),
  jsonPathText: c(() => q.jsonPathText(u.meta, ['a', 'b']), '"u"."meta" #>> $1', ['{a,b}']),
  jsonContains: c(() => q.jsonContains(u.meta, { a: 1 }), '"u"."meta" @> $1', ['{"a":1}']),
  jsonContainedBy: c(() => q.jsonContainedBy(u.meta, { a: 1 }), '"u"."meta" <@ $1', ['{"a":1}']),
  hasKey: c(() => q.hasKey(u.meta, 'a'), '"u"."meta" ? $1', ['a']),
  hasAnyKey: c(() => q.hasAnyKey(u.meta, ['a', 'b']), '"u"."meta" ?| $1', ['{a,b}']),
  hasAllKeys: c(() => q.hasAllKeys(u.meta, ['a', 'b']), '"u"."meta" ?& $1', ['{a,b}']),
  jsonPathExists: c(() => q.jsonPathExists(u.meta, '$.a'), '"u"."meta" @? $1', ['$.a']),
  jsonPathMatch: c(() => q.jsonPathMatch(u.meta, '$.a > 1'), '"u"."meta" @@ $1', ['$.a > 1']),
  jsonConcat: c(() => q.jsonConcat(u.meta, { b: 2 }), '"u"."meta" || $1', ['{"b":2}']),
  jsonDelete: c(() => q.jsonDelete(u.meta, 'a'), '"u"."meta" - $1', ['a']),
  jsonDeletePath: c(() => q.jsonDeletePath(u.meta, ['a', 'b']), '"u"."meta" #- $1', ['{a,b}']),

  // ── numeric ──────────────────────────────────────────────────────────────
  add: c(() => q.add(u.n, 1), '"u"."n" + $1', ['1']),
  sub: c(() => q.sub(u.n, 1), '"u"."n" - $1', ['1']),
  mul: c(() => q.mul(u.n, 2), '"u"."n" * $1', ['2']),
  div: c(() => q.div(u.n, 2), '"u"."n" / $1', ['2']),
  mod: c(() => q.mod(u.n, 2), '"u"."n" % $1', ['2']),
  abs: c(() => q.abs(u.amount), 'abs("u"."amount")'),

  // ── tsvector ─────────────────────────────────────────────────────────────
  matches: c(
    () => q.matches(tsv, tsq),
    `(to_tsvector('english', "u"."name")) @@ (websearch_to_tsquery('english', $1))`,
    ['x'],
  ),
  tsRank: c(
    () => q.tsRank(tsv, tsq),
    `ts_rank(to_tsvector('english', "u"."name"), websearch_to_tsquery('english', $1))`,
    ['x'],
  ),
  tsRankCd: c(
    () => q.tsRankCd(tsv, tsq),
    `ts_rank_cd(to_tsvector('english', "u"."name"), websearch_to_tsquery('english', $1))`,
    ['x'],
  ),

  // ── range ────────────────────────────────────────────────────────────────
  rangeOverlaps: c(() => q.rangeOverlaps(rng, '[a,b)'), '("u"."at") && $1', ['[a,b)']),
  rangeContains: c(() => q.rangeContains(rng, 'x'), '("u"."at") @> $1', ['x']),
  rangeContainedBy: c(() => q.rangeContainedBy(rng, 'x'), '("u"."at") <@ $1', ['x']),
  strictlyLeft: c(() => q.strictlyLeft(rng, 'x'), '("u"."at") << $1', ['x']),
  strictlyRight: c(() => q.strictlyRight(rng, 'x'), '("u"."at") >> $1', ['x']),
  adjacent: c(() => q.adjacent(rng, 'x'), '("u"."at") -|- $1', ['x']),
  rangeUnion: c(() => q.rangeUnion(rng, 'x'), '("u"."at") + $1', ['x']),
  rangeIntersection: c(() => q.rangeIntersection(rng, 'x'), '("u"."at") * $1', ['x']),
  // NOT parenthesised: a comma-separated function-argument list already delimits an opaque
  // fragment, so the emitter's `isOpaque` guard does not apply inside `fn(...)`.
  rangeLower: c(() => q.rangeLower(rng), 'lower("u"."at")'),
  rangeUpper: c(() => q.rangeUpper(rng), 'upper("u"."at")'),

  // ── net: THE SAME TOKENS as range, read the other way round ──────────────
  containsNet: c(() => q.containsNet(net, '10.0.0.0/8'), '("u"."name") >> $1', ['10.0.0.0/8']),
  containedByNet: c(() => q.containedByNet(net, '10.0.0.0/8'), '("u"."name") << $1', [
    '10.0.0.0/8',
  ]),
  overlapsNet: c(() => q.overlapsNet(net, '10.0.0.0/8'), '("u"."name") && $1', ['10.0.0.0/8']),

  // ── vector (pgvector) ────────────────────────────────────────────────────
  // Four take a `vector`; `hamming` and `jaccard` take a `bit`, which is what pgvector 0.8.6
  // declares in `pg_operator`. The BINDS are the half a token-only golden would miss: `[3,2,1]`
  // is pgvector's bracket form, which is neither a PostgreSQL array literal nor JSON.
  l2: c(() => q.l2(vec, [3, 2, 1]), `('[1,2,3]'::vector) <-> $1`, ['[3,2,1]']),
  cosine: c(() => q.cosine(vec, [3, 2, 1]), `('[1,2,3]'::vector) <=> $1`, ['[3,2,1]']),
  innerProduct: c(() => q.innerProduct(vec, [3, 2, 1]), `('[1,2,3]'::vector) <#> $1`, ['[3,2,1]']),
  l1: c(() => q.l1(vec, [3, 2, 1]), `('[1,2,3]'::vector) <+> $1`, ['[3,2,1]']),
  hamming: c(() => q.hamming(bits, '110'), `('101'::bit(3)) <~> $1`, ['110']),
  jaccard: c(() => q.jaccard(bits, '110'), `('101'::bit(3)) <%> $1`, ['110']),

  // ── boolean / ordering ───────────────────────────────────────────────────
  and: c(() => q.and(q.eq(u.name, 'a'), q.isNull(u.at)), '("u"."name" = $1 and "u"."at" is null)', [
    'a',
  ]),
  or: c(() => q.or(q.eq(u.name, 'a'), q.isNull(u.at)), '("u"."name" = $1 or "u"."at" is null)', [
    'a',
  ]),
  not: c(() => q.not(q.isNull(u.at)), 'not ("u"."at" is null)'),
  isTrue: c(() => q.isTrue(u.ok), '"u"."ok" is true'),
  isNotTrue: c(() => q.isNotTrue(u.ok), '"u"."ok" is not true'),
  isFalse: c(() => q.isFalse(u.ok), '"u"."ok" is false'),
  isNotFalse: c(() => q.isNotFalse(u.ok), '"u"."ok" is not false'),
  exists: c(() => q.exists(sub), `exists (\n  ${SUB_SQL}\n)`),
  notExists: c(() => q.notExists(sub), `not exists (\n  ${SUB_SQL}\n)`),
  asc: c(() => q.asc(u.name), 'asc:name'),
  desc: c(() => q.desc(u.name, 'last'), 'desc:name:last'),

  // ── aggregates / full text ───────────────────────────────────────────────
  'fn.count': c(() => q.fn.count(), 'count(*)'),
  'fn.sum': c(() => q.fn.sum(u.n), 'sum("u"."n")'),
  'fn.avg': c(() => q.fn.avg(u.n), 'avg("u"."n")'),
  'fn.min': c(() => q.fn.min(u.at), 'min("u"."at")'),
  'fn.max': c(() => q.fn.max(u.at), 'max("u"."at")'),
  'fn.rank': c(() => q.fn.rank(), 'rank()'),
  // the configuration is a PARAMETER cast to regconfig, never spliced text
  'fn.toTsvector': c(
    () => q.fn.toTsvector('english', u.name),
    'to_tsvector($1::regconfig, "u"."name")',
    ['english'],
  ),
  'fn.toTsquery': c(() => q.fn.toTsquery('english', 'a'), 'to_tsquery($1::regconfig, $2)', [
    'english',
    'a',
  ]),
  'fn.plaintoTsquery': c(
    () => q.fn.plaintoTsquery('english', 'a'),
    'plainto_tsquery($1::regconfig, $2)',
    ['english', 'a'],
  ),
  'fn.phrasetoTsquery': c(
    () => q.fn.phrasetoTsquery('english', 'a'),
    'phraseto_tsquery($1::regconfig, $2)',
    ['english', 'a'],
  ),
  'fn.websearchToTsquery': c(
    () => q.fn.websearchToTsquery('english', 'a'),
    'websearch_to_tsquery($1::regconfig, $2)',
    ['english', 'a'],
  ),
}

describe('every operator emits exactly this SQL and exactly these binds', () => {
  for (const [name, spec] of Object.entries(CASES)) {
    it(name, () => {
      const built = spec.build()
      if (name === 'asc' || name === 'desc') {
        // An ORDER BY item, not an expression: pinned by shape rather than by compiled SQL.
        const o = built as { e: { qn: string }; dir: string; nulls?: string }
        const shape = `${o.dir}:${o.e.qn.replaceAll('"', '')}${o.nulls ? `:${o.nulls}` : ''}`
        expect(shape).toBe(spec.sql)
        return
      }
      const out = render(built)
      expect(out.sql).toBe(spec.sql)
      expect(out.binds).toStrictEqual(spec.binds)
    })
  }
})

describe('the manifest is the contract', () => {
  it('every OPS row has a golden, and every golden has an OPS row (the CI gate)', () => {
    const manifest = OPS.map((o) => o.name)
    const golden = Object.keys(CASES)
    expect([...manifest].sort()).toStrictEqual([...golden].sort())
  })

  it('the six vector rows are confirmable, not deferred (design/14 V)', () => {
    // They were the WS5 deferral until `definePgType()` gave `vector` a codec and a pgvector
    // container gave the differential a target. `deferred` back on any of them would mean the
    // live suite had silently stopped running them — which is what this row exists to catch.
    const vector = OPS.filter((o) => o.class === 'vector')
    expect(vector.length).toBe(6)
    for (const o of vector) expect(o.deferred).toBeUndefined()
    expect(OPS.filter((o) => o.deferred !== undefined).map((o) => o.name)).toStrictEqual([
      'fn.rank',
    ])
  })

  it("the runtime range→subtype table is `ops.types.ts`'s `RangeElemPg`, spelled once", () => {
    expect(RANGE_ELEMENT_NAMES).toStrictEqual({
      int4range: 'int4',
      int8range: 'int8',
      numrange: 'numeric',
      tsrange: 'timestamp',
      tstzrange: 'timestamptz',
      daterange: 'date',
    })
  })
})

describe('properties', () => {
  it('an operator never mutates its operands (03 §1.3)', () => {
    const before = JSON.stringify(u.name)
    q.eq(u.name, 'a')
    q.ilike(u.name, 'a%')
    q.inList(u.name, ['a', 'b'])
    expect(JSON.stringify(u.name)).toBe(before)
    expect(Object.isFrozen(u.name)).toBe(true)
  })

  it('refs are cached per (table, alias) and identical per key', () => {
    expect(refsOf(t, 'u')).toBe(u)
    expect(refsOf(t, 'u').name).toBe(u.name)
    expect(refsOf(t, 'v')).not.toBe(u)
    expect(refsOf(t).name).not.toBe(u.name)
  })

  it('a ref is an AST node, so a template hole splices it instead of binding it', () => {
    const out = render(toNode(q.sql`lower(${u.name})`.as(textCodec)))
    expect(out.sql).toBe('lower("u"."name")')
    expect(out.binds).toStrictEqual([])
  })

  it('`inList([])` is the constant false, and `notInList([])` the constant true', () => {
    expect(render(q.inList(u.name, []))).toStrictEqual({ sql: 'false', binds: [] })
    expect(render(q.notInList(u.name, []))).toStrictEqual({ sql: 'true', binds: [] })
  })

  it('`eq(a, null)` throws rather than compiling to `a = NULL`', () => {
    expect(() => q.eq(u.name, null as never)).toThrow(NullOperandError)
    expect(() => q.neq(u.name, null as never)).toThrow(NullOperandError)
    try {
      q.eq(u.name, null as never)
    } catch (e) {
      expect((e as NullOperandError).code).toBe('NULL_OPERAND')
      expect((e as Error).message).toContain('isNull(a)')
    }
  })

  it('a jsonb key that looks like an operator, a quote or a comment is still just a bind', () => {
    // The GHSA-wmrf-hv6w-mr66 / GHSA-pv5w-4p9q-p3v2 payload shapes, used as KEYS.
    const payloads = [`')-- `, `"].sibling["`, `a->b`, `\\`, `'; drop table t; --`]
    for (const p of payloads) {
      expect(render(q.jsonGetText(u.meta, p))).toStrictEqual({
        sql: '"u"."meta" ->> $1',
        binds: [p],
      })
    }
    const path = render(q.jsonPathText(u.meta, payloads))
    expect(path.sql).toBe('"u"."meta" #>> $1')
    expect(path.binds).toHaveLength(1)
  })

  it('a numeric key picks the `jsonb -> integer` overload, not `-> text`', () => {
    // `textCodec.encode(0)` throws outright; sending the key untyped would silently select the
    // TEXT overload and return null for every array element.
    const out = compileExpr(q.jsonGet(u.meta, 0) as unknown as Expr)
    expect(out.sql).toBe('"u"."meta" -> $1')
    expect(out.binds[0]).toStrictEqual({ k: 'value', encoded: '0', oid: 23 })
  })

  it('a `json` accessor keeps the json result codec; a `jsonb` one keeps jsonb', () => {
    expect(codecName(q.jsonGet(js, 'a'))).toBe('json')
    expect(codecName(q.jsonGet(u.meta, 'a'))).toBe('jsonb')
  })

  it('`sum` and `avg` widen exactly as PostgreSQL does', () => {
    expect(codecName(q.fn.sum(u.n))).toBe('int8') // int4 → int8
    expect(codecName(q.fn.sum(u.id))).toBe('numeric') // int8 → numeric
    expect(codecName(q.fn.sum(u.amount))).toBe('numeric')
    expect(codecName(q.fn.avg(u.n))).toBe('numeric')
    expect(codecName(q.fn.min(u.at))).toBe('timestamptz')
  })
})

function codecName(e: unknown): string {
  return (e as { resultCodec: { name: string } }).resultCodec.name
}
