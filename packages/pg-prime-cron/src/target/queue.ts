import { UsageError } from 'pg-prime'
import type { Db } from 'pg-prime'
import type { Plan } from '../planner.js'
import type { DueRow } from '../sql/claim.js'
import type { Tables } from '../sql/tables.js'
import type { CronEnqueuer, RunState, ScheduleDef } from '../types.js'

export interface QueueContext {
  readonly db: Db
  readonly t: Tables
  readonly enqueuer: CronEnqueuer
  readonly instance: string
}

/** `cron.start()`: start every declared queue so its `{ tx }` sends are allowed. */
export function startQueues(_c: QueueContext, defs: readonly ScheduleDef<any>[]): Promise<void> {
  return defs.length > 0 ? Promise.reject(notImplemented()) : Promise.resolve()
}

/** One short transaction: K1 with `decided` `'enqueued'` (or `'missed'`), then `send`. */
export function queueTick(
  _c: QueueContext,
  _def: ScheduleDef<any>,
  _row: DueRow,
  _plan: Plan,
  _payload: unknown,
): Promise<{ runId: bigint; state: RunState } | undefined> {
  return Promise.reject(notImplemented())
}

/** A manual run of a queue-target schedule: enqueued at once, never `pending`. */
export function queueTrigger(
  _c: QueueContext,
  _def: ScheduleDef<any>,
  _payload: unknown,
): Promise<{ runId: bigint; state: RunState }> {
  return Promise.reject(notImplemented())
}

const notImplemented = () => new UsageError('queue target not implemented')
