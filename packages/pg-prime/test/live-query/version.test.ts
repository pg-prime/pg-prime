/**
 * `executeRowCount()` and `.ifVersion()` against a server, tier 1: the count is the command tag's,
 * and a conflict inside `db.transaction()` rolls back what the batch already wrote.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { VersionConflictError } from '../../src/errors/index.js'
import * as q from '../../src/query/types.js'
import { defineSchema, pgTable } from '../../src/schema/index.js'
import { makeLiveDb, type LiveDb } from './_db.js'

const NS = 'pgprime_q_version'

const blocks = pgTable(
  'blocks',
  (t) => ({
    id: t.bigint().primaryKey(),
    text: t.text(),
    rev: t.integer(),
  }),
  undefined,
  { schema: NS },
)
const schema = defineSchema({ blocks })
const b = schema.h.blocks

let live: LiveDb
const db = () => live.dbFor(schema)

beforeAll(async () => {
  live = await makeLiveDb(NS)
  await live.conn.execute({
    text: `create table ${NS}.blocks (id bigint primary key, text text not null, rev integer not null)`,
    params: [],
    mode: 'simple',
  })
}, 120_000)

beforeEach(async () => {
  await live.conn.execute({
    text: `truncate ${NS}.blocks; insert into ${NS}.blocks values (1, 'a', 1), (2, 'b', 1), (3, 'c', 1)`,
    params: [],
    mode: 'simple',
  })
})

afterAll(async () => {
  await live?.end()
})

const rows = () => live.raw(`select id, text, rev from ${NS}.blocks order by id`)

describe('executeRowCount()', () => {
  it('update: 0, 1 and N, with and without RETURNING', async () => {
    const upd = (ids: bigint[]) =>
      db()
        .update(b)
        .set(({ blocks: x }) => ({ rev: q.add(x.rev, 1) }))
        .where(({ blocks: x }) => q.inList(x.id, ids))
    expect(await upd([]).executeRowCount()).toBe(0)
    expect(await upd([1n]).executeRowCount()).toBe(1)
    expect(await upd([1n, 2n, 3n]).executeRowCount()).toBe(3)
    expect(
      await upd([9n])
        .returning(({ blocks: x }) => ({ id: x.id }))
        .executeRowCount(),
    ).toBe(0)
    expect(await upd([2n, 3n]).returningAll().executeRowCount()).toBe(2)
    expect(await rows()).toStrictEqual([
      ['1', 'a', '3'],
      ['2', 'b', '3'],
      ['3', 'c', '3'],
    ])
  })

  it('delete: 0, 1 and N, with and without RETURNING', async () => {
    const del = (ids: bigint[]) =>
      db()
        .deleteFrom(b)
        .where(({ blocks: x }) => q.inList(x.id, ids))
    expect(await del([9n]).executeRowCount()).toBe(0)
    expect(
      await del([1n])
        .returning(({ blocks: x }) => ({ id: x.id }))
        .executeRowCount(),
    ).toBe(1)
    expect(await del([2n, 3n]).executeRowCount()).toBe(2)
    expect(await rows()).toStrictEqual([])
  })
})

describe('.ifVersion()', () => {
  const bump = (h: ReturnType<typeof db>, id: bigint, rev: number) =>
    h
      .update(b)
      .set(({ blocks: x }) => ({ text: 'new', rev: q.add(x.rev, 1) }))
      .where(({ blocks: x }) => q.eq(x.id, id))
      .ifVersion(({ blocks: x }) => x.rev, rev)

  it('a match runs and returns as usual', async () => {
    const [row] = await bump(db(), 1n, 1)
      .returning(({ blocks: x }) => ({ rev: x.rev }))
      .execute()
    expect(row).toStrictEqual({ rev: 2 })
    expect(await bump(db(), 2n, 1).executeRowCount()).toBe(1)
    expect(
      await db()
        .deleteFrom(b)
        .where(({ blocks: x }) => q.eq(x.id, 3n))
        .ifVersion(({ blocks: x }) => x.rev, 1)
        .executeRowCount(),
    ).toBe(1)
    expect(await rows()).toStrictEqual([
      ['1', 'new', '2'],
      ['2', 'new', '2'],
    ])
  })

  it('a stale version throws, from delete too', async () => {
    await expect(bump(db(), 1n, 0).execute()).rejects.toBeInstanceOf(VersionConflictError)
    await expect(
      db()
        .deleteFrom(b)
        .where(({ blocks: x }) => q.eq(x.id, 1n))
        .ifVersion(({ blocks: x }) => x.rev, 5)
        .execute(),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT', table: 'blocks' })
    expect((await rows())[0]).toStrictEqual(['1', 'a', '1'])
  })

  const paths: [string, (h: ReturnType<typeof db>) => Promise<unknown>][] = [
    ['execute()', (h) => bump(h, 2n, 0).execute()],
    ['executeTakeFirst()', (h) => bump(h, 2n, 0).executeTakeFirst()],
    ['executeRowCount()', (h) => bump(h, 2n, 0).executeRowCount()],
    ['tx.run(q)', (h) => h.run(bump(h, 2n, 0))],
    ['tx.run(q.compile())', (h) => h.run(bump(h, 2n, 0).compile())],
    ['prepare().execute()', (h) => bump(h, 2n, 0).prepare().execute({})],
  ]
  it.each(paths)('a conflict via %s rolls back the earlier write', async (_, conflicting) => {
    let conflict: unknown
    await expect(
      db().transaction(async (tx) => {
        expect(await bump(tx as never, 1n, 1).executeRowCount()).toBe(1)
        await conflicting(tx as never).catch((e: unknown) => {
          conflict = e
          throw e
        })
        await bump(tx as never, 3n, 1).execute()
      }),
    ).rejects.toSatisfy((e) => e === conflict)
    expect(conflict).toBeInstanceOf(VersionConflictError)
    expect(await rows()).toStrictEqual([
      ['1', 'a', '1'],
      ['2', 'b', '1'],
      ['3', 'c', '1'],
    ])
  })

  it('a caught conflict leaves the transaction usable', async () => {
    await db().transaction(async (tx) => {
      await expect(bump(tx as never, 2n, 0).execute()).rejects.toBeInstanceOf(VersionConflictError)
      await bump(tx as never, 1n, 1).execute()
    })
    expect((await rows())[0]).toStrictEqual(['1', 'new', '2'])
  })
})
