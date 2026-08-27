/**
 * `RowOf` / `InferResult` / `Loaded` (design/04 §2.5, design/03 §2.3 last paragraph).
 *
 * Two different jobs, and the point of this file is that they meet:
 *
 *  · `InferResult<typeof q>` recovers the exact row type of a built query (Kysely's trick,
 *    kysely.md §2.6) for the cases where the projection is the source of truth;
 *  · `Loaded<H, K, F>` lets a *signature* demand a load state (MikroORM's real insight,
 *    mikroorm.md §3.2) without a `Ref<T>`/`Collection<T>` runtime wrapper.
 *
 * Because query results are plain object types, a query that selected the right things is
 * **assignable** to the `Loaded` contract with no cast and no runtime marker. That composition is
 * the claim; everything below is it, or a control proving it is not vacuous.
 */
import { expectTypeOf } from 'expect-type'
import type { Loaded } from '../../../src/schema/index.js'
import type { Executor, InferResult, RowOf } from '../../../src/query/types.js'
import type { CommentsH, PostsH, UserId, UsersH } from '../../schema/fixture.js'
import { schema } from '../../schema/fixture.js'
import type { Assert, Eq } from './kit.js'

declare const db: Executor

const q = db.from(schema.h.users, 'u').select((t) => ({ id: t.u.id, email: t.u.email }))

// ── one indexed access recovers the row; `InferResult` is its array form ────
expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{ id: UserId; email: string }>()
type _Row = Assert<Eq<RowOf<typeof q>, { id: UserId; email: string }>>
type _Arr = Assert<Eq<InferResult<typeof q>, { id: UserId; email: string }[]>>

/** `execute()` returns exactly `InferResult`. */
type _Exec = Assert<Eq<Awaited<ReturnType<(typeof q)['execute']>>, InferResult<typeof q>>>

// ── Loaded: a signature that demands a loaded relation ──────────────────────
declare function notify(u: Loaded<UsersH, 'posts'>): string

/** A hand-written object satisfies it, because `Loaded` is structural, not a brand. */
declare const structural: Loaded<UsersH, 'posts'>
notify(structural)

/**
 * And so does a **query result**, with no cast and no runtime marker — which is the composition
 * design/04 §2.5 claims and the reason `Loaded` is worth having at all. Spelled on `comments`
 * (3 columns, one required `one` relation to a 6-column table) because the projection has to name
 * every column: there is no `...t.c.$all` spread in the v1 surface, only `selectAll(alias)`, which
 * replaces the whole projection and so cannot be combined with a relation key. Recorded as a gap
 * in design/09 §3.1 — design/03 §2.3's own example is written with `...u.$all`.
 */
declare function render(c: Loaded<CommentsH, 'post'>): void
const loaded = db.from(schema.h.comments, 'c').select((t) => ({
  id: t.c.id,
  postId: t.c.postId,
  body: t.c.body,
  post: t.c.post.one((s) =>
    s.select((p) => ({
      id: p.id,
      authorId: p.authorId,
      title: p.title,
      body: p.body,
      published: p.published,
      createdAt: p.createdAt,
    })),
  ),
}))
declare const loadedRow: RowOf<typeof loaded>
render(loadedRow)

/** Partial-column load state: three parameters, mirroring MikroORM v7. */
declare function shortName(u: Loaded<UsersH, never, 'id' | 'displayName'>): void
declare const bare: Loaded<UsersH>
shortName(bare) // a full row satisfies a partial contract

/** Cardinality reaches `Loaded` too: `maybeOne` is nullable, `one` is not. */
type _Many = Assert<Eq<Loaded<UsersH, 'posts'>['posts'], Loaded<PostsH>[]>>
type _MaybeOne = Assert<Eq<Loaded<UsersH, 'latest'>['latest'], Loaded<PostsH> | null>>
type _One = Assert<Eq<Loaded<PostsH, 'author'>['author'], Loaded<UsersH>>>

// ─────────────────────────────────────────────────────────────────────────────
// Negative controls
// ─────────────────────────────────────────────────────────────────────────────

// @ts-expect-error a bare row has no `posts`, so it cannot satisfy the contract
notify(bare)

// @ts-expect-error 'author' is not a relation of `users`
type _NoSuchRelation = Loaded<UsersH, 'author'>

declare const partial: Loaded<UsersH, never, 'id' | 'displayName'>
// @ts-expect-error `email` was not in the selected column set
partial.email

declare const withLatest: Loaded<UsersH, 'latest'>
// @ts-expect-error `latest` is a `maybeOne`, so it is possibly null
withLatest.latest.title

// @ts-expect-error `RowOf` demands something query-shaped, not any object
type _NotAQuery = RowOf<{ a: 1 }>
