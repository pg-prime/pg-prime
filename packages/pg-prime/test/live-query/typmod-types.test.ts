/**
 * `t.raw()` columns whose type carries a typmod, against a real server (tier 1).
 *
 * `char(10)` used to reach the one-byte `"char"` codec (OID 18), so every bound value was cut to
 * its first character and stored as `'h         '` with no error anywhere; the `::char` cast on a
 * bulk insert's first row did the same for `bpchar`. Every write here is re-read with raw SQL.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as q from '../../src/query/types.js'
import { defineSchema, pgTable } from '../../src/schema/index.js'
import { makeLiveDb, type LiveDb } from './_db.js'

const NS = 'pgprime_q_typmod'

const pad = pgTable(
  'pad',
  (t) => ({
    id: t.integer().primaryKey().generatedAlways(),
    c: t.raw('char(10)').$type<string>(),
    v: t.raw('character varying(8)').$type<string>(),
    one: t.raw('"char"').$type<string>(),
    // Single-row only: `::bit` is bit(1), so the bulk paths cannot carry a bit(4) (22026).
    b: t.raw('bit(4)').$type<string>().nullable(),
  }),
  undefined,
  { schema: NS },
)
const schema = defineSchema({ pad })
const p = schema.h.pad

let live: LiveDb
const db = () => live.dbFor(schema)

beforeAll(async () => {
  live = await makeLiveDb(NS)
  await live.conn.execute({
    text: `create table ${NS}.pad (id integer generated always as identity primary key,
      c char(10) not null, v character varying(8) not null, one "char" not null, b bit(4))`,
    params: [],
    mode: 'simple',
  })
}, 120_000)

afterAll(async () => {
  await live?.end()
})

const rows = () => live.raw(`select c, v, one, b from ${NS}.pad order by id`)
const row = (c: string, v: string) => ({ c, v, one: 'x', b: null })

describe('char(n) is bpchar, not "char"', () => {
  it('a single row, a cast first row and an unnest all store the whole value, space-padded', async () => {
    await db()
      .insertInto(p)
      .values({ ...row('hello', 'abc'), b: '1010' })
      .execute()

    const many = db()
      .insertInto(p)
      .valuesMany([row('world', 'de'), row('ab', 'f')])
    expect(many.compile().sql).toContain('$1::bpchar')
    await many.execute()

    const bulk = db()
      .insertInto(p)
      .valuesMany([row('unnest', 'g')], { strategy: 'unnest' })
    expect(bulk.compile().sql).toContain('::bpchar[]')
    await bulk.execute()

    expect(await rows()).toStrictEqual([
      ['hello     ', 'abc', 'x', '1010'],
      ['world     ', 'de', 'x', null],
      ['ab        ', 'f', 'x', null],
      ['unnest    ', 'g', 'x', null],
    ])
  })

  it('reads back through the bpchar codec, padding intact', async () => {
    const got = await db()
      .from(p)
      .select(({ pad: x }) => ({ c: x.c, b: x.b }))
      .where(({ pad: x }) => q.eq(x.v, 'abc'))
      .execute()
    expect(got).toStrictEqual([{ c: 'hello     ', b: '1010' }])
  })
})
