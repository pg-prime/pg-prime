import type { Db, RawQuery } from 'pg-prime'
import { json, ms, type Q, type Tables } from './tables.js'

/** One statement for every live run of this instance; a missing id has lost its lease. */
export const heartbeat = (
  q: Q,
  t: Tables,
  runs: readonly { id: bigint; token: string }[],
  leaseMs: number,
): RawQuery => q.sql`
  update ${t.r} r set lease_until = now() + ${ms(leaseMs)}
  from unnest(${runs.map((r) => r.id)}::bigint[], ${runs.map((r) => r.token)}::text[]) h (id, tok)
  where r.id = h.id and r.token = h.tok and r.state in ('running', 'cancelling')
  returning r.id, r.state::text as state`

export interface Finish {
  readonly id: bigint
  readonly token: string
  readonly state: 'succeeded' | 'failed' | 'cancelled'
  readonly error: string | null
  readonly result: unknown
  readonly attempts: number
}

/** F1: token-guarded finish that frees the slot; locks run, then schedule. */
export const finish = (q: Q, t: Tables, f: Finish): RawQuery => q.sql`
  with f as (
    update ${t.r} set state = ${f.state}::${t.st}, finished_at = clock_timestamp(),
      error = ${f.error}::text, result = ${json(f.result)}::jsonb, attempts = ${f.attempts}::int,
      token = null, lease_until = null
    where id = ${f.id}::bigint and token = ${f.token}::text and state in ('running', 'cancelling')
    returning schedule
  )
  update ${t.s} x set running = x.running - 1 from f where x.name = f.schedule
  returning 1 as ok`

/** Abort is not finish: the slot stays taken until the handler settles. */
export const markCancelling = (q: Q, t: Tables, id: bigint, token: string): RawQuery => q.sql`
  update ${t.r} set state = 'cancelling'
  where id = ${id}::bigint and token = ${token}::text and state = 'running'`

/** X1: `pending` → `cancelled` (slot freed); `running` → `cancelling` (slot kept). */
export async function cancel(db: Db, t: Tables, id: bigint): Promise<boolean> {
  return db.transaction(async (tx) => {
    // F1's lock order, run then schedule, so a concurrent finish cannot deadlock with this.
    const [run] = await tx.sql`select schedule, state::text as state from ${t.r}
      where id = ${id}::bigint for update`.execute()
    if (run?.['state'] !== 'pending' && run?.['state'] !== 'running') return false
    await tx.sql`select 1 from ${t.s} where name = ${run['schedule']} for update`.execute()
    const [c] = await tx.sql`
      with c as (
        update ${t.r} set
          state = (case when state = 'pending' then 'cancelled' else 'cancelling' end)::${t.st},
          finished_at = case when state = 'pending' then clock_timestamp() end
        where id = ${id}::bigint and state in ('pending', 'running')
        returning schedule, state::text as state
      ), u as (
        update ${t.s} x set running = x.running - 1
        from c where x.name = c.schedule and c.state = 'cancelled'
      )
      select count(*)::int as n from c`.execute()
    return c?.['n'] === 1
  })
}
