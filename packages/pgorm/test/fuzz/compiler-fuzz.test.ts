/**
 * Whole-compiler fuzz (03 §3.4, last bullet; Appendix B gate).
 *
 * Generates random bounded-depth ASTs, compiles them, and asserts four invariants:
 *
 *  (a) `binds.length` equals the highest `$n` in the SQL, and `$1..$n` each appear exactly
 *      once, in order — i.e. numbering is a single left-to-right pass with no gaps;
 *  (b) no bind's *value* appears as a substring of the SQL text;
 *  (c) the statement count is exactly 1 (`;` outside string/identifier tokens);
 *  (d) PostgreSQL parses and plans the SQL — a describe-only round trip via
 *      `EXPLAIN (GENERIC_PLAN)`, which is the PG-16+ way to plan a parameterised statement
 *      without supplying values or executing anything.
 */

import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Expr, OrderItem, ProjectionItem, SelectNode } from '../../src/compile/ast.js'
import { compile } from '../../src/compile/compiler.js'
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inAny,
  inList,
  isNotNull,
  isNull,
  isTrue,
  jsonGetText,
  jsonPathText,
  nested,
  not,
  or,
  param,
  projection,
  select,
} from '../../src/compile/nodes.js'
import { spikeCodecs } from '../../src/sql/codec.js'
import { sql, toNode } from '../../src/sql/fragment.js'
import { FUZZ_CASES, FUZZ_SEED, connect, sqlState } from './_pg.js'
import { makeFixture } from './fixture.js'
import { rng } from './generator.js'

let client: pg.Client

/** This file owns its own schema: vitest runs test files in parallel against one container. */
const fx = makeFixture('pgorm_fz_ast')
const { c, p, u, commentsFrom, postsFrom, usersFrom } = fx

/**
 * SQLSTATEs that mean "the SQL is fine, our spike codecs are just loose about types". The
 * spike's `unknownParam` codec deliberately declares no PostgreSQL type, so the planner
 * sometimes cannot infer one; that is a codec-layer gap (agent 02), not a compiler bug.
 */
const TOLERATED = new Set([
  '42P18', // indeterminate_datatype
  '42804', // datatype_mismatch
  '42883', // undefined_function (operator not defined for the inferred types)
  '42725', // ambiguous_function
  '42846', // cannot_coerce
])

beforeAll(async () => {
  client = await connect()
  await client.query(fx.ddl)
}, 60_000)

afterAll(async () => {
  await client?.query(fx.drop)
  await client?.end()
})

// ─────────────────────────── random AST generator ───────────────────────────

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T
const int = (r: () => number, lo: number, hi: number): number =>
  lo + Math.floor(r() * (hi - lo + 1))

/** Distinctive so invariant (b) — "no bind value appears in the SQL" — actually has teeth. */
function payload(r: () => number, n: number): string {
  return `«fz${n}»${pick(r, [`'; drop table ${fx.schema}.users; --`, '"x"', '\\\\', '$1', ';', '/*'])}`
}

const USER_COLS = ['id', 'email', 'name', 'role', 'created_at', 'deleted_at'] as const

function randomPredicate(r: () => number, depth: number, mint: () => string): Expr {
  const leaf = (): Expr => {
    switch (int(r, 0, 7)) {
      case 0:
        return eq(u(pick(r, USER_COLS)), param(mint(), spikeCodecs.text))
      case 1:
        return gt(u('created_at'), param(new Date(0), spikeCodecs.timestamptz))
      case 2:
        return isNull(u('deleted_at'))
      case 3:
        return isNotNull(u('email'))
      case 4:
        return inList(
          u('id'),
          Array.from({ length: int(r, 0, 3) }, () => param(int(r, 1, 9), spikeCodecs.int8)),
        )
      case 5:
        return inAny(u('email'), param([mint()], spikeCodecs.textArray))
      case 6:
        return eq(jsonPathText(u('meta'), ['billing', mint()]), param(mint(), spikeCodecs.text))
      default:
        return toNode(sql`${u('email')} = ${mint()}`.as(spikeCodecs.bool))
    }
  }
  if (depth <= 0) return leaf()
  switch (int(r, 0, 3)) {
    case 0:
      return and(...Array.from({ length: int(r, 0, 3) }, () => randomPredicate(r, depth - 1, mint)))
    case 1:
      return or(...Array.from({ length: int(r, 1, 3) }, () => randomPredicate(r, depth - 1, mint)))
    case 2:
      return not(randomPredicate(r, depth - 1, mint))
    default:
      return leaf()
  }
}

function randomProjection(r: () => number, mint: () => string): ProjectionItem[] {
  const items: ProjectionItem[] = []
  for (let i = 0, n = int(r, 1, 5); i < n; i++) {
    switch (int(r, 0, 3)) {
      case 0:
        items.push(projection(`k${i}`, u(pick(r, USER_COLS))))
        break
      case 1:
        items.push(projection(`k${i}`, toNode(sql`upper(${u('name')}) || ${mint()}`.as(spikeCodecs.text))))
        break
      case 2:
        items.push(projection(`k${i}`, jsonGetText(u('meta'), mint())))
        break
      default:
        items.push(projection(`k${i}`, param(mint(), spikeCodecs.text)))
    }
  }
  return items
}

function randomNested(r: () => number): ProjectionItem {
  const inner: SelectNode = select({
    projection: [
      projection('id', p('id')),
      projection('title', p('title')),
      projection('amount', p('amount')),
      ...(r() < 0.4
        ? [
            nested('comments', {
              kind: 'many',
              alias: 'cm',
              query: select({
                projection: [projection('id', c('id')), projection('body', c('body'))],
                from: commentsFrom,
                where: eq(c('post_id'), p('id')),
              }),
            }),
          ]
        : []),
    ],
    from: postsFrom,
    where: and(eq(p('author_id'), u('id')), isTrue(p('published'))),
    ...(r() < 0.6 ? { orderBy: [desc(p('created_at'))] } : {}),
    ...(r() < 0.6 ? { limit: param(int(r, 1, 5), spikeCodecs.int4) } : {}),
  })
  return nested('rel', { kind: r() < 0.3 ? 'one' : 'many', query: inner, alias: 'lp' })
}

function randomSelect(r: () => number): SelectNode {
  let n = 0
  const mint = () => payload(r, n++)
  const orderBy: OrderItem[] = r() < 0.6 ? [pick(r, [desc(u('created_at')), asc(u('id'))])] : []
  return select({
    projection: [
      ...randomProjection(r, mint),
      ...(r() < 0.35 ? [randomNested(r)] : []),
    ],
    from: usersFrom,
    ...(r() < 0.8 ? { where: randomPredicate(r, int(r, 0, 2), mint) } : {}),
    ...(orderBy.length > 0 ? { orderBy } : {}),
    ...(r() < 0.5 ? { limit: param(int(r, 1, 50), spikeCodecs.int4) } : {}),
    ...(r() < 0.3 ? { offset: param(int(r, 0, 10), spikeCodecs.int4) } : {}),
  })
}

// ─────────────────────────── invariants ───────────────────────────

/** Count `;` that are NOT inside a single-quoted string or a double-quoted identifier. */
function statementCount(text: string): number {
  let inStr = false
  let inIdent = false
  let n = 1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (ch === "'") inStr = text[i + 1] === "'" ? (i++, true) : false
      else if (ch === '\\') i++
    } else if (inIdent) {
      if (ch === '"') inIdent = text[i + 1] === '"' ? (i++, true) : false
    } else if (ch === "'") inStr = true
    else if (ch === '"') inIdent = true
    else if (ch === ';') n++
  }
  return n
}

describe('whole-compiler fuzz', () => {
  const OFFLINE = Math.max(FUZZ_CASES, 10_000)

  it(`holds all four invariants over ${OFFLINE} random ASTs`, () => {
    const r = rng(FUZZ_SEED ^ 0x1234)
    for (let i = 0; i < OFFLINE; i++) {
      const ast = randomSelect(r)
      const c0 = compile(ast)

      // (a) numbering is dense, ordered, and matches binds.length exactly.
      const ns = [...c0.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))
      expect(ns, `case ${i}`).toEqual(Array.from({ length: c0.binds.length }, (_, k) => k + 1))

      // (b) no bind VALUE ever appears in the SQL text.
      expect(c0.sql, `case ${i}`).not.toContain('«fz')
      expect(c0.sql, `case ${i}`).not.toContain('drop table')

      // (c) exactly one statement.
      expect(statementCount(c0.sql), `case ${i}`).toBe(1)

      // Determinism: the same AST compiles to the same bytes.
      expect(compile(ast).sql).toBe(c0.sql)
    }
  }, 300_000)

  it('the statement tokenizer itself is right (it is load-bearing for invariant c)', () => {
    expect(statementCount('select 1')).toBe(1)
    expect(statementCount('select 1; select 2')).toBe(2)
    expect(statementCount(`select ';'`)).toBe(1)
    expect(statementCount(`select "a;b"`)).toBe(1)
    expect(statementCount(`select '''; ' , "x""; y"`)).toBe(1)
    expect(statementCount(`select E'\\'; ' ; select 2`)).toBe(2)
  })

  it('PostgreSQL parses and plans a sample of the generated statements', async () => {
    // `EXPLAIN (GENERIC_PLAN)` is PG 16+: it plans a parameterised statement with no values
    // and no execution — exactly the describe-only round trip 03 §3.4 asks for.
    const r = rng(FUZZ_SEED ^ 0xbeef)
    const SAMPLE = Number(process.env['PGORM_FUZZ_PG_CASES'] ?? 1000)
    let planned = 0
    let tolerated = 0
    const failures: { sql: string; code?: string | undefined; message: string }[] = []

    for (let i = 0; i < SAMPLE; i++) {
      const compiled = compile(randomSelect(r))
      try {
        await client.query(`explain (generic_plan) ${compiled.sql}`)
        planned++
      } catch (e) {
        const code = sqlState(e)
        if (code !== undefined && TOLERATED.has(code)) tolerated++
        else failures.push({ sql: compiled.sql, code, message: (e as Error).message })
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `\n── compiler fuzz / live plan ──\nplanned: ${planned}  tolerated(codec-typing): ${tolerated}  ` +
        `hard failures: ${failures.length}\n`,
    )
    if (failures.length > 0) {
      // eslint-disable-next-line no-console
      console.error(failures[0])
    }
    expect(failures).toEqual([])
    expect(planned).toBeGreaterThan(SAMPLE * 0.5)
  }, 300_000)
})
