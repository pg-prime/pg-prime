import type { RawQuery } from 'pg-prime'
import { json, ms, type Q, type Tables } from './tables.js'

export interface DueRow {
  readonly name: string
  readonly next_at: Date
  readonly pattern: string | null
  readonly every_ms: number | null
  readonly at: Date | null
  readonly tz: string
  readonly start_at: Date | null
  readonly anchor_at: Date
  readonly end_at: Date | null
  readonly max_runs: number | null
  readonly runs: number
  readonly overlap: 'skip' | 'allow'
  readonly misfire: 'skip' | 'once'
  readonly misfire_grace_ms: number
  readonly target: 'handler' | 'queue'
  readonly payload: unknown
  readonly timeout_ms: number | null
  readonly retry: Record<string, unknown> | null
  readonly db_now: Date
}

/** Q1: due schedules this instance can execute; no locks. */
export const due = (q: Q, t: Tables, mine: readonly string[]): RawQuery => q.sql`
  select name, next_at, pattern, every_ms::float8 as every_ms, at, tz, start_at, anchor_at, end_at,
         max_runs, runs, overlap, misfire, misfire_grace_ms, target, payload, timeout_ms, retry,
         now() as db_now
  from ${t.s}
  where enabled and not paused and next_at <= now() and name = any(${mine}::text[])
  order by next_at limit 100`

/** Milliseconds until the earliest `next_at` of `mine`, or null when none is scheduled. */
export const wakeIn = (q: Q, t: Tables, mine: readonly string[]): RawQuery => q.sql`
  select extract(epoch from min(next_at) - now())::float8 * 1000 as ms
  from ${t.s}
  where enabled and not paused and next_at is not null and name = any(${mine}::text[])`

export interface ClaimArgs {
  readonly name: string
  readonly expect: Date
  readonly fire: Date
  readonly decided: 'missed' | 'enqueued' | null
  readonly missed: number
  readonly next: Date | null
  readonly leaseMs: number
  readonly instance: string
  readonly payload: unknown
}

/** K1: CAS on `next_at` under the row lock; `runs_tick` refuses a duplicate tick. */
export const claim = (q: Q, t: Tables, a: ClaimArgs): RawQuery => q.sql`
  with s as (
    select name, overlap, running from ${t.s}
    where name = ${a.name} and next_at = ${a.expect}::timestamptz and enabled and not paused
    for update
  ), d as (
    select name, case when ${a.decided}::text is not null then ${a.decided}::text
                      when running = 0 or overlap = 'allow' then 'running'
                      else 'skipped' end as st
    from s
  ), r as (
    insert into ${t.r} (schedule, tick_at, state, missed, token, lease_until, instance, started_at,
                        finished_at, payload)
    select d.name, ${a.fire}::timestamptz, d.st::${t.st}, ${a.missed}::int,
           case when d.st = 'running' then gen_random_uuid()::text end,
           case when d.st = 'running' then now() + ${ms(a.leaseMs)} end,
           ${a.instance}::text,
           case when d.st = 'running' then clock_timestamp() end,
           case when d.st in ('skipped', 'missed') then clock_timestamp() end,
           ${json(a.payload)}::jsonb
    from d
    on conflict (schedule, tick_at) where not manual do nothing
    returning id, state::text as state, token, payload
  ), u as (
    update ${t.s} x set
      next_at = ${a.next}::timestamptz, updated_at = now(),
      runs = x.runs + (select count(*) from r),
      running = x.running + (select count(*) from r where state = 'running')
    from d where x.name = d.name
  )
  select id, state, token, payload from r`

/** Moves `next_at` without a run: nothing is left to fire inside `end_at`. */
export const advance = (q: Q, t: Tables, name: string, expect: Date, next: Date | null): RawQuery =>
  q.sql`update ${t.s} set next_at = ${next}::timestamptz, updated_at = now()
    where name = ${name} and next_at = ${expect}::timestamptz`

/** T1: a manual handler run, `pending` (counted, so overlap holds) or `skipped`. */
export const trigger = (
  q: Q,
  t: Tables,
  a: { name: string; instance: string; payload: unknown; channel: string },
): RawQuery => q.sql`
  with s as (
    select name, overlap, running, payload from ${t.s}
    where name = ${a.name} and target = 'handler'
    for update
  ), d as (
    select name, payload,
           case when running = 0 or overlap = 'allow' then 'pending' else 'skipped' end as st
    from s
  ), r as (
    insert into ${t.r} (schedule, manual, state, instance, finished_at, payload)
    select name, true, st::${t.st}, ${a.instance}::text,
           case when st = 'skipped' then clock_timestamp() end,
           coalesce(${json(a.payload)}::jsonb, payload)
    from d
    returning id, state::text as state
  ), u as (
    update ${t.s} x set running = x.running + (select count(*) from r where state = 'pending')
    from d where x.name = d.name
  ), n as (
    select pg_notify(${a.channel}, ${a.name}) from r where state = 'pending'
  )
  select id, state from r where (select count(*) from n) >= 0`

export interface StartedRow {
  readonly id: bigint
  readonly schedule: string
  readonly tick_at: Date | null
  readonly manual: boolean
  readonly missed: number
  readonly payload: unknown
  readonly token: string
  readonly timeout_ms: number | null
  readonly retry: Record<string, unknown> | null
}

/** T2: an instance that registered the handler takes `pending` manual runs. */
export const pickup = (
  q: Q,
  t: Tables,
  a: { mine: readonly string[]; limit: number; leaseMs: number; instance: string },
): RawQuery => q.sql`
  with p as (
    select id from ${t.r}
    where state = 'pending' and schedule = any(${a.mine}::text[])
    order by id limit ${a.limit}::int
    for update skip locked
  )
  update ${t.r} r set state = 'running', token = gen_random_uuid()::text,
    lease_until = now() + ${ms(a.leaseMs)}, instance = ${a.instance}::text,
    started_at = clock_timestamp()
  from p, ${t.s} s
  where r.id = p.id and s.name = r.schedule
  returning r.id, r.schedule, r.tick_at, r.manual, r.missed, r.payload, r.token, s.timeout_ms, s.retry`
