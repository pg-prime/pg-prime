// design/04 §4, mistake E1: a misspelled column in a projection.
// The suggestion must stay INLINE (TS2551 "Did you mean"), not be buried in an overload cascade.
import type { Executor } from '../../../packages/pgorm/src/query/types.js'
import { schema } from '../../../packages/pgorm/test/schema/fixture.js'
declare const db: Executor
db.from(schema.h.users, 'u').select((t) => ({ e: t.u.emial }))
