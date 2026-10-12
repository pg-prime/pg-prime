// A relay process whose sink logs its first wave, says so, and never settles it. With
// OUTBOX_CLOSE it then closes the relay, says so, and ends its pool once stdin ends.
import { defineSchema, pgPrime, sql } from 'pg-prime'
import { defineOutbox, functionSink, pgOutbox } from '../../../src/index.ts'

const schema = process.env['OUTBOX_SCHEMA']
const db = pgPrime({ schema: defineSchema({}), connection: process.env['PG_PRIME_TEST_URL'] })
const outbox = pgOutbox({ db, schema, define: { t: defineOutbox('kill', { partitions: 1 }) } })
await outbox.start()
const relay = outbox.topics.t.relay(
  functionSink(async (wave, ctx) => {
    for (const r of wave) {
      await db.sql`insert into ${sql.ident(schema, 'log')} (idem, epoch) values (${r.idem}, ${ctx.epoch})`.execute()
    }
    process.stdout.write('delivering\n')
    if (process.env['OUTBOX_CLOSE']) {
      await relay.close()
      process.stdout.write('closed\n')
      process.stdin.once('end', () => void db.end()).resume()
    }
    await new Promise(() => {})
  }),
  { leaseMs: 1_500, graceMs: 100 },
)
