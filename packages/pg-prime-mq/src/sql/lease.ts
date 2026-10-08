import { sql } from 'pg-prime'
import { ms, one, run, wakeCte, watchCte, withCtes } from './tables.js'
import type { F, Q, Tables } from './tables.js'

/** S6: extends every lease the worker holds; a row locked by an open transaction is skipped. */
export async function heartbeat(
  q: Q,
  t: Tables,
  held: readonly { readonly id: bigint; readonly token: string }[],
  leaseMs: number,
): Promise<Map<bigint, boolean>> {
  const rows = await run(
    q,
    'heartbeat',
    sql`with h as (
        select m.id from ${t.messages} m
        join unnest(${held.map((h) => h.id)}::bigint[], ${held.map((h) => h.token)}::text[]) as k(id, token)
          on m.id = k.id and m.token = k.token
        where m.state = 'active'
        for update of m skip locked
      )
      update ${t.messages} m set lease_until = now() + ${ms(leaseMs)}
      from h where m.id = h.id
      returning m.id, m.cancel`,
  )
  return new Map(rows.map((r) => [r['id'] as bigint, r['cancel'] as boolean]))
}

/**
 * The family backoff in SQL, from a message's stored `retry` policy: the delay of attempt
 * `attempts + 1`, exactly as `backoffMs` computes it.
 */
export const backoffSql = (retry: F, attempts: F, random: F = sql`random()`): F =>
  sql`(case ${retry}->>'jitter' when 'none' then 1.0 when 'equal' then 0.5 + ${random} / 2
      else ${random} end)
    * least((${retry}->>'maxDelayMs')::float8, (${retry}->>'baseDelayMs')::float8 * 2 ^ (${attempts}))`

/** S9g: one expiry scanner per queue per interval. */
export async function expiryGate(
  q: Q,
  t: Tables,
  queue: string,
  everyMs: number,
): Promise<boolean> {
  const rows = await run(
    q,
    'expire-gate',
    sql`update ${t.queues} set expire_at = now()
      where name = ${queue} and expire_at <= now() - ${ms(everyMs)} returning 1`,
  )
  return rows.length === 1
}

/**
 * S9: an expired lease is a failed attempt (D6). With attempts left the message is re-queued
 * with backoff here; an exhausted one is returned for `finish(…, 'failed', expired)`.
 */
export function expireSql(t: Tables, queue: string): F {
  return withCtes(
    [
      [
        'x',
        sql`select id, attempts, (retry->>'maxAttempts')::int as max_attempts from ${t.messages}
          where queue = ${queue} and state = 'active' and lease_until < now()
          for update skip locked`,
      ],
      [
        'done',
        sql`update ${t.messages} m set attempts = m.attempts + 1, state = 'delayed',
            run_at = now() + ${backoffSql(sql`m.retry`, sql`m.attempts`)} * interval '1 ms',
            order_key = sign(m.order_key) * ${t.next},
            error = 'lease-expired', stack = null, token = null, lease_until = null
          from x where m.id = x.id and x.attempts + 1 < x.max_attempts
          returning m.id, m.queue, m.state, m.group_key, m.counted`,
      ],
      [
        'gd',
        sql`update ${t.groups} g set active = g.active - c.n
          from (select group_key, count(*)::int as n from done where group_key is not null group by 1) c
          where g.queue = ${queue} and g.key = c.group_key
          returning g.queue`,
      ],
      [
        'qd',
        sql`update ${t.queues} u set active = u.active - c.n
          from (select count(*)::int as n from done where counted) c
          where u.name = ${queue} and c.n > 0 and (select count(*) from gd) >= 0
          returning u.name as queue`,
      ],
      wakeCte(t, 'done'),
      watchCte(t, 'done'),
    ],
    (refs) => sql`select (select array_agg(id order by id) from done) as requeued,
      (select array_agg(id order by id) from x where attempts + 1 >= max_attempts) as exhausted,
      ${refs} as fx`,
  )
}

export async function expire(
  q: Q,
  t: Tables,
  queue: string,
): Promise<{ requeued: bigint[]; exhausted: bigint[] }> {
  const r = await one(q, 'expire', expireSql(t, queue))
  return {
    requeued: (r['requeued'] as bigint[] | null) ?? [],
    exhausted: (r['exhausted'] as bigint[] | null) ?? [],
  }
}
