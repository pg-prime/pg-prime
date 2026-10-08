import type { Entry, SubscriptionDef } from '@pg-prime/events'
import type { AsyncDisposable_ } from 'pg-prime'
import type { QueueDef } from '../define.js'
import type { Core } from '../mq.js'
import { ASYNC_DISPOSE } from '../util.js'
import type { QueueHandle } from './handle.js'

export interface BindOptions<E, T> {
  /** Entry → message; default: the entry's payload as is. */
  map?: (e: Entry<E>) => { payload: T; key?: string; group?: string; priority?: number }
  /** Entries per transaction; default 100. */
  batchSize?: number
  /** The subscription lease; default 30 000. */
  leaseMs?: number
  /** Default 5 000. */
  pollMs?: number
  signal?: AbortSignal
}

export interface Binding extends AsyncDisposable_ {
  /** True while this binding holds the subscription's lease. */
  readonly active: boolean
  close(): Promise<void>
}

/**
 * A subscription reader whose batch handler sends the batch and commits the offset in one
 * transaction: every matching entry becomes exactly one message.
 */
export function bind<E, T>(
  core: Core,
  sub: SubscriptionDef<E>,
  def: QueueDef<T, any>,
  handle: QueueHandle<T, any>,
  opts: BindOptions<E, T> = {},
): Binding {
  const { map = (e: Entry<E>) => ({ payload: e.payload as unknown as T }), ...run } = opts
  const reader = core
    .events()
    .subscription(sub)
    .run(
      {
        batch: async (es, ctx) => {
          await handle.start()
          const items = es.map((e) => {
            const { payload, ...o } = map(e)
            return { payload, opts: o }
          })
          await core.db.transaction(async (tx) => {
            await handle.sendMany(items, { tx })
            await ctx.commit({ tx })
          })
          core.hooks.emit('onBind', { subscription: sub.name, queue: def.name, count: es.length })
        },
      },
      { batchSize: 100, ...run },
    )
  const close = async (): Promise<void> => {
    core.running.delete(binding)
    await reader.close()
  }
  const binding = {
    get active() {
      return reader.active
    },
    close,
    [ASYNC_DISPOSE]: close,
  } as unknown as Binding
  core.running.add(binding)
  return binding
}
