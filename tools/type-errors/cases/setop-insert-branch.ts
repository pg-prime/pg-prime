// E4: an `InsertQuery` satisfies `RowSource` structurally, so `select … union insert …` used to
// typecheck and then fail in the compiler. The `[SELECT_SOURCE]` brand is what keeps it out.
import type { Executor } from '../../../packages/pgorm/src/query/types.js'
import { schema } from '../../../packages/pgorm/test/schema/fixture.js'
declare const db: Executor
const sel = db.from(schema.h.posts, 'p').select((t) => ({ id: t.p.id }))
const ins = db.insertInto(schema.h.posts).values({ authorId: 'a', title: 't' }).returning((t) => ({ id: t.posts.id }))
sel.union(ins).execute()
