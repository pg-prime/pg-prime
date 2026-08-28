/**
 * Write paths against a real server, tier 1 (design/09 WS4).
 *
 * **Every write is verified by re-reading it with raw SQL, never with the builder** (R1). A write
 * checked by a `select` built from the same code proves only that the two agree; the failure this
 * catches is the one where they agree *and are both wrong* — a column list in the wrong order, an
 * `excluded` reference that resolved to the target row, a `DO UPDATE … WHERE` that never fires.
 *
 * The upsert cases run both branches of the partial-index predicate on purpose: an upsert tested
 * only on the insert branch is an upsert nobody has tested.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectTypeOf } from 'expect-type'
import { int8Codec, numericCodec } from '../../src/codec/index.js'
import * as q from '../../src/query/types.js'
import { sqlState } from '../live/_harness.js'
import { makeLiveDb, type LiveDb } from './_db.js'

let live: LiveDb

beforeAll(async () => {
  live = await makeLiveDb('pgprime_q_writes')
}, 120_000)

afterAll(async () => {
  await live?.end()
})

const h = () => live.fx.schema.h
const ns = () => live.fx.ns

const newUser = (email: string) => ({
  email,
  name: 'New',
  role: 'member' as const,
  tags: ['x'],
  meta: {},
  balance: '3.50',
  createdAt: new Date('2026-07-01T00:00:00Z'),
})

describe('§2.5 — insert … returning', () => {
  it('R3 + raw re-read: what came back is what is in the table', async () => {
    const rows = await live.db
      .insertInto(h().users)
      .values(newUser('ins1@example.com'))
      .returning(({ users: u }) => ({ id: u.id, createdAt: u.createdAt, balance: u.balance }))
      .execute()

    expectTypeOf(rows).toEqualTypeOf<{ id: bigint; createdAt: Date; balance: string }[]>()
    expect(rows).toHaveLength(1)
    const { id, balance } = rows[0]!

    // The oracle: raw SQL, parameterised, straight to the server.
    const raw = await live.raw(
      `select email, name, role, tags, balance, created_at from ${ns()}.users where id = $1`,
      [String(id)],
    )
    expect(raw).toStrictEqual([
      ['ins1@example.com', 'New', 'member', '{x}', '3.50', '2026-07-01 00:00:00+00'],
    ])
    expect(balance).toBe('3.50')
  })

  it('an expression value is evaluated by the server, not sent as a parameter', async () => {
    const built = live.db
      .insertInto(h().users)
      .values({ ...newUser('ins2@example.com'), createdAt: q.fn.now() })
      .returning(({ users: u }) => ({ id: u.id, createdAt: u.createdAt }))

    // `now()` is SQL, not data: it is spliced, and the column contributes no bind slot.
    expect(built.compile().sql).toContain('now()')
    expect(built.compile().binds).toHaveLength(6)

    const before = Date.now()
    const [row] = await built.execute()
    // The value came from the server's clock, and it is a real timestamp near ours.
    expect(row!.createdAt).toBeInstanceOf(Date)
    expect(Math.abs(row!.createdAt.getTime() - before)).toBeLessThan(60_000)
    // Truncated to milliseconds on purpose: `now()` is microsecond-resolution and a JavaScript
    // `Date` is not, so `created_at = $1` is `false` on a real server and only accidentally `true`
    // on one whose clock landed on a whole millisecond. That loss is the documented cost of
    // `timestamptz → Date` (00 sign-off #6); a caller who needs the microseconds asks for the
    // `timestamptz:string` codec, whose whole reason for existing is this line.
    expect(
      await live.raw(
        `select date_trunc('milliseconds', created_at) = $1::timestamptz from ${ns()}.users where id = $2`,
        [row!.createdAt.toISOString(), String(row!.id)],
      ),
    ).toStrictEqual([['t']])
  })

  it('a violated constraint surfaces as a SQLSTATE, not as a message (R13)', async () => {
    await live.db.insertInto(h().users).values(newUser('dup@example.com')).execute()
    const err = await live.db
      .insertInto(h().users)
      .values(newUser('dup@example.com'))
      .execute()
      .catch((e: unknown) => e)
    expect(sqlState(err)).toBe('23505')
  })
})

describe('§2.5 — upsert, both branches of the partial-index predicate', () => {
  const upsert = (email: string, name: string) =>
    live.db
      .insertInto(h().users)
      .values({ ...newUser(email), name })
      .onConflict((c) =>
        c
          .columns((t) => [t.email])
          .where((t) => q.isNull(t.deletedAt))
          .doUpdate((_set, excluded) => ({ name: excluded.name, balance: excluded.balance }))
          .whereUpdate((t, excluded) => q.lt(t.createdAt, excluded.createdAt)),
      )
      .returning(({ users: u }) => ({ id: u.id, name: u.name }))

  it('the insert branch inserts', async () => {
    const rows = await upsert('up1@example.com', 'First').execute()
    expect(rows).toHaveLength(1)
    expect(
      await live.raw(`select name from ${ns()}.users where email = 'up1@example.com'`),
    ).toStrictEqual([['First']])
  })

  it('the update branch updates, and DO UPDATE … WHERE decides whether it fires', async () => {
    await upsert('up2@example.com', 'First').execute()
    const firstId = (
      await live.raw(`select id from ${ns()}.users where email = 'up2@example.com'`)
    )[0]![0]

    // `created_at` is 2026-07-01 for both, so `t.created_at < excluded.created_at` is FALSE:
    // the row is left untouched and RETURNING yields nothing at all.
    const noop = await upsert('up2@example.com', 'Second').execute()
    expect(noop).toStrictEqual([])
    expect(
      await live.raw(`select name from ${ns()}.users where email = 'up2@example.com'`),
    ).toStrictEqual([['First']])

    // Make the incoming row strictly newer, and the same statement writes.
    const rows = await live.db
      .insertInto(h().users)
      .values({
        ...newUser('up2@example.com'),
        name: 'Third',
        createdAt: new Date('2026-08-01T00:00:00Z'),
      })
      .onConflict((c) =>
        c
          .columns((t) => [t.email])
          .where((t) => q.isNull(t.deletedAt))
          .doUpdate((_set, excluded) => ({ name: excluded.name }))
          .whereUpdate((t, excluded) => q.lt(t.createdAt, excluded.createdAt)),
      )
      .returning(({ users: u }) => ({ id: u.id }))
      .execute()
    expect(rows).toHaveLength(1)
    expect(String(rows[0]!.id)).toBe(firstId)
    expect(
      await live.raw(`select name from ${ns()}.users where email = 'up2@example.com'`),
    ).toStrictEqual([['Third']])
  })

  it('`excluded` really is the proposed row, not the target row', async () => {
    await live.db
      .insertInto(h().users)
      .values({ ...newUser('up3@example.com'), tags: ['old'] })
      .execute()
    await live.db
      .insertInto(h().users)
      .values({ ...newUser('up3@example.com'), tags: ['new'] })
      .onConflict((c) =>
        c
          .columns((t) => [t.email])
          .doUpdate((set, excluded) => ({
            tags: q.arrayConcat(set.tags, excluded.tags),
          })),
      )
      .execute()
    // `set.tags || excluded.tags` — the stored row first, the proposed row second.
    expect(
      await live.raw(`select tags from ${ns()}.users where email = 'up3@example.com'`),
    ).toStrictEqual([['{old,new}']])
  })

  it('doNothing swallows the conflict and returns nothing', async () => {
    await live.db.insertInto(h().users).values(newUser('up4@example.com')).execute()
    const rows = await live.db
      .insertInto(h().users)
      .values({ ...newUser('up4@example.com'), name: 'Ignored' })
      .onConflict((c) => c.columns((t) => [t.email]).doNothing())
      .returning(({ users: u }) => ({ id: u.id }))
      .execute()
    expect(rows).toStrictEqual([])
    expect(
      await live.raw(`select name from ${ns()}.users where email = 'up4@example.com'`),
    ).toStrictEqual([['New']])
  })
})

describe('§2.5 — update and delete', () => {
  it('update … set … where … returning, verified with raw SQL', async () => {
    await live.db.insertInto(h().users).values(newUser('upd1@example.com')).execute()
    const rows = await live.db
      .update(h().users)
      .set(({ users: u }) => ({ name: 'Renamed', balance: q.add(u.balance, '1.50') }))
      .where(({ users: u }) => q.eq(u.email, 'upd1@example.com'))
      .returning(({ users: u }) => ({ id: u.id, balance: u.balance }))
      .execute()

    expectTypeOf(rows).toEqualTypeOf<{ id: bigint; balance: string }[]>()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.balance).toBe('5.00')
    expect(
      await live.raw(`select name, balance from ${ns()}.users where email = 'upd1@example.com'`),
    ).toStrictEqual([['Renamed', '5.00']])
  })

  it('bulk update by key applies a different patch per row, in one statement', async () => {
    await live.db
      .insertInto(h().users)
      .valuesMany([newUser('bulk1@example.com'), newUser('bulk2@example.com')])
      .execute()
    const ids = (
      await live.raw(
        `select id from ${ns()}.users where email in ('bulk1@example.com','bulk2@example.com') order by email`,
      )
    ).map((r) => BigInt(r[0]!))

    const built = live.db
      .update(h().users)
      .fromValues(
        [
          { id: ids[0]!, balance: '11.11' },
          { id: ids[1]!, balance: '22.22' },
        ],
        { id: int8Codec, balance: numericCodec },
      )
      .set((_t, v) => ({ balance: v.balance }))
      .where(({ users: u }, v) => q.eq(u.id, v.id))
    expect(built.compile().binds).toHaveLength(4)
    await built.execute()

    expect(
      await live.raw(`select email, balance from ${ns()}.users where id = any($1) order by email`, [
        `{${ids.join(',')}}`,
      ]),
    ).toStrictEqual([
      ['bulk1@example.com', '11.11'],
      ['bulk2@example.com', '22.22'],
    ])
  })

  it('delete with `= any($1)` removes exactly the named rows', async () => {
    await live.db
      .insertInto(h().users)
      .valuesMany([
        newUser('del1@example.com'),
        newUser('del2@example.com'),
        newUser('del3@example.com'),
      ])
      .execute()
    const ids = (
      await live.raw(
        `select id from ${ns()}.users where email in ('del1@example.com','del2@example.com') order by email`,
      )
    ).map((r) => BigInt(r[0]!))

    const rows = await live.db
      .deleteFrom(h().users)
      .where(({ users: u }) => q.inList(u.id, ids))
      .returning(({ users: u }) => ({ id: u.id, email: u.email }))
      .execute()

    expect(rows.map((r) => r.email).sort()).toStrictEqual(['del1@example.com', 'del2@example.com'])
    expect(
      await live.raw(`select email from ${ns()}.users where email like 'del%' order by email`),
    ).toStrictEqual([['del3@example.com']])
  })

  it('an empty in-list deletes nothing — `where false`, not `where true`', async () => {
    const before = await live.raw(`select count(*) from ${ns()}.users`)
    await live.db
      .deleteFrom(h().users)
      .where(({ users: u }) => q.inList(u.id, []))
      .execute()
    expect(await live.raw(`select count(*) from ${ns()}.users`)).toStrictEqual(before)
  })
})

describe('transactions', () => {
  it('a rejected callback rolls the whole thing back', async () => {
    await expect(
      live.db.transaction(async (tx) => {
        await tx.insertInto(h().users).values(newUser('tx1@example.com')).execute()
        throw new Error('nope')
      }),
    ).rejects.toThrowError('nope')
    expect(
      await live.raw(`select count(*) from ${ns()}.users where email = 'tx1@example.com'`),
    ).toStrictEqual([['0']])
  })

  it('a resolved callback commits', async () => {
    const out = await live.db.transaction(async (tx) => {
      const [row] = await tx
        .insertInto(h().users)
        .values(newUser('tx2@example.com'))
        .returning(({ users: u }) => ({ id: u.id }))
        .execute()
      return row!.id
    })
    expect(
      await live.raw(`select id from ${ns()}.users where email = 'tx2@example.com'`),
    ).toStrictEqual([[String(out)]])
  })
})

describe('§2.7 — insert … select writes each value into the column the projection named', () => {
  it('a projection in a DIFFERENT order than the declaration still lands correctly', async () => {
    // `insert into t (cols) select …` is positional, so the column list must follow the
    // *projection*. Taking it in table-declaration order put the e-mail in `name`, the name in
    // `role` and the role in `email` — three text columns, no server error, every row scrambled.
    // The oracle is a raw re-read of the row that was written.
    await live.db
      .insertInto(h().users)
      .values({ ...newUser('src@example.com'), name: 'Ada', role: 'admin' })
      .execute()

    await live.db
      .insertInto(h().users)
      .fromSelect((d) =>
        d
          .from(h().users, 'src')
          .select(({ src }) => ({
            role: src.role,
            balance: src.balance,
            createdAt: src.createdAt,
            meta: src.meta,
            tags: src.tags,
            name: q.concat(src.name, ' copy'),
            email: q.concat(src.email, '.copy'),
          }))
          .where(({ src }) => q.eq(src.email, 'src@example.com')),
      )
      .execute()

    expect(
      await live.raw(
        `select email, name, role::text from ${ns()}.users where email = 'src@example.com.copy'`,
      ),
    ).toStrictEqual([['src@example.com.copy', 'Ada copy', 'admin']])
  })
})

describe('§2.6 — an array column and the two bulk strategies', () => {
  it("'unnest' is refused for a text[] column, and 'values'/'auto' write it correctly", async () => {
    const rows = [
      { ...newUser('arr1@example.com'), tags: ['a', 'b'] },
      { ...newUser('arr2@example.com'), tags: [] },
    ]
    // One array per column would need a `text[][]` parameter — PostgreSQL has no such type, so
    // the codec's leaf encoder was handed an array where it wanted a string (PgEncodeError), and
    // even if it had encoded, `unnest` flattens every dimension and loses the row boundaries.
    expect(() =>
      live.db.insertInto(h().users).valuesMany(rows, { strategy: 'unnest' }).compileAll(),
    ).toThrowError(/unnest/)

    await live.db.insertInto(h().users).valuesMany(rows).execute()
    expect(
      await live.raw(
        `select email, tags::text from ${ns()}.users where email like 'arr_@example.com' order by email`,
      ),
    ).toStrictEqual([
      ['arr1@example.com', '{a,b}'],
      ['arr2@example.com', '{}'],
    ])
  })
})
