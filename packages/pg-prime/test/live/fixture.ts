/**
 * The live fixture — design/09 Appendix A.
 *
 * Two halves that must never disagree: the `pgTable(…)` declarations the builder will query, and
 * the DDL that creates them. `fixture.drift.test.ts` asserts the two agree against
 * `information_schema` (R5). If they ever drift, every other live test is testing a lie.
 *
 * It is a **factory keyed by schema name** (R6): against a real server the whole suite shares one
 * database, so each file owns a namespace — `makeFixture('pgprime_q_select')` — and a
 * `drop schema … cascade` in one file cannot pull the floor out from under another.
 *
 * **Every row exists to break a specific naive implementation.** The `why` column in Appendix A is
 * repeated here as comments; if a row cannot name the bug it catches, delete it.
 */

import {
  defineRelations,
  defineSchema,
  pgEnum,
  pgTable,
  primaryKey,
  REFS,
  uniqueIndex,
} from '../../src/schema/index.js'

/** 2^53 + 1: exactly representable as `int8`, **not** as a JSON number. Every nested `id` in the
 *  fixture is above this line, so a `json_agg` path that forgets `::text` loses the last digit. */
export const FIRST_POST_ID = 9007199254740993n

export const userRole = pgEnum('user_role', ['admin', 'owner', 'member'])

export type UserMeta = {
  billing?: { country: string }
  [key: string]: unknown
}

export function makeFixture(ns: string) {
  const opts = { schema: ns } as const

  const users = pgTable(
    'users',
    (t) => ({
      id: t.bigint().primaryKey().generatedAlways(),
      email: t.text().unique(),
      name: t.text(),
      role: t.enum(userRole),
      tags: t.text().array(),
      meta: t.jsonb().$type<UserMeta>(),
      balance: t.numeric(),
      createdAt: t.timestamptz(),
      deletedAt: t.timestamptz().nullable(),
      birthday: t.date().nullable(),
    }),
    (t) => [uniqueIndex('users_email_key').on(t.email)],
    opts,
  )

  const kv = pgTable(
    'kv',
    (t) => ({
      k1: t.text(),
      k2: t.integer(),
      v: t.text(),
    }),
    (t) => [primaryKey(t.k1, t.k2)],
    opts,
  )

  const posts = pgTable(
    'posts',
    (t) => ({
      id: t.bigint().primaryKey().generatedAlways(),
      authorId: t.bigint(),
      title: t.text(),
      body: t.text(),
      amount: t.numeric(),
      published: t.boolean(),
      createdAt: t.timestamptz(),
      tagIds: t.bigint().array(),
      // Appendix A's `kv` row is "a two-column PK for a composite relation from posts.(k1,k2)",
      // which only exists if posts carries the two columns. Nullable: most posts have no kv.
      k1: t.text().nullable(),
      k2: t.integer().nullable(),
    }),
    undefined,
    opts,
  )

  const comments = pgTable(
    'comments',
    (t) => ({
      // `id` and `created_at` deliberately collide with users/posts: a positional decoder that
      // keys on column *name* instead of position clobbers one with the other in a join.
      id: t.bigint().primaryKey().generatedAlways(),
      postId: t.bigint(),
      body: t.text(),
      createdAt: t.timestamptz(),
    }),
    undefined,
    opts,
  )

  const tags = pgTable(
    'tags',
    (t) => ({
      id: t.bigint().primaryKey(),
      name: t.text(),
    }),
    undefined,
    opts,
  )

  const postTags = pgTable(
    'post_tags',
    (t) => ({
      postId: t.bigint(),
      tagId: t.bigint(),
    }),
    (t) => [primaryKey(t.postId, t.tagId)],
    opts,
  )

  const tables = { users, posts, comments, tags, postTags, kv }

  // Explicit `from`/`to` while FK inference is `unknown`-typed in the runtime (design/09 §5).
  const relations = defineRelations(tables, (r) => ({
    users: {
      posts: r.many.posts({ from: users[REFS].id, to: posts[REFS].authorId }),
    },
    posts: {
      author: r.one.users({ from: posts[REFS].authorId, to: users[REFS].id }),
      comments: r.many.comments({ from: posts[REFS].id, to: comments[REFS].postId }),
      tags: r.many.tags({
        from: posts[REFS].id,
        to: tags[REFS].id,
        through: { table: postTags, from: postTags[REFS].postId, to: postTags[REFS].tagId },
      }),
      kv: r.maybeOne.kv({
        from: [posts[REFS].k1, posts[REFS].k2],
        to: [kv[REFS].k1, kv[REFS].k2],
      }),
    },
    comments: {
      post: r.one.posts({ from: comments[REFS].postId, to: posts[REFS].id }),
    },
  }))

  const schema = defineSchema(tables, relations)

  const ddl = `
create schema ${ns};
create type ${ns}.user_role as enum ('admin', 'owner', 'member');

create table ${ns}.users (
  id         bigint generated always as identity primary key,
  email      text not null,
  name       text not null,
  role       ${ns}.user_role not null,
  tags       text[] not null,
  meta       jsonb not null,
  balance    numeric(12,2) not null,
  created_at timestamptz not null,
  deleted_at timestamptz,
  birthday   date
);
create unique index users_email_key on ${ns}.users (email);

create table ${ns}.kv (
  k1 text not null,
  k2 integer not null,
  v  text not null,
  primary key (k1, k2)
);

-- start 2^53+1, so every id in every nested payload is past the float64 cliff
create table ${ns}.posts (
  id         bigint generated always as identity (start with ${FIRST_POST_ID}) primary key,
  author_id  bigint not null references ${ns}.users (id),
  title      text not null,
  body       text not null,
  amount     numeric(12,2) not null,
  published  boolean not null,
  created_at timestamptz(6) not null,
  tag_ids    bigint[] not null,
  k1         text,
  k2         integer,
  foreign key (k1, k2) references ${ns}.kv (k1, k2)
);

create table ${ns}.comments (
  id         bigint generated always as identity primary key,
  post_id    bigint not null references ${ns}.posts (id),
  body       text not null,
  created_at timestamptz not null
);

create table ${ns}.tags (
  id   bigint primary key,
  name text not null
);

create table ${ns}.post_tags (
  post_id bigint not null references ${ns}.posts (id),
  tag_id  bigint not null references ${ns}.tags (id),
  primary key (post_id, tag_id)
);
`

  const seed = `
-- u1 5 posts (per-parent limit 3 must drop 2) · quote- and operator-looking jsonb keys
-- u2 1 post · balance 10.50 (the trailing zero must survive as '10.50', not 10.5)
-- u3 0 posts (json_agg → [], count → 0n, some → false, every → true)
-- u4 soft-deleted (excluded by alive(), matches the partial-index upsert predicate)
-- u5 every nullable column NULL, tags '{}', meta JSON null — which is NOT SQL NULL
-- u6 quote / backslash / semicolon / comment / emoji / astral char, mixed-case email
insert into ${ns}.users (email, name, role, tags, meta, balance, created_at, deleted_at, birthday)
values
  ('ada@example.com', 'Ada', 'admin',
   '{vip,beta}', '{"billing":{"country":"DE"},"k\\"ey":1,"a->b":2}', 1234.00,
   '2026-01-01T00:00:00.000001Z', null, '1990-05-17'),
  ('bob@example.com', 'Bob', 'member',
   '{beta}', '{}', 10.50, '2026-01-02T00:00:00Z', null, null),
  ('cyd@example.com', 'Cyd', 'member',
   '{}', '{}', 0.00, '2026-01-03T00:00:00Z', null, null),
  ('dee@example.com', 'Dee', 'owner',
   '{vip}', '{}', 7.00, '2026-01-04T00:00:00Z', '2026-06-01T12:00:00Z', null),
  ('eve@example.com', 'Eve', 'member',
   '{}', 'null', 0.00, '2026-01-05T00:00:00Z', null, null),
  ('Frank.O@Example.COM', 'O''Hara "Frank" \\ ; -- 🙂𝄞', 'member',
   '{vip,beta}', '{}', 0.01, '2026-01-06T00:00:00Z', null, null);

insert into ${ns}.kv (k1, k2, v) values ('a', 1, 'kv-a1'), ('b', 2, 'kv-b2');

-- two of u1's posts share created_at to the microsecond: any "order by created_at desc" that
-- does not tiebreak on id is non-deterministic, and a cursor built on it silently skips rows.
insert into ${ns}.posts (author_id, title, body, amount, published, created_at, tag_ids, k1, k2)
select u.id, v.title, v.body, v.amount, v.published, v.created_at, v.tag_ids, v.k1, v.k2
from (values
  ('ada@example.com', 'first',  'body one',   0.00::numeric,        true,
   '2026-02-01T10:00:00.000000Z'::timestamptz, array[1::int8, 2],   'a',        1),
  ('ada@example.com', 'tie-a',  'body two',   -1.10::numeric,       true,
   '2026-02-02T10:00:00.123456Z'::timestamptz, array[1::int8],      null::text, null::int),
  ('ada@example.com', 'tie-b',  'body three', 12345678.90::numeric, true,
   '2026-02-02T10:00:00.123456Z'::timestamptz, array[]::int8[],     null,       null),
  ('ada@example.com', 'draft',  'body four',  5.00::numeric,        false,
   '2026-02-03T10:00:00Z'::timestamptz,        array[${FIRST_POST_ID}::int8], null, null),
  ('ada@example.com', 'fifth',  'body five',  1.00::numeric,        true,
   '2026-02-04T10:00:00Z'::timestamptz,        array[2::int8, 3],   null,       null),
  ('bob@example.com', 'bobs',   'body six',   7.77::numeric,        true,
   '2026-02-05T10:00:00Z'::timestamptz,        array[3::int8],      'b',        2)
) as v(email, title, body, amount, published, created_at, tag_ids, k1, k2)
join ${ns}.users u on u.email = v.email;

-- exactly one post has comments; every other parent must come back as [] and not as [null]
insert into ${ns}.comments (post_id, body, created_at)
select p.id, v.body, v.created_at
from (values
  ('one',   '2026-03-01T00:00:00Z'::timestamptz),
  ('two',   '2026-03-02T00:00:00Z'::timestamptz),
  ('three', '2026-03-03T00:00:00Z'::timestamptz)
) as v(body, created_at)
cross join (select id from ${ns}.posts where title = 'first') p;

insert into ${ns}.tags (id, name) values (1, 'vip'), (2, 'beta'), (3, 'alpha');

-- tag 1 is on two posts (m2m fan-out); post 'first' has two tags (m2m fan-in)
insert into ${ns}.post_tags (post_id, tag_id)
select p.id, v.tag_id
from (values ('first', 1::int8), ('tie-a', 1::int8), ('first', 2::int8)) as v(title, tag_id)
join ${ns}.posts p on p.title = v.title;
`

  const drop = `drop schema if exists ${ns} cascade`

  return { ns, tables, users, posts, comments, tags, postTags, kv, relations, schema, ddl, seed, drop }
}

export type Fixture = ReturnType<typeof makeFixture>
