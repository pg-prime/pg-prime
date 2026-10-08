// The consumer body tools/pack-smoke.mjs compiles and runs in a project holding only the
// tarballs, so every import here goes through the published export maps.
import { defineQueue, migrationSql, pgMq } from '@pg-prime/mq'
import { createMockPool } from '@pg-prime/testing'
import type { MockStep } from '@pg-prime/testing'
import { defineSchema, pgPrime } from 'pg-prime'

// An empty server: no ledger yet, every other statement answers no rows.
const step: MockStep = (q) =>
  q.text.includes('to_regclass') ? { fields: ['ok'], rows: [['f']] } : {}
const pool = createMockPool({ script: Array.from({ length: 200 }, () => step) })
const db = pgPrime({ pool, schema: defineSchema({}) })
const emails = defineQueue<{ to: string }>('emails')
const mq = pgMq({ db, define: { emails } })
await mq.start()
// The mock returns no rows, so the send cannot settle; the statement is what is checked.
await mq.queues.emails.send({ to: 'a@example.com' }).catch(() => {})
const sent = pool.queries.find((q) => q.text.includes('jsonb_to_recordset'))
if (sent === undefined || !JSON.stringify(sent.values).includes('a@example.com')) {
  throw new Error(`pack-smoke: send issued ${JSON.stringify(pool.texts.slice(-5))}`)
}
if (!migrationSql()[0]?.sql.includes('"pgprime_mq".messages')) {
  throw new Error('pack-smoke: migrationSql')
}
await db.end()
console.log('pack-smoke @pg-prime/mq consumer OK')
