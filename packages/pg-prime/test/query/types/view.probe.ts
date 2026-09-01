/**
 * `pgView` / `pgMaterializedView` as typed read-only entities — design/01 §3 row 58.
 *
 * The claims under test, in the order they matter:
 *
 *  1. A view is a **FROM source with exact column types**: `db.from(activeUsers)` binds the alias
 *     `active_users`, the refs carry the declared branded/PG types, and the projected row is
 *     exactly the declared shape. A CTE handle cannot do this — `CteColMeta.pg` is `any`, so the
 *     operator gates go dark — which is why a view carries real `Cols` instead.
 *  2. A view **joins** like a table, on either side, with the same alias rules.
 *  3. `insertInto` / `update` / `deleteFrom` resolve to design/04 §4.1's branded sentence rather
 *     than to a statement builder. The *text* of that sentence is `tools/type-errors/`'s golden;
 *     what is pinned here is that the three entry points are sentinels at all, and that the three
 *     of them still build normally for a table.
 *  4. `refreshMaterializedView` takes a materialized view and refuses a plain one.
 *
 * Every negative is an `@ts-expect-error`, which is TS2578 when it stops firing.
 */
import { expectTypeOf } from 'expect-type'
import { eq } from '../../../src/query/types.js'
import type { Db, Executor, RowOf } from '../../../src/query/types.js'
import type { ERR, OrmTypeError } from '../../../src/schema/index.js'
import type { UserId } from '../../schema/fixture.js'
import { activeUsers, schema, userStats } from '../../schema/fixture.js'

declare const db: Executor
declare const handle: Db<typeof schema>

// ── 1. A view is a FROM source with exact column types ───────────────────────

const rows = db
  .from(activeUsers)
  .select((t) => ({ id: t.active_users.id, email: t.active_users.email }))
expectTypeOf<RowOf<typeof rows>>().toEqualTypeOf<{ id: UserId; email: string }>()

/** The alias is the view's own name, exactly as a table handle's is its registry key. */
const aliased = db.from(activeUsers, 'v').select((t) => ({ e: t.v.email }))
expectTypeOf<RowOf<typeof aliased>>().toEqualTypeOf<{ e: string }>()

/** `selectAll()` is the declared column list and nothing else. */
const everything = db.from(activeUsers).selectAll('active_users')
expectTypeOf<RowOf<typeof everything>>().toEqualTypeOf<{ id: UserId; email: string }>()

/** The PG type class survives, so the operator gates stay exact. */
db.from(activeUsers).where((t) => eq(t.active_users.email, 'a@b.c'))

// @ts-expect-error — `uuid` is not a `text`, and the operand table says so
db.from(activeUsers).where((t) => eq(t.active_users.id, 1))

// @ts-expect-error — the view has no column called `nope`
db.from(activeUsers).select((t) => ({ n: t.active_users.nope }))

// ── 2. Joins ─────────────────────────────────────────────────────────────────

const joined = db
  .from(schema.h.users, 'u')
  .innerJoin(activeUsers, 'a', (t) => eq(t.u.id, t.a.id))
  .select((t) => ({ id: t.u.id, email: t.a.email }))
expectTypeOf<RowOf<typeof joined>>().toEqualTypeOf<{ id: UserId; email: string }>()

const fromView = db
  .from(activeUsers)
  .innerJoin(schema.h.posts, 'p', (t) => eq(t.p.authorId, t.active_users.id))
  .select((t) => ({ title: t.p.title }))
expectTypeOf<RowOf<typeof fromView>>().toEqualTypeOf<{ title: string }>()

// ── 3. No write surface ──────────────────────────────────────────────────────

/**
 * The sentinel is a *type*, so the assertion is that the three entry points resolve to an
 * `OrmTypeError` carrying a sentence — never that they resolve to a builder.
 */
expectTypeOf(db.insertInto(activeUsers)).toExtend<OrmTypeError<string>>()
expectTypeOf(db.update(activeUsers)).toExtend<OrmTypeError<string>>()
expectTypeOf(db.deleteFrom(activeUsers)).toExtend<OrmTypeError<string>>()
expectTypeOf(db.insertInto(userStats)).toExtend<OrmTypeError<string>>()

/** The sentence names the view, so the reader is told which entity refused. */
type InsertErr = (typeof db.insertInto<typeof activeUsers>) extends (t: never) => infer R
  ? R
  : never
expectTypeOf<InsertErr[typeof ERR]>().toEqualTypeOf<
  'insertInto() takes a table: "active_users" is a view and is read-only — write to the table it selects from, or add an INSTEAD OF trigger through the sql/ lane'
>()

// @ts-expect-error — the sentinel has no `values`; this is row 58's acceptance criterion
db.insertInto(activeUsers).values({ email: 'a@b.c' })

// @ts-expect-error — nor a `set`
db.update(activeUsers).set(() => ({ email: 'a@b.c' }))

// @ts-expect-error — nor a `where`
db.deleteFrom(activeUsers).where(() => eq(1, 1))

/** A table is untouched: all three still build. */
db.insertInto(schema.h.users).values({ email: 'a@b.c' })
db.update(schema.h.users).set(() => ({ email: 'a@b.c' }))
db.deleteFrom(schema.h.users).where((t) => eq(t.users.email, 'a@b.c'))

/** So is a CTE handle, whose refusal is still the runtime's (it carries no `[READONLY]`). */
db.with('recent', (d) => d.from(schema.h.posts, 'p').select((t) => ({ id: t.p.id })))
  .insertInto(schema.h.posts)
  .values({ authorId: 'u1', title: 't' })

// ── 4. REFRESH ───────────────────────────────────────────────────────────────

expectTypeOf(handle.refreshMaterializedView(userStats)).toEqualTypeOf<Promise<void>>()
void handle.refreshMaterializedView(userStats, { concurrently: true })

// @ts-expect-error — a plain view has no stored rows to refresh
void handle.refreshMaterializedView(activeUsers)

// @ts-expect-error — nor does a table
void handle.refreshMaterializedView(schema.h.users)
