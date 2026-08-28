/**
 * `innerJoin` — scope widening (design/03 §2.2, design/04 §2.3).
 *
 * The claim: a join adds exactly one alias to `S`, the alias is visible in its own `ON` callback
 * and in every callback after it, and nothing that was not joined is reachable. `S` is the whole
 * mechanism — there is no `DB` interface and no `keyof DB`, so the cost of a join is the cost of
 * one more entry in a 1–4 entry record, not a pass over the schema.
 */
import { expectTypeOf } from 'expect-type'
import type { Executor, RowOf } from '../../../src/query/types.js'
import { and, eq, nest } from '../../../src/query/types.js'
import type { UserId } from '../../schema/fixture.js'
import { schema } from '../../schema/fixture.js'
import type { Assert, Eq } from './kit.js'

declare const db: Executor

// ── positive: two joins, three aliases, all exact and all non-null ───────────
const q = db
  .from(schema.h.posts, 'p')
  .innerJoin(schema.h.users, 'u', (t) => eq(t.p.authorId, t.u.id))
  .innerJoin(schema.h.comments, 'c', (t) => eq(t.c.postId, t.p.id))
  .where((t) => and(eq(t.p.published, true), eq(t.u.role, 'admin')))
  .select((t) => ({
    title: t.p.title,
    author: nest({ id: t.u.id, email: t.u.email }),
    comment: t.c.body,
  }))

expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{
  title: string
  author: { id: UserId; email: string }
  comment: string
}>()
type _Q = Assert<
  Eq<RowOf<typeof q>, { title: string; author: { id: UserId; email: string }; comment: string }>
>

/** The same table twice, under two aliases — the case a template-literal alias parser gets wrong. */
const selfJoin = db
  .from(schema.h.posts, 'p')
  .leftJoin(schema.h.posts, 'reply', (t) => eq(t.reply.authorId, t.p.authorId))
  .select((t) => ({ a: t.p.title, b: t.reply.title }))
type _Self = Assert<Eq<RowOf<typeof selfJoin>, { a: string; b: string | null }>>

/** The joined alias is already usable inside its own `ON` callback. */
db.from(schema.h.posts, 'p').innerJoin(schema.h.users, 'u', (t) => eq(t.p.authorId, t.u.id))

/**
 * `eq(a, b)` types `b` from `a` — deliberately, and it is what makes `eq(t.u.views, 'x')` an
 * error (see `../query.probe.ts`). The consequence is that a **branded FK is asymmetric**:
 * `users.id` is `$type<UserId>()` while `posts.author_id` is a plain `uuid`, so the predicate
 * typechecks in one direction only. The modelling fix is to brand both ends of the key; the
 * builder cannot infer it for you without also accepting `eq(t.u.views, 'x')`.
 */
db.from(schema.h.posts, 'p').innerJoin(schema.h.users, 'u', (t) => eq(t.p.authorId, t.u.id))
// @ts-expect-error the other operand order needs `posts.authorId` to carry the same brand
db.from(schema.h.posts, 'p').innerJoin(schema.h.users, 'u', (t) => eq(t.u.id, t.p.authorId))


// ─────────────────────────────────────────────────────────────────────────────
// right / full / cross, and the two laterals (design/03 §2.2; `12` B)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A RIGHT join is a LEFT join with the nullable side swapped, and the *type* has to swap with it:
 * it is the aliases already in scope that gain `| null`, because the rows that survive are the
 * joined table's. Getting this backwards is silent — the SQL is identical either way.
 */
const right = db
  .from(schema.h.posts, 'p')
  .rightJoin(schema.h.users, 'u', (t) => eq(t.p.authorId, t.u.id))
  .select((t) => ({ title: t.p.title, email: t.u.email }))
type _Right = Assert<Eq<RowOf<typeof right>, { title: string | null; email: string }>>

/** Two aliases were in scope, so a right join nulls both of them. */
const rightAfterTwo = db
  .from(schema.h.posts, 'p')
  .innerJoin(schema.h.comments, 'c', (t) => eq(t.c.postId, t.p.id))
  .rightJoin(schema.h.users, 'u', (t) => eq(t.p.authorId, t.u.id))
  .select((t) => ({ title: t.p.title, body: t.c.body, email: t.u.email }))
type _RightTwo = Assert<
  Eq<RowOf<typeof rightAfterTwo>, { title: string | null; body: string | null; email: string }>
>

/** A FULL join nulls both sides, including the one it adds. */
const full = db
  .from(schema.h.posts, 'p')
  .fullJoin(schema.h.users, 'u', (t) => eq(t.p.authorId, t.u.id))
  .select((t) => ({ title: t.p.title, email: t.u.email }))
type _Full = Assert<Eq<RowOf<typeof full>, { title: string | null; email: string | null }>>

/** A CROSS join nulls nothing — and takes no `ON`, so there is no third argument to pass. */
const cross = db
  .from(schema.h.posts, 'p')
  .crossJoin(schema.h.users, 'u')
  .select((t) => ({ title: t.p.title, email: t.u.email }))
type _Cross = Assert<Eq<RowOf<typeof cross>, { title: string; email: string }>>

// @ts-expect-error a cross join has no ON clause; use innerJoin for a predicate
db.from(schema.h.posts, 'p').crossJoin(schema.h.users, 'u', (t) => eq(t.p.authorId, t.u.id))

/** The bare two-argument spelling defaults the alias to the source's own key, as it does elsewhere. */
const crossBare = db
  .from(schema.h.posts, 'p')
  .crossJoin(schema.h.users)
  .select((t) => ({ email: t.users.email }))
type _CrossBare = Assert<Eq<RowOf<typeof crossBare>, { email: string }>>

/** A lateral binds the sub-query's own row shape under the alias, with its codecs intact. */
const lateral = db
  .from(schema.h.users, 'u')
  .innerJoinLateral(
    (t) =>
      db
        .from(schema.h.posts, 'p')
        .where((s) => eq(s.p.authorId, t.u.id))
        .select((s) => ({ id: s.p.id, title: s.p.title }))
        .limit(3),
    'recent',
  )
  .select((t) => ({ email: t.u.email, title: t.recent.title, id: t.recent.id }))
type _Lateral = Assert<Eq<RowOf<typeof lateral>, { email: string; title: string; id: string }>>

/** …and a LEFT lateral nulls its own alias and nothing else. */
const leftLateral = db
  .from(schema.h.users, 'u')
  .leftJoinLateral(
    (t) =>
      db
        .from(schema.h.posts, 'p')
        .where((s) => eq(s.p.authorId, t.u.id))
        .select((s) => ({ title: s.p.title })),
    'recent',
  )
  .select((t) => ({ email: t.u.email, title: t.recent.title }))
type _LeftLateral = Assert<Eq<RowOf<typeof leftLateral>, { email: string; title: string | null }>>

/** The `ON` is optional (it defaults to `ON TRUE`) and sees the lateral's alias when written. */
db.from(schema.h.users, 'u').leftJoinLateral(
  () => db.from(schema.h.posts, 'p').select((s) => ({ title: s.p.title })),
  'recent',
  (t) => eq(t.recent.title, 'x'),
)

/** The lateral's columns are its projection's, not the source table's. */
db.from(schema.h.users, 'u')
  .innerJoinLateral(() => db.from(schema.h.posts, 'p').select((s) => ({ title: s.p.title })), 'r')
  // @ts-expect-error `body` was not projected by the sub-query
  .select((t) => ({ x: t.r.body }))

// ─────────────────────────────────────────────────────────────────────────────
// Negative controls
// ─────────────────────────────────────────────────────────────────────────────

const joined = db
  .from(schema.h.posts, 'p')
  .innerJoin(schema.h.users, 'u', (t) => eq(t.p.authorId, t.u.id))

// @ts-expect-error `c` was never joined
joined.select((t) => ({ x: t.c.body }))

// @ts-expect-error the ON callback must return a boolean expression, not a column
db.from(schema.h.posts, 'p').innerJoin(schema.h.users, 'u', (t) => t.u.id)

// @ts-expect-error operands are tied to each other's output type: bool vs text
db.from(schema.h.posts, 'p').innerJoin(schema.h.users, 'u', (t) => eq(t.p.published, t.u.email))

/**
 * ...but only to each other's **TS** type. `eq` is not PG-type-class gated, so `uuid = text` —
 * two different PG types that both decode to `string` — compiles here and is a 42883 at prepare
 * time. Gating it would mean rejecting `int4 = int8`, which PostgreSQL accepts, so the check
 * belongs to the compile seam (WS2/WS3), not to the operand type. Recorded in design/04 §5.
 */
db.from(schema.h.posts, 'p').innerJoin(schema.h.users, 'u', (t) => eq(t.p.authorId, t.u.email))

// @ts-expect-error `users` has no relation called `author` — `posts` does, and joining is not that
joined.select((t) => ({ x: t.u.author }))
