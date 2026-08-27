/**
 * `assertShape` and the `CodecMismatchError` golden (design/03 §3.2; design/09 WS6).
 *
 * The oracle here is `03` §3.2's own message, which a human approved in review and which is
 * reproduced literally below (R2). The *behaviour* oracle is the mock's scripted `dataTypeID`:
 * `RowDescription` is the server's answer to "what type is this column", and the whole point of
 * the check is that our declaration and that answer are two independent statements which can
 * disagree. Tier 1 runs the same check against a real one — `test/live-query/executor.test.ts`.
 *
 * R4's negative control is here rather than in a sibling: every case that throws is paired with
 * the same query under a *correct* OID, because a check that fires on everything is worth nothing.
 */

import { describe, expect, it, vi } from 'vitest'
import { PgDecodeError, int4Codec, numericCodec, textCodec } from '../../src/codec/index.js'
import { CodecMismatchError, renderCodecMismatch } from '../../src/query/errors.js'
import { pgPrime } from '../../src/query/run.js'
import * as q from '../../src/query/types.js'
import { sql } from '../../src/sql/index.js'
import { field, mockDriver } from './_mock-driver.js'
import { schema } from './_schema.js'

const rendered = (e: unknown): string => `${(e as Error).name}: ${(e as Error).message}`

describe('the message is `03` §3.2 s, rendered', () => {
  it('the golden — a fragment whose `.as()` call site is known', () => {
    // `03` §3.2 shows a fourth line reading `at src/reports.ts:42  sql`sum(…)`.as(codecs.int4)`.
    // We print the stack frame we captured and not a re-rendering of the caller's source, because
    // there is no way to recover the *text* of an expression at runtime. The file and line — the
    // part that answers "where do I go and fix it" — are the part that survives.
    expect(
      renderCodecMismatch({
        column: 'total',
        declared: 'int4',
        declaredOid: 23,
        actual: 'numeric',
        actualOid: 1700,
        origin: { site: 'at src/reports.ts:42:19' },
      }),
    ).toBe(
      [
        'column "total" was declared as codec `int4` (oid 23)',
        'but Postgres returned `numeric` (oid 1700).',
        '  at src/reports.ts:42:19',
        'Fix: use codecs.numeric, or cast in SQL.',
      ].join('\n'),
    )
  })

  it('the schema-column variant names table.column and says schema drift', () => {
    // A different mistake with a different fix: the caller s source is innocent and the database
    // has moved. Pointing at their `.select()` would send them to the wrong file.
    expect(
      renderCodecMismatch({
        column: 'createdAt',
        declared: 'timestamptz',
        declaredOid: 1184,
        actual: 'text',
        actualOid: 25,
        origin: { column: '"users"."created_at"' },
      }),
    ).toBe(
      [
        'column "createdAt" was declared as codec `timestamptz` (oid 1184)',
        'but Postgres returned `text` (oid 25).',
        '  "users"."created_at" is schema drift: the database no longer matches the pgTable(...) declaration.',
        'Fix: run the pending migration, or declare "users"."created_at" as text.',
      ].join('\n'),
    )
  })

  it('an OID with no codec is named as such rather than as `undefined`', () => {
    expect(
      renderCodecMismatch({
        column: 'v',
        declared: 'text',
        declaredOid: 25,
        actual: undefined,
        actualOid: 90001,
        origin: undefined,
      }),
    ).toBe(
      [
        'column "v" was declared as codec `text` (oid 25)',
        'but Postgres returned an unregistered type (oid 90001).',
        'Fix: register a codec for oid 90001, or cast in SQL.',
      ].join('\n'),
    )
  })
})

describe('assertShape fires on a lying codec', () => {
  /** `sum(amount)` over `numeric`, declared `int4`. `03` §3.2 s own example. */
  const lying = (db: ReturnType<typeof pgPrime<typeof schema>>) =>
    db.from(schema.h.posts).select(({ posts: p }) => ({
      total: sql`sum(${p.amount})`.as(int4Codec),
    }))

  it('throws before decoding, with the call site of the `.as()`', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push([['10.50']])
    driver.fields.push([field('total', 1700)])

    const err = await lying(db).execute().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CodecMismatchError)
    const text = rendered(err)
    expect(text).toContain(
      'CodecMismatchError: column "total" was declared as codec `int4` (oid 23)',
    )
    expect(text).toContain('but Postgres returned `numeric` (oid 1700).')
    expect(text).toContain('Fix: use codecs.numeric, or cast in SQL.')
    // The call site is THIS file — captured by `.as()`, three frames up from `captureSite`.
    expect(text).toContain('assert-shape.test.ts')
    expect((err as CodecMismatchError).code).toBe('CODEC_MISMATCH')
  })

  it('R4 negative control: the SAME query with the right codec does not throw', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push([['10.50']])
    driver.fields.push([field('total', 1700)])
    expect(
      await db
        .from(schema.h.posts)
        .select(({ posts: p }) => ({ total: sql`sum(${p.amount})`.as(numericCodec) }))
        .execute(),
    ).toStrictEqual([{ total: '10.50' }])
  })

  it('with assertShape: false the check is gone and the lie is the user s problem', async () => {
    const db = (rows: string[][]) => {
      const driver = mockDriver()
      driver.rows.push(rows)
      driver.fields.push([field('total', 1700)])
      return { driver, db: pgPrime({ driver, schema, assertShape: false }) }
    }

    // Two outcomes, and BOTH are worth writing down, because only one of them is loud.
    //
    // `int4`'s decoder is strict, so a `numeric` with a fractional part surfaces as a decode
    // error — noisy, and findable.
    await expect(lying(db([['10.50']]).db).execute()).rejects.toThrow(PgDecodeError)
    // But a `sum()` that happens to come out whole decodes CLEANLY, as a `number`, having
    // silently discarded the fact that it was a `numeric(12,2)` and would not have next month.
    // That is the failure `assertShape` exists to make impossible, and it is invisible here.
    expect(await lying(db([['10']]).db).execute()).toStrictEqual([{ total: 10 }])
  })

  it('a schema column that drifted names the column, not the caller', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push([['nope']])
    driver.fields.push([field('createdAt', 25)]) // the server says text; we declared timestamptz
    const err = await db
      .from(schema.h.users)
      .select(({ users: u }) => ({ createdAt: u.createdAt }))
      .execute()
      .catch((e: unknown) => e)
    expect(rendered(err)).toContain('"users"."created_at" is schema drift')
    expect(rendered(err)).toContain('Fix: run the pending migration, or declare')
  })
})

describe('assertShape skips what it cannot judge', () => {
  it('no field metadata at all: nothing to compare, so nothing is claimed', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push([['10']])
    // `fields` is left empty — an adapter that reported none.
    expect(
      await db
        .from(schema.h.posts)
        .select(({ posts: p }) => ({ total: sql`sum(${p.amount})`.as(int4Codec) }))
        .execute(),
    ).toStrictEqual([{ total: 10 }])
  })

  it('an untyped fragment declares nothing, so it can be nothing but right', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push([['hi']])
    driver.fields.push([field('v', 25)])
    expect(
      await db
        .from(schema.h.posts)
        .select(() => ({ v: sql`'hi'`.asUnsafe<string>() }))
        .execute(),
    ).toStrictEqual([{ v: 'hi' }])
  })

  it('a nest() group is walked into — its members are columns like any other', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push([['x']])
    driver.fields.push([field('grp.name', 1700)]) // we declared text; the server says numeric
    const err = await db
      .from(schema.h.users)
      .select(({ users: u }) => ({ grp: q.nest({ name: u.name }) }))
      .execute()
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CodecMismatchError)
    expect(rendered(err)).toContain('column "name" was declared as codec `text` (oid 25)')
  })

  it('a relation column accepts json OR jsonb and rejects anything else', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    const build = () =>
      db.from(schema.h.users).select(({ users: u }) => ({
        id: u.id,
        posts: u.posts.many((p) => p.select((t) => ({ id: t.id }))),
      }))

    driver.rows.push([['7', '[]']])
    driver.fields.push([field('id', 20), field('posts', 114)]) // json — accepted
    expect(await build().execute()).toStrictEqual([{ id: 7n, posts: [] }])

    driver.rows.push([['7', '[]']])
    driver.fields.push([field('id', 20), field('posts', 25)]) // text — refused
    const err = await build().execute().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CodecMismatchError)
    expect(rendered(err)).toContain('column "posts"')
  })
})

/** Referenced by the goldens above; keeps the import list honest. */
void textCodec

describe('the dev gate is NODE_ENV, resolved once', () => {
  it('NODE_ENV=production turns the check off without any option being passed', async () => {
    // The default is `NODE_ENV !== 'production'` and it is cached on first use (a bundler that
    // hoists the module above the app's configuration must not pin the answer at evaluation
    // time). So the only honest way to test the gate is a fresh module graph.
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'production')
    try {
      const { pgPrime: fresh } = await import('../../src/query/run.js')
      const { mockDriver: freshMock, field: freshField } = await import('./_mock-driver.js')
      const { sql: freshSql } = await import('../../src/sql/index.js')
      const { int4Codec: freshInt4 } = await import('../../src/codec/index.js')
      const { schema: freshSchema } = await import('./_schema.js')

      const driver = freshMock()
      const db = fresh({ driver, schema: freshSchema })
      driver.rows.push([['10']])
      driver.fields.push([freshField('total', 1700)]) // numeric, declared int4

      expect(
        await db
          .from(freshSchema.h.posts)
          .select(({ posts: p }) => ({ total: freshSql`sum(${p.amount})`.as(freshInt4) }))
          .execute(),
      ).toStrictEqual([{ total: 10 }])
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })

  it('R4 negative control: the same fresh graph WITHOUT production still throws', async () => {
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'test')
    try {
      const { pgPrime: fresh } = await import('../../src/query/run.js')
      const { mockDriver: freshMock, field: freshField } = await import('./_mock-driver.js')
      const { sql: freshSql } = await import('../../src/sql/index.js')
      const { int4Codec: freshInt4 } = await import('../../src/codec/index.js')
      const { schema: freshSchema } = await import('./_schema.js')

      const driver = freshMock()
      const db = fresh({ driver, schema: freshSchema })
      driver.rows.push([['10']])
      driver.fields.push([freshField('total', 1700)])

      await expect(
        db
          .from(freshSchema.h.posts)
          .select(({ posts: p }) => ({ total: freshSql`sum(${p.amount})`.as(freshInt4) }))
          .execute(),
      ).rejects.toThrow(/declared as codec `int4`/)
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})
