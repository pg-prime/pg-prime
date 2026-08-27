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
 *      without supplying values or executing anything;
 *  (e) PostgreSQL accepts the statement WITH the parameter types the codecs declare, and runs it.
 *
 * WS3 note: half the predicate leaves are now built through the **operator surface**
 * (`src/query/ops.ts`) rather than through `nodes.ts`, so the layer users type is under the same
 * five invariants as the layer it builds on. See `opLeaf`.
 *
 * (e) is the WS2 addition and it is the one that puts the codec seam under test. `GENERIC_PLAN`
 * plans `$n` as untyped no matter what we would have sent, so it can never disagree with a codec;
 * (e) sends `paramTypesOf(compiled.binds)` in `Parse` and executes, which is exactly what
 * `execute()` will do. A codec whose `paramOid` does not fit the operator it is used with fails
 * here, with a SQLSTATE.
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
import { arrayCodecOf, boolCodec, int4Codec, int8Codec, textCodec, timestamptzCodec } from '../../src/codec/index.js'
import { sql, toNode } from '../../src/sql/fragment.js'
import * as ops from '../../src/query/types.js'
import { connect, makeHarness, planProbe, sqlState, type Harness } from '../live/_harness.js'
import type { PgConnection } from '../../src/driver/index.js'
import { paramTypesOf } from '../../src/compile/contract.js'
import { FUZZ_CASES, FUZZ_SEED } from './_budget.js'
import { makeFixture } from './fixture.js'
import { rng } from './generator.js'

/** `text[]` — the codec the spike called `textArray`. */
const textArrayCodec = arrayCodecOf(textCodec)

let client: pg.Client
let h: Harness
/** The adapter connection, because only it can send `paramTypes` in `Parse` (invariant (e)). */
let conn: PgConnection

/** This file owns its own schema: vitest runs test files in parallel against one container. */
const fx = makeFixture('pgprime_fz_ast')
const { c, p, u, ur, commentsFrom, postsFrom, usersFrom } = fx

/**
 * **Empty, deliberately** (design/09 WS2 exit).
 *
 * It used to hold `42P18` / `42804` / `42883` / `42725` / `42846` — "the SQL is fine, the spike
 * codecs are just loose about types". Two things were measured while joining the codec seam:
 *
 *  1. Under the `EXPLAIN (GENERIC_PLAN)` oracle the set NEVER fired, before or after the swap.
 *     GENERIC_PLAN plans `$n` as untyped regardless of what we would have declared, so that
 *     oracle cannot produce a type error and the tolerance was dead code pretending to be a
 *     known gap.
 *  2. Under the new (e) oracle — Parse with `paramTypesOf(binds)`, then execute — the codecs ARE
 *     under test, and every generated statement still passes. So there is nothing left to tolerate.
 *
 * Anything non-empty here again must name the SQLSTATE, the generator shape that produces it, and
 * why it is not a codec bug. An empty set is the gate: a codec regression is now a red test.
 */
const TOLERATED = new Set<string>([])

beforeAll(async () => {
  client = await connect()
  await client.query(fx.ddl)
  await client.query(fx.seed)
  h = await makeHarness()
  conn = await h.driver.acquire()
}, 60_000)

afterAll(async () => {
  await h?.driver.release(conn)
  await h?.end()
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

/**
 * Columns whose type is `text`, so a `= $n :: text` comparison is one PostgreSQL will resolve.
 *
 * WS2 note: this used to be every column, including `id` (`int8`) and `created_at` (`timestamptz`),
 * which only planned because the spike sent no parameter type at all and PG then coerced the
 * untyped `$n` to the column. Under invariant (e) — where the codec's `paramOid` is actually
 * declared in `Parse` — 69 of 1000 generated statements failed with
 * `operator does not exist: timestamp with time zone = text`. That was a GENERATOR bug the old
 * oracle could not see: the fuzzer was minting predicates no typed builder can express, and
 * calling the resulting SQLSTATE a "tolerated codec gap".
 *
 * The type-class gate (`src/query/ops-free.ts`, WS0/WS3) is what makes `eq(t.u.createdAt, 'x')`
 * unrepresentable at the type level; this list is the same rule at the AST level.
 */
const TEXT_COLS = ['email', 'name', 'role'] as const

/** Any column, for projections — where the type does not have to resolve against an operator. */
const USER_COLS = ['id', 'email', 'name', 'role', 'created_at', 'deleted_at'] as const

/**
 * Leaves built through the **operator surface** (`src/query/ops.ts`), not through `nodes.ts`
 * (design/09 WS3).
 *
 * The two generators produce the same *kind* of tree, but only this one exercises the layer a
 * user actually types: the operand plumbing that picks the right-hand codec, the array parameter
 * `inList` mints, the `text[]` a json path becomes. Each shape below is one PostgreSQL will
 * resolve with the parameter types the codecs declare, which is invariant (e)'s whole point — a
 * shape that would not resolve is one the type-class gate makes unrepresentable anyway.
 */
function opLeaf(r: () => number, mint: () => string): Expr {
  const asExpr = (e: unknown): Expr => e as unknown as Expr
  switch (int(r, 0, 9)) {
    case 0:
      return asExpr(ops.ilike(ur[pick(r, TEXT_COLS_TS)]!, `%${mint()}%`))
    case 1:
      return asExpr(ops.startsWith(ur['email']!, mint()))
    case 2:
      return asExpr(ops.hasKey(ur['meta']!, mint()))
    case 3:
      return asExpr(ops.eq(ops.jsonPathText(ur['meta']!, ['billing', mint()]), mint()))
    case 4:
      return asExpr(
        ops.inList(
          ur['id']!,
          Array.from({ length: int(r, 0, 3) }, () => BigInt(int(r, 1, 9))),
        ),
      )
    case 5:
      return asExpr(ops.isDistinctFrom(ur['deleted_at']!, null))
    case 6:
      return asExpr(
        ops.between(ur['created_at']!, new Date(0), new Date('2100-01-01T00:00:00Z')),
      )
    case 7:
      return asExpr(ops.notILike(ur['name']!, `%${mint()}%`))
    case 8:
      return asExpr(ops.jsonContains(ur['meta']!, { [mint()]: mint() }))
    default:
      return asExpr(ops.regex(ur['role']!, `^${mint().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  }
}

/** The TS keys of {@link TEXT_COLS}. Same list, one indirection, so they cannot drift. */
const TEXT_COLS_TS = TEXT_COLS

function randomPredicate(r: () => number, depth: number, mint: () => string): Expr {
  const leaf = (): Expr => {
    // Half the leaves come from the operator surface, half from the raw node constructors, and
    // both end up in one tree — which is also a small property test that the two agree on what
    // an `Expr` is (they do: a ref IS a `ColumnNode`).
    if (r() < 0.5) return opLeaf(r, mint)
    switch (int(r, 0, 8)) {
      case 0:
        return eq(u(pick(r, TEXT_COLS)), param(mint(), textCodec))
      case 1:
        return gt(u('created_at'), param(new Date(0), timestamptzCodec))
      case 2:
        return isNull(u('deleted_at'))
      case 3:
        return isNotNull(u('email'))
      case 4:
        return inList(
          u('id'),
          Array.from({ length: int(r, 0, 3) }, () => param(int(r, 1, 9), int8Codec)),
        )
      case 5:
        return inAny(u('email'), param([mint()], textArrayCodec))
      case 6:
        return eq(jsonPathText(u('meta'), ['billing', mint()]), param(mint(), textCodec))
      case 7:
        /**
         * A bare `${value}` hole against a NON-text column. The hole carries `unknownCodec`,
         * whose `paramOid` is 0 — "unspecified, infer from context" — so PostgreSQL resolves
         * `int8 = $1` from the column. It is the only shape in this generator that puts the
         * untyped-parameter codec under test: declare any concrete type there (25, 705, …) and
         * this leaf stops resolving. Without it, R10's `unknownCodec.paramOid = 25` mutation
         * survived the whole suite.
         */
        return toNode(sql`${u('id')} = ${int(r, 1, 9)}`.as(boolCodec))
      default:
        return toNode(sql`${u('email')} = ${mint()}`.as(boolCodec))
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
        items.push(projection(`k${i}`, toNode(sql`upper(${u('name')}) || ${mint()}`.as(textCodec))))
        break
      case 2:
        items.push(projection(`k${i}`, jsonGetText(u('meta'), mint())))
        break
      default:
        items.push(projection(`k${i}`, param(mint(), textCodec)))
    }
  }
  return items
}

function randomNested(r: () => number): ProjectionItem {
  // A `one` relation may not carry its own limit/offset — the lateral would return several rows
  // and duplicate the parent row, so the planner refuses it (see `hoistOne`). The generator
  // therefore decides the cardinality FIRST and only offers a per-parent limit to `many`.
  const kind = r() < 0.3 ? ('one' as const) : ('many' as const)
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
    ...(kind === 'many' && r() < 0.6 ? { limit: param(int(r, 1, 5), int4Codec) } : {}),
  })
  return nested('rel', { kind, query: inner, alias: 'lp' })
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
    ...(r() < 0.5 ? { limit: param(int(r, 1, 50), int4Codec) } : {}),
    ...(r() < 0.3 ? { offset: param(int(r, 0, 10), int4Codec) } : {}),
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

  it('(d)+(e) PostgreSQL plans the SQL, and runs it with the codecs\' declared param types', async () => {
    // (d) `EXPLAIN (GENERIC_PLAN)` is PG 16+: it plans a parameterised statement with no values
    //     and no execution — exactly the describe-only round trip 03 §3.4 asks for. It says
    //     nothing about parameter TYPES, because it plans every `$n` as untyped.
    // (e) is what tests the codec seam: Parse with `paramTypesOf(binds)` — the OIDs the codecs
    //     declare — then execute for real. `TOLERATED` is empty, so any SQLSTATE fails the run.
    const r = rng(FUZZ_SEED ^ 0xbeef)
    const SAMPLE = Number(process.env['PG_PRIME_FUZZ_PG_CASES'] ?? 1000)
    let planned = 0
    let executed = 0
    let tolerated = 0
    const failures: { stage: 'plan' | 'execute'; sql: string; code?: string | undefined; message: string }[] = []

    const record = (stage: 'plan' | 'execute', sql: string, e: unknown): void => {
      const code = sqlState(e)
      if (code !== undefined && TOLERATED.has(code)) tolerated++
      else failures.push({ stage, sql, code, message: (e as Error).message })
    }

    for (let i = 0; i < SAMPLE; i++) {
      const compiled = compile(randomSelect(r))
      try {
        for (const stmt of planProbe(compiled.sql)) await client.query(stmt)
        planned++
      } catch (e) {
        record('plan', compiled.sql, e)
      }
      try {
        await conn.execute({
          text: compiled.sql,
          params: compiled.binds.map((b) => (b.k === 'value' ? b.encoded : null)),
          paramTypes: paramTypesOf(compiled.binds),
        })
        executed++
      } catch (e) {
        record('execute', compiled.sql, e)
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `\n── compiler fuzz / live ──\nplanned: ${planned}/${SAMPLE}  ` +
        `executed with declared param types: ${executed}/${SAMPLE}  ` +
        `tolerated: ${tolerated}  hard failures: ${failures.length}\n`,
    )
    if (failures.length > 0) {
      // eslint-disable-next-line no-console
      console.error(failures[0])
    }
    expect(failures).toEqual([])
    expect(planned).toBe(SAMPLE)
    expect(executed).toBe(SAMPLE)
  }, 300_000)
})
