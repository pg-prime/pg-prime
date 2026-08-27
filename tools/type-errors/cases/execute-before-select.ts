// E16: `.execute()` before `.select()` used to typecheck as `Promise<unknown[]>` and emit `select *`.
import type { Executor } from '../../../packages/pgorm/src/query/types.js'
import { schema } from '../../../packages/pgorm/test/schema/fixture.js'
declare const db: Executor
db.from(schema.h.users, 'u').execute()
