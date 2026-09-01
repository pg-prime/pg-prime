/**
 * The shared example schema for the type probes: a fully-cyclic 3-table graph
 * exercising every column builder the spike carries.
 */
import {
  comment,
  defineRelations,
  defineSchema,
  index,
  pgEnum,
  pgMaterializedView,
  pgTable,
  pgView,
  REFS,
  uniqueIndex,
} from '../../src/schema/index.js'
import { sql } from '../../src/sql/index.js'

export const memberRole = pgEnum('member_role', ['owner', 'admin', 'member'])

export type UserPrefs = {
  theme: 'light' | 'dark' | 'system'
  digest: 'daily' | 'weekly' | 'off'
}

export type UserId = string & { readonly __brand: 'UserId' }

export const users = pgTable(
  'users',
  (t) => ({
    // uuid PK with a DDL default → optional on insert, non-null on read
    id: t.uuid().primaryKey().defaultSql('gen_random_uuid()').$type<UserId>(),
    // NOT NULL by default, no default → required on insert
    email: t.text().unique(),
    // .nullable() opts in to `| null` and to insert-optionality
    displayName: t.text().nullable(),
    age: t.integer().nullable(),
    // literal DDL default
    views: t.bigint().default(0n),
    active: t.boolean().default(true),
    // jsonb narrowed by $type, then given a literal default
    prefs: t.jsonb().$type<UserPrefs>().default({ theme: 'system', digest: 'weekly' }),
    // text[] with a literal default
    tags: t.text().array().default([]),
    role: t.enum(memberRole).default('member'),
    // date decodes to a branded 'YYYY-MM-DD' string, never a Date
    birthday: t.date().nullable(),
    balance: t.numeric().default('0.00'),
    createdAt: t.timestamptz().defaultSql('now()'),
    updatedAt: t
      .timestamptz()
      .defaultSql('now()')
      .$onUpdate(() => new Date()),
    // GENERATED ALWAYS → absent from insert *and* update, present in select
    seq: t.bigint().generatedAlways(),
    // TS-only default: optional on insert, but NO `DEFAULT` in the DDL
    slug: t.text().$default(() => 'anonymous'),
  }),
  (t) => [uniqueIndex('users_email_idx').on(t.email), comment('Application user accounts.')],
)

export const posts = pgTable(
  'posts',
  (t) => ({
    id: t.uuid().primaryKey().defaultSql('gen_random_uuid()'),
    authorId: t.uuid(),
    title: t.text(),
    body: t.text().nullable(),
    published: t.boolean().default(false),
    createdAt: t.timestamptz().defaultSql('now()'),
  }),
  (t) => [index('posts_author_idx').on(t.authorId)],
)

export const comments = pgTable('comments', (t) => ({
  id: t.uuid().primaryKey().defaultSql('gen_random_uuid()'),
  postId: t.uuid(),
  body: t.text(),
}))

const tables = { users, posts, comments }

// Fully cyclic: users → posts → users, posts → comments → posts. No thunks.
//
// `from`/`to` are explicit because they have to be: the column DSL has no `.references()`, so
// there is no foreign key in the schema for a resolver to infer from (design/09 WS5, §5's risk
// row). `defineSchema` rejects a relation that omits them.
export const relations = defineRelations(tables, (r) => ({
  users: {
    posts: r.many.posts({ from: users[REFS].id, to: posts[REFS].authorId }),
    latest: r.maybeOne.posts({ from: users[REFS].id, to: posts[REFS].authorId }),
  },
  posts: {
    author: r.one.users({ from: posts[REFS].authorId, to: users[REFS].id }),
    comments: r.many.comments({ from: posts[REFS].id, to: comments[REFS].postId }),
  },
  comments: { post: r.one.posts({ from: comments[REFS].postId, to: posts[REFS].id }) },
}))

export const schema = defineSchema(tables, relations)

/**
 * Handles are exported as **type aliases**, not as `const`s.
 *
 * `export const usersH = schema.h.users` forces the emitter to re-print the
 * whole `Schema<{...100 tables...}, {...}>` type argument once per handle:
 * measured 25,343 → 10,527 bytes of `fixture.d.ts` for this 3-table fixture
 * when the three handle consts were replaced by these three aliases (−58 %,
 * TS 7.0.2 `--emitDeclarationOnly`). A named alias emits as
 * `export type UsersH = (typeof schema.h)['users'];` — one line, and the cost
 * is O(1) in the number of handles instead of O(tables × handles).
 */
export type UsersH = (typeof schema.h)['users']
export type PostsH = (typeof schema.h)['posts']
export type CommentsH = (typeof schema.h)['comments']

/**
 * A declared view and a declared materialized view (design/01 §3 row 58).
 *
 * They are NOT in `defineSchema(...)`: a view carries its own one-entry registry, so it is a
 * handle on its own and `db.from(activeUsers)` needs no `.h`. Their reason for living in the
 * shared fixture is `tools/type-errors/cases/insert-into-view.ts` and the `expect-type` probes,
 * both of which need one view whose columns are exactly known.
 */
export const activeUsers = pgView('active_users')
  .columns((t) => ({ id: t.uuid().$type<UserId>(), email: t.text() }))
  .as(sql`select "id", "email" from "users" where "active"`)

export const userStats = pgMaterializedView('user_stats')
  .columns((t) => ({ userId: t.uuid().$type<UserId>(), posts: t.bigint() }))
  .refreshable({ concurrently: true })
  .as(sql`select "author_id" as "user_id", count(*) as "posts" from "posts" group by 1`)
