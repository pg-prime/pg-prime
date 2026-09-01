// design/01 §3 row 58: a view is a queryable entity with no write surface.
import type { Executor } from '../../../packages/pg-prime/src/query/types.js'
import { activeUsers } from '../../../packages/pg-prime/test/schema/fixture.js'
declare const db: Executor
db.insertInto(activeUsers).values({ email: 'a@b.c' })
