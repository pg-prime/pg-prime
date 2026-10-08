import { sql } from 'pg-prime'
import { ms, one, run } from './tables.js'
import type { Q, Tables } from './tables.js'

/** One maintainer per queue per interval: a CAS on `queues.maint_at`. */
export async function maintenanceGate(
  q: Q,
  t: Tables,
  queue: string,
  everyMs: number,
): Promise<
  { keepCompletedN: number | null; keepFailedN: number | null; counted: boolean } | undefined
> {
  const [r] = await run(
    q,
    'maintain',
    sql`update ${t.queues} set maint_at = now()
      where name = ${queue} and maint_at <= now() - ${ms(everyMs)}
      returning keep_completed_n, keep_failed_n, concurrency is not null as counted`,
  )
  return r === undefined
    ? undefined
    : {
        keepCompletedN: r['keep_completed_n'] as number | null,
        keepFailedN: r['keep_failed_n'] as number | null,
        counted: r['counted'] as boolean,
      }
}

/** S10 by age: one batch of finished messages past their `expire_at`, any queue. */
export async function expireBatch(q: Q, t: Tables): Promise<number> {
  const r = await one(
    q,
    'retention',
    sql`with del as (
        delete from ${t.messages} where id in (
          select id from ${t.messages}
          where expire_at <= now() and state in ('completed', 'failed', 'cancelled')
          limit 1000 for update skip locked)
        returning 1
      ) select count(*)::int as n from del`,
  )
  return r['n'] as number
}

/** S10 by count: one batch of the `state` messages beyond the newest `keep`. */
export async function trimBatch(
  q: Q,
  t: Tables,
  queue: string,
  state: 'completed' | 'failed',
  keep: number,
): Promise<number> {
  const r = await one(
    q,
    'retention-count',
    sql`with del as (
        delete from ${t.messages} where id in (
          select id from ${t.messages} where queue = ${queue} and state = ${state}::${t.msgState}
          order by finished_at desc offset ${keep}::int limit 1000 for update skip locked)
        returning 1
      ) select count(*)::int as n from del`,
  )
  return r['n'] as number
}

/** Expired dedup windows, each deleted under its own row lock. */
export async function dedupBatch(q: Q, t: Tables): Promise<number> {
  const r = await one(
    q,
    'dedup-expire',
    sql`with del as (
        delete from ${t.dedup} where (queue, key) in (
          select queue, key from ${t.dedup} where expire_at <= now()
          limit 1000 for update skip locked)
        returning 1
      ) select count(*)::int as n from del`,
  )
  return r['n'] as number
}

/**
 * Counter reconcile, lock-then-count (15 §0.5 rule 3): statement 1 locks the counter rows,
 * statement 2 counts in a fresh snapshot. Every claim and settle that moves a counter holds its
 * row, so the count cannot race them.
 */
export async function reconcileGroups(q: Q, t: Tables, queue: string): Promise<void> {
  const locked = await run(
    q,
    'reconcile-lock',
    sql`select key from ${t.groups} where queue = ${queue} and active <> 0
      order by key limit 500 for update skip locked`,
  )
  if (locked.length === 0) return
  await run(
    q,
    'reconcile',
    sql`update ${t.groups} g set active = c.n
      from (select k.key, (select count(*)::int from ${t.messages} m
          where m.queue = ${queue} and m.group_key = k.key and m.state = 'active') as n
        from unnest(${locked.map((r) => r['key'] as string)}::text[]) as k(key)) c
      where g.queue = ${queue} and g.key = c.key and g.active <> c.n`,
  )
}

export async function reconcileQueue(q: Q, t: Tables, queue: string): Promise<void> {
  await run(q, 'reconcile-lock', sql`select 1 from ${t.queues} where name = ${queue} for update`)
  await run(
    q,
    'reconcile',
    sql`update ${t.queues} set active = c.n
      from (select count(*)::int as n from ${t.messages}
        where queue = ${queue} and state = 'active' and counted) c
      where name = ${queue} and active <> c.n`,
  )
}
