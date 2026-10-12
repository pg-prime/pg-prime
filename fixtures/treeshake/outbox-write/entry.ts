// plan 15 §0.4: `pgOutbox` + `write`, the package's typical import.
import { defineOutbox, pgOutbox } from '@pg-prime/outbox'
import type { Db } from 'pg-prime'

const orders = defineOutbox<{ id: string }>('orders')

export async function run(db: Db): Promise<void> {
  const outbox = pgOutbox({ db, define: { orders } })
  await outbox.start()
  await db.transaction((tx) => outbox.topics.orders.write({ id: '1' }, { tx }))
}
