/**
 * The live fixture schema expressed as compiler metadata, so the fuzz suites compile against
 * tables that actually exist in the container.
 *
 * It is a *factory* keyed by schema name because vitest runs test files in parallel workers
 * against one shared container: each file owns its own schema, so a `drop schema … cascade`
 * in one file cannot pull the floor out from under another.
 */

import { columnMeta, col, table, tableMeta } from '../../src/compile/nodes.js'
import { spikeCodecs } from '../../src/sql/codec.js'

export function makeFixture(schema: string) {
  const usersTable = tableMeta(schema, 'users')
  const postsTable = tableMeta(schema, 'posts')
  const commentsTable = tableMeta(schema, 'comments')

  const usersCols = {
    id: columnMeta('id', spikeCodecs.int8),
    email: columnMeta('email', spikeCodecs.text),
    name: columnMeta('name', spikeCodecs.text),
    role: columnMeta('role', spikeCodecs.text),
    meta: columnMeta('meta', spikeCodecs.jsonb),
    created_at: columnMeta('created_at', spikeCodecs.timestamptz),
    deleted_at: columnMeta('deleted_at', spikeCodecs.timestamptz),
  } as const

  const postsCols = {
    id: columnMeta('id', spikeCodecs.int8),
    author_id: columnMeta('author_id', spikeCodecs.int8),
    title: columnMeta('title', spikeCodecs.text),
    amount: columnMeta('amount', spikeCodecs.numeric),
    published: columnMeta('published', spikeCodecs.bool),
    created_at: columnMeta('created_at', spikeCodecs.timestamptz),
  } as const

  const commentsCols = {
    id: columnMeta('id', spikeCodecs.int8),
    post_id: columnMeta('post_id', spikeCodecs.int8),
    body: columnMeta('body', spikeCodecs.text),
  } as const

  return {
    schema,
    usersTable,
    postsTable,
    commentsTable,
    usersCols,
    postsCols,
    commentsCols,
    usersFrom: table(usersTable),
    postsFrom: table(postsTable),
    commentsFrom: table(commentsTable),
    u: (k: keyof typeof usersCols, alias = 'users') =>
      col(alias, usersCols[k].name, usersCols[k].codec),
    p: (k: keyof typeof postsCols, alias = 'posts') =>
      col(alias, postsCols[k].name, postsCols[k].codec),
    c: (k: keyof typeof commentsCols, alias = 'comments') =>
      col(alias, commentsCols[k].name, commentsCols[k].codec),

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

export type Fixture = ReturnType<typeof makeFixture>
