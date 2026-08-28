// design/08 §5's nine core cases, as pairs: `raw()` is `pg` with
// `query({ rowMode: 'array' })` plus a hand mapper, `orm()` is the same answer through the builder.
//
// ─── The rules the shape of this file comes from (design/08 §5) ─────────────
//
//   "every case is a pair … against the same database, the same query, the same connection
//    settings, interleaved in the same process to cancel drift. We report
//    overhead_p50 = orm_p50 / raw_p50 and overhead_p99, never absolute milliseconds in isolation."
//
// So: two `pg.Pool`s with identical options (one under the driver, one raw), one process, and
// `samplePairedAsync` alternates the two sides sample by sample. The gate is the ratio.
//
// ─── And the rule about where it runs ───────────────────────────────────────
//
// Not on a shared runner as a PR gate, and never on PGlite. PGlite is a WASM build talking over an
// in-process bridge: its absolute latency is not a PostgreSQL number and its *ratio* is dominated
// by the bridge rather than by our overhead, so a 1.15x gate there would measure the wrong thing in
// both directions. `run.mjs` skips this whole section unless `PG_PRIME_TEST_URL` is set.
//
// ─── The oracle ─────────────────────────────────────────────────────────────
//
// Every pair is checked for value equality before it is timed (`assertSamePair`). Two sides that
// return different answers are not a benchmark, they are two different jobs — and the failure mode
// this catches is real: a raw query that forgot `order by`, or a mapper that returned `Number` where
// the builder returns `bigint`, would otherwise show up as "the ORM is 1.4x slower" rather than as
// "the oracle is wrong".

import { handMapRows, handMapUsers } from './hand-mapper.mjs'
import { samplePairedAsync } from './sampler.mjs'

/** Deep equality that knows about the two JavaScript types PostgreSQL text actually needs. */
export function sameValue(a, b) {
  if (a === b) return true
  if (typeof a === 'bigint' || typeof b === 'bigint') return typeof a === typeof b && a === b
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (!sameValue(a[k], b[k])) return false
  return true
}

function assertSamePair(name, ormOut, rawOut) {
  if (sameValue(ormOut, rawOut)) return
  const show = (v) =>
    JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x)).slice(0, 400)
  throw new Error(
    `bench/runtime: the "${name}" pair does not return the same answer, so the ratio would be ` +
      `meaningless.\n  orm: ${show(ormOut)}\n  raw: ${show(rawOut)}`,
  )
}

/**
 * Rows the write cases consume, minted up front so no case pays for `nextval`-shaped setup inside
 * the timing loop, and so "delete by PK" always has a row to delete (R6: deterministic).
 */
async function seedDisposable(pool, ns, howMany) {
  const { rows } = await pool.query({
    text: `insert into ${ns}.comments (post_id, body, created_at)
           select p.id, 'disposable ' || g, '2026-05-01T00:00:00Z'::timestamptz
           from generate_series(1, $1) g
           cross join lateral (select id from ${ns}.posts order by id limit 1) p
           returning id`,
    values: [howMany],
    rowMode: 'array',
  })
  return rows.map((r) => BigInt(r[0]))
}

/**
 * The nine cases. Each is `{ name, iters, samples, orm, raw }`; `run.mjs` checks the pair, then
 * times it.
 *
 * **`iters` x `samples` is chosen per case, and the reason is the p99.** design/08 §5 gates a p99
 * ratio, and a p99 over 40 samples of a 0.3 ms round trip is the 40th-of-40 sample — i.e. the
 * scheduler's worst moment, not the code's. So `iters` is sized to put each sample near 5-10 ms and
 * `samples` is 60-100 on the cheap cases, which is what makes the 99th percentile a percentile.
 * The expensive cases (the relation loads, at ~65 and ~90 ms) go the other way: one call is already
 * a sample, and 40 of them is a minute of wall clock.
 *
 * `08` §5 names nine and the builder expresses all nine, so nothing here is a substitution. Where
 * the raw side needs SQL, the SQL is written out in full rather than assembled, because it is the
 * oracle and the PR reviews it as SQL (R2).
 */
export async function buildCases({ db, api, pool, rawQuery, rawTypes, ns, h }) {
  const q = api

  // ── a big enough table for the 1 000-row case ─────────────────────────────
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

  const pointUserId = BigInt(
    (await rawQuery(`select id from ${ns}.users order by id limit 1`, []))[0][0],
  )
  const firstPostId = BigInt(
    (await rawQuery(`select id from ${ns}.posts order by id limit 1`, []))[0][0],
  )

  const disposable = await seedDisposable(pool, ns, 2500)
  let delCursor = 0
  const nextDisposable = () => {
    const id = disposable[delCursor++ % disposable.length]
    return id
  }

  let seq = 0
  const nextEmail = () => `bench-${process.pid}-${seq++}@example.com`

  // ── the twelve-column join both the decode bench and case 2 use ───────────
  const TWELVE_SQL = `
    select p.id, p.author_id, p.title, p.body, p.amount, p.published, p.created_at,
           a.email, a.name, a.balance, c.id, c.body
    from ${ns}.posts p
    join ${ns}.users a on p.author_id = a.id
    left join ${ns}.comments c on c.post_id = p.id
    order by p.id
    limit $1`

  const twelveOrm = (limit) =>
    db
      .from(h.posts)
      .innerJoin(h.users, 'author', ({ posts: p, author: a }) => q.eq(p.authorId, a.id))
      .leftJoin(h.comments, 'c', ({ posts: p, c }) => q.eq(c.postId, p.id))
      .orderBy(({ posts: p }) => q.asc(p.id))
      .limit(limit)
      .select(({ posts: p, author: a, c }) => ({
        id: p.id,
        authorId: p.authorId,
        title: p.title,
        body: p.body,
        amount: p.amount,
        published: p.published,
        createdAt: p.createdAt,
        authorEmail: a.email,
        authorName: a.name,
        authorBalance: a.balance,
        commentId: c.id,
        commentBody: c.body,
      }))

  // ── 8/9: the relation loads, and the LATERAL + json_agg they must match ───
  const ONE_LEVEL_SQL = `
    select u.id, coalesce(r.v, '[]'::json)
    from ${ns}.users u
    left join lateral (
      select json_agg(x.o) as v
      from (
        select json_build_object('id', p.id::text, 'title', p.title) as o
        from ${ns}.posts p
        where p.author_id = u.id
        order by p.id
        limit 5
      ) x
    ) r on true
    order by u.id`

  const TWO_LEVEL_SQL = `
    select u.id, coalesce(r.v, '[]'::json)
    from ${ns}.users u
    left join lateral (
      select json_agg(x.o) as v
      from (
        select json_build_object(
                 'id', p.id::text,
                 'title', p.title,
                 'comments', coalesce(cr.v, '[]'::json)
               ) as o
        from ${ns}.posts p
        left join lateral (
          select json_agg(y.o) as v
          from (
            select json_build_object('id', c.id::text, 'body', c.body) as o
            from ${ns}.comments c
            where c.post_id = p.id
            order by c.id
            limit 5
          ) y
        ) cr on true
        where p.author_id = u.id
        order by p.id
        limit 5
      ) x
    ) r on true
    order by u.id`

  /** The hand mapper for the relation payloads: `id` arrived as `::text`, so it is a `bigint`. */
  const mapOneLevel = (rows) =>
    rows.map((r) => ({
      id: BigInt(r[0]),
      posts: (typeof r[1] === 'string' ? JSON.parse(r[1]) : r[1]).map((p) => ({
        id: BigInt(p.id),
        title: p.title,
      })),
    }))

  const mapTwoLevel = (rows) =>
    rows.map((r) => ({
      id: BigInt(r[0]),
      posts: (typeof r[1] === 'string' ? JSON.parse(r[1]) : r[1]).map((p) => ({
        id: BigInt(p.id),
        title: p.title,
        comments: p.comments.map((c) => ({ id: BigInt(c.id), body: c.body })),
      })),
    }))

  return [
    {
      name: 'point select by PK',
      // A point select is ~0.25 ms, so one call per sample makes every sample a coin flip against
      // the scheduler. 30 calls per sample puts each one at ~8 ms, which is where the percentile
      // of 60 samples starts describing the code rather than the machine.
      iters: 30,
      samples: 100,
      orm: () =>
        db
          .from(h.users)
          .select(({ users: u }) => ({ id: u.id, email: u.email, name: u.name }))
          .where(({ users: u }) => q.eq(u.id, pointUserId))
          .executeTakeFirst(),
      raw: async () =>
        handMapUsers(
          await rawQuery(`select id, email, name from ${ns}.users where id = $1`, [
            String(pointUserId),
          ]),
        )[0],
    },
    {
      name: 'select 1 000 rows (12 cols, 2 joins)',
      iters: 2,
      samples: 60,
      orm: () => twelveOrm(1000).execute(),
      raw: async () => handMapRows(await rawQuery(TWELVE_SQL, ['1000'])),
    },
    {
      name: 'insert one',
      iters: 10,
      samples: 100,
      orm: () =>
        db
          .insertInto(h.users)
          .values({
            email: nextEmail(),
            name: 'Bench',
            role: 'member',
            tags: ['bench'],
            meta: {},
            balance: '1.00',
            createdAt: new Date('2026-07-01T00:00:00Z'),
          })
          .returning(({ users: u }) => ({ id: u.id }))
          .execute()
          .then((rows) => rows.length),
      raw: async () =>
        (
          await rawQuery(
            `insert into ${ns}.users (email, name, role, tags, meta, balance, created_at)
             values ($1, $2, $3, $4, $5, $6, $7) returning id`,
            [nextEmail(), 'Bench', 'member', '{bench}', '{}', '1.00', '2026-07-01T00:00:00.000Z'],
          )
        ).length,
    },
    {
      name: 'insert 1 000 (batch)',
      iters: 1,
      samples: 40,
      orm: () =>
        db
          .insertInto(h.comments)
          .valuesMany(
            Array.from({ length: 1000 }, (_unused, i) => ({
              postId: firstPostId,
              body: `batch ${i}`,
              createdAt: new Date('2026-07-01T00:00:00Z'),
            })),
          )
          .execute()
          .then(() => 1000),
      raw: async () => {
        const values = []
        const params = []
        for (let i = 0; i < 1000; i++) {
          const b = i * 3
          values.push(`($${b + 1}, $${b + 2}, $${b + 3})`)
          params.push(String(firstPostId), `batch ${i}`, '2026-07-01T00:00:00.000Z')
        }
        await rawQuery(
          `insert into ${ns}.comments (post_id, body, created_at) values ${values.join(', ')}`,
          params,
        )
        return 1000
      },
    },
    {
      name: 'update by PK',
      iters: 10,
      samples: 100,
      orm: () =>
        db
          .update(h.users)
          .set(() => ({ name: 'Renamed' }))
          .where(({ users: u }) => q.eq(u.id, pointUserId))
          .returning(({ users: u }) => ({ id: u.id }))
          .execute()
          .then((rows) => rows.length),
      raw: async () =>
        (
          await rawQuery(`update ${ns}.users set name = $1 where id = $2 returning id`, [
            'Renamed',
            String(pointUserId),
          ])
        ).length,
    },
    {
      name: 'delete by PK',
      // 8 x 60 x 2 sides + warm-up < the 2 500 disposable rows seeded above, so every delete in
      // the run matches exactly one row. Wrapping past the end would silently start timing a
      // delete that matches nothing, which is a different statement's worth of work.
      iters: 8,
      samples: 60,
      orm: () =>
        db
          .deleteFrom(h.comments)
          .where(({ comments: c }) => q.eq(c.id, nextDisposable()))
          .returning(({ comments: c }) => ({ id: c.id }))
          .execute()
          .then((rows) => rows.length),
      raw: async () =>
        (
          await rawQuery(`delete from ${ns}.comments where id = $1 returning id`, [
            String(nextDisposable()),
          ])
        ).length,
      /** Both sides consume a different id, so only the row COUNT is comparable. */
      compare: 'count',
    },
    {
      name: '5-statement transaction',
      iters: 4,
      samples: 100,
      orm: () =>
        db.transaction(async (tx) => {
          let n = 0
          for (let i = 0; i < 5; i++) {
            n += (
              await tx
                .from(h.users)
                .select(({ users: u }) => ({ id: u.id }))
                .where(({ users: u }) => q.eq(u.id, pointUserId))
                .execute()
            ).length
          }
          return n
        }),
      raw: async () => {
        const conn = await pool.connect()
        try {
          await conn.query('begin')
          let n = 0
          for (let i = 0; i < 5; i++) {
            const r = await conn.query({
              text: `select id from ${ns}.users where id = $1`,
              values: [String(pointUserId)],
              rowMode: 'array',
              types: rawTypes,
            })
            n += r.rows.length
          }
          await conn.query('commit')
          return n
        } finally {
          conn.release()
        }
      },
    },
    {
      name: 'relation load, one level',
      iters: 2,
      samples: 40,
      orm: () =>
        db
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
      raw: async () => mapOneLevel(await rawQuery(ONE_LEVEL_SQL, [])),
    },
    {
      name: 'relation load, two levels',
      iters: 2,
      samples: 40,
      orm: () =>
        db
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
      raw: async () => mapTwoLevel(await rawQuery(TWO_LEVEL_SQL, [])),
    },
  ]
}

/** Check the pair, then time it. Returns the row `run.mjs` prints and gates. */
export async function runCase(c) {
  const ormOut = await c.orm()
  const rawOut = await c.raw()
  if (c.compare === 'count') {
    const n = (v) => (Array.isArray(v) ? v.length : v)
    assertSamePair(c.name, n(ormOut), n(rawOut))
  } else {
    assertSamePair(c.name, ormOut, rawOut)
  }
  const paired = await samplePairedAsync(c.orm, c.raw, {
    iters: c.iters ?? 1,
    samples: c.samples ?? 60,
    warmup: c.warmup ?? 10,
  })
  return { name: c.name, ...paired }
}
