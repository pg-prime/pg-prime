// 03 §3.2: a value in a projection must carry a codec. `sql<T>` is not a cast, and a bare
// JavaScript value has no PostgreSQL type — `val(v, codec)` or `sql`…`.as(codec)` say which.
import type { Executor } from '../../../packages/pgorm/src/query/types.js'
import { schema } from '../../../packages/pgorm/test/schema/fixture.js'
declare const db: Executor
db.from(schema.h.users, 'u').select((t) => ({ id: t.u.id, kind: 'user' }))
