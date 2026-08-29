// design/08 §5's nine cases, four ways: raw `pg`, pg-prime, drizzle-orm, kysely.
//
// ─── The rules, and where they come from ────────────────────────────────────
//
// `08` §5 says the nightly runs "a comparison run against drizzle-orm, kysely and @prisma/client
// on identical queries". Identical queries, one database, one process — so:
//
//   · ONE `pg.Pool`, shared by all four arms. Not four identical pools: a pool is a queue with a
//     `max`, and four of them is four queues. Sharing it removes the last difference that is not
//     the library under test.
//   · The arms are interleaved sample by sample (`sampler.mjs`'s rule for the pairs), so a runner
//     whose neighbour starts a build reports noise without a direction.
//   · Every arm's answer is checked against pg-prime's before anything is timed, through a
//     normaliser that knows the two JavaScript types PostgreSQL text actually needs. Arms that
//     return different answers are not a comparison, they are different jobs.
//
// ─── What the normaliser forgives, and what it does not ─────────────────────
//
// It forgives `bigint` vs a decimal string and `Date` vs an ISO string, because the four
// libraries disagree about which of those a `bigint` or a `timestamptz` column should become and
// that disagreement is a design choice rather than an error. It does NOT forgive a different row
// count, a different column set, a missing nested array or a lossy `number` where the id is past
// 2^53 — the fixture's post ids start at 2^53+1 precisely so that a `number` cannot survive this
// check.

import { asc, eq } from 'drizzle-orm'
import { sql as ksql } from 'kysely'
import { jsonArrayFrom } from 'kysely/helpers/postgres'

/** `1n` and `'1'` are the same id; `new Date(x)` and its ISO string are the same instant. */
export function normalise(v) {
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v
  if (Array.isArray(v)) return v.map(normalise)
  if (v !== null && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = normalise(v[k])
    return out
  }
  return v
}

const show = (v) => JSON.stringify(normalise(v)).slice(0, 300)

/**
 * Check an arm's answer against pg-prime's.
 *
 * Returns `undefined` when they agree and a **divergence record** when they do not — rather than
 * throwing, which is what the first version did and what `bench/runtime/e2e.mjs` does for its
 * pairs. The difference is deliberate and it is the difference between the two files: `e2e.mjs`
 * compares *us* against raw `pg` doing the same job, where a disagreement is a bug in the bench.
 * Here four independent libraries are compared, and a disagreement can be a fact about one of
 * them that the comparison exists to report. Aborting would delete the most interesting output.
 *
 * A divergence is only tolerated where the case declares it in `knownDivergences`, with the
 * reason, and it is printed under the table on every run. An undeclared one still throws.
 */
export function checkAnswer(caseName, armName, got, want, known) {
  const a = JSON.stringify(normalise(got))
  const b = JSON.stringify(normalise(want))
  if (a === b) return undefined
  const why = known?.[armName]
  if (why === undefined) {
    throw new Error(
      `bench/compare: "${armName}" does not return the same answer as pg-prime for "${caseName}", ` +
        `and the case declares no known divergence for it — so timing them together would be ` +
        `meaningless.\n  ${armName}: ${show(got)}\n  pg-prime: ${show(want)}`,
    )
  }
  return { case: caseName, arm: armName, why, got: show(got), want: show(want) }
}

/**
 * Build the nine cases. Every case is `{ name, iters, samples, arms: { … } }`, and every arm is a
 * thunk that returns the answer.
 *
 * `iters` and `samples` are `bench/runtime/e2e.mjs`'s, unchanged, for the reason that file gives:
 * a p99 over 40 samples of a 0.3 ms round trip is the scheduler's worst moment, not the code's.
 */
export async function buildCases({ ns, pool, rawQuery, prime, h, api, drizzle, dz, kysely, kn }) {
  const q = api

  await pool.query(`
    insert into ${ns}.posts (author_id, title, body, amount, published, created_at, tag_ids)
    select (select id from ${ns}.users order by id limit 1),
           'bench post ' || g,
           'body text for bench post number ' || g || ', long enough to look like prose',
           (1000 + (g % 9000))::numeric / 100,
           g % 3 <> 0,
           '2026-04-01T12:34:56.123456Z'::timestamptz + (g || ' seconds')::interval,
           array[]::bigint[]
    from generate_series(1, 1200) g
  `)

  const userId = BigInt((await rawQuery(`select id from ${ns}.users order by id limit 1`))[0].id)
  const postId = BigInt((await rawQuery(`select id from ${ns}.posts order by id limit 1`))[0].id)

  const { rows: disposableRows } = await pool.query({
    text: `insert into ${ns}.comments (post_id, body, created_at)
           select $1::bigint, 'disposable ' || g, '2026-05-01T00:00:00Z'::timestamptz
           from generate_series(1, 4000) g
           returning id`,
    values: [String(postId)],
  })
  const disposable = disposableRows.map((r) => BigInt(r.id))
  let delCursor = 0
  const nextDisposable = () => disposable[delCursor++ % disposable.length]

  let seq = 0
  const nextEmail = () => `cmp-${process.pid}-${seq++}@example.com`

  const newRow = () => ({
    email: nextEmail(),
    name: 'Bench',
    role: 'member',
    tags: ['bench'],
    meta: {},
    balance: '1.00',
    createdAt: new Date('2026-07-01T00:00:00Z'),
  })

  const batchRows = (n) =>
    Array.from({ length: n }, (_u, i) => ({
      postId,
      body: `batch ${i}`,
      createdAt: new Date('2026-07-01T00:00:00Z'),
    }))

  const TWELVE_SQL = `
    select p.id, p.author_id, p.title, p.body, p.amount, p.published, p.created_at,
           a.email, a.name, a.balance, c.id as comment_id, c.body as comment_body
    from ${ns}.posts p
    join ${ns}.users a on p.author_id = a.id
    left join ${ns}.comments c on c.post_id = p.id
    order by p.id
    limit $1`

  return [
    {
      name: 'point select by PK',
      iters: 30,
      samples: 100,
      arms: {
        raw: async () =>
          (
            await rawQuery(`select id, email, name from ${ns}.users where id = $1`, [
              String(userId),
            ])
          )[0],
        'pg-prime': () =>
          prime
            .from(h.users)
            .select(({ users: u }) => ({ id: u.id, email: u.email, name: u.name }))
            .where(({ users: u }) => q.eq(u.id, userId))
            .executeTakeFirst(),
        drizzle: async () =>
          (
            await drizzle
              .select({ id: dz.users.id, email: dz.users.email, name: dz.users.name })
              .from(dz.users)
              .where(eq(dz.users.id, userId))
          )[0],
        kysely: () =>
          kysely
            .selectFrom(kn.users)
            .select(['id', 'email', 'name'])
            .where('id', '=', userId)
            .executeTakeFirst(),
      },
    },
    {
      name: 'select 1 000 rows (12 cols, 2 joins)',
      iters: 2,
      samples: 60,
      arms: {
        raw: () => rawQuery(TWELVE_SQL, ['1000']),
        'pg-prime': () =>
          prime
            .from(h.posts)
            .innerJoin(h.users, 'author', ({ posts: p, author: a }) => q.eq(p.authorId, a.id))
            .leftJoin(h.comments, 'c', ({ posts: p, c }) => q.eq(c.postId, p.id))
            .orderBy(({ posts: p }) => q.asc(p.id))
            .limit(1000)
            .select(({ posts: p, author: a, c }) => ({
              id: p.id,
              author_id: p.authorId,
              title: p.title,
              body: p.body,
              amount: p.amount,
              published: p.published,
              created_at: p.createdAt,
              email: a.email,
              name: a.name,
              balance: a.balance,
              comment_id: c.id,
              comment_body: c.body,
            }))
            .execute(),
        drizzle: () =>
          drizzle
            .select({
              id: dz.posts.id,
              author_id: dz.posts.authorId,
              title: dz.posts.title,
              body: dz.posts.body,
              amount: dz.posts.amount,
              published: dz.posts.published,
              created_at: dz.posts.createdAt,
              email: dz.users.email,
              name: dz.users.name,
              balance: dz.users.balance,
              comment_id: dz.comments.id,
              comment_body: dz.comments.body,
            })
            .from(dz.posts)
            .innerJoin(dz.users, eq(dz.posts.authorId, dz.users.id))
            .leftJoin(dz.comments, eq(dz.comments.postId, dz.posts.id))
            .orderBy(asc(dz.posts.id))
            .limit(1000),
        kysely: () =>
          kysely
            .selectFrom(`${kn.posts} as p`)
            .innerJoin(`${kn.users} as a`, 'p.author_id', 'a.id')
            .leftJoin(`${kn.comments} as c`, 'c.post_id', 'p.id')
            .select([
              'p.id',
              'p.author_id',
              'p.title',
              'p.body',
              'p.amount',
              'p.published',
              'p.created_at',
              'a.email',
              'a.name',
              'a.balance',
              'c.id as comment_id',
              'c.body as comment_body',
            ])
            .orderBy('p.id')
            .limit(1000)
            .execute(),
      },
    },
    {
      name: 'insert one',
      iters: 10,
      samples: 100,
      // Every arm inserts a DIFFERENT row (the email is unique), so only the row count is
      // comparable — the same rule `e2e.mjs` applies to `delete by PK`.
      compare: 'count',
      arms: {
        raw: async () => {
          const r = newRow()
          return (
            await rawQuery(
              `insert into ${ns}.users (email, name, role, tags, meta, balance, created_at)
               values ($1,$2,$3,$4,$5,$6,$7) returning id`,
              [r.email, r.name, r.role, '{bench}', '{}', r.balance, r.createdAt.toISOString()],
            )
          ).length
        },
        'pg-prime': () =>
          prime
            .insertInto(h.users)
            .values(newRow())
            .returning(({ users: u }) => ({ id: u.id }))
            .execute()
            .then((rows) => rows.length),
        drizzle: () =>
          drizzle
            .insert(dz.users)
            .values(newRow())
            .returning({ id: dz.users.id })
            .then((rows) => rows.length),
        kysely: () =>
          kysely
            .insertInto(kn.users)
            .values(() => {
              const r = newRow()
              return {
                email: r.email,
                name: r.name,
                role: r.role,
                tags: ksql`array['bench']::text[]`,
                meta: ksql`'{}'::jsonb`,
                balance: r.balance,
                created_at: r.createdAt,
              }
            })
            .returning('id')
            .execute()
            .then((rows) => rows.length),
      },
    },
    {
      name: 'insert 1 000 (batch)',
      iters: 1,
      samples: 40,
      compare: 'count',
      arms: {
        raw: async () => {
          const values = []
          const params = []
          for (let i = 0; i < 1000; i++) {
            const b = i * 3
            values.push(`($${b + 1}, $${b + 2}, $${b + 3})`)
            params.push(String(postId), `batch ${i}`, '2026-07-01T00:00:00.000Z')
          }
          await rawQuery(
            `insert into ${ns}.comments (post_id, body, created_at) values ${values.join(', ')}`,
            params,
          )
          return 1000
        },
        'pg-prime': () =>
          prime
            .insertInto(h.comments)
            .valuesMany(batchRows(1000))
            .execute()
            .then(() => 1000),
        drizzle: () =>
          drizzle
            .insert(dz.comments)
            .values(batchRows(1000))
            .then(() => 1000),
        kysely: () =>
          kysely
            .insertInto(kn.comments)
            .values(
              batchRows(1000).map((r) => ({
                post_id: r.postId,
                body: r.body,
                created_at: r.createdAt,
              })),
            )
            .execute()
            .then(() => 1000),
      },
    },
    {
      name: 'update by PK',
      iters: 10,
      samples: 100,
      compare: 'count',
      arms: {
        raw: async () =>
          (
            await rawQuery(`update ${ns}.users set name = $1 where id = $2 returning id`, [
              'Renamed',
              String(userId),
            ])
          ).length,
        'pg-prime': () =>
          prime
            .update(h.users)
            .set(() => ({ name: 'Renamed' }))
            .where(({ users: u }) => q.eq(u.id, userId))
            .returning(({ users: u }) => ({ id: u.id }))
            .execute()
            .then((rows) => rows.length),
        drizzle: () =>
          drizzle
            .update(dz.users)
            .set({ name: 'Renamed' })
            .where(eq(dz.users.id, userId))
            .returning({ id: dz.users.id })
            .then((rows) => rows.length),
        kysely: () =>
          kysely
            .updateTable(kn.users)
            .set({ name: 'Renamed' })
            .where('id', '=', userId)
            .returning('id')
            .execute()
            .then((rows) => rows.length),
      },
    },
    {
      name: 'delete by PK',
      iters: 8,
      samples: 60,
      compare: 'count',
      arms: {
        raw: async () =>
          (
            await rawQuery(`delete from ${ns}.comments where id = $1 returning id`, [
              String(nextDisposable()),
            ])
          ).length,
        'pg-prime': () =>
          prime
            .deleteFrom(h.comments)
            .where(({ comments: c }) => q.eq(c.id, nextDisposable()))
            .returning(({ comments: c }) => ({ id: c.id }))
            .execute()
            .then((rows) => rows.length),
        drizzle: () =>
          drizzle
            .delete(dz.comments)
            .where(eq(dz.comments.id, nextDisposable()))
            .returning({ id: dz.comments.id })
            .then((rows) => rows.length),
        kysely: () =>
          kysely
            .deleteFrom(kn.comments)
            .where('id', '=', nextDisposable())
            .returning('id')
            .execute()
            .then((rows) => rows.length),
      },
    },
    {
      name: '5-statement transaction',
      iters: 4,
      samples: 100,
      arms: {
        raw: async () => {
          const conn = await pool.connect()
          try {
            await conn.query('begin')
            let n = 0
            for (let i = 0; i < 5; i++) {
              const r = await conn.query({
                text: `select id from ${ns}.users where id = $1`,
                values: [String(userId)],
              })
              n += r.rows.length
            }
            await conn.query('commit')
            return n
          } finally {
            conn.release()
          }
        },
        'pg-prime': () =>
          prime.transaction(async (tx) => {
            let n = 0
            for (let i = 0; i < 5; i++) {
              n += (
                await tx
                  .from(h.users)
                  .select(({ users: u }) => ({ id: u.id }))
                  .where(({ users: u }) => q.eq(u.id, userId))
                  .execute()
              ).length
            }
            return n
          }),
        drizzle: () =>
          drizzle.transaction(async (tx) => {
            let n = 0
            for (let i = 0; i < 5; i++) {
              n += (
                await tx.select({ id: dz.users.id }).from(dz.users).where(eq(dz.users.id, userId))
              ).length
            }
            return n
          }),
        kysely: () =>
          kysely.transaction().execute(async (tx) => {
            let n = 0
            for (let i = 0; i < 5; i++) {
              n += (await tx.selectFrom(kn.users).select('id').where('id', '=', userId).execute())
                .length
            }
            return n
          }),
      },
    },
    {
      name: 'relation load, one level',
      iters: 2,
      samples: 40,
      knownDivergences: {
        kysely:
          'the nested `bigint` ids come back through a float64, for the same reason as drizzle and ' +
          'from a different API: `jsonArrayFrom` aggregates children with `json_agg` and the ' +
          'result arrives as JSON, so `JSON.parse` turns an id past 2^53 into the nearest double ' +
          'before anything types it. It returns a `number`, not even a wrong `bigint`. ' +
          'pg-prime emits `id::text` INSIDE `json_build_object` and decodes it through the ' +
          'column\u2019s codec, which is why its column is exact — and which is also extra work ' +
          'this comparison charges it for. Measured 2026-08-29 against kysely 0.29.5.',
        drizzle:
          "the nested `bigint` ids come back through a float64. Drizzle's relational query " +
          'aggregates children as JSON and parses them with `JSON.parse`, so a value past 2^53 ' +
          'is rounded before the column\u2019s `mode: \u2019bigint\u2019` ever sees it: for post ids ' +
          '9007199254740993..997 it returns 9007199254740992, ...994, ...996, ...996, ...996 \u2014 ' +
          'the right TYPE, the wrong value, in the right order. The same drizzle query as a FLAT ' +
          '`select` returns all five correctly, so this is the relational builder specifically. ' +
          'Measured here on 2026-08-29 against drizzle-orm 0.45.2; the fixture starts post ids at ' +
          '2^53+1 exactly so that a bench can see it.',
      },
      arms: {
        raw: async () =>
          (
            await rawQuery(`
              select u.id, coalesce(r.v, '[]'::json) as posts
              from ${ns}.users u
              left join lateral (
                select json_agg(x.o) as v
                from (
                  select json_build_object('id', p.id::text, 'title', p.title) as o
                  from ${ns}.posts p where p.author_id = u.id order by p.id limit 5
                ) x
              ) r on true
              order by u.id`)
          ).map((r) => ({ id: r.id, posts: r.posts })),
        'pg-prime': () =>
          prime
            .from(h.users)
            .orderBy(({ users: u }) => q.asc(u.id))
            .select(({ users: u }) => ({
              id: u.id,
              posts: u.posts.many((s) =>
                s
                  .select((p) => ({ id: p.id, title: p.title }))
                  .orderBy((p) => q.asc(p.id))
                  .limit(5),
              ),
            }))
            .execute(),
        drizzle: () =>
          drizzle.query.users.findMany({
            columns: { id: true },
            with: {
              posts: { columns: { id: true, title: true }, orderBy: asc(dz.posts.id), limit: 5 },
            },
            orderBy: asc(dz.users.id),
          }),
        kysely: () =>
          kysely
            .selectFrom(`${kn.users} as u`)
            .select((eb) => [
              'u.id',
              jsonArrayFrom(
                eb
                  .selectFrom(`${kn.posts} as p`)
                  .select(['p.id', 'p.title'])
                  .whereRef('p.author_id', '=', 'u.id')
                  .orderBy('p.id')
                  .limit(5),
              ).as('posts'),
            ])
            .orderBy('u.id')
            .execute(),
      },
    },
    {
      name: 'relation load, two levels',
      iters: 2,
      samples: 40,
      knownDivergences: {
        kysely:
          'the nested `bigint` ids come back through a float64, for the same reason as drizzle and ' +
          'from a different API: `jsonArrayFrom` aggregates children with `json_agg` and the ' +
          'result arrives as JSON, so `JSON.parse` turns an id past 2^53 into the nearest double ' +
          'before anything types it. It returns a `number`, not even a wrong `bigint`. ' +
          'pg-prime emits `id::text` INSIDE `json_build_object` and decodes it through the ' +
          'column\u2019s codec, which is why its column is exact — and which is also extra work ' +
          'this comparison charges it for. Measured 2026-08-29 against kysely 0.29.5.',
        drizzle:
          "the nested `bigint` ids come back through a float64. Drizzle's relational query " +
          'aggregates children as JSON and parses them with `JSON.parse`, so a value past 2^53 ' +
          'is rounded before the column\u2019s `mode: \u2019bigint\u2019` ever sees it: for post ids ' +
          '9007199254740993..997 it returns 9007199254740992, ...994, ...996, ...996, ...996 \u2014 ' +
          'the right TYPE, the wrong value, in the right order. The same drizzle query as a FLAT ' +
          '`select` returns all five correctly, so this is the relational builder specifically. ' +
          'Measured here on 2026-08-29 against drizzle-orm 0.45.2; the fixture starts post ids at ' +
          '2^53+1 exactly so that a bench can see it.',
      },
      arms: {
        raw: async () =>
          (
            await rawQuery(`
              select u.id, coalesce(r.v, '[]'::json) as posts
              from ${ns}.users u
              left join lateral (
                select json_agg(x.o) as v
                from (
                  select json_build_object(
                           'id', p.id::text, 'title', p.title,
                           'comments', coalesce(cr.v, '[]'::json)) as o
                  from ${ns}.posts p
                  left join lateral (
                    select json_agg(y.o) as v
                    from (
                      select json_build_object('id', c.id::text, 'body', c.body) as o
                      from ${ns}.comments c where c.post_id = p.id order by c.id limit 5
                    ) y
                  ) cr on true
                  where p.author_id = u.id order by p.id limit 5
                ) x
              ) r on true
              order by u.id`)
          ).map((r) => ({ id: r.id, posts: r.posts })),
        'pg-prime': () =>
          prime
            .from(h.users)
            .orderBy(({ users: u }) => q.asc(u.id))
            .select(({ users: u }) => ({
              id: u.id,
              posts: u.posts.many((s) =>
                s
                  .select((p) => ({
                    id: p.id,
                    title: p.title,
                    comments: p.comments.many((s2) =>
                      s2
                        .select((c) => ({ id: c.id, body: c.body }))
                        .orderBy((c) => q.asc(c.id))
                        .limit(5),
                    ),
                  }))
                  .orderBy((p) => q.asc(p.id))
                  .limit(5),
              ),
            }))
            .execute(),
        drizzle: () =>
          drizzle.query.users.findMany({
            columns: { id: true },
            with: {
              posts: {
                columns: { id: true, title: true },
                orderBy: asc(dz.posts.id),
                limit: 5,
                with: {
                  comments: {
                    columns: { id: true, body: true },
                    orderBy: asc(dz.comments.id),
                    limit: 5,
                  },
                },
              },
            },
            orderBy: asc(dz.users.id),
          }),
        kysely: () =>
          kysely
            .selectFrom(`${kn.users} as u`)
            .select((eb) => [
              'u.id',
              jsonArrayFrom(
                eb
                  .selectFrom(`${kn.posts} as p`)
                  .select((eb2) => [
                    'p.id',
                    'p.title',
                    jsonArrayFrom(
                      eb2
                        .selectFrom(`${kn.comments} as c`)
                        .select(['c.id', 'c.body'])
                        .whereRef('c.post_id', '=', 'p.id')
                        .orderBy('c.id')
                        .limit(5),
                    ).as('comments'),
                  ])
                  .whereRef('p.author_id', '=', 'u.id')
                  .orderBy('p.id')
                  .limit(5),
              ).as('posts'),
            ])
            .orderBy('u.id')
            .execute(),
      },
    },
  ]
}
