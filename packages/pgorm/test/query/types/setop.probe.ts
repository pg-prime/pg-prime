/**
 * Set operations (design/03 §2.8).
 *
 * The claim: branch shapes must match, checked at compile time, and the failure resolves to a
 * *sentence* rather than to a constraint cascade — design/03 §2.8 names the exact wording,
 * `union branch 2 has no column "kind"`.
 *
 * Three checks in the order a human would look (missing column → extra column → wrong type), and
 * the branch number is a real count, so a three-way union blames branch 3 when branch 3 is wrong.
 */
import { expectTypeOf } from 'expect-type'
import type { Executor, RowOf } from '../../../src/query/types.js'
import { desc } from '../../../src/query/types.js'
import { schema } from '../../schema/fixture.js'
import type { Assert, Eq } from './kit.js'

declare const db: Executor

const users = db.from(schema.h.users, 'u').select((t) => ({ id: t.u.email, name: t.u.email }))
const posts = db.from(schema.h.posts, 'p').select((t) => ({ id: t.p.id, name: t.p.title }))
const comments = db.from(schema.h.comments, 'c').select((t) => ({ id: t.c.id, name: t.c.body }))

// ── positive: matching shapes, then order/limit over the whole result ────────
const all = users.unionAll(posts).orderBy((r) => desc(r.id)).limit(50)
expectTypeOf<RowOf<typeof all>>().toEqualTypeOf<{ id: string; name: string }>()
type _All = Assert<Eq<RowOf<typeof all>, { id: string; name: string }>>

/** Chains, and the row type is branch 1's throughout. */
const three = users.union(posts).union(comments)
type _Three = Assert<Eq<RowOf<typeof three>, { id: string; name: string }>>

/** The whole vocabulary is there. */
users.union(posts)
users.unionAll(posts)
users.intersect(posts)
users.intersectAll(posts)
users.except(posts)
users.exceptAll(posts)

// ─────────────────────────────────────────────────────────────────────────────
// Negative controls.
//
// The check is a **return-position** sentinel (design/04 §4.1): a mismatched branch makes the
// call resolve to `OrmTypeError<'…'>`, so the diagnostic lands on the next thing done with it —
// hence the `.execute()` on each line below. Checking in parameter position instead was built
// first and measured at 926–1 319 characters, because TypeScript then prints the whole `Query<…>`
// argument twice; this way it is one line of ~150. `tools/type-errors/` holds the exact text.
// ─────────────────────────────────────────────────────────────────────────────

const missing = db.from(schema.h.posts, 'p').select((t) => ({ id: t.p.id }))
const extra = db
  .from(schema.h.posts, 'p')
  .select((t) => ({ id: t.p.id, name: t.p.title, kind: t.p.title }))
const wrongType = db.from(schema.h.posts, 'p').select((t) => ({ id: t.p.id, name: t.p.published }))

// @ts-expect-error union branch 2 has no column "name"
users.unionAll(missing).execute()

// @ts-expect-error union branch 2 has an extra column "kind"
users.unionAll(extra).execute()

// @ts-expect-error union branch 2 column "name" has a different type
users.unionAll(wrongType).execute()

/** Branch numbering is real: the same mistake in third position blames branch 3. */
// @ts-expect-error union branch 3 has no column "name"
users.union(posts).union(missing).execute()

/**
 * A set-op result is deliberately narrower than a `Query`: PostgreSQL applies `ORDER BY`,
 * `LIMIT` and `OFFSET` to the whole result and there is no scope left to filter or join against,
 * so those methods are absent rather than present-and-wrong.
 */
// @ts-expect-error there is no scope to filter after a set operation
users.unionAll(posts).where(() => true)

// @ts-expect-error nor to join against
users.unionAll(posts).innerJoin(schema.h.posts, 'p2', () => true)

// @ts-expect-error `orderBy` on a set result names RESULT columns, not a scope alias
users.unionAll(posts).orderBy((r) => r.u.email)
