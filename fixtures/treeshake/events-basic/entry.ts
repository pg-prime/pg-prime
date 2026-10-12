// plan 15 §0.4: `pgEvents` + a channel + a topic `publish`, the package's typical import. The
// handle keeps every method reachable, so no producer-only exclusion is claimed.
import { defineChannel, defineTopic, pgEvents } from '@pg-prime/events'
import type { Db } from 'pg-prime'

const ping = defineChannel<{ id: string }>('ping')
const orders = defineTopic<{ id: string }>('orders')

export async function run(db: Db): Promise<void> {
  const events = pgEvents({ db, define: { channels: { ping }, topics: { orders } } })
  await events.channels.ping.notify({ id: '1' })
  await events.topics.orders.publish({ id: '1' })
}
