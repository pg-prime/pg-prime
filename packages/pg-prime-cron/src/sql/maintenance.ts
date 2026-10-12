import type { Db, RawQuery } from 'pg-prime'
import { ms, OPEN, type Q, type Tables } from './tables.js'

/** At most one instance runs maintenance per period. */
export const gate = (q: Q, t: Tables, everyMs: number): RawQuery =>
  q.sql`update ${t.m} set maint_at = now() where maint_at <= now() - ${ms(everyMs)} returning 1 as ok`

/** Expired leases: `running` → `failed`, `cancelling` → `cancelled`; slots freed per schedule. */
export const expire = (q: Q, t: Tables): RawQuery => q.sql`
  with e as (
    select id from ${t.r}
    where state in ('running', 'cancelling') and lease_until < now()
    order by lease_until limit 500
    for update skip locked
  ), f as (
    update ${t.r} r set
      state = (case when r.state = 'cancelling' then 'cancelled' else 'failed' end)::${t.st},
      error = 'lease-expired', finished_at = clock_timestamp(), token = null, lease_until = null
    from e where r.id = e.id
    returning r.schedule
  ), c as (
    select schedule, count(*) as n from f group by schedule
  )
  update ${t.s} x set running = x.running - c.n from c where x.name = c.schedule
  returning x.name`

/** Lock-then-count: every statement that moves `running` holds the same row lock. */
export async function reconcile(db: Db, t: Tables): Promise<number> {
  return db.transaction(async (tx) => {
    const locked = await tx.sql`
      select name from ${t.s} s
      where running > 0 or exists (select 1 from ${t.r} r where r.schedule = s.name and r.state in ${OPEN})
      order by name limit 500
      for update skip locked`.execute()
    if (locked.length === 0) return 0
    const fixed = await tx.sql`
      update ${t.s} x set running = c.n
      from (
        select l.name, (select count(*) from ${t.r} r where r.schedule = l.name and r.state in ${OPEN}) as n
        from unnest(${locked.map((r) => r['name'])}::text[]) l (name)
      ) c
      where x.name = c.name and x.running <> c.n
      returning x.name`.execute()
    return fixed.length
  })
}

/** Finished runs beyond `keep_runs` or older than `keep_runs_ms`, one batch. */
export const retain = (q: Q, t: Tables): RawQuery => q.sql`
  delete from ${t.r} where id in (
    select x.id from ${t.s} s cross join lateral (
      select r.id from ${t.r} r
      where r.schedule = s.name and r.state not in ${OPEN}
        and (r.created_at < now() - s.keep_runs_ms * interval '1 ms'
             or r.id <= (select h.id from ${t.r} h where h.schedule = s.name
                         order by h.id desc offset s.keep_runs limit 1))
      limit 1000
    ) x
    limit 1000
  )`

export const unclaimed = (q: Q, t: Tables, leaseMs: number): RawQuery => q.sql`
  select count(*)::int as n from ${t.r}
  where state = 'pending' and created_at < now() - ${ms(leaseMs)}`
