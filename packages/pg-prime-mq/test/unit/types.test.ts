import { describe, expectTypeOf, it } from 'vitest'
import type { Db, Queryable } from 'pg-prime'
import type { StandardSchemaV1 } from '@pg-prime/events'
import { defineQueue, pgMq } from '../../src/index.js'
import type {
  ChildSendOptions,
  MessageRef,
  PayloadOf,
  QueueHandle,
  ResultOf,
} from '../../src/index.js'

const db = {} as Db
const schema = {} as StandardSchemaV1<unknown, { sku: string }>

/** @pg-prime/cron's queue target (18 §6) takes any object of this shape. */
interface CronEnqueuer {
  queue(def: { readonly name: string }): {
    start?(): Promise<void>
    send(
      payload: any,
      opts: { tx: Queryable<any>; key: string; dedup?: 'until-done' },
    ): Promise<{ id: bigint; deduplicated: boolean }>
  }
}

describe('registry types', () => {
  const emails = defineQueue<{ to: string }, boolean>('emails')
  const stock = defineQueue('stock', { schema })
  const mq = pgMq({ db, define: { emails, stock } })

  it('maps each declaration to a typed handle', () => {
    expectTypeOf(mq.queues.emails).toEqualTypeOf<QueueHandle<{ to: string }, boolean>>()
    expectTypeOf(mq.queues.stock).toEqualTypeOf<QueueHandle<{ sku: string }, void>>()
    expectTypeOf<PayloadOf<typeof emails>>().toEqualTypeOf<{ to: string }>()
    expectTypeOf<ResultOf<typeof emails>>().toEqualTypeOf<boolean>()
    expectTypeOf(mq.queues.emails.send).returns.toEqualTypeOf<Promise<MessageRef>>()
    // @ts-expect-error not declared
    void mq.queues.nope
    type Payload = Parameters<typeof mq.queues.emails.send>[0]
    // @ts-expect-error wrong payload
    const bad: Payload = { to: 1 }
    void bad
  })

  it('handlers return the declared result type', () => {
    mq.queues.emails.work(async () => true)
    // @ts-expect-error a string is not the declared boolean
    mq.queues.emails.work(async () => 'yes')
  })

  it('children and spawns take no dedup', () => {
    // @ts-expect-error dedup is root-only
    const c: ChildSendOptions = { dedup: 'until-done' }
    void c
  })

  it('pgMq satisfies cron’s CronEnqueuer structurally', () => {
    expectTypeOf(pgMq({ db })).toExtend<CronEnqueuer>()
  })
})
