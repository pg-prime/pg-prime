/**
 * `.prepare<P>()`, `executeTakeFirst()`, `stream()` and `placeholder()` at the type level
 * (design/03 §1.4b; design/09 WS6).
 *
 * Three claims, and the negative control for each:
 *
 *  1. `PreparedQuery<P, O>` keeps `O` exactly — the same row type `execute()` would give, not a
 *     widened or `Partial` one.
 *  2. `P` is the caller's, and `execute()` demands exactly it. A missing key and an extra key are
 *     both compile errors, so the runtime check in `./prepared.ts` is a backstop and not the
 *     first line of defence for the *typed* caller.
 *  3. `placeholder(name, codec)` is a class-gated operand: it reaches `eq`/`gt` through the same
 *     `[META].pg` door a column does (fork F1, `03` §2.9), so a `text` hole cannot be compared
 *     with a `numeric` column.
 */
import { expectTypeOf } from 'expect-type'
import { int8Codec, numericCodec, textCodec } from '../../../src/codec/index.js'
import type { Executor, PreparedQuery } from '../../../src/query/types.js'
import { eq, gt, ilike, placeholder } from '../../../src/query/types.js'
import type { UserId } from '../../schema/fixture.js'
import { schema } from '../../schema/fixture.js'
import type { OUT } from '../../../src/schema/index.js'
import type { Assert, Eq } from './kit.js'

declare const db: Executor

const q = db
  .from(schema.h.users, 'u')
  .select((t) => ({ id: t.u.id, email: t.u.email }))
  .where((t) => eq(t.u.email, placeholder('email', textCodec)))

// ── 1. the row type survives .prepare() unchanged ────────────────────────────
const p = q.prepare<{ email: string }>('users_by_email')
type Row = { id: UserId; email: string }

expectTypeOf(p).toEqualTypeOf<PreparedQuery<{ email: string }, Row>>()
expectTypeOf(p.execute({ email: 'a@b.c' })).resolves.toEqualTypeOf<Row[]>()

/** `executeTakeFirst` is the row **or undefined** — never `null`, never the row alone. */
expectTypeOf(p.executeTakeFirst({ email: 'a@b.c' })).resolves.toEqualTypeOf<Row | undefined>()
expectTypeOf(q.executeTakeFirst()).resolves.toEqualTypeOf<Row | undefined>()

type _TakeFirstIsExact = Assert<
  Eq<Awaited<ReturnType<typeof q.executeTakeFirst>>, Row | undefined>
>

/** `stream()` yields the row type, one at a time. */
expectTypeOf(q.stream()).toEqualTypeOf<AsyncIterable<Row>>()
expectTypeOf(q.stream({ batchSize: 500 })).toEqualTypeOf<AsyncIterable<Row>>()

/** `toSQL()` never needs a database and never needs the holes filled. */
expectTypeOf(q.toSQL().sql).toEqualTypeOf<string>()
expectTypeOf(p.meta.placeholders).toEqualTypeOf<readonly string[]>()

// ── 2. P is demanded exactly ─────────────────────────────────────────────────
// @ts-expect-error — the placeholder was declared and no value was given for it.
p.execute({})
// @ts-expect-error — `emial` is a typo; the type layer catches it before the runtime does.
p.execute({ emial: 'a@b.c' })
// @ts-expect-error — a `string` hole is not a `number`.
p.execute({ email: 42 })

/** With no explicit `P`, the default admits `{}` and refuses anything else. */
const none = db.from(schema.h.users, 'u').select((t) => ({ id: t.u.id })).prepare()
none.execute({})
// @ts-expect-error — nothing was declared, so nothing may be passed.
none.execute({ email: 'a@b.c' })

// ── 3. a placeholder is a class-gated operand ────────────────────────────────
//
// A class-gated operator reads `[META]['pg']` off its operand, and a placeholder republishes its
// codec's `name` there exactly as a column and a `.as()` fragment do (WS3's closure of the fork-F1
// hole). `ilike` takes a `TextOperand`, so this is the door and the negative is the proof that the
// hole goes through it rather than round it.
db.from(schema.h.users, 'u')
  .select((t) => ({ id: t.u.id }))
  .where(() => ilike(placeholder('pattern', textCodec), 'a%'))

db.from(schema.h.users, 'u')
  .select((t) => ({ id: t.u.id }))
  // @ts-expect-error — a `numeric` hole is not a text operand, however string-shaped it is.
  .where(() => ilike(placeholder('pattern', numericCodec), 'a%'))

// The comparison operators are `AnyOperand` on the left and `Operand<T>` on the right, so they are
// gated on the TS type only — the design's rule for `eq`/`gt`, not a placeholder quirk. `numeric`
// decodes to `string`, so a `text` hole is assignable to a `numeric` column's comparison.
// Recorded rather than asserted, so nobody reads the negative above as meaning more than it does.
db.from(schema.h.users, 'u')
  .select((t) => ({ id: t.u.id }))
  .where((t) => gt(t.u.balance, placeholder('min', textCodec)))

/** And it carries the codec's OUTPUT type, so the comparison's operand type is exact. */
type _HoleOut = Assert<Eq<(typeof idHole)[typeof OUT], bigint>>
const idHole = placeholder('id', int8Codec)

// ── .prepare() needs a projection, exactly as .execute() does ────────────────
// @ts-expect-error — no `.select()`, so there is no row shape to prepare.
db.from(schema.h.users, 'u').prepare()
// @ts-expect-error — same guard on the streaming terminal.
db.from(schema.h.users, 'u').stream()
// @ts-expect-error — and on the single-row one.
db.from(schema.h.users, 'u').executeTakeFirst()

// ── the write builders have the same three terminals ─────────────────────────
const w = db
  .insertInto(schema.h.users)
  .values({ email: 'a@b.c' })
  .returning((t) => ({ id: t.users.id }))
expectTypeOf(w.executeTakeFirst()).resolves.toEqualTypeOf<{ id: UserId } | undefined>()
expectTypeOf(w.prepare()).toEqualTypeOf<PreparedQuery<Record<string, never>, { id: UserId }>>()
