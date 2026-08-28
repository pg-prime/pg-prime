/**
 * The executor against a real server, tier 1 (design/09 WS6).
 *
 * What only a server can answer, and therefore what is here rather than in `test/query/`:
 *
 *  - **`assertShape`'s oracle is `RowDescription`.** A mock's `dataTypeID` is a number we chose;
 *    here it is PostgreSQL's own answer to "what type is this column", produced by a planner that
 *    has never heard of our codec table. `sum(numeric)` is `numeric`, and no amount of declaring
 *    `int4` changes that.
 *  - **The dynamic-OID path needs a real OID.** `sql`now()`.asUnsafe<Date>()` yields a `Date`
 *    only because the server said 1184 and our registry knew what to do with it.
 *  - **`explain()` returns a plan** — for every `03` §2 example the appendix-A suite builds, which
 *    is R1's "PostgreSQL itself" applied to the whole vocabulary at once.
 *  - **Cursors are a server feature.** `DECLARE` outside a transaction is `25P01`; the fact that
 *    ours never hits it is a property of the transaction we open, and only a server can confirm.
 *
 * R3 throughout: every assertion pairs a static type with a runtime value on the same expression.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectTypeOf } from 'expect-type'
import { int4Codec, int8Codec, numericCodec, textCodec } from '../../src/codec/index.js'
import { CodecMismatchError } from '../../src/query/errors.js'
import { clearDescribeCache, describeCacheStats } from '../../src/query/executor.js'
import * as q from '../../src/query/types.js'
import { sql } from '../../src/sql/index.js'
import { PgDecodeError } from '../../src/codec/index.js'
import { sqlState } from '../live/_harness.js'
import { makeLiveDb, type LiveDb } from './_db.js'

let live: LiveDb

beforeAll(async () => {
  live = await makeLiveDb('pgprime_q_executor')
}, 120_000)

afterAll(async () => {
  await live?.end()
})

const h = () => live.fx.schema.h

// ─────────────────────────────────────────────────────────────────────────────
// assertShape — the lying codec (03 §3.2)
// ─────────────────────────────────────────────────────────────────────────────

describe('a lying codec is caught by the server s own RowDescription', () => {
  /** `03` §3.2's own example: `sum(amount)` over `numeric(12,2)`, declared `int4`. */
  const lying = (db: LiveDb['db']) =>
    db.from(h().posts).select(({ posts: p }) => ({ total: sql`sum(${p.amount})`.as(int4Codec) }))

  it('throws CodecMismatchError with the exact message and the .as() call site', async () => {
    const err = await lying(live.db)
      .execute()
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CodecMismatchError)
    const text = `${(err as Error).name}: ${(err as Error).message}`
    expect(text).toContain(
      'CodecMismatchError: column "total" was declared as codec `int4` (oid 23)',
    )
    // 1700 is PostgreSQL's, not ours: `sum(numeric)` is `numeric`, whatever we declared.
    expect(text).toContain('but Postgres returned `numeric` (oid 1700).')
    expect(text).toContain('Fix: use codecs.numeric, or cast in SQL.')
    expect(text).toContain('executor.test.ts')
  })

  it('R4 negative control: the same query with `numeric` returns the exact value', async () => {
    const rows = await live.db
      .from(h().posts)
      .select(({ posts: p }) => ({ total: sql`sum(${p.amount})`.as(numericCodec) }))
      .execute()
    expectTypeOf(rows).toEqualTypeOf<{ total: string }[]>()
    // 0.00 + -1.10 + 12345678.90 + 5.00 + 1.00 + 7.77 — as a precision-exact string.
    expect(rows).toStrictEqual([{ total: '12345691.57' }])
  })

  it('with assertShape: false the check is gone, and the lie is the user s problem', async () => {
    // The same pool and the same registry, with the dev check turned off at the db level.
    const db = live.dbWith({ assertShape: false })
    // `int4.decodeText('12345691.57')` refuses a fractional part — loud, and findable.
    await expect(lying(db).execute()).rejects.toThrow(PgDecodeError)

    // The quiet half is the one that matters: a whole-number sum decodes CLEANLY as a `number`,
    // having silently discarded that it was a `numeric(12,2)`. That is what the dev check exists
    // to make impossible, and here it is, invisible.
    const rows = await db
      .from(h().posts)
      .select(({ posts: p }) => ({ total: sql`sum(${p.amount})::int4`.as(int4Codec) }))
      .execute()
    expect(rows).toStrictEqual([{ total: 12345692 }])
  })

  it('a schema column whose type drifted names the column and says schema drift', async () => {
    // Drift, produced for real: the column is altered under a db that still declares it `text`.
    await live.raw(`alter table ${live.fx.ns}.tags alter column name type varchar(64)`)
    const err = await live.db
      .from(h().tags)
      .select(({ tags: t }) => ({ name: t.name }))
      .execute()
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CodecMismatchError)
    const text = (err as Error).message
    expect(text).toContain('"tags"."name" is schema drift')
    expect(text).toContain('but Postgres returned `varchar` (oid 1043).')
    await live.raw(`alter table ${live.fx.ns}.tags alter column name type text`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic-OID decode (03 §3.2, "untyped fragments still decode correctly")
// ─────────────────────────────────────────────────────────────────────────────

describe('untyped fragments decode by OID', () => {
  it('R3: `sql`now()`.asUnsafe<Date>()` in a projection yields a real Date', async () => {
    const before = new Date()
    const rows = await live.db
      .from(h().users)
      .select(({ users: u }) => ({ id: u.id, at: sql`now()`.asUnsafe<Date>() }))
      .limit(1)
      .execute()
    expectTypeOf(rows).toEqualTypeOf<{ id: bigint; at: Date }[]>()
    const at = rows[0]?.at
    // The type is the caller's assertion; the VALUE is ours, and it is a Date because the server
    // said 1184 and the registry knew what that is. A string here is the bug this test exists for.
    expect(at).toBeInstanceOf(Date)
    expect((at as Date).getTime()).toBeGreaterThanOrEqual(before.getTime() - 60_000)
  })

  it('R4 negative control: an OID we have no codec for comes back as the raw wire text', async () => {
    const rows = await live.db
      .from(h().users)
      .select(() => ({ v: sql`'(1,2)'::point`.asUnsafe<string>() }))
      .limit(1)
      .execute()
    // `point` has no codec. The honest answer is the text PostgreSQL sent, not a guess.
    expect(rows).toStrictEqual([{ v: '(1,2)' }])
  })

  it('a declared codec on the same fragment wins — the dynamic path is the fallback', async () => {
    const rows = await live.db
      .from(h().users)
      .select(() => ({ at: sql`now()::text`.as(textCodec) }))
      .limit(1)
      .execute()
    expectTypeOf(rows).toEqualTypeOf<{ at: string }[]>()
    expect(typeof rows[0]?.at).toBe('string')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// executeTakeFirst / toSQL
// ─────────────────────────────────────────────────────────────────────────────

describe('executeTakeFirst()', () => {
  it('R3: the first row, typed as the row and not as an array', async () => {
    const row = await live.db
      .from(h().users)
      .select(({ users: u }) => ({ email: u.email, balance: u.balance }))
      // `id`, not `email`: text ordering is collation-dependent, and 'Frank.O@…' sorts before
      // 'ada@…' under C and after it under en_US.UTF-8 — a test that disagrees with itself
      // between PGlite and PG 17 is testing the locale, not the executor.
      .orderBy(({ users: u }) => q.asc(u.id))
      .executeTakeFirst()
    expectTypeOf(row).toEqualTypeOf<{ email: string; balance: string } | undefined>()
    expect(row).toStrictEqual({ email: 'ada@example.com', balance: '1234.00' })
  })

  it('undefined on no rows', async () => {
    expect(
      await live.db
        .from(h().users)
        .select(({ users: u }) => ({ id: u.id }))
        .where(({ users: u }) => q.eq(u.email, 'nobody@example.com'))
        .executeTakeFirst(),
    ).toBeUndefined()
  })

  it('does NOT truncate a write: an INSERT … RETURNING five rows still inserts five', async () => {
    // The whole reason `executeTakeFirst` is `rows[0]` and not `maxRows: 1` — the portal cap
    // STOPS the statement. The oracle is a second, hand-written count through `live.raw`.
    const rows = [1, 2, 3, 4, 5].map((n) => ({ id: BigInt(100 + n), name: `t${n}` }))
    const first = await live.db
      .insertInto(h().tags)
      .valuesMany(rows)
      .returning(({ tags: t }) => ({ id: t.id }))
      .executeTakeFirst()
    expect(first).toStrictEqual({ id: 101n })
    const counted = await live.raw(
      `select count(*) from ${live.fx.ns}.tags where id between 101 and 105`,
    )
    expect(counted).toStrictEqual([['5']])
    await live.raw(`delete from ${live.fx.ns}.tags where id between 101 and 105`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// prepare()
// ─────────────────────────────────────────────────────────────────────────────

describe('.prepare() round-trips typed parameters', () => {
  it('R3: three holes, three codecs, exact values back', async () => {
    const byThree = live.db
      .from(h().posts)
      .select(({ posts: p }) => ({ title: p.title, amount: p.amount, at: p.createdAt }))
      .where(({ posts: p }) =>
        q.and(
          q.gt(p.amount, q.placeholder('min', numericCodec)),
          q.eq(p.published, true),
          q.eq(p.title, q.placeholder('title', textCodec)),
        ),
      )
      .prepare<{ min: string; title: string }>('posts_by_title')

    const a = await byThree.execute({ min: '-2.00', title: 'bobs' })
    expectTypeOf(a).toEqualTypeOf<{ title: string; amount: string; at: Date }[]>()
    expect(a).toStrictEqual([
      { title: 'bobs', amount: '7.77', at: new Date('2026-02-05T10:00:00.000Z') },
    ])

    // Same artifact, different parameters — the point of preparing at all.
    expect(await byThree.execute({ min: '-2.00', title: 'first' })).toStrictEqual([
      { title: 'first', amount: '0.00', at: new Date('2026-02-01T10:00:00.000Z') },
    ])
    // And two values that exclude everything, so each hole really is a filter.
    expect(await byThree.execute({ min: '99999999.00', title: 'bobs' })).toStrictEqual([])
    expect(await byThree.execute({ min: '-2.00', title: 'no-such-post' })).toStrictEqual([])
  })

  it('a bigint hole survives past 2^53 (R5, through the placeholder path)', async () => {
    const byId = live.db
      .from(h().posts)
      .select(({ posts: p }) => ({ id: p.id, title: p.title }))
      .where(({ posts: p }) => q.eq(p.id, q.placeholder('id', int8Codec)))
      .prepare<{ id: bigint }>()
    const first = await live.db
      .from(h().posts)
      .select(({ posts: p }) => ({ id: p.id, title: p.title }))
      .orderBy(({ posts: p }) => q.asc(p.id))
      .executeTakeFirst()
    const { id, title } = first as { id: bigint; title: string }
    // The fixture's identity starts at 2^53+1, so this is past the float64 cliff by construction.
    expect(id).toBeGreaterThan(9007199254740992n)
    // The oracle is a hand-written statement with the id spelled as a literal — a bind that lost
    // a digit would match a different row, or none.
    expect(await live.raw(`select title from ${live.fx.ns}.posts where id = ${id}`)).toStrictEqual([
      [title],
    ])
    expect(await byId.execute({ id })).toStrictEqual([{ id, title }])
  })

  it('meta.reads / meta.writes name real relations', () => {
    const p = live.db
      .update(h().tags)
      .set(() => ({ name: 'x' }))
      .where(({ tags: t }) => q.eq(t.id, 999n))
      .returning(({ tags: t }) => ({ id: t.id }))
      .prepare()
    expect(p.meta.writes.map((w) => `${w.schema}.${w.name}`)).toStrictEqual([`${live.fx.ns}.tags`])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// stream()
// ─────────────────────────────────────────────────────────────────────────────

describe('stream()', () => {
  it('R3: rows come back one at a time, typed and exact, in the order asked for', async () => {
    const seen: { title: string; amount: string }[] = []
    for await (const row of live.db
      .from(h().posts)
      .select(({ posts: p }) => ({ title: p.title, amount: p.amount }))
      .orderBy(({ posts: p }) => q.asc(p.title))
      .stream({ batchSize: 2 })) {
      expectTypeOf(row).toEqualTypeOf<{ title: string; amount: string }>()
      seen.push(row)
    }
    expect(seen.map((r) => r.title)).toStrictEqual([
      'bobs',
      'draft',
      'fifth',
      'first',
      'tie-a',
      'tie-b',
    ])
    expect(seen[1]).toStrictEqual({ title: 'draft', amount: '5.00' })
  })

  it('outside a transaction it opens its own — no 25P01 (the `00` week-1 finding)', async () => {
    // A DECLARE outside a transaction block is `25P01`; ours never sees it because the runner
    // opens one. The proof is that this completes at all, and the counter-proof is below.
    const first: unknown[] = []
    for await (const row of live.db
      .from(h().users)
      .select(({ users: u }) => ({ id: u.id }))
      .stream()) {
      first.push(row)
    }
    expect(first).toHaveLength(6)

    // The counter-proof: the same DECLARE issued by hand, outside a transaction, on a raw
    // connection — PostgreSQL refuses it, which is what our BEGIN is for. (R13: SQLSTATE.)
    const err = await live.conn
      .execute({ text: `declare c_probe cursor for select 1`, params: [] })
      .catch((e: unknown) => e)
    expect(sqlState(err)).toBe('25P01')
  })

  it('breaking out early releases the connection — the pool still works afterwards', async () => {
    for await (const row of live.db
      .from(h().posts)
      .select(({ posts: p }) => ({ id: p.id }))
      .stream({ batchSize: 1 })) {
      void row
      break
    }
    // If the cursor's transaction or its connection had leaked, this would hang or fail.
    expect(
      await live.db
        .from(h().users)
        .select(({ users: u }) => ({ id: u.id }))
        .execute(),
    ).toHaveLength(6)
  })

  it('inside db.transaction() it joins, and sees the transaction s own uncommitted writes', async () => {
    const seen: string[] = []
    await live.db
      .transaction(async (tx) => {
        await tx.insertInto(h().tags).values({ id: 900n, name: 'streamed' }).execute()
        for await (const row of tx
          .from(h().tags)
          .select(({ tags: t }) => ({ name: t.name }))
          .where(({ tags: t }) => q.eq(t.id, 900n))
          .stream()) {
          seen.push(row.name)
        }
        throw new Error('rollback please')
      })
      .catch(() => {})
    // The cursor read the uncommitted row, which is only possible if it joined the transaction…
    expect(seen).toStrictEqual(['streamed'])
    // …and the rollback took it away again, which is only possible if the cursor did not commit.
    expect(await live.raw(`select count(*) from ${live.fx.ns}.tags where id = 900`)).toStrictEqual([
      ['0'],
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// explain()
// ─────────────────────────────────────────────────────────────────────────────

describe('explain()', () => {
  it('returns a typed plan tree for a select', async () => {
    const r = await live.db
      .from(h().posts)
      .select(({ posts: p }) => ({ id: p.id, title: p.title }))
      .where(({ posts: p }) => q.eq(p.published, true))
      .explain()
    expect(typeof r.plan?.['Node Type']).toBe('string')
    expect(r.executed).toBe(false)
    expect(r.text.length).toBeGreaterThan(0)
  })

  it('analyze reports real times and really ran', async () => {
    const r = await live.db
      .from(h().posts)
      .select(({ posts: p }) => ({ id: p.id }))
      .explain({ analyze: true })
    expect(r.executed).toBe(true)
    expect(r.planningTimeMs).toBeGreaterThan(0)
    expect(r.executionTimeMs).toBeGreaterThanOrEqual(0)
    expect(r.plan?.['Actual Rows']).toBeGreaterThan(0)
  })

  it('format text gives PostgreSQL s own rendering', async () => {
    const r = await live.db
      .from(h().posts)
      .select(({ posts: p }) => ({ id: p.id }))
      .explain({ format: 'text' })
    expect(r.plan).toBeUndefined()
    expect(r.text).toMatch(/Scan/)
  })

  it('the ANALYZE rail really rolls a mutating statement back', async () => {
    await live.raw(`insert into ${live.fx.ns}.tags (id, name) values (800, 'before')`)
    const r = await live.db
      .update(h().tags)
      .set(() => ({ name: 'after' }))
      .where(({ tags: t }) => q.eq(t.id, 800n))
      .explain({ analyze: true })
    expect(r.executed).toBe(true)
    expect(r.rolledBack).toBe(true)
    // The oracle is the row itself, read back on a different path.
    expect(await live.raw(`select name from ${live.fx.ns}.tags where id = 800`)).toStrictEqual([
      ['before'],
    ])

    // …and `rollback: false` really writes, which is what makes the default worth having.
    const kept = await live.db
      .update(h().tags)
      .set(() => ({ name: 'after' }))
      .where(({ tags: t }) => q.eq(t.id, 800n))
      .explain({ analyze: true, rollback: false })
    expect(kept.rolledBack).toBe(false)
    expect(await live.raw(`select name from ${live.fx.ns}.tags where id = 800`)).toStrictEqual([
      ['after'],
    ])
    await live.raw(`delete from ${live.fx.ns}.tags where id = 800`)
  })

  it('a prepared query explains with its parameters bound', async () => {
    const p = live.db
      .from(h().posts)
      .select(({ posts: p2 }) => ({ id: p2.id }))
      .where(({ posts: p2 }) => q.gt(p2.amount, q.placeholder('min', numericCodec)))
      .prepare<{ min: string }>()
    const r = await p.explain({ min: '0.00' })
    expect(typeof r.plan?.['Node Type']).toBe('string')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// db.sql`…` and the description cache (03 §1.4c)
// ─────────────────────────────────────────────────────────────────────────────

describe('the fragment-only statement and its decode-plan cache', () => {
  it('rows are keyed by field name and decoded by OID', async () => {
    const rows = await live.db
      .sql`select 9007199254740993::int8 as big, 10.50::numeric as amt`.execute()
    // The claim is about VALUES: `int8` past 2^53 is a bigint, `numeric` keeps its scale. A
    // name-keyed row of raw strings would fail both.
    expect(rows).toStrictEqual([{ big: 9007199254740993n, amt: '10.50' }])
  })

  it('100 executions build ONE decode plan (the honest form of `03` §1.4c)', async () => {
    clearDescribeCache(true)
    const raw = live.db.sql`select 1::int4 as n`
    for (let i = 0; i < 100; i++) await raw.execute()
    const stats = describeCacheStats()
    // NOT a count of `Parse` messages: in unnamed mode `Parse` goes out per execution by
    // definition, and with `rowMode: 'array'` the RowDescription arrives with every result. What
    // the cache saves is the plan construction, so that is what is counted (09 §3.6).
    expect(stats.builds).toBe(1)
    expect(stats.hits).toBe(99)
  })

  it('a DDL change to the result type invalidates it (0A000 / 42804 family)', async () => {
    clearDescribeCache(true)
    await live.raw(`create table ${live.fx.ns}.cache_probe (v int4)`)
    await live.raw(`insert into ${live.fx.ns}.cache_probe values (1)`)
    const raw = live.db.sql`select v from ${sql.ident([live.fx.ns, 'cache_probe'])}`
    expect(await raw.execute()).toStrictEqual([{ v: 1 }])
    expect(describeCacheStats().builds).toBe(1)

    await live.raw(`alter table ${live.fx.ns}.cache_probe alter column v type text`)
    // The OID signature moved, so the plan is rebuilt rather than reused — and the VALUE proves
    // it: a stale `int4` plan would throw, and a stale one that did not would return a number.
    expect(await raw.execute()).toStrictEqual([{ v: '1' }])
    expect(describeCacheStats().builds).toBe(2)
    await live.raw(`drop table ${live.fx.ns}.cache_probe`)
  })

  it('a builder query never touches the cache — its codecs are static', async () => {
    clearDescribeCache(true)
    await live.db
      .from(h().users)
      .select(({ users: u }) => ({ id: u.id }))
      .execute()
    expect(describeCacheStats().builds).toBe(0)
  })

  it('the raw surface streams and explains too', async () => {
    const seen: unknown[] = []
    for await (const row of live.db.sql`select generate_series(1, 5)::int4 as n`.stream({
      batchSize: 2,
    })) {
      seen.push(row)
    }
    expect(seen).toStrictEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }])
    expect((await live.db.sql`select 1`.explain()).plan).toBeDefined()
  })
})
