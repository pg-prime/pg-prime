// plan 15 §0.4: `pgCron` + `defineSchedule`, the package's typical import (croner included).
import { defineSchedule, pgCron } from '@pg-prime/cron'
import type { Db } from 'pg-prime'

const nightly = defineSchedule('nightly', { cron: '0 3 * * *' }, { handler: async () => {} })

export async function run(db: Db): Promise<void> {
  await pgCron({ db, schedules: [nightly] }).start()
}
