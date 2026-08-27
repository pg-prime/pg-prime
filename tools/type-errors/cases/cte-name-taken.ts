// design/03 §2.7: two CTEs cannot share a name.
import type { Executor } from '../../../packages/pg-prime/src/query/types.js'
import { schema } from '../../../packages/pg-prime/test/schema/fixture.js'
declare const db: Executor
db.with('recent', (x) => x.from(schema.h.posts, 'p').select((t) => ({ id: t.p.id })))
  .with('recent', (x) => x.from(schema.h.posts, 'p').select((t) => ({ id: t.p.id })))
  .fromCte('recent')
