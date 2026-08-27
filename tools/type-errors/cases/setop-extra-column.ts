// design/03 §2.8: the mirror case — the branch selects a column branch 1 does not.
import type { Executor } from '../../../packages/pgorm/src/query/types.js'
import { schema } from '../../../packages/pgorm/test/schema/fixture.js'
declare const db: Executor
const a = db.from(schema.h.users, 'u').select((t) => ({ id: t.u.email }))
const b = db.from(schema.h.posts, 'p').select((t) => ({ id: t.p.title, kind: t.p.title }))
a.unionAll(b).execute()
