// design/03 §2.9 / design/09 §3.0: a text operator on a numeric column.
// `balance` is `numeric`, which decodes to `string`, so only the PG type-class gate catches it.
import type { Executor } from '../../../packages/pg-prime/src/query/types.js'
import { ilike } from '../../../packages/pg-prime/src/query/types.js'
import { schema } from '../../../packages/pg-prime/test/schema/fixture.js'
declare const db: Executor
db.from(schema.h.users, 'u').where((t) => ilike(t.u.balance, 'x%'))
