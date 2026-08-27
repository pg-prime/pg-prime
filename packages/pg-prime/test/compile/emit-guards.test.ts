/**
 * Emitter guards: the places where the compiler used to write SQL that PostgreSQL either rejects
 * or — worse — accepts with a different meaning.
 *
 * Four independent rules, one describe block each:
 *
 *  - a set-operation branch that carries a `WITH` must be parenthesised (42601 otherwise);
 *  - `RETURNING` unqualifies the *target's* columns only, never a FROM/USING item's (42702);
 *  - a node that cannot be emitted faithfully throws instead of emitting something else;
 *  - every enum-valued option is mapped to a fixed literal, so an AST cannot carry free text
 *    into the output.
 *
 * The SQL below is hand-written against the PostgreSQL grammar; `test/fuzz/parens-live.test.ts`
 * runs the same shapes on a real server, which is what makes these goldens an oracle rather than
 * a recording.
 */

import { describe, expect, it } from 'vitest'
import {
  boolCodec,
  int4Codec,
  int8Codec,
  numericCodec,
  textCodec,
} from '../../src/codec/index.js'
import type { RawPart, SelectNode } from '../../src/compile/ast.js'
import { compile, compileExpr } from '../../src/compile/compiler.js'
import {
  arrayExpr,
  caseWhen,
  col,
  columnMeta,
  cte,
  cteRef,
  eq,
  join,
  lit,
  param,
  projection,
  raw,
  rowExpr,
  select,
  setItem,
  setop,
  table,
  tableMeta,
  update,
  valuesFrom,
} from '../../src/compile/nodes.js'
import { InvalidFragmentError, UnsupportedNodeError } from '../../src/sql/errors.js'
import { p, postsFrom, u, usersFrom } from '../sql/_helpers.js'

describe('§2.4 — a set-operation branch that carries a WITH is parenthesised', () => {
  const branchWithCte = select({
    with: [
      cte({
        name: 'recent',
        recursive: false,
        query: select({ projection: [projection('id', u('id'))], from: usersFrom }),
      }),
    ],
    projection: [projection('id', col('recent', 'id', int8Codec))],
    from: cteRef('recent'),
  })

  it('emits `(with … select …) union all select …`, not a bare WITH after UNION', () => {
    // Bare, this is `… union all with "recent" as (…) select …`, which PostgreSQL rejects with
    // 42601: a WITH may only begin a *parenthesised* branch of a set operation.
    const sql = compile(
      setop({
        op: 'union all',
        left: select({ projection: [projection('id', p('id'))], from: postsFrom }),
        right: branchWithCte,
      }),
    ).sql
    expect(sql).toContain('union all\n(\n  with "recent" as (')
    expect(sql.endsWith(')')).toBe(true)
    // The parenthesised branch is the whole select, CTE included.
    expect(sql).toMatch(/\(\n {2}with "recent" as \([\s\S]*select "recent"\."id" as "id"/)
  })

  it('NEGATIVE CONTROL — two plain selects still emit no parentheses at all', () => {
    const sql = compile(
      setop({
        op: 'union',
        left: select({ projection: [projection('id', u('id'))], from: usersFrom }),
        right: select({ projection: [projection('id', p('id'))], from: postsFrom }),
      }),
    ).sql
    expect(sql).toBe(
      [
        'select "users"."id" as "id"',
        'from "public"."users" as "users"',
        'union',
        'select "posts"."id" as "id"',
        'from "public"."posts" as "posts"',
      ].join('\n'),
    )
  })
})

describe('§2.6 — RETURNING unqualifies the target, and only the target', () => {
  const products = tableMeta('public', 'products')
  const productsFrom = table(products)
  const idCol = columnMeta('id', int8Codec)
  const priceCol = columnMeta('price', numericCodec)

  const bulkUpdate = update({
    target: productsFrom,
    set: [setItem(priceCol, col('v', 'price', numericCodec))],
    from: [
      valuesFrom({
        alias: 'v',
        columns: ['id', 'price'],
        casts: ['int8', 'numeric'],
        rows: [[param(1n, int8Codec), param('9.99', numericCodec)]],
      }),
    ],
    where: eq(col('products', 'id', int8Codec), col('v', 'id', int8Codec)),
    returning: [
      projection('id', col('products', 'id', int8Codec)),
      projection('price', col('v', 'price', numericCodec)),
    ],
  })

  it('qualifies BOTH sides once a FROM item shares the scope', () => {
    // Unqualifying every column produced `returning "id", "price"`, and both names exist on the
    // target AND on the values item: 42702 column reference "price" is ambiguous. Unqualifying
    // only the target's own columns is not enough either — `"id"` is equally ambiguous, which
    // `test/fuzz/parens-live.test.ts` demonstrates against a real server.
    expect(compile(bulkUpdate).sql).toBe(
      [
        'update "public"."products" as "products"',
        'set "price" = "v"."price"',
        'from (values ($1::int8, $2::numeric)) as "v"("id", "price")',
        'where "products"."id" = "v"."id"',
        'returning "products"."id" as "id", "v"."price" as "price"',
      ].join('\n'),
    )
    expect(idCol.quoted).toBe('"id"')
  })

  it('NEGATIVE CONTROL — a RETURNING with only target columns is unchanged', () => {
    const c = compile(
      update({
        target: productsFrom,
        set: [setItem(priceCol, param('1.00', numericCodec))],
        where: eq(col('products', 'id', int8Codec), param(1n, int8Codec)),
        returning: [projection('id', col('products', 'id', int8Codec))],
      }),
    )
    expect(c.sql.endsWith('returning "id" as "id"')).toBe(true)
  })
})

describe('a node the emitter cannot render faithfully throws', () => {
  it('a cross join with an ON clause is a lost predicate, not a cartesian product', () => {
    expect(() =>
      compile(
        select({
          projection: [projection('id', u('id'))],
          from: usersFrom,
          joins: [join('cross', postsFrom, eq(p('authorId'), u('id')))],
        }),
      ),
    ).toThrow(UnsupportedNodeError)
  })

  it('a hole in a fragment’s parts is reported, not skipped along with its chunk', () => {
    const holed = raw(['a ', ' b'], [undefined as unknown as RawPart], null)
    expect(() => compileExpr(holed)).toThrow(InvalidFragmentError)
  })

  it('a CASE with no WHEN branch is a syntax error, so it never reaches the server', () => {
    expect(() => compileExpr(caseWhen([], textCodec))).toThrow(UnsupportedNodeError)
  })
})

describe('case / row / array — understood by the planner, therefore emitted', () => {
  it('the searched and the simple CASE', () => {
    expect(
      compileExpr(
        caseWhen([{ when: p('published'), then: lit(1, int4Codec) }], int4Codec, {
          else: lit(0, int4Codec),
        }),
      ).sql,
    ).toBe('case when "posts"."published" then 1 else 0 end')
    expect(
      compileExpr(
        caseWhen([{ when: lit(1, int4Codec), then: lit(2, int4Codec) }], int4Codec, {
          operand: u('role'),
        }),
      ).sql,
    ).toBe('case "users"."role" when 1 then 2 end')
  })

  it('row() and array[], including the empty array PostgreSQL cannot type on its own', () => {
    expect(compileExpr(rowExpr([u('id'), u('email')])).sql).toBe(
      'row("users"."id", "users"."email")',
    )
    expect(compileExpr(arrayExpr([param('a', textCodec)], textCodec)).sql).toBe('array[$1]')
    // `array[]` alone is 42P18 indeterminate_datatype.
    expect(compileExpr(arrayExpr([], int4Codec)).sql).toBe('array[]::integer[]')
  })

  it('they are self-delimiting, so no operand position wraps them', () => {
    const c = caseWhen([{ when: p('published'), then: lit(1, int4Codec) }], int4Codec)
    expect(compileExpr(eq(c, lit(1, int4Codec))).sql).toBe(
      'case when "posts"."published" then 1 end = 1',
    )
  })
})

describe('option strings are mapped to fixed literals, never concatenated', () => {
  const forged = (locking: unknown): SelectNode =>
    select({
      projection: [projection('id', u('id'))],
      from: usersFrom,
      locking: locking as SelectNode['locking'],
    })

  it('a lock strength that is not one of the four throws instead of reaching the SQL', () => {
    expect(() => compile(forged({ strength: 'update of pg_authid', wait: 'block' }))).toThrow(
      UnsupportedNodeError,
    )
    expect(() => compile(forged({ strength: 'update', wait: 'nowait; drop table t' }))).toThrow(
      UnsupportedNodeError,
    )
  })

  it('so do a bad NULLS placement, frame mode, frame exclusion and frame bound', () => {
    const withOrder = (nulls: unknown): SelectNode =>
      select({
        projection: [projection('id', u('id'))],
        from: usersFrom,
        orderBy: [{ e: u('id'), dir: 'asc', nulls: nulls as 'first' }],
      })
    expect(() => compile(withOrder('first, (select 1)'))).toThrow(UnsupportedNodeError)

    const withFrame = (frame: unknown): SelectNode =>
      select({
        projection: [projection('id', u('id'))],
        from: usersFrom,
        windows: [{ name: 'w', def: { frame: frame as never } }],
      })
    expect(() => compile(withFrame({ mode: 'rows)) --', start: { k: 'current row' } }))).toThrow(
      UnsupportedNodeError,
    )
    expect(() =>
      compile(withFrame({ mode: 'rows', start: { k: 'current row' }, exclude: 'ties)' })),
    ).toThrow(UnsupportedNodeError)
    expect(() => compile(withFrame({ mode: 'rows', start: { k: 'whatever' } }))).toThrow(
      UnsupportedNodeError,
    )
  })

  it('NEGATIVE CONTROL — every documented option still emits exactly what it did', () => {
    const c = compile(
      select({
        projection: [projection('id', u('id'))],
        from: usersFrom,
        orderBy: [{ e: u('id'), dir: 'desc', nulls: 'last' }],
        windows: [
          {
            name: 'w',
            def: {
              partitionBy: [u('role')],
              frame: {
                mode: 'range',
                start: { k: 'unbounded preceding' },
                end: { k: 'preceding', n: lit(1, int4Codec) },
                exclude: 'current row',
              },
            },
          },
        ],
        locking: { strength: 'no key update', of: ['users'], wait: 'skip locked' },
      }),
    )
    expect(c.sql).toContain('window "w" as (partition by "users"."role" range between ')
    expect(c.sql).toContain('unbounded preceding and 1 preceding exclude current row)')
    expect(c.sql).toContain('order by "users"."id" desc nulls last')
    expect(c.sql.endsWith('for no key update of "users" skip locked')).toBe(true)
    expect(compile(select({ projection: [projection('t', lit(true, boolCodec))] })).sql).toBe(
      'select true as "t"',
    )
  })
})
