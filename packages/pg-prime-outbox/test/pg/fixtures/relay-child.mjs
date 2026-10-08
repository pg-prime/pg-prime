// A relay process for the SIGKILL test: it logs its first wave, says so, and never settles it.
import { defineSchema, pgPrime, sql } from 'pg-prime'
import { defineOutbox, functionSink, pgOutbox } from '../../../src/index.ts'

const schema = process.env['OUTBOX_SCHEMA']
const db = pgPrime({ schema: defineSchema({}), connection: process.env['PG_PRIME_TEST_URL'] })
const outbox = pgOutbox({ db, schema, define: { t: defineOutbox('kill', { partitions: 1 }) } })
await outbox.start()
outbox.topics.t.relay(
  functionSink(async (wave, ctx) => {
    for (const r of wave) {
      await db.sql`insert into ${sql.ident(schema, 'log')} (idem, epoch) values (${r.idem}, ${ctx.epoch})`.execute()
    }
    process.stdout.write('delivering\n')
    await new Promise(() => {})
  }),
  { leaseMs: 1_500 },
)
