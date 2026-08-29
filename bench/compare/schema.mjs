// The three competitors' spellings of ONE database — `test/live/fixture.ts`'s tables, which are
// the only ones in this repository whose declarations are checked against `information_schema`
// (R5). A bench-private schema would be a second thing that can drift and its DDL would be
// checked by nothing.
//
// The DDL itself is never written here: `run.mjs` applies the fixture's own `ddl` and `seed`, so
// all four arms are demonstrably talking to the same tables.

import { relations } from 'drizzle-orm'
import { bigint, boolean, jsonb, numeric, pgSchema, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * The drizzle spelling.
 *
 * `mode: 'bigint'` on the identity columns and `mode: 'string'` on `numeric` so the values that
 * come back are the same JavaScript types pg-prime returns — the point of the comparison is how
 * long the same answer takes, and an arm that hands back a lossy `number` where another hands
 * back a `bigint` is doing less work, not the same work faster (design/08 §5's own rule that a
 * pair which returns different answers is two different jobs).
 */
export function drizzleSchema(ns) {
  const s = pgSchema(ns)
  const users = s.table('users', {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: text('role').notNull(),
    tags: text('tags').array().notNull(),
    meta: jsonb('meta').notNull(),
    balance: numeric('balance', { mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  })
  const posts = s.table('posts', {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    authorId: bigint('author_id', { mode: 'bigint' }).notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    amount: numeric('amount', { mode: 'string' }).notNull(),
    published: boolean('published').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 6 }).notNull(),
  })
  const comments = s.table('comments', {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    postId: bigint('post_id', { mode: 'bigint' }).notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  })

  const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }))
  const postsRelations = relations(posts, ({ one, many }) => ({
    author: one(users, { fields: [posts.authorId], references: [users.id] }),
    comments: many(comments),
  }))
  const commentsRelations = relations(comments, ({ one }) => ({
    post: one(posts, { fields: [comments.postId], references: [posts.id] }),
  }))

  return {
    users,
    posts,
    comments,
    schema: { users, posts, comments, usersRelations, postsRelations, commentsRelations },
  }
}

/**
 * Kysely needs no schema object at runtime — it is types-only, and this file is `.mjs`. What it
 * does need is the qualified table names, because the fixture lives in its own namespace.
 *
 * That asymmetry is worth stating rather than hiding: kysely's arm has no runtime schema to build
 * and no metadata to consult, which is part of why it is the fastest of the three on the cheap
 * cases. A comparison that gave it one would be measuring something nobody ships.
 */
export function kyselyNames(ns) {
  return {
    users: `${ns}.users`,
    posts: `${ns}.posts`,
    comments: `${ns}.comments`,
  }
}
