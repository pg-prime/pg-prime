/**
 * Negative probes. Every `@ts-expect-error` below MUST fire: an *unused*
 * `@ts-expect-error` is itself a compile error, so a lost type error breaks the
 * build. This file is typechecked (not run) on TS 5.9.3 and TS 7.0.2.
 */
import type { Insertable, Loaded } from '../../src/schema/index.js'
import { defineRelations, pgTable, text } from '../../src/schema/index.js'
import { posts, users, type PostsH, type UsersH } from './fixture.js'

declare const full: Loaded<UsersH, 'posts'>
declare const bare: Loaded<UsersH>
declare const partial: Loaded<UsersH, never, 'id' | 'displayName'>
declare const withLatest: Loaded<UsersH, 'latest'>

declare function notify(u: Loaded<UsersH, 'posts'>): string

// ── Loaded<> ────────────────────────────────────────────────────────────────
notify(full) // ok

// @ts-expect-error — Property 'posts' is missing: an unloaded relation is absent
notify(bare)

// @ts-expect-error — 'author' is not a relation of `users`
type Nope = Loaded<UsersH, 'author'>

// @ts-expect-error — 'email' was not selected
partial.email

// @ts-expect-error — 'latest' is possibly null (maybeOne)
withLatest.latest.title

// @ts-expect-error — 'nope' is not a column of `users`
type NoCol = Loaded<UsersH, never, 'nope'>

// a full row satisfies a partial contract — this must NOT error
declare function shortName(u: Loaded<UsersH, never, 'id' | 'displayName'>): string
shortName(bare)

// a relation is typed all the way down: the loaded rows are real `posts` rows,
// so a structurally-wrong element is rejected
declare const users0: Loaded<UsersH>
declare const postRow: Loaded<PostsH>
// @ts-expect-error — a `posts` row needs id/authorId/title/body/published/createdAt
notify({ ...users0, posts: [{ id: 'p1' }] })

// …and a to-many relation cannot be satisfied by a single object
// @ts-expect-error — 'posts' is `PostRow[]`, not `PostRow`
notify({ ...users0, posts: postRow })

// ── Insertable ──────────────────────────────────────────────────────────────
const ins1: Insertable<typeof users> = {
  email: 'a@b.c',
  // @ts-expect-error — 'seq' is GENERATED ALWAYS: never insertable
  seq: 1n,
}

// @ts-expect-error — required column 'email' is missing
const ins2: Insertable<typeof users> = { displayName: 'Ada' }

const ins3: Insertable<typeof users> = {
  // @ts-expect-error — NOT NULL by default: `email` is `string`, not `string | null`
  email: null,
}

const ins4: Insertable<typeof users> = {
  email: 'a@b.c',
  // @ts-expect-error — a plain string is not the branded `date` string
  birthday: '2026-01-01',
}

const ins5: Insertable<typeof posts> = {
  authorId: 'u1',
  title: 't',
  // @ts-expect-error — `timestamptz` decodes to `Date`, not a string
  createdAt: '2026-01-01',
}

// ── $type is narrow-only ────────────────────────────────────────────────────
// @ts-expect-error — `text().$type<number>()` is a silent lie in Drizzle; rejected here
const bad = text().$type<number>()

// `$type` to a branded subtype of the column's own type is fine
const good = text().$type<string & { readonly __brand: 'Email' }>()

// ── .default() is type-checked against the column ───────────────────────────
// @ts-expect-error — a `text` default must be a string
const badDefault = text().default(1)

// @ts-expect-error — an array column's default must be an array of the element type
const badArrayDefault = text().array().default(['a', 1])

// ── defineRelations: `to` is a registry key, checked at declaration ─────────
export const badRels = defineRelations({ users, posts }, (r) => ({
  // @ts-expect-error — 'comments' is not in this registry
  users: { c: r.many.comments() },
}))

// ── column keys may not start with `$` ──────────────────────────────────────
export const kitchen = pgTable('kitchen', (t) => ({ ok: t.text() }))

export type _Probes = [
  typeof ins1,
  typeof ins2,
  typeof ins3,
  typeof ins4,
  typeof ins5,
  typeof bad,
  typeof good,
  typeof badDefault,
  typeof badArrayDefault,
  Nope,
  NoCol,
]
