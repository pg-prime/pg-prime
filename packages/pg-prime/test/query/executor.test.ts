/**
 * `pgPrime()`'s two invisible decisions: **which registry** a db decodes against, and **how often**
 * a decode plan is built (design/09 WS4/WS6 seam).
 *
 * Both are invisible in the sense that no SQL changes, which is why each needs an oracle that is
 * not the builder: a codec registered on the process-wide default (whose presence or absence is
 * the whole question), and a counting wrapper around `buildDecoder` (whose call count is the
 * whole question). The decoded values are asserted against hand-written expectations either way,
 * so a memo that returned a stale decoder would fail on the value and not only on the count.
 */

import { describe, expect, it, vi } from 'vitest'

const built = vi.hoisted(() => ({ n: 0 }))

vi.mock('../../src/compile/decode.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/compile/decode.js')>(
    '../../src/compile/decode.js',
  )
  return {
    ...actual,
    buildDecoder: (...args: Parameters<typeof actual.buildDecoder>) => {
      built.n += 1
      return actual.buildDecoder(...args)
    },
  }
})

const { defaultRegistry, textCodec } = await import('../../src/codec/index.js')
const { pgPrime } = await import('../../src/query/run.js')
const { defineSchema, pgEnum, pgTable } = await import('../../src/schema/index.js')
const { mockDriver } = await import('./_mock-driver.js')
const { schema } = await import('./_schema.js')

/** The OID the query will decode this column with — `undefined` until a registry has resolved it. */
function oidOfFirstColumn(shape: import('../../src/compile/contract.js').ResultShape): number | undefined {
  if (shape.k !== 'row') throw new Error('expected a row shape')
  const field = shape.fields[0]
  if (field === undefined || field.k !== 'col') throw new Error('expected a column field')
  return field.codec.oid
}

describe('pgPrime() does not decode against the process-wide registry', () => {
  it('an enum resolved on defaultRegistry() is invisible to a db that was given none', () => {
    // The oracle is a *user type's OID*, which is exactly what `02` §4.6 says is per database.
    // `resolveDynamic` writes it into whichever registry it was handed; a db that shares the
    // process-wide one therefore decodes its rows against whatever database resolved first.
    const mood = pgEnum('audit_mood', ['sad', 'ok'])
    const moody = pgTable('moody', (t) => ({ v: t.enum(mood) }))
    const moodSchema = defineSchema({ moody })
    defaultRegistry().register({
      ...textCodec,
      name: 'audit_mood',
      sqlName: '"public"."audit_mood"',
      oid: 90001,
      typeClass: 'enum',
    })

    const shape = (db: ReturnType<typeof pgPrime<typeof moodSchema>>) =>
      db
        .from(moodSchema.h.moody)
        .select(({ moody: m }) => ({ v: m.v }))
        .compile().shape

    // A fresh registry has never met this database, so the codec is still the *pending* one.
    expect(oidOfFirstColumn(shape(pgPrime({ driver: mockDriver(), schema: moodSchema })))).toBeUndefined()
    // Handing the shared one over explicitly still works — this is isolation, not a regression.
    expect(
      oidOfFirstColumn(
        shape(pgPrime({ driver: mockDriver(), schema: moodSchema, registry: defaultRegistry() })),
      ),
    ).toBe(90001)
  })
})

describe('the decode plan is built once per compiled statement', () => {
  it('two executions of one builder build one decoder, and decode the same values', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    const query = db.from(schema.h.users).select(({ users: u }) => ({ id: u.id, email: u.email }))

    driver.rows.push([['7', 'ada@x']], [['8', 'grace@x']])
    built.n = 0
    expect(await query.execute()).toStrictEqual([{ id: 7n, email: 'ada@x' }])
    const afterFirst = built.n
    expect(await query.execute()).toStrictEqual([{ id: 8n, email: 'grace@x' }])

    expect(afterFirst).toBe(1)
    expect(built.n).toBe(1)
  })

  it('a different statement gets its own decoder', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push([['7', 'ada@x']], [['t']])
    built.n = 0
    await db.from(schema.h.users).select(({ users: u }) => ({ id: u.id, email: u.email })).execute()
    expect(
      await db.from(schema.h.posts).select(({ posts: p }) => ({ published: p.published })).execute(),
    ).toStrictEqual([{ published: true }])
    expect(built.n).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// WS6 (design/09 §3.6) — what reaches the wire, and what comes back
// ─────────────────────────────────────────────────────────────────────────────

const { field } = await import('./_mock-driver.js')
const { int8Codec, numericCodec, timestamptzCodec, unknownCodec } = await import(
  '../../src/codec/index.js'
)
const { sql } = await import('../../src/sql/index.js')
const q = await import('../../src/query/types.js')

describe('execute() — the wire shape (03 §1.3)', () => {
  it('sends the SQL, the ALREADY-ENCODED params, and one paramType per param', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push([['7']])

    await db
      .from(schema.h.posts)
      .select(({ posts: p }) => ({ id: p.id }))
      .where(({ posts: p }) => q.gt(p.amount, '10.50'))
      .limit(3)
      .execute()

    const sent = driver.log.at(-1)
    // The oracle is not our own encoder: `numeric` is a precision-exact STRING on the wire and
    // `int4` a decimal one, so a params array of JS values (10.5, 3) would be visibly different.
    expect(sent?.params).toStrictEqual(['10.50', '3'])
    // 1700 = numeric, 23 = int4. A `0` here would mean "infer from context", which is the 42P18
    // that `paramTypesOf` exists to prevent (02 §2.3).
    expect(sent?.paramTypes).toStrictEqual([1700, 23])
    expect(sent?.mode).toBe('unnamed')
    expect(sent?.statementName).toBeUndefined()
  })

  it('executeTakeFirst() is rows[0] over BYTE-IDENTICAL SQL, and never caps the portal', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    const query = db.from(schema.h.users).select(({ users: u }) => ({ id: u.id }))

    driver.rows.push([['7'], ['8']], [['7'], ['8']])
    const all = await query.execute()
    const first = await query.executeTakeFirst()

    expect(all).toStrictEqual([{ id: 7n }, { id: 8n }])
    expect(first).toStrictEqual({ id: 7n })
    const [a, b] = driver.log
    expect(b?.text).toBe(a?.text)
    // `maxRows` CLOSES the portal at the cap, so on an `INSERT … RETURNING` it would stop the
    // statement rather than truncate its output (PgQuery.maxRows). Never sent.
    expect(driver.log.every((r) => !('maxRows' in r))).toBe(true)
  })

  it('executeTakeFirst() on a CHUNKED insert runs every chunk, not just the first', async () => {
    // R10 M5's replacement test. `maxRows: 1` on `compileAll()[0]` is the tempting implementation
    // and it passes every single-statement case; a batch that chunked is where it inserts a fifth
    // of the rows and returns happily (03 §2.6 — one logical batch, N statements, one transaction).
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    // `begin` consumes the first scripted result, then one per chunk.
    driver.rows.push([], [['1']], [['2']], [['3']])
    const first = await db
      .insertInto(schema.h.comments)
      .valuesMany(
        [{ body: 'a' }, { body: 'b' }, { body: 'c' }, { body: 'd' }, { body: 'e' }],
        { strategy: 'values', chunkSize: 2 },
      )
      .returning(({ comments: c }) => ({ id: c.id }))
      .executeTakeFirst()

    expect(first).toStrictEqual({ id: 1n })
    // begin + three inserts + commit. A capped first statement would be one insert and no
    // transaction at all.
    expect(driver.texts().map((t) => t.split(' ')[0])).toStrictEqual([
      'begin',
      'insert',
      'insert',
      'insert',
      'commit',
    ])
  })

  it('executeTakeFirst() on an empty result is undefined, not null and not a throw', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push([])
    expect(
      await db.from(schema.h.users).select(({ users: u }) => ({ id: u.id })).executeTakeFirst(),
    ).toBeUndefined()
  })
})

describe('meta.reads / meta.writes (03 §1.3)', () => {
  const db = pgPrime({ driver: mockDriver(), schema })
  const names = (l: readonly { schema: string; name: string }[]): string[] =>
    l.map((n) => `${n.schema}.${n.name}`)

  it('a select reads its tables and writes none', () => {
    const m = db
      .from(schema.h.users)
      .innerJoin(schema.h.posts, 'p', ({ users: u, p }) => q.eq(p.authorId, u.id))
      .select(({ users: u, p }) => ({ id: u.id, title: p.title }))
      .prepare().meta
    expect(names(m.reads).sort()).toStrictEqual(['public.posts', 'public.users'])
    expect(m.writes).toStrictEqual([])
    expect(m.kind).toBe('select')
  })

  it('an insert writes its target', () => {
    const m = db
      .insertInto(schema.h.comments)
      .values({ body: 'x' })
      .returning(({ comments: c }) => ({ id: c.id }))
      .prepare().meta
    expect(names(m.writes)).toStrictEqual(['public.comments'])
    expect(m.kind).toBe('insert')
  })

  it('an update writes its target', () => {
    const m = db
      .update(schema.h.users)
      .set(() => ({ name: 'x' }))
      .where(({ users: u }) => q.eq(u.id, 1n))
      .returning(({ users: u }) => ({ id: u.id }))
      .prepare().meta
    expect(names(m.writes)).toStrictEqual(['public.users'])
    expect(m.kind).toBe('update')
  })

  it('a delete writes its target', () => {
    const m = db
      .deleteFrom(schema.h.comments)
      .where(({ comments: c }) => q.eq(c.id, 1n))
      .returning(({ comments: c }) => ({ id: c.id }))
      .prepare().meta
    expect(names(m.writes)).toStrictEqual(['public.comments'])
    expect(m.kind).toBe('delete')
  })

  it('a writable CTE writes the CTE table AND reads the outer one', () => {
    const m = db
      .with('gone', (d) =>
        d
          .deleteFrom(schema.h.comments)
          .where(({ comments: c }) => q.eq(c.postId, 1n))
          .returning(({ comments: c }) => ({ id: c.id })),
      )
      .fromCte('gone')
      .select(({ gone: g }) => ({ id: g.id }))
      .prepare().meta
    expect(names(m.writes)).toStrictEqual(['public.comments'])
    // And `reads` is EMPTY, which is the answer worth pinning: a CTE name is not a relation in
    // the catalogue, so a cache keyed on `reads` must not be told to watch `public.gone`. The
    // outer statement genuinely reads nothing but the writable CTE's own output.
    expect(names(m.reads)).toStrictEqual([])
    // The kind is the OUTER statement's; `writes` is what says a plan cache must be invalidated.
    expect(m.kind).toBe('select')
  })
})

describe('untyped fragments decode by OID (03 §3.2)', () => {
  /** `sql`now()`.asUnsafe<Date>()` — no declared codec, so the RowDescription decides. */
  const build = (db: ReturnType<typeof pgPrime<typeof schema>>) =>
    db.from(schema.h.users).select(({ users: u }) => ({
      id: u.id,
      at: sql`now()`.asUnsafe<Date>(),
    }))

  it('the plan carries `unknown` and the executed row carries a Date', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    const query = build(db)

    // The negative control lives in the same test: the COMPILED plan really does declare nothing.
    const planned = query.compile().shape
    if (planned.k !== 'row' || planned.fields[1]?.k !== 'col') throw new Error('bad plan')
    expect(planned.fields[1].codec).toBe(unknownCodec)

    driver.rows.push([['7', '2026-01-02 03:04:05.000006+00']])
    driver.fields.push([field('id', 20), field('at', 1184)])
    expect(await query.execute()).toStrictEqual([
      { id: 7n, at: new Date('2026-01-02T03:04:05.000Z') },
    ])
  })

  it('R4 negative control: with no OID reported, the value stays the raw wire text', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push([['7', '2026-01-02 03:04:05.000006+00']])
    // `fields: []` is what an adapter that reports no metadata gives us. Without a `dataTypeID`
    // there is nothing to resolve, and guessing would be worse than the wire text.
    expect(await build(db).execute()).toStrictEqual([
      { id: 7n, at: '2026-01-02 03:04:05.000006+00' },
    ])
  })

  it('the decoder memo is keyed on the OID signature, so a changed type is not cached', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    const query = build(db)

    driver.rows.push([['7', '2026-01-02 03:04:05+00']])
    driver.fields.push([field('id', 20), field('at', 1184)])
    built.n = 0
    expect((await query.execute())[0]).toStrictEqual({
      id: 7n,
      at: new Date('2026-01-02T03:04:05.000Z'),
    })
    expect(built.n).toBe(1)

    // Same statement, same builder instance, same `Compiled` — and the column is now `text`
    // (25). A memo keyed only on the `Compiled` would hand back the timestamptz decoder and
    // silently answer with a Date built from a string that is no longer a timestamp.
    driver.rows.push([['8', 'hello']])
    driver.fields.push([field('id', 20), field('at', 25)])
    expect((await query.execute())[0]).toStrictEqual({ id: 8n, at: 'hello' })
    expect(built.n).toBe(2)
  })
})

describe('toSQL() (09 WS6 deliverable 9)', () => {
  it('gives the SQL and the encoded binds without touching a database', () => {
    const snap = compileOnlyDb
      .from(schema.h.posts)
      .select(({ posts: p }) => ({ id: p.id }))
      .where(({ posts: p }) => q.eq(p.amount, '1.00'))
      .toSQL()
    expect(snap.sql).toContain('"posts"."amount" = $1')
    expect(snap.params).toStrictEqual(['1.00'])
    expect(snap.placeholders).toStrictEqual([])
  })

  it('does NOT throw on an unfilled placeholder — it names it', () => {
    const snap = compileOnlyDb
      .from(schema.h.posts)
      .select(({ posts: p }) => ({ id: p.id }))
      .where(({ posts: p }) => q.eq(p.amount, q.placeholder('amount', numericCodec)))
      .toSQL()
    expect(snap.params).toStrictEqual([{ placeholder: 'amount' }])
    expect(snap.placeholders).toStrictEqual(['amount'])
  })

  it('a write builder has one too, with the RETURNING list compiled', () => {
    const snap = compileOnlyDb
      .insertInto(schema.h.comments)
      .values({ body: 'hi' })
      .returning(({ comments: c }) => ({ id: c.id }))
      .toSQL()
    expect(snap.sql.startsWith('insert into "public"."comments"')).toBe(true)
    expect(snap.params).toStrictEqual(['hi'])
    expect(snap.meta.kind).toBe('insert')
  })
})

/** Deliberately executor-less: `toSQL()` must work where `execute()` cannot (03 §1.4a). */
const compileOnlyDb = (await import('../../src/query/run.js')).compileOnly(schema)

/** Codecs referenced above but not below; keeps the import list honest under noUnusedLocals. */
void [int8Codec, timestamptzCodec]
