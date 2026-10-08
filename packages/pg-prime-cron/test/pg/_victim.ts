// Child process for the SIGKILL test: claims a tick, says so, then hangs until killed.
import { defineSchema, pgPrime } from 'pg-prime'
import { defineSchedule, pgCron } from '../../src/index.js'

const [url, schema, pgbouncer] = process.argv.slice(2) as [string, string, string]
const db = pgPrime({
  connection: url,
  schema: defineSchema({}),
  ...(pgbouncer === '1' ? { poolerMode: 'pgbouncer-transaction' as const } : {}),
})
const victim = defineSchedule(
  'victim',
  { everyMs: 2000 },
  {
    handler: () => {
      console.log('running')
      return new Promise(() => {})
    },
  },
)
await pgCron({ db, schema, pollMs: 200, leaseMs: 1500, schedules: [victim] }).start()
