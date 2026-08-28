/**
 * The fuzz fixture — three tables that exist in the container, declared ONCE as `pgTable(...)` and
 * turned into compiler metadata by `metaOf` (design/09 WS2).
 *
 * Before the codec seam landed this file hand-wrote `columnMeta('id', spikeCodecs.int8)` per
 * column, which meant the fuzz suites exercised a mapping nobody had checked against a database.
 * Going through `metaOf` puts them on the same seam production uses, so a codec that resolves
 * wrongly now shows up as a fuzz failure rather than as a fuzz *tolerance*.
 *
 * It is a *factory* keyed by schema name because vitest runs test files in parallel workers
 * against one shared container: each file owns its own schema, so a `drop schema … cascade`
 * in one file cannot pull the floor out from under another.
 *
 * TS keys are deliberately snake_case here (`created_at`, not `createdAt`): this fixture is about
 * SQL shapes, and matching the DB name keeps the generated statements readable next to the DDL.
 */

import { col, table } from '../../src/compile/nodes.js'
import { metaOf } from '../../src/query/meta.js'
import { refsOf } from '../../src/query/ref.js'
import { pgTable } from '../../src/schema/index.js'

export function makeFixture(schema: string) {
  const opts = { schema } as const

  const users = pgTable(
    'users',
    (t) => ({
      id: t.bigint().primaryKey(),
      email: t.text(),
      name: t.text(),
      role: t.text(),
      meta: t.jsonb(),
      created_at: t.timestamptz(),
      deleted_at: t.timestamptz().nullable(),
    }),
    undefined,
    opts,
  )

  const posts = pgTable(
    'posts',
    (t) => ({
      id: t.bigint().primaryKey(),
      author_id: t.bigint(),
      title: t.text(),
      amount: t.numeric(),
      published: t.boolean(),
      created_at: t.timestamptz(),
    }),
    undefined,
    opts,
  )

  const comments = pgTable(
    'comments',
    (t) => ({
      id: t.bigint().primaryKey(),
      post_id: t.bigint(),
      body: t.text(),
    }),
    undefined,
    opts,
  )

  const usersMeta = metaOf(users)
  const postsMeta = metaOf(posts)
  const commentsMeta = metaOf(comments)

  // `metaOf` is string-keyed (`Readonly<Record<string, ColumnMeta>>`), so the column-key unions
  // below are declared by hand. Making `metaOf` generic in the table would recover them, but it
  // would also put a mapped type on every table in the program, and `bench/types` gates that —
  // the builder (WS4) indexes by key from `Sources` and does not need it. Noted in design/09 §3.2.
  const usersCols = usersMeta.byKey
  const postsCols = postsMeta.byKey
  const commentsCols = commentsMeta.byKey

  return {
    schema,
    usersTable: usersMeta.table,
    postsTable: postsMeta.table,
    commentsTable: commentsMeta.table,
    usersCols,
    postsCols,
    commentsCols,
    usersFrom: table(usersMeta.table),
    postsFrom: table(postsMeta.table),
    commentsFrom: table(commentsMeta.table),
    /**
     * The same columns as {@link u}, but as typed refs for the **operator surface** (WS3).
     *
     * `u('email')` gives the compiler's `ColumnNode`; `ur.email` gives the thing
     * `src/query/ops.ts` accepts, so the fuzz can generate predicates the way a user writes them
     * — through `ilike`/`hasKey`/`between` — instead of only through `nodes.ts`. Same alias, so
     * the two mix freely inside one generated statement.
     */
    ur: refsOf(users, 'users'),
    pr: refsOf(posts, 'posts'),
    u: (k: UserCol, alias = 'users') => col(alias, usersCols[k]!.name, usersCols[k]!.codec),
    p: (k: PostCol, alias = 'posts') => col(alias, postsCols[k]!.name, postsCols[k]!.codec),
    c: (k: CommentCol, alias = 'comments') =>
      col(alias, commentsCols[k]!.name, commentsCols[k]!.codec),

    ddl: `
drop schema if exists ${schema} cascade;
create schema ${schema};
create table ${schema}.users (
  id bigint primary key,
  email text not null,
  name text not null,
  role text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table ${schema}.posts (
  id bigint primary key,
  author_id bigint not null references ${schema}.users(id),
  title text not null,
  amount numeric(12,2) not null default 0,
  published boolean not null default false,
  created_at timestamptz not null default now()
);
create table ${schema}.comments (
  id bigint primary key,
  post_id bigint not null references ${schema}.posts(id),
  body text not null
);
`,

    // 9007199254740993 = 2^53 + 1 and 9007199254740995 = 2^53 + 3: both are exactly
    // representable as int8 and NOT representable as a JSON number. That is the point.
    seed: `
insert into ${schema}.users (id, email, name, role) values
  (9007199254740993, 'ada@example.com', 'Ada', 'admin'),
  (2, 'bob@example.com', 'Bob', 'user'),
  (3, 'cyd@example.com', 'Cyd', 'user');
insert into ${schema}.posts (id, author_id, title, amount, published, created_at) values
  (9007199254740995, 9007199254740993, 'newest', 1234.56,     true,  '2026-08-14T12:00:00Z'),
  (11,               9007199254740993, 'older',  0.10,        true,  '2026-08-13T12:00:00Z'),
  (12,               9007199254740993, 'oldest', 99999999.99, true,  '2026-08-12T12:00:00Z'),
  (13,               9007199254740993, 'draft',  5.00,        false, '2026-08-15T12:00:00Z'),
  (14,               2,                'bobs',   7.77,        true,  '2026-08-11T12:00:00Z');
insert into ${schema}.comments (id, post_id, body) values
  (100, 9007199254740995, 'first'),
  (101, 9007199254740995, 'second');
`,

    drop: `drop schema if exists ${schema} cascade`,
  }
}

export type UserCol = 'id' | 'email' | 'name' | 'role' | 'meta' | 'created_at' | 'deleted_at'
export type PostCol = 'id' | 'author_id' | 'title' | 'amount' | 'published' | 'created_at'
export type CommentCol = 'id' | 'post_id' | 'body'

export type Fixture = ReturnType<typeof makeFixture>
