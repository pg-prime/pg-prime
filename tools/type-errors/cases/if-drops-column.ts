// E2: `select()` REPLACES, so a `$if(boolean, …)` branch that does not re-select every column the
// query already has cannot be typed `O & Partial<Omit<O2, keyof O>>` — that promises `id`.
import type { Executor } from '../../../packages/pgorm/src/query/types.js'
import { schema } from '../../../packages/pgorm/test/schema/fixture.js'
declare const db: Executor
declare const flag: boolean
const q = db.from(schema.h.users, 'u').select((t) => ({ id: t.u.id }))
q.$if(flag, (b) => b.select((t) => ({ email: t.u.email }))).execute()
