/**
 * design/20 §3.3's type goldens: `definePolicy`, `setting`, `updatedAtTrigger`, `NonNullOperand`.
 * Compiled (not run) on TS 5.9.3 and 7.0.2 by `test/query/typecheck.test.ts`.
 */
import { expectTypeOf } from 'expect-type'
import { int4Codec, uuidCodec } from '../../../src/codec/index.js'
import {
  definePolicy,
  defineSchema,
  eq,
  pgTable,
  pgView,
  rls,
  setting,
  sql,
  updatedAtTrigger,
} from '../../../src/index.js'
import type { Executor, Policy } from '../../../src/index.js'
import type { RowOf } from '../../../src/query/types.js'

const orgId = setting('app.org_id', uuidCodec)
const count = setting('app.count', int4Codec)
const label = setting('app.label')

const documents = pgTable(
  'documents',
  (t) => ({
    id: t.uuid(),
    orgId: t.uuid(),
    archived: t.boolean().default(false),
    updatedAt: t.timestamptz(),
  }),
  (t) => [
    rls.force(),
    updatedAtTrigger(t.updatedAt),
    // @ts-expect-error — not a timestamp column
    updatedAtTrigger(t.archived),
  ],
)
const someView = pgView('v')
  .columns((t) => ({ id: t.uuid() }))
  .as(sql`select 1`)

expectTypeOf(
  definePolicy('tenant', {
    on: documents,
    to: ['app_user', 'public'],
    using: (t) => eq(t.orgId, orgId.current()),
    withCheck: (t) => eq(t.orgId, orgId.current()),
  }),
).toEqualTypeOf<Policy<typeof documents>>()

definePolicy('raw', { on: documents, for: 'select', using: () => sql`true` })
definePolicy('ins', { on: documents, for: 'insert', withCheck: (t) => eq(t.archived, false) })

// @ts-expect-error — FOR INSERT takes withCheck, not using
definePolicy('a', { on: documents, for: 'insert', using: (t) => eq(t.archived, false) })
// @ts-expect-error — FOR SELECT takes using, not withCheck
definePolicy('b', { on: documents, for: 'select', withCheck: (t) => eq(t.archived, false) })
// @ts-expect-error — a uuid is not a predicate
definePolicy('c', { on: documents, using: (t) => t.orgId })
// @ts-expect-error — a number is not a uuid
definePolicy('d', { on: documents, using: (t) => eq(t.orgId, 1) })
// @ts-expect-error — `= NULL` is never true; use isNull
definePolicy('e', { on: documents, using: (t) => eq(t.orgId, null) })
// @ts-expect-error — a view cannot carry a policy
definePolicy('f', { on: someView, using: () => sql`true` })

orgId.set('6f1c2a3b-0000-4000-8000-000000000001')
count.set(1)
label.set('x')
// @ts-expect-error — an int4 setting takes a number
count.set('1')

declare const db: Executor
const q = db
  .from(defineSchema({ documents }).h.documents)
  .select(() => ({ org: orgId.current(), n: count.current() }))
expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{ org: string | null; n: number | null }>()
