// plan 15 §0.4: `pgMq` + `send`, the package's typical import (events included).
import { defineQueue, pgMq } from '@pg-prime/mq'
import type { Db } from 'pg-prime'

const emails = defineQueue<{ to: string }>('emails')

export async function run(db: Db): Promise<void> {
  const mq = pgMq({ db, define: { emails } })
  await mq.queues.emails.send({ to: 'someone@example.com' })
}
