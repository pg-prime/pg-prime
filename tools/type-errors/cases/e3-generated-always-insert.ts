// design/04 §4, mistake E3: writing a GENERATED ALWAYS column.
// `seq` is `ro: true`, so it is absent from the insert shape entirely.
import type { Insertable } from '../../../packages/pg-prime/src/schema/index.js'
import type { users } from '../../../packages/pg-prime/test/schema/fixture.js'
const row: Insertable<typeof users> = { email: 'a@b.c', seq: 1n }
