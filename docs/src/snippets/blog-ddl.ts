/**
 * The tables, created — what `pg-prime migrate apply` does for a reader who followed the getting
 * started guide, and what the examples runner needs before a `select` can return rows.
 *
 * A fragment: it needs a `db` in scope, so it is only ever composed *after* one
 * (`use=blog,blog-ddl`, or after a page's own `setup=` blocks).
 */
await db.sql`
  create table users (
    id         bigint generated always as identity primary key,
    email      text not null unique,
    name       text not null,
    created_at timestamptz not null default now()
  )
`.execute()

await db.sql`
  create table posts (
    id         bigint generated always as identity primary key,
    author_id  bigint not null references users (id),
    title      text not null,
    body       text not null,
    published  boolean not null default false,
    created_at timestamptz not null default now()
  )
`.execute()

export {}
