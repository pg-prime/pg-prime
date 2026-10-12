// The consumer body tools/pack-smoke.mjs compiles and runs in a project holding only the
// tarballs (no @pg-prime/mq), so every import here goes through the published export maps.
import { defineSchedule, pgCron, ScheduleError } from '@pg-prime/cron'
import type { RunContext } from '@pg-prime/cron'
import { createMockPool } from '@pg-prime/testing'
import { defineSchema, pgPrime } from 'pg-prime'

const nightly = defineSchedule<{ table: string }>(
  'nightly',
  { cron: '0 3 * * *', tz: 'Europe/Berlin' },
  { handler: async (run: RunContext<{ table: string }>) => run.payload.table },
  { payload: { table: 'events' }, overlap: 'skip', misfire: 'once' },
)

const db = pgPrime({ pool: createMockPool(), schema: defineSchema({}) })
const cron = pgCron({ db, schedules: [nightly] })
const next = await cron.preview(nightly.when, { from: new Date('2026-03-28T12:00:00Z'), count: 2 })
if (
  next.map((d) => d.toISOString()).join() !== '2026-03-29T01:00:00.000Z,2026-03-30T01:00:00.000Z'
) {
  throw new Error(`pack-smoke: croner preview gave ${next.join()}`)
}
const bad = await cron
  .preview({ cron: 'not a pattern' }, { from: new Date() })
  .catch((e: unknown) => e)
if (!(bad instanceof ScheduleError) || bad.field !== 'cron')
  throw new Error('pack-smoke: no ScheduleError')
await cron.close()
await db.end()
console.log('pack-smoke @pg-prime/cron consumer OK')
