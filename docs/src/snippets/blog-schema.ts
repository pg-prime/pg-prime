/**
 * The schema the guides talk about: two tables, one relation in each direction.
 *
 * Composed into a block with `use=blog-schema` when the page needs the *types* and builds its own
 * handle; `blog` (schema + a `db`) and `blog-ddl` (the tables, created) are the other two halves.
 */
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

export {}
