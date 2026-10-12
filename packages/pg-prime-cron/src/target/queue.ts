import { UsageError } from 'pg-prime'
import type { Db } from 'pg-prime'
import type { Plan } from '../planner.js'
import { claim, type DueRow } from '../sql/claim.js'
import { json, type Q, type Tables } from '../sql/tables.js'
import type { CronEnqueuer, RunState, ScheduleDef } from '../types.js'

export interface QueueContext {
  readonly db: Db
  readonly t: Tables
  readonly enqueuer: CronEnqueuer
  readonly instance: string
}

type Result = { runId: bigint; state: RunState }

const queueOf = (def: ScheduleDef<any>) =>
  (def.target as { queue: Parameters<CronEnqueuer['queue']>[0] }).queue

/** `cron.start()`: start every declared queue so its `{ tx }` sends are allowed. */
export async function startQueues(
  c: QueueContext,
  defs: readonly ScheduleDef<any>[],
): Promise<void> {
  for (const d of defs) await c.enqueuer.queue(queueOf(d)).start?.()
}

/** Sends in the claim's transaction; `overlap: 'skip'` holds one key until mq finishes it. */
async function send(
  c: QueueContext,
  tx: Q,
  def: ScheduleDef<any>,
  run: { id: bigint; payload: unknown; overlap: string },
  key: string,
): Promise<Result> {
  const opts =
    run.overlap === 'skip'
      ? { tx, key: `cron:${def.name}`, dedup: 'until-done' as const }
      : { tx, key }
  const m = await c.enqueuer.queue(queueOf(def)).send(run.payload, opts)
  const state = m.deduplicated ? 'skipped' : 'enqueued'
  await tx.sql`update ${c.t.r} set state = ${state}::${c.t.st}, message_id = ${m.id}::bigint,
    finished_at = clock_timestamp() where id = ${run.id}::bigint`.execute()
  return { runId: run.id, state }
}

/** One short transaction: K1 with `decided` `'enqueued'` (or `'missed'`), then `send`. */
export function queueTick(
  c: QueueContext,
  def: ScheduleDef<any>,
  row: DueRow,
  plan: Plan,
  payload: unknown,
): Promise<Result | undefined> {
  const fire = plan.fire!
  return c.db.transaction(async (tx) => {
    const [r] = await claim(tx, c.t, {
      name: row.name,
      expect: plan.expect,
      fire,
      decided: plan.decided ?? 'enqueued',
      missed: plan.missed,
      next: plan.next,
      leaseMs: 0,
      instance: c.instance,
      payload,
    }).execute()
    if (r === undefined) return undefined
    const run = { id: r['id'] as bigint, payload: r['payload'], overlap: row.overlap }
    if (r['state'] !== 'enqueued') return { runId: run.id, state: r['state'] as RunState }
    return send(c, tx, def, run, `cron:${row.name}:${fire.getTime()}`)
  })
}

/** A manual run of a queue-target schedule: enqueued at once, never `pending`. */
export function queueTrigger(
  c: QueueContext,
  def: ScheduleDef<any>,
  payload: unknown,
): Promise<Result> {
  return c.db.transaction(async (tx) => {
    const [r] = await tx.sql`
      with s as (
        select name, overlap, payload from ${c.t.s} where name = ${def.name} and target = 'queue'
      ), r as (
        insert into ${c.t.r} (schedule, manual, state, instance, payload)
        select name, true, 'enqueued', ${c.instance}::text, coalesce(${json(payload)}::jsonb, payload)
        from s
        returning id, payload
      )
      select r.id, r.payload, s.overlap from r, s`.execute()
    if (r === undefined) throw new UsageError(`cron: no queue-target schedule '${def.name}'`)
    const run = { id: r['id'] as bigint, payload: r['payload'], overlap: r['overlap'] as string }
    return send(c, tx, def, run, `cron:${def.name}:manual:${run.id}`)
  })
}
