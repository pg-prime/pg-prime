/**
 * The builder-side twin of `test/sql/_helpers.ts`.
 *
 * `_helpers.ts` hand-builds `TableMeta`/`ColumnMeta` for the compiler suites. This file declares
 * the *same* tables through `pgTable(...)`, so `metaOf(h)` produces metadata structurally identical
 * to the hand-built kind — same DB names, same codecs, same pre-quoted identifiers.
 *
 * That identity is the whole point: it is what lets `test/query/ast-equivalence.test.ts` assert
 * `toStrictEqual` between a builder's `toAst()` and an AST the compiler suite already verified.
 * If these two ever drift, the equivalence oracle silently weakens to "the builder produces some
 * AST", so any change here must be made in both files.
 *
 * `email` is `varchar` rather than `text` on purpose: `test/compile/insert.test.ts` pins
 * `$1::varchar` for `castFirstRow`, which is WS2's finding that the cast comes from `sqlName`.
 * Reproducing that from the builder is why `t.varchar()` exists (design/09 §3.4).
 */

import { defineRelations, defineSchema, pgTable, REFS } from '../../src/schema/index.js'

/**
 * Identity / defaults / nullability are declared where `03` §2's schema declares them, so
 * `Insertable<users>` is the same three required columns the §2.5 golden inserts. None of it
 * reaches `metaOf`: the codec seam reads `ddl.pgType` and `ddl.dbName` only, so these modifiers
 * change the *type* of an insert and not one byte of the metadata this file exists to match.
 */
export const users = pgTable('users', (t) => ({
  id: t.bigint().primaryKey().generatedAlways(),
  email: t.varchar(),
  name: t.text(),
  role: t.text(),
  meta: t.jsonb().default({}),
  createdAt: t.timestamptz().defaultSql('now()'),
  deletedAt: t.timestamptz().nullable(),
}))

export const posts = pgTable('posts', (t) => ({
  id: t.bigint().primaryKey().generatedAlways(),
  authorId: t.bigint(),
  title: t.text(),
  amount: t.numeric(),
  published: t.boolean(),
  createdAt: t.timestamptz(),
}))

/** `postId` is nullable so `body` is the single required column — the one-column insert the
 *  30 000-cell strategy boundary needs. Nullability changes no `ColumnMeta`, so the twin holds. */
export const comments = pgTable('comments', (t) => ({
  id: t.bigint().primaryKey().generatedAlways(),
  postId: t.bigint().nullable(),
  body: t.text(),
}))

const tables = { users, posts, comments }

/**
 * The same relation graph `test/compile/nested.test.ts` hand-builds a LATERAL for, declared.
 *
 * `from`/`to` are explicit because the column DSL has no `.references()` — there is no foreign
 * key in a `pgTable(...)` for a resolver to infer from, so design/09 WS5 makes them mandatory and
 * `defineSchema` rejects a relation that omits them.
 */
export const relations = defineRelations(tables, (r) => ({
  users: { posts: r.many.posts({ from: users[REFS].id, to: posts[REFS].authorId }) },
  posts: {
    author: r.one.users({ from: posts[REFS].authorId, to: users[REFS].id }),
    comments: r.many.comments({ from: posts[REFS].id, to: comments[REFS].postId }),
  },
  comments: { post: r.one.posts({ from: comments[REFS].postId, to: posts[REFS].id }) },
}))

export const schema = defineSchema(tables, relations)
