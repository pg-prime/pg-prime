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
export async function startQueues(
  _c: QueueContext,
  defs: readonly ScheduleDef<any>[],
): Promise<void> {
  if (defs.length > 0) throw notImplemented()
}

/** One short transaction: K1 with `decided` `'enqueued'` (or `'missed'`), then `send`. */
export async function queueTick(
  _c: QueueContext,
  _def: ScheduleDef<any>,
  _row: DueRow,
  _plan: Plan,
  _payload: unknown,
): Promise<{ runId: bigint; state: RunState } | undefined> {
  throw notImplemented()
}

/** A manual run of a queue-target schedule: enqueued at once, never `pending`. */
export async function queueTrigger(
  _c: QueueContext,
  _def: ScheduleDef<any>,
  _payload: unknown,
): Promise<{ runId: bigint; state: RunState }> {
  throw notImplemented()
}

const notImplemented = () => new UsageError('queue target not implemented')
