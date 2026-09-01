/**
 * Declared views and materialized views against a real server (design/01 §3 row 58, tier 1).
 *
 * Tier 1 is PGlite by default, and PGlite supports `CREATE VIEW`, `CREATE MATERIALIZED VIEW`,
 * `REFRESH` and `REFRESH … CONCURRENTLY` — measured, which is why this file is here and not only
 * under `test/pg/`. What tier 2 adds (`test/pg/views.test.ts`) is the statement log around
 * `REFRESH` and the `55000` a `CONCURRENTLY` without a unique index earns.
 *
 * The two halves that must never disagree sit next to each other, R5-style: the `pgView(...)` /
 * `pgMaterializedView(...)` declarations the builder queries, and the DDL that creates them. In a
 * real project the second half is the kit's — it renders exactly these statements into the
 * repeatables lane — and writing it out here is what makes the test prove the *declaration* is
 * honest rather than prove the emitter agrees with itself.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectTypeOf } from 'expect-type'
import { desc, eq } from '../../src/query/types.js'
import type { RowOf } from '../../src/query/types.js'
import { pgMaterializedView, pgView } from '../../src/schema/index.js'
import { sql } from '../../src/sql/index.js'
import { makeLiveDb, type LiveDb } from './_db.js'

const NS = 'pgprime_q_views'

/** design/05 §3.6 form (b): declared columns + a raw body. */
const activePosts = pgView('active_posts', { schema: NS })
  .columns((t) => ({
    id: t.bigint(),
    authorId: t.bigint(),
    title: t.text(),
  }))
  .with({ securityBarrier: true })
  .as(sql`select id, author_id, title from ${sql.ident(NS, 'posts')} where published`)

/** A matview with a unique index, so `CONCURRENTLY` is available. */
const postCounts = pgMaterializedView('post_counts', { schema: NS })
  .columns((t) => ({ authorId: t.bigint(), posts: t.bigint() }))
  .refreshable({ concurrently: true })
  .as(sql`select author_id, count(*) from ${sql.ident(NS, 'posts')} group by 1`)

/** Form (c): it exists and we do not manage it. Same typing, nothing emitted. */
const legacy = pgView('legacy_titles', { schema: NS })
  .columns((t) => ({ title: t.text() }))
  .existing()

let live: LiveDb

beforeAll(async () => {
  live = await makeLiveDb(NS)
  await live.raw(
    `create view "${NS}"."active_posts" ("id","author_id","title") with (security_barrier = true) ` +
      `as select id, author_id, title from "${NS}"."posts" where published`,
  )
  await live.raw(
    `create materialized view "${NS}"."post_counts" ("author_id","posts") as ` +
      `select author_id, count(*) from "${NS}"."posts" group by 1`,
  )
  await live.raw(`create unique index post_counts_pk on "${NS}"."post_counts" ("author_id")`)
  await live.raw(
    `create view "${NS}"."legacy_titles" ("title") as select title from "${NS}"."posts"`,
  )
}, 120_000)

afterAll(async () => {
  await live?.end()
})

describe('a declared view is a FROM source', () => {
  it('queries with exactly the declared column types, and the server agrees', async () => {
    const q = live.db
      .from(activePosts)
      .select((t) => ({ id: t.active_posts.id, title: t.active_posts.title }))
      .orderBy((t) => t.active_posts.id)
    expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{ id: bigint; title: string }>()

    const rows = await q.execute()
    expect(rows.length).toBeGreaterThan(0)
    // `id` is int8: a bigint, not a number and not a string. That is the whole point of declaring
    // the columns — a CTE handle would have typed it `any` and decoded it by whatever OID arrived.
    for (const r of rows) expect(typeof r.id).toBe('bigint')

    const oracle = await live.raw(`select id, title from "${NS}"."active_posts" order by id`)
    expect(rows.map((r) => [String(r.id), r.title])).toEqual(oracle)
  })

  it('joins a table, in both directions, with the same alias rules', async () => {
    const fromTable = await live.db
      .from(live.db.h.users, 'u')
      .innerJoin(activePosts, 'p', (t) => eq(t.p.authorId, t.u.id))
      .select((t) => ({ email: t.u.email, title: t.p.title }))
      .orderBy((t) => desc(t.p.id))
      .limit(3)
      .execute()
    expect(fromTable.length).toBeGreaterThan(0)
    expectTypeOf<(typeof fromTable)[number]>().toEqualTypeOf<{ email: string; title: string }>()

    const fromView = await live.db
      .from(activePosts)
      .innerJoin(live.db.h.users, 'u', (t) => eq(t.active_posts.authorId, t.u.id))
      .select((t) => ({ title: t.active_posts.title, email: t.u.email }))
      .limit(3)
      .execute()
    expect(fromView.length).toBeGreaterThan(0)
  })

  it('an `.existing()` view is queryable and nothing about it is special at runtime', async () => {
    const rows = await live.db
      .from(legacy)
      .select((t) => ({ title: t.legacy_titles.title }))
      .execute()
    expect(rows.length).toBeGreaterThan(0)
  })

  it('refuses a write at runtime too, with the sentence that says what to do', () => {
    expect(() => live.db.insertInto(activePosts as never)).toThrow(
      /"active_posts" is a view, which is read-only/,
    )
    expect(() => live.db.update(activePosts as never)).toThrow(/read-only/)
    expect(() => live.db.deleteFrom(activePosts as never)).toThrow(/read-only/)
  })
})

describe('refreshMaterializedView', () => {
  const sumOf = async (): Promise<bigint> => {
    const rows = await live.db
      .from(postCounts)
      .select((t) => ({ posts: t.post_counts.posts }))
      .execute()
    return rows.reduce((a, r) => a + r.posts, 0n)
  }

  it('refreshes, and the refreshed rows are visible through the builder', async () => {
    const before = await sumOf()
    expect(before).toBeGreaterThan(0n)

    await live.raw(
      `insert into "${NS}"."posts" (author_id, title, body, amount, published, created_at, tag_ids) ` +
        `select author_id, 'extra', 'b', 1, true, now(), '{}' from "${NS}"."posts" limit 1`,
    )

    // Still stale: a matview is a snapshot, and this is the half people forget.
    expect(await sumOf()).toBe(before)

    await live.db.refreshMaterializedView(postCounts)
    expect(await sumOf()).toBe(before + 1n)
  })

  it("honours the declaration's `concurrently`, and an explicit override", async () => {
    await live.db.refreshMaterializedView(postCounts, { concurrently: true })
    await live.db.refreshMaterializedView(postCounts, { concurrently: false })
  })

  it('works inside a transaction, which is why it is on every handle and not only on Db', async () => {
    await live.db.transaction(async (db) => {
      await db.refreshMaterializedView(postCounts)
    })
  })

  it('refuses anything that is not a materialized view', async () => {
    await expect(live.db.refreshMaterializedView(activePosts as never)).rejects.toThrow(
      /takes a pgMaterializedView/,
    )
  })
})
