// design/03 §2.8: matching column names, different types.
import type { Executor } from '../../../packages/pgorm/src/query/types.js'
import { schema } from '../../../packages/pgorm/test/schema/fixture.js'
declare const db: Executor
const a = db.from(schema.h.users, 'u').select((t) => ({ id: t.u.email }))
const b = db.from(schema.h.posts, 'p').select((t) => ({ id: t.p.published }))
a.unionAll(b).execute()
