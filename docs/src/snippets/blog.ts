/**
 * The prelude most runnable examples on this site are composed with (`use=blog`).
 *
 * It is a real module: `tools/docs-typecheck.mjs` compiles it on TypeScript 5.9.3 and
 * `tools/docs-examples.mjs` runs it, in front of the block that uses it, against PGlite. The two
 * tables here are the ones the guides talk about, and the DDL below is the same shape the schema
 * declares — a guide that shows a query gets a database where that query really runs.
 */
import { pgPrime } from 'pg-prime'
import { defineRelations, defineSchema, pgTable, REFS } from 'pg-prime/schema'

const users = pgTable('users', (t) => ({
  id: t.bigint().primaryKey().generatedAlways(),
  email: t.text().unique(),
  name: t.text(),
  createdAt: t.timestamptz().defaultSql('now()'),
}))

const posts = pgTable('posts', (t) => ({
  id: t.bigint().primaryKey().generatedAlways(),
  authorId: t.bigint().references(() => users[REFS].id),
  title: t.text(),
  body: t.text(),
  published: t.boolean().default(false),
  createdAt: t.timestamptz().defaultSql('now()'),
}))

const relations = defineRelations({ users, posts }, (r) => ({
  users: { posts: r.many.posts() },
  posts: { author: r.one.users() },
}))

const schema = defineSchema({ users, posts }, relations)

const db = pgPrime({
  // The examples runner points this at a PGlite server it starts for the run; in your application
  // it is your own `postgres://` URL.
  connection: process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/postgres',
  schema,
})

await db.sql`
  create table if not exists users (
    id         bigint generated always as identity primary key,
    email      text not null unique,
    name       text not null,
    created_at timestamptz not null default now()
  )
`.execute()

await db.sql`
  create table if not exists posts (
    id         bigint generated always as identity primary key,
    author_id  bigint not null references users (id),
    title      text not null,
    body       text not null,
    published  boolean not null default false,
    created_at timestamptz not null default now()
  )
`.execute()

export {}
