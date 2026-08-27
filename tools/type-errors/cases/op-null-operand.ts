// design/09 §3.3 decision 1: `eq(a, null)` would compile to `a = NULL`, which is NULL and
// therefore never true — the query silently returns no rows. Rejected at the type level;
// `isNull(a)` and `isDistinctFrom(a, b)` say each of the two things a caller might mean.
import type { Executor } from '../../../packages/pgorm/src/query/types.js'
import { eq } from '../../../packages/pgorm/src/query/types.js'
import { schema } from '../../../packages/pgorm/test/schema/fixture.js'
declare const db: Executor
db.from(schema.h.users, 'u').where((t) => eq(t.u.birthday, null))
