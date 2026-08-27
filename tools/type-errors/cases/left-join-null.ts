// design/03 §2.2: a column read off a left-joined alias is nullable.
import type { Executor } from '../../../packages/pg-prime/src/query/types.js'
import { eq } from '../../../packages/pg-prime/src/query/types.js'
import { schema } from '../../../packages/pg-prime/test/schema/fixture.js'
declare const db: Executor
declare function needsString(s: string): void
const q = db
  .from(schema.h.posts, 'p')
  .leftJoin(schema.h.users, 'u', (t) => eq(t.p.authorId, t.u.id))
  .select((t) => ({ e: t.u.email }))
declare const row: import('../../../packages/pg-prime/src/query/types.js').RowOf<typeof q>
needsString(row.e)
