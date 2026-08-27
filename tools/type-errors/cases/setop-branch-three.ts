// The branch number is a real count, not a hard-coded 2.
import type { Executor } from '../../../packages/pg-prime/src/query/types.js'
import { schema } from '../../../packages/pg-prime/test/schema/fixture.js'
declare const db: Executor
const a = db.from(schema.h.users, 'u').select((t) => ({ id: t.u.email, kind: t.u.email }))
const ok = db.from(schema.h.posts, 'p').select((t) => ({ id: t.p.title, kind: t.p.title }))
const bad = db.from(schema.h.posts, 'p').select((t) => ({ id: t.p.title }))
a.union(ok).union(bad).execute()
