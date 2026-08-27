// design/04 §4, mistake E2: the wrong operand type in a `where`.
// The operand comes from the OPERATOR, not from the column (kysely.md §5.2(3)).
import type { Executor } from '../../../packages/pgorm/src/query/types.js'
import { eq } from '../../../packages/pgorm/src/query/types.js'
import { schema } from '../../../packages/pgorm/test/schema/fixture.js'
declare const db: Executor
db.from(schema.h.users, 'u').where((t) => eq(t.u.views, 'not a bigint'))
