/**
 * Shared helpers for the `sql`-tag and compiler suites.
 *
 * Deliberately tiny: the point of these tests is to pin the *exact* SQL text and the *exact*
 * bind list, so anything that pretty-prints or normalises would defeat them.
 */

import { compileExpr } from '../../src/compile/compiler.js'
import type { Bind } from '../../src/compile/contract.js'
import { columnMeta, tableMeta, col, table } from '../../src/compile/nodes.js'
import {
  boolCodec,
  int8Codec,
  jsonbCodec,
  numericCodec,
  textCodec,
  timestamptzCodec,
  varcharCodec,
} from '../../src/codec/index.js'
import type { Fragment } from '../../src/sql/fragment.js'
import { toNode } from '../../src/sql/fragment.js'

/** Compile a fragment in isolation. */
export function render(f: Fragment<unknown>): { sql: string; binds: readonly Bind[] } {
  return compileExpr(toNode(f))
}

/** The encoded wire values, in `$1..$n` order. */
export function values(binds: readonly Bind[]): unknown[] {
  return binds.map((b) => (b.k === 'value' ? b.encoded : `<slot:${b.name}>`))
}

/** Convenience: sql text of a fragment. */
export const text = (f: Fragment<unknown>): string => render(f).sql

// ─────────────────────────── the fixture schema ───────────────────────────
//
// Mirrors design/03 §2's example schema closely enough that the goldens in test/compile can
// be compared line-for-line against the design document's Appendix A.

export const usersTable = tableMeta('public', 'users')
export const postsTable = tableMeta('public', 'posts')
export const commentsTable = tableMeta('public', 'comments')

export const usersCols = {
  id: columnMeta('id', int8Codec),
  email: columnMeta('email', varcharCodec),
  name: columnMeta('name', textCodec),
  role: columnMeta('role', textCodec),
  meta: columnMeta('meta', jsonbCodec),
  createdAt: columnMeta('created_at', timestamptzCodec),
  deletedAt: columnMeta('deleted_at', timestamptzCodec),
} as const

export const postsCols = {
  id: columnMeta('id', int8Codec),
  authorId: columnMeta('author_id', int8Codec),
  title: columnMeta('title', textCodec),
  amount: columnMeta('amount', numericCodec),
  published: columnMeta('published', boolCodec),
  createdAt: columnMeta('created_at', timestamptzCodec),
} as const

export const commentsCols = {
  id: columnMeta('id', int8Codec),
  postId: columnMeta('post_id', int8Codec),
  body: columnMeta('body', textCodec),
} as const

/** `u('email')` => the `"users"."email"` column node under the default `users` alias. */
export const u = (k: keyof typeof usersCols, alias = 'users') =>
  col(alias, usersCols[k].name, usersCols[k].codec)
export const p = (k: keyof typeof postsCols, alias = 'posts') =>
  col(alias, postsCols[k].name, postsCols[k].codec)
export const c = (k: keyof typeof commentsCols, alias = 'comments') =>
  col(alias, commentsCols[k].name, commentsCols[k].codec)

export const usersFrom = table(usersTable)
export const postsFrom = table(postsTable)
export const commentsFrom = table(commentsTable)
