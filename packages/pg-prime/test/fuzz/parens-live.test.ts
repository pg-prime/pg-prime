/**
 * PostgreSQL itself as the oracle for the emitter's parenthesisation and qualification rules.
 *
 * The goldens in `test/compile/parens.test.ts` and `test/compile/emit-guards.test.ts` say what the
 * compiler emits; this file says what the *server* does with it. That distinction is the whole
 * point for this class of bug: every shape below used to compile to text PostgreSQL accepted —
 * and then evaluated differently from the tree the caller built, or rejected outright. A golden
 * cannot tell those two apart on its own, and a value comparison can.
 *
 * Tier 1: runs on PGlite by default, or on `PG_PRIME_TEST_URL` when it is set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { boolCodec, int4Codec, int8Codec, numericCodec, textCodec } from '../../src/codec/index.js'
import type { Expr } from '../../src/compile/ast.js'
import { compile } from '../../src/compile/compiler.js'
import {
  cast,
  col,
  columnMeta,
  cte,
  cteRef,
  eq,
  is,
  lit,
  mkNode,
  not,
  param,
  projection,
  select,
  setItem,
  setop,
  table,
  tableMeta,
  update,
  valuesFrom,
} from '../../src/compile/nodes.js'
import { sql, toNode } from '../../src/sql/fragment.js'
import { connect } from '../live/_harness.js'

const SCHEMA = 'pgprime_fz_parens'

let client: pg.Client

/**
 * Neutralise `pg`'s per-OID type parsers so every cell arrives as the server's own text — the
 * same contract the driver adapter implements, and the one that keeps `'t'`/`'f'` distinguishable
 * from a coerced boolean.
 */
const TEXT_ONLY = { getTypeParser: () => (v: string) => v }

/** Run a compiled statement and return the raw (text-protocol) rows. */
async function run(stmt: Parameters<typeof compile>[0]): Promise<unknown[][]> {
  const c = compile(stmt)
  const res = await client.query({
    text: c.sql,
    values: c.binds.map((b) => (b.k === 'value' ? b.encoded : null)),
    rowMode: 'array',
    types: TEXT_ONLY as never,
  })
  return res.rows as unknown[][]
}

/** `select <expr> as "v"` — one row, one cell, whatever PostgreSQL made of the expression. */
async function evaluate(e: Expr): Promise<unknown> {
  const rows = await run(select({ projection: [projection('v', e)] }))
  return rows[0]?.[0]
}

const un = (op: '-' | '~', e: Expr): Expr =>
  mkNode({ k: 'un' as const, op, e, resultCodec: int4Codec })

const between = (e: Expr, lo: Expr, hi: Expr): Expr =>
  mkNode({ k: 'between' as const, e, lo, hi, symmetric: false, not: false })

beforeAll(async () => {
  client = await connect()
  await client.query(`drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA}`)
  await client.query(
    `create table ${SCHEMA}.products (id bigint primary key, price numeric not null)`,
  )
  await client.query(`insert into ${SCHEMA}.products values (1, 1.00), (2, 2.00)`)
})

afterAll(async () => {
  await client.query(`drop schema if exists ${SCHEMA} cascade`)
  await client.end()
})

describe('a unary operand means what the tree says, on the server', () => {
  it('`-(-1)` is 1 — unparenthesised it is `--1`, a comment that eats the statement', async () => {
    expect(await evaluate(un('-', lit(-1, int4Codec)))).toBe('1')
  })

  it('`~(-1)` is 0 — `~-` would lex as one operator name', async () => {
    expect(await evaluate(un('~', lit(-1, int4Codec)))).toBe('0')
  })

  it('`(not x) between …` is not `not (x between …)` — TRUE vs FALSE', async () => {
    // `not` binds looser than BETWEEN, so the bare form negates the whole clause. (Under `=` the
    // two readings happen to be logically equivalent for booleans, which is exactly why a golden
    // is not enough here and why this case is the one worth executing.)
    expect(
      await evaluate(
        between(not(lit(true, boolCodec)), lit(false, boolCodec), lit(true, boolCodec)),
      ),
    ).toBe('t')
    // …and the server confirms the reading we are avoiding.
    const bare = await client.query({
      text: 'select not true between false and true as v',
      types: TEXT_ONLY as never,
    })
    expect((bare.rows[0] as { v: string }).v).toBe('f')
  })

  it('`(-2147483648)::int4` is in range, where `-2147483648::int4` overflows (22003)', async () => {
    expect(await evaluate(cast(lit(-2147483648, int4Codec), 'int4', int4Codec))).toBe('-2147483648')
  })

  it('`(-x)::text` casts the negation, not the other way round', async () => {
    expect(await evaluate(cast(un('-', lit(2, int4Codec)), 'text', textCodec))).toBe('-2')
  })
})

describe('an opaque fragment keeps its own scope', () => {
  it('`a is distinct from (b or true)` is not `(a is distinct from b) or true`', async () => {
    // Bare, the fragment’s `or true` binds to the whole comparison and the predicate is
    // constantly true — the filter silently disappears.
    expect(
      await evaluate(is(lit(true, boolCodec), 'distinct from', toNode(sql`false or true`))),
    ).toBe('f')
  })
})

describe('statement-level shapes', () => {
  it('a set-operation branch carrying a WITH parses (42601 without the parentheses)', async () => {
    const rows = await run(
      setop({
        op: 'union all',
        left: select({ projection: [projection('n', lit(1, int4Codec))] }),
        right: select({
          with: [
            cte({
              name: 'c',
              recursive: false,
              query: select({ projection: [projection('n', lit(2, int4Codec))] }),
            }),
          ],
          projection: [projection('n', col('c', 'n', int4Codec))],
          from: cteRef('c'),
        }),
      }),
    )
    expect(rows.map((r) => r[0])).toEqual(['1', '2'])
  })

  it('UPDATE … FROM (values …) RETURNING keeps the FROM item qualified (42702 otherwise)', async () => {
    const products = table(tableMeta(SCHEMA, 'products'))
    const rows = await run(
      update({
        target: products,
        set: [setItem(columnMeta('price', numericCodec), col('v', 'price', numericCodec))],
        from: [
          valuesFrom({
            alias: 'v',
            columns: ['id', 'price'],
            casts: ['int8', 'numeric'],
            rows: [
              [param(1n, int8Codec), param('10.50', numericCodec)],
              [param(2n, int8Codec), param('20.50', numericCodec)],
            ],
          }),
        ],
        where: eq(col('products', 'id', int8Codec), col('v', 'id', int8Codec)),
        returning: [
          projection('id', col('products', 'id', int8Codec)),
          // The ambiguous one: `price` exists on the target AND on `v`.
          projection('newPrice', col('v', 'price', numericCodec)),
        ],
      }),
    )
    expect(rows.map((r) => [r[0], r[1]]).sort()).toEqual([
      ['1', '10.50'],
      ['2', '20.50'],
    ])
  })
})
