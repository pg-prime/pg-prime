// kysely.md §1.8 pattern 3: the imperative build-up that silently loses a column without `[INV]`.
import type { Executor, Query } from '../../../packages/pg-prime/src/query/types.js'
export type _Ref = Query<never, never>
import { schema } from '../../../packages/pg-prime/test/schema/fixture.js'
declare const db: Executor
declare const needsEmail: boolean
let q = db.from(schema.h.users, 'u').select((t) => ({ id: t.u.id }))
if (needsEmail) q = db.from(schema.h.users, 'u').select((t) => ({ id: t.u.id, email: t.u.email }))
