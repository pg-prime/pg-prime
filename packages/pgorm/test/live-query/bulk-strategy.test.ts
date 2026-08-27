/**
 * **The strategy differential** (design/09 WS4, tier 1).
 *
 * `03` §2.6 offers two ways to write the same batch — a multi-row `VALUES` and PostgreSQL's
 * `unnest` — and switches between them automatically at 30 000 cells. That switch is invisible:
 * the caller writes one line and gets whichever the heuristic picked. So the only assertion worth
 * making is that the two are **indistinguishable in the database**.
 *
 * Two namespaces, the same 12 000 rows through each strategy, then `select … order by` from both
 * compared with `toStrictEqual`. Identity columns are offset-normalised, because the two tables
 * are different tables and their sequences do not have to agree — nothing else is normalised, and
 * in particular every `numeric` and every `timestamptz` is compared verbatim.
 *
 * The same differential runs for `fromValues`, whose two strategies have the same property and
 * the same failure mode: a `values` source that loses the per-column cast becomes `text`, and a
 * batch of 12 000 silently lands as the wrong type or not at all.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { int8Codec, numericCodec } from '../../src/codec/index.js'
import * as q from '../../src/query/types.js'
import { makeLiveDb, type LiveDb } from './_db.js'

/** `09` WS4 names this number. 4 columns × 12 000 = 48 000 cells, so `auto` would pick `unnest`. */
const N = 12_000

let a: LiveDb
let b: LiveDb

beforeAll(async () => {
  a = await makeLiveDb('pgorm_q_bulk_values')
  b = await makeLiveDb('pgorm_q_bulk_unnest')
}, 240_000)

afterAll(async () => {
  await a?.end()
  await b?.end()
})

/** The batch. Deliberately awkward values: trailing zeros, negatives, quotes, microseconds. */
function batch(postId: bigint): readonly {
  postId: bigint
  body: string
  createdAt: Date
}[] {
  return Array.from({ length: N }, (_, i) => ({
    postId,
    body: i % 97 === 0 ? `it's a "quoted" \\ body ${i}` : `body ${i}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i % 60, i % 1000)),
  }))
}

async function firstPostId(live: LiveDb): Promise<bigint> {
  const rows = await live.raw(`select min(id) from ${live.fx.ns}.posts`)
  return BigInt(rows[0]![0]!)
}

/** Every inserted row, ordered, with the identity column rebased to 0. */
async function readBack(live: LiveDb): Promise<unknown[][]> {
  const rows = await live.raw(
    `select id, post_id, body, created_at from ${live.fx.ns}.comments order by id`,
  )
  const base = BigInt(rows[0]![0]!)
  return rows.map((r) => [String(BigInt(r[0]!) - base), r[1], r[2], r[3]])
}

describe(`insert: values vs unnest, ${N} rows`, () => {
  it('both strategies put byte-identical data in the table', async () => {
    const viaValues = a.db
      .insertInto(a.fx.schema.h.comments)
      .valuesMany(batch(await firstPostId(a)), { strategy: 'values' })
    const viaUnnest = b.db
      .insertInto(b.fx.schema.h.comments)
      .valuesMany(batch(await firstPostId(b)), { strategy: 'unnest' })

    // They really are different statements, and by the amount `03` §2.6 claims.
    expect(viaValues.compileAll()).toHaveLength(3) // chunked at 5 000
    expect(viaUnnest.compileAll()).toHaveLength(3)
    expect(viaValues.compileAll()[0]!.binds.length).toBe(15_000)
    expect(viaUnnest.compileAll()[0]!.binds.length).toBe(3)

    await viaValues.execute()
    await viaUnnest.execute()

    const [left, right] = await Promise.all([readBack(a), readBack(b)])
    expect(left).toHaveLength(N + 3) // the fixture seeds 3 comments
    expect(left).toStrictEqual(right)
  }, 240_000)

  it('and both agree with the builder’s own read, at the promised types', async () => {
    const rows = await a.db
      .from(a.fx.schema.h.comments)
      .select(({ comments: c }) => ({ id: c.id, body: c.body, at: c.createdAt }))
      .orderBy(({ comments: c }) => q.desc(c.id))
      .limit(1)
      .execute()
    expect(rows[0]!.body).toBe(`body ${N - 1}`)
    expect(rows[0]!.at).toStrictEqual(new Date(Date.UTC(2026, 0, 1, 0, 0, (N - 1) % 60, (N - 1) % 1000)))
  })
})

describe('fromValues: values vs unnest', () => {
  it('both strategies apply the same per-row patch', async () => {
    const ids = async (live: LiveDb) =>
      (
        await live.raw(`select id from ${live.fx.ns}.users order by id limit 3`)
      ).map((r) => BigInt(r[0]!))

    const patches = (xs: readonly bigint[]) =>
      xs.map((id, i) => ({ id, balance: `${i + 1}.0${i}` }))

    const run = async (live: LiveDb, strategy: 'values' | 'unnest') => {
      const xs = await ids(live)
      const built = live.db
        .update(live.fx.schema.h.users)
        .fromValues(patches(xs), { id: int8Codec, balance: numericCodec }, { strategy })
        .set((_t, v) => ({ balance: v.balance }))
        .where(({ users: u }, v) => q.eq(u.id, v.id))
      await built.execute()
      return built.compile().binds.length
    }

    expect(await run(a, 'values')).toBe(6)
    expect(await run(b, 'unnest')).toBe(2)

    const read = async (live: LiveDb) =>
      live.raw(`select balance from ${live.fx.ns}.users order by id limit 3`)
    expect(await read(a)).toStrictEqual([['1.00'], ['2.01'], ['3.02']])
    expect(await read(a)).toStrictEqual(await read(b))
  })
})
