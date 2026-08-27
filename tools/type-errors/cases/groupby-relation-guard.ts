// design/03 §2.3: a relation row-set projection after a GROUP BY that drops the parent key.
import type { Executor } from '../../../packages/pgorm/src/query/types.js'
import { schema } from '../../../packages/pgorm/test/schema/fixture.js'
declare const db: Executor
db.from(schema.h.users, 'u')
  .groupBy((t) => [t.u.email])
  .select((t) => ({ posts: t.u.posts.many((q) => q.select((p) => ({ id: p.id }))) }))
