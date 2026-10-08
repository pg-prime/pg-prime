// The consumer body tools/pack-smoke.mjs compiles and runs in a project holding only the
// tarballs, so every import here goes through the published export maps.
import { ContextError, TransactionHost } from '@pg-prime/context'
import { rollbackScope } from '@pg-prime/context/testing'
import { createMockPool } from '@pg-prime/testing'
import { defineSchema, pgPrime } from 'pg-prime'

const pool = createMockPool()
const db = pgPrime({ pool, schema: defineSchema({}) })
const host = new TransactionHost(db)

await host.run({ settings: { 'app.tenant_id': 't1' } }, () =>
  host.transaction(async (tx) => {
    if (host.tx() !== tx) throw new Error('pack-smoke: host.tx() is not the active transaction')
  }),
)
const scope = await rollbackScope(host)
let strict = false
await host.run({ settings: { 'app.tenant_id': 't1' } }, async () => {
  try {
    void host.db
  } catch (e) {
    strict = e instanceof ContextError && e.code === 'CONTEXT_UNSCOPED_QUERY'
  }
})
await scope.rollback()
if (!strict || pool.texts[1] !== 'select set_config($1,$2,true)') {
  throw new Error(`pack-smoke: unexpected statements ${JSON.stringify(pool.texts)}`)
}
await db.end()
console.log('pack-smoke @pg-prime/context consumer OK')
