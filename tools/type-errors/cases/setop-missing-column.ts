// design/03 §2.8: `union branch 2 has no column "kind"`, verbatim.
import type { Executor } from '../../../packages/pg-prime/src/query/types.js'
import { schema } from '../../../packages/pg-prime/test/schema/fixture.js'
declare const db: Executor
const a = db.from(schema.h.users, 'u').select((t) => ({ id: t.u.email, kind: t.u.email }))
const b = db.from(schema.h.posts, 'p').select((t) => ({ id: t.p.title }))
a.unionAll(b).execute()
