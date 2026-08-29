/**
 * INSERT / upsert / bulk, tier 0 (design/09 WS4; `03` §2.5–2.6, Appendix A).
 *
 * Three groups, in the order a reader should care about them:
 *
 *  1. **Goldens.** `03` §2.5's insert and Appendix A's upsert, byte for byte, from the builder.
 *  2. **The strategy switch and the chunk boundary**, tested at the exact numbers `03` §2.6
 *     names — `rows × columns` at 30 000 and 30 001, rows at 5 000 and 5 001. An off-by-one here
 *     is invisible in production until the batch that straddles it.
 *  3. **What reaches the wire**, through the recording mock: chunks share ONE connection inside
 *     ONE transaction, and open no transaction of their own inside `db.transaction(...)`.
 */

import { describe, expect, it } from 'vitest'
import { textCodec } from '../../src/codec/index.js'
import { BuilderError, TooManyParametersError } from '../../src/sql/errors.js'
import { compileOnly, pgPrime } from '../../src/query/run.js'
import * as q from '../../src/query/types.js'
import { mockDriver } from './_mock-driver.js'
import { schema } from './_schema.js'

const db = compileOnly(schema)
const sqlOf = (b: { compile(): { sql: string } }) => b.compile().sql
const vals = (b: { compile(): { binds: readonly unknown[] } }) =>
  b.compile().binds.map((x) => (x as { encoded?: unknown }).encoded)

const rowsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ email: `u${i}`, name: `n${i}`, role: 'member' }))

describe('§2.5 — insert with RETURNING', () => {
  it('matches Appendix A byte for byte, from the builder', () => {
    const built = db
      .insertInto(schema.h.users)
      .values({ email: 'a@b.c', name: 'Ada', role: 'admin' })
      .returning(({ users: u }) => ({ id: u.id, createdAt: u.createdAt }))
    expect(sqlOf(built)).toBe(
      [
        'insert into "public"."users" ("email", "name", "role") values ($1, $2, $3)',
        'returning "id" as "id", "created_at" as "createdAt"',
      ].join('\n'),
    )
    expect(vals(built)).toStrictEqual(['a@b.c', 'Ada', 'admin'])
    expect(built.compile().meta.writes).toStrictEqual([{ schema: 'public', name: 'users' }])
  })

  it('the column list is the TABLE’s order, not the object literal’s', () => {
    // Same statement either way: a builder whose column order followed `Object.keys` would mint a
    // second prepared statement for the same insert.
    const a = db.insertInto(schema.h.users).values({ email: 'a', name: 'b', role: 'c' })
    const b = db.insertInto(schema.h.users).values({ role: 'c', email: 'a', name: 'b' })
    expect(sqlOf(a)).toBe(sqlOf(b))
    expect(vals(a)).toStrictEqual(vals(b))
  })

  it('an expression may stand in for any value', () => {
    const built = db
      .insertInto(schema.h.users)
      .values({ email: 'a', name: 'b', role: 'c', createdAt: q.fn.now() })
    expect(sqlOf(built)).toBe(
      'insert into "public"."users" ("email", "name", "role", "created_at") ' +
        'values ($1, $2, $3, now())',
    )
  })

  it('returningAll projects every column, unqualified', () => {
    expect(sqlOf(db.insertInto(schema.h.users).defaultValues().returningAll())).toBe(
      [
        'insert into "public"."users" () default values',
        'returning "id" as "id", "email" as "email", "name" as "name", "role" as "role", ' +
          '"meta" as "meta", "created_at" as "createdAt", "deleted_at" as "deletedAt"',
      ].join('\n'),
    )
  })

  it('a column the table does not have is named, not silently dropped', () => {
    expect(() =>
      db.insertInto(schema.h.users).values({ email: 'a', name: 'b', role: 'c', nope: 1 } as never),
    ).toThrowError(/names column\(s\) \[nope\] that "users" does not have/)
  })
})

describe('Appendix A — upsert with a partial-index predicate, EXCLUDED, and DO UPDATE WHERE', () => {
  it('emits all four clauses, in PostgreSQL’s order', () => {
    const built = db
      .insertInto(schema.h.users)
      .values({ email: 'a@b.c', name: 'Ada', role: 'admin' })
      .onConflict((c) =>
        c
          .columns((t) => [t.email])
          .where((t) => q.isNull(t.deletedAt))
          .doUpdate((set, excluded) => ({
            name: excluded.name,
            meta: excluded.meta,
            createdAt: q.fn.now(),
          }))
          .whereUpdate((t, excluded) => q.lt(t.createdAt, excluded.createdAt)),
      )
      .returning(({ users: u }) => ({ id: u.id }))

    expect(sqlOf(built)).toBe(
      [
        'insert into "public"."users" ("email", "name", "role") values ($1, $2, $3)',
        'on conflict ("email") where "users"."deleted_at" is null',
        'do update set "name" = "excluded"."name", "meta" = "excluded"."meta", ' +
          '"created_at" = now()',
        'where "users"."created_at" < "excluded"."created_at"',
        'returning "id" as "id"',
      ].join('\n'),
    )
    expect(vals(built)).toStrictEqual(['a@b.c', 'Ada', 'admin'])
  })

  it('do nothing, a named constraint, and an expression index', () => {
    const base = db.insertInto(schema.h.users).values({ email: 'a', name: 'b', role: 'c' })
    expect(sqlOf(base.onConflict((c) => c.columns((t) => [t.email]).doNothing()))).toContain(
      'on conflict ("email")\ndo nothing',
    )
    expect(sqlOf(base.onConflict((c) => c.constraint('users_email_key').doNothing()))).toContain(
      'on conflict on constraint "users_email_key"\ndo nothing',
    )
    expect(
      sqlOf(
        base.onConflict((c) =>
          c.expressions((t) => [q.sql`lower(${t.email})`.as(textCodec)]).doNothing(),
        ),
      ),
    ).toContain('on conflict (lower("users"."email"))')
  })

  it('the two `where`s are different clauses and cannot be confused', () => {
    const base = db.insertInto(schema.h.users).values({ email: 'a', name: 'b', role: 'c' })
    // The index predicate needs a target; a named constraint has none.
    expect(() =>
      base.onConflict((c) => c.constraint('x').where((t) => q.isNull(t.deletedAt))),
    ).toThrowError(/partial-index predicate/)
    // `DO UPDATE … WHERE` needs a DO UPDATE.
    expect(() =>
      base.onConflict((c) => c.columns((t) => [t.email]).whereUpdate((t) => q.isNull(t.deletedAt))),
    ).toThrowError(/needs \.doUpdate\(\.\.\.\) first/)
  })
})

describe('§2.6 — the two bulk strategies and the automatic switch', () => {
  it('multi-row VALUES casts row 1 only', () => {
    expect(sqlOf(db.insertInto(schema.h.users).valuesMany(rowsOf(2)))).toBe(
      'insert into "public"."users" ("email", "name", "role") values ' +
        '($1::varchar, $2::text, $3::text), ($4, $5, $6)',
    )
  })

  it('unnest is one parameter per column, whatever the row count', () => {
    const built = db.insertInto(schema.h.users).valuesMany(rowsOf(3), { strategy: 'unnest' })
    expect(sqlOf(built)).toBe(
      [
        'insert into "public"."users" ("email", "name", "role")',
        'select * from unnest($1::varchar[], $2::text[], $3::text[])',
      ].join('\n'),
    )
    expect(vals(built)).toStrictEqual(['{u0,u1,u2}', '{n0,n1,n2}', '{member,member,member}'])
    expect(built.compile().binds).toHaveLength(3)
  })

  it('auto switches at rows × columns > 30 000 — exactly there, not near there', () => {
    // ONE column, so `rows` IS `cells` and the boundary is reachable to the row. With three
    // columns the two sides of the comparison are 30 000 and 30 003, and an implementation whose
    // threshold was 30 001 would pass — R10 M9 proved exactly that.
    const oneCol = (n: number) =>
      db.insertInto(schema.h.comments).valuesMany(
        Array.from({ length: n }, (_, i) => ({ body: `b${i}` })),
        { chunkSize: 1e6 },
      )
    expect(sqlOf(oneCol(30_000))).toContain(' values ')
    expect(sqlOf(oneCol(30_001))).toContain('select * from unnest(')

    // …and the same switch through the documented three-column shape.
    const wide = (n: number) =>
      db.insertInto(schema.h.users).valuesMany(rowsOf(n), { chunkSize: 1e6 })
    expect(sqlOf(wide(10_000))).toContain(' values ')
    expect(sqlOf(wide(10_001))).toContain('select * from unnest(')
  })

  it('chunks at 5 000 rows — 5 000 is one statement, 5 001 is two', () => {
    const all = (n: number) =>
      db.insertInto(schema.h.users).valuesMany(rowsOf(n), { strategy: 'values' }).compileAll()
    expect(all(5_000)).toHaveLength(1)
    expect(all(5_001)).toHaveLength(2)
    // …and the split is 5 000 + 1, not 2 500 + 2 501.
    expect(all(5_001)[0]!.binds).toHaveLength(15_000)
    expect(all(5_001)[1]!.binds).toHaveLength(3)
  })

  it('toAst() refuses to describe a chunked batch, and says what to call instead', () => {
    const built = db.insertInto(schema.h.users).valuesMany(rowsOf(5_001), { strategy: 'values' })
    expect(() => built.toAst()).toThrowError(/2 statements \(chunked at 5000 rows\)/)
    expect(built.compileAll()).toHaveLength(2)
  })

  it('the 65 535 wire ceiling throws a typed error naming the statement', () => {
    const built = db
      .insertInto(schema.h.users)
      .valuesMany(rowsOf(21_846), { strategy: 'values', chunkSize: 1e6 })
    expect(() => built.compileAll()).toThrowError(TooManyParametersError)
    expect(() => built.compileAll()).toThrowError(
      'compiled insert uses 65538 bind parameters; the PostgreSQL wire protocol caps ' +
        "parameters at 65535. Use strategy: 'unnest' or chunk the batch.",
    )
  })

  it('rows that differ only in a boolean or enum VALUE are one batch, not a heterogeneous one', () => {
    // The type-level guard used to ask "did `R` come out a union?", and a column whose type IS a
    // union (`boolean` is `true | false`) keeps its literal type through inference — so this
    // perfectly rectangular batch was refused at compile time with a message about columns. Found
    // while writing the getting-started page (design/12 §4 D). The runtime never had the bug: it
    // compares `Object.keys` per row, which is what the type now mirrors.
    const built = db.insertInto(schema.h.posts).valuesMany([
      { authorId: 1n, title: 'a', amount: '1', published: true, createdAt: new Date(0) },
      { authorId: 2n, title: 'b', amount: '2', published: false, createdAt: new Date(0) },
    ])
    expect(built.compileAll()).toHaveLength(1)
    expect(sqlOf(built)).toContain(
      'insert into "public"."posts" ("author_id", "title", "amount", "published", "created_at") values',
    )
    // `t` / `f` is the bool codec's encoding; the point is that both rows made it into one
    // statement's bind list with their own value.
    expect(vals(built).slice(3, 4)).toStrictEqual(['t'])
    expect(vals(built).slice(8, 9)).toStrictEqual(['f'])
  })

  it('every row must set the same columns — a missing key is named, never NULLed', () => {
    expect(() =>
      db
        .insertInto(schema.h.users)
        .valuesMany([{ email: 'a', name: 'b', role: 'c' }, { email: 'd', name: 'e' } as never]),
    ).toThrowError(/Row 1 sets \[email, name\]; row 0 sets \[email, name, role\]/)
  })
})

describe('what reaches the wire (the recording mock)', () => {
  const setup = () => {
    const driver = mockDriver()
    return { driver, db: pgPrime({ driver, schema }) }
  }

  it('a chunked insert wraps its chunks in ONE transaction on ONE connection', async () => {
    const { driver, db: live } = setup()
    await live
      .insertInto(schema.h.users)
      .valuesMany(rowsOf(5_001), { strategy: 'values' })
      .execute()
    const texts = driver.log.map((r) => r.text.split('\n')[0]!.slice(0, 12))
    expect(texts[0]).toBe('begin')
    expect(texts.at(-1)).toBe('commit')
    expect(texts.filter((t) => t.startsWith('insert into'))).toHaveLength(2)
    expect(driver.acquired).toBe(1)
  })

  it('an unchunked insert opens no transaction at all', async () => {
    const { driver, db: live } = setup()
    await live.insertInto(schema.h.users).values({ email: 'a', name: 'b', role: 'c' }).execute()
    expect(driver.log.map((r) => r.text)).toHaveLength(1)
    expect(driver.log[0]!.text).toContain('insert into')
  })

  it('inside db.transaction(...) the chunks do NOT open a second one', async () => {
    const { driver, db: live } = setup()
    await live.transaction(async (tx) => {
      await tx
        .insertInto(schema.h.users)
        .valuesMany(rowsOf(5_001), { strategy: 'values' })
        .execute()
    })
    expect(driver.log.filter((r) => r.text === 'begin')).toHaveLength(1)
    expect(driver.log.filter((r) => r.text === 'commit')).toHaveLength(1)
    expect(driver.acquired).toBe(1)
  })

  it('a failed chunk rolls back and rethrows', async () => {
    const { driver, db: live } = setup()
    driver.failOn = (query) => (query.params.length === 3 ? new Error('boom') : undefined)
    await expect(
      live.insertInto(schema.h.users).valuesMany(rowsOf(5_001), { strategy: 'values' }).execute(),
    ).rejects.toThrowError('boom')
    expect(driver.log.map((r) => r.text).filter((t) => t === 'rollback')).toHaveLength(1)
    expect(driver.log.map((r) => r.text)).not.toContain('commit')
  })

  it('parameters reach the wire already encoded, with their declared OIDs', async () => {
    const { driver, db: live } = setup()
    await live.insertInto(schema.h.users).values({ email: 'a', name: 'b', role: 'c' }).execute()
    expect(driver.log[0]!.params).toStrictEqual(['a', 'b', 'c'])
  })
})

describe('§2.7 — insert … select puts each value in the column the projection named', () => {
  it('the column list follows the PROJECTION, not the table declaration', () => {
    // `insert into t (cols) select …` is POSITIONAL. The table's declaration order is
    // (id, email, name, role, …); this projection is spelled (role, name, email). Taking the
    // column list in declaration order wrote `email` into `role` and `role` into `email` — legal
    // SQL, three text columns, no error, every row scrambled.
    const built = db
      .insertInto(schema.h.users)
      .fromSelect((d) =>
        d
          .from(schema.h.users, 'src')
          .select(({ src }) => ({ role: src.name, name: src.email, email: src.role })),
      )
    expect(sqlOf(built)).toBe(
      [
        'insert into "public"."users" ("role", "name", "email")',
        'select "src"."name" as "role", "src"."email" as "name", "src"."role" as "email"',
        'from "public"."users" as "src"',
      ].join('\n'),
    )
  })

  it('a projection naming a column the table does not have is refused', () => {
    expect(() =>
      db
        .insertInto(schema.h.users)
        .fromSelect((d) => d.from(schema.h.users, 'src').select(({ src }) => ({ nope: src.id }))),
    ).toThrowError(BuilderError)
  })
})
