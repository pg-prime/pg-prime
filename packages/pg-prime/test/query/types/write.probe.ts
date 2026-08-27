/**
 * The write builders' types (design/09 WS4; `03` §2.5–2.6).
 *
 * The claims under test, in the order they matter:
 *
 *  1. `values(...)` takes `Insertable` shape — a GENERATED ALWAYS column is *absent*, a column
 *     with a default is *optional*, everything else is *required* — widened per column to
 *     "value or expression" so `createdAt: fn.now()` needs no cast.
 *  2. `RETURNING` narrows the row exactly, the way `select` does, and `returningAll()` is the
 *     table's select row.
 *  3. `set(...)` accepts every writable column and rejects a read-only one.
 *  4. `fromValues(rows, codecs)` gives the second lambda parameter refs typed **by the declared
 *     codec** — `numeric` → `string`, `int8` → `bigint` — which is the whole reason the codecs
 *     are declared at the call site instead of inferred from the JavaScript.
 *  5. `excluded` is a full ref record, so operators work on it.
 *
 * Every negative is an `@ts-expect-error`, which is TS2578 when it stops firing — so a lost
 * rejection fails `test/query/typecheck.test.ts` (R4, R7).
 */
import { expectTypeOf } from 'expect-type'
import { int8Codec, numericCodec, textCodec } from '../../../src/codec/index.js'
import type { Executor, RowOf } from '../../../src/query/types.js'
import { add, arrayConcat, eq, fn, isNull, lt } from '../../../src/query/types.js'
import type { DateString } from '../../../src/schema/index.js'
import type { UserId } from '../../schema/fixture.js'
import { schema } from '../../schema/fixture.js'

declare const db: Executor

// ── 1. Insertable shape ──────────────────────────────────────────────────────

const ins = db.insertInto(schema.h.users).values({ email: 'a@b.c' })
// `seq` is GENERATED ALWAYS, `id`/`views`/… have defaults, `email` is the one required column.

/** A value or an expression, per column. */
db.insertInto(schema.h.users).values({ email: 'a@b.c', createdAt: fn.now(), views: 1n })

// @ts-expect-error — `email` is required (NOT NULL, no default)
db.insertInto(schema.h.users).values({ displayName: 'x' })

// @ts-expect-error — `seq` is GENERATED ALWAYS: absent from the insert row entirely
db.insertInto(schema.h.users).values({ email: 'a@b.c', seq: 1n })

// @ts-expect-error — a column the table does not have
db.insertInto(schema.h.users).values({ email: 'a@b.c', nope: 1 })

// @ts-expect-error — right shape, wrong type
db.insertInto(schema.h.users).values({ email: 42 })

// ── 2. RETURNING narrows exactly ─────────────────────────────────────────────

const returned = ins.returning((t) => ({ id: t.users.id, joined: t.users.createdAt }))
expectTypeOf<RowOf<typeof returned>>().toEqualTypeOf<{ id: UserId; joined: Date }>()

const all = db.insertInto(schema.h.posts).values({ authorId: 'u1', title: 't' }).returningAll()
expectTypeOf<RowOf<typeof all>>().toEqualTypeOf<{
  id: string
  authorId: string
  title: string
  body: string | null
  published: boolean
  createdAt: Date
}>()

// ── 3. set() ─────────────────────────────────────────────────────────────────

db.update(schema.h.users).set((t) => ({ views: add(t.users.views, 1n), displayName: 'x' }))
db.update(schema.h.users).set(() => ({ balance: '1.00', createdAt: fn.now() }))

// @ts-expect-error — `seq` is GENERATED ALWAYS
db.update(schema.h.users).set(() => ({ seq: 1n }))

// @ts-expect-error — wrong type for the column
db.update(schema.h.users).set(() => ({ views: 'lots' }))

// ── 4. fromValues gives typed refs, from the DECLARED codecs ─────────────────

const bulk = db
  .update(schema.h.users)
  .fromValues([{ id: 'u1', balance: '1.00' }], { id: textCodec, balance: numericCodec })

bulk.set((_t, v) => ({ balance: v.balance })).where((t, v) => eq(t.users.email, 'x'))

// @ts-expect-error — `v.nope` was not declared
bulk.set((_t, v) => ({ balance: v.nope }))

// ── 5. excluded is a ref record ──────────────────────────────────────────────

db
  .insertInto(schema.h.users)
  .values({ email: 'a@b.c' })
  .onConflict((c) =>
    c
      .columns((t) => [t.email])
      .where((t) => isNull(t.birthday))
      .doUpdate((set, excluded) => ({
        displayName: excluded.displayName,
        tags: arrayConcat(set.tags, excluded.tags),
        updatedAt: fn.now(),
      }))
      .whereUpdate((t, excluded) => lt(t.updatedAt, excluded.updatedAt)),
  )

const upsert = db.insertInto(schema.h.users).values({ email: 'a@b.c' })
// @ts-expect-error — the column types still apply to `excluded`: `views` is int8, `email` is text
upsert.onConflict((c) => c.columns((t) => [t.email]).doUpdate((_s, ex) => ({ email: ex.views })))

// ── delete ───────────────────────────────────────────────────────────────────

const del = db
  .deleteFrom(schema.h.posts)
  .using(schema.h.users, 'u')
  .where((t) => eq(t.posts.authorId, t.u.id))
  .returning((t) => ({ id: t.posts.id, email: t.u.email }))

expectTypeOf<RowOf<typeof del>>().toEqualTypeOf<{ id: string; email: string }>()

// @ts-expect-error — `using` widened the scope under `u`, so `users` is not a key
db.deleteFrom(schema.h.posts).using(schema.h.users, 'u').where((t) => isNull(t.users.birthday))

export type _Unused = [typeof returned, typeof all, typeof bulk, typeof upsert, DateString, typeof int8Codec]
