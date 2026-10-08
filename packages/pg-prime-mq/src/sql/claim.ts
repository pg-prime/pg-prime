import { sql } from 'pg-prime'
import { cols, ms, one, run, wakeCte, watchCte, withCtes } from './tables.js'
import type { Cte, F, Q, Tables } from './tables.js'
import { msgRow } from './read.js'
import type { MsgRow } from './read.js'

export interface ClaimOptions {
  readonly queue: string
  /** Free slots: one claim serves them all. */
  readonly n: number
  readonly leaseMs: number
  readonly token: string | null
  readonly consumer: string
  /** The queue declares a global rate or concurrency: S4's locked queue-row counters. */
  readonly limited: boolean
}

export interface GroupOptions {
  /** Round-robin cursor: the scan starts after this group key. */
  readonly after: string
  readonly scan: number
  /** Defaults for groups whose row sets none. */
  readonly concurrency: number | undefined
  readonly rate: { readonly max: number; readonly perMs: number } | undefined
}

const set = (t: Tables, o: ClaimOptions, counted: F): F =>
  sql`state = 'active', token = coalesce(${o.token}::text, gen_random_uuid()::text),
    lease_until = now() + ${ms(o.leaseMs)}, consumer = ${o.consumer},
    started_at = clock_timestamp(), claims = m.claims + 1, counted = ${counted}`

const queueOpen = (t: Tables, q: string): F =>
  sql`exists (select from ${t.queues} where name = ${q} and not paused
    and coalesce(limited_until, '-infinity') <= now())`

/** S4's `q`: the queue row, locked (waiting, never skipping) before any group or message row. */
const lockedQueue = (t: Tables, q: string): Cte => [
  'q',
  sql`select name, rate_max, rate_ms, concurrency, active,
      (rate_window is null or rate_window + rate_ms * interval '1 ms' <= now()) as fresh,
      case when rate_window is null or rate_window + rate_ms * interval '1 ms' <= now() then 0
        else rate_count end as used
    from ${t.queues}
    where name = ${q} and not paused and coalesce(limited_until, '-infinity') <= now()
    for update`,
]

/** Free global capacity; 0 when the queue row is paused or limited (`LIMIT NULL` means unlimited). */
const globalFree = (n: number): F =>
  sql`coalesce((select greatest(0, least(${n}::int, coalesce(rate_max - used, ${n}::int),
    coalesce(concurrency - active, ${n}::int))) from q), 0)`

const queueBump = (t: Tables): Cte => [
  'qu',
  sql`update ${t.queues} u set
      rate_window = case when q.fresh then now() else u.rate_window end,
      rate_count = q.used + c.n,
      active = u.active + case when u.concurrency is null then 0 else c.n end,
      limited_until = case when q.rate_max <= q.used + c.n
        then coalesce(case when q.fresh then now() end, u.rate_window) + q.rate_ms * interval '1 ms'
        else u.limited_until end
    from q, (select count(*)::int as n from up) c
    where u.name = q.name and c.n > 0`,
]

/** S3 (fast path) or S4 (global limits): ungrouped ready messages, lowest priority first, FIFO. */
export function claimSql(t: Tables, o: ClaimOptions): F {
  const limited = o.limited
  return withCtes(
    [
      limited && lockedQueue(t, o.queue),
      [
        'next',
        sql`select id from ${t.messages}
          where queue = ${o.queue} and state = 'ready'
            and group_key is null ${limited ? sql`` : sql`and ${queueOpen(t, o.queue)}`}
          order by priority, order_key
          limit ${limited ? globalFree(o.n) : sql`${o.n}::int`}
          for update skip locked`,
      ],
      [
        'up',
        sql`update ${t.messages} m set ${set(t, o, limited ? sql`(select concurrency is not null from q)` : sql`false`)}
          from next where m.id = next.id
          returning ${cols('m')}`,
      ],
      limited && queueBump(t),
      watchCte(t, 'up'),
    ],
    (refs) => sql`select ${cols('up')}, ${refs} as fx from up`,
  )
}

/**
 * S5: a recursive skip scan over `messages_ready_g` lists exactly the groups with ready messages
 * after the cursor; their rows are claimed with SKIP LOCKED and their caps applied per group.
 */
export function claimGroupsSql(t: Tables, o: ClaimOptions, g: GroupOptions): F {
  const q = o.queue
  // An unset concurrency is bound as int max, never NULL: `active < NULL` excludes every group.
  const gc = sql`coalesce(concurrency, ${g.concurrency ?? 2147483647}::int)`
  const rmax = sql`coalesce(rate_max, ${g.rate?.max ?? null}::int)`
  const rms = sql`coalesce(rate_ms, ${g.rate?.perMs ?? null}::int)`
  const fresh = sql`(rate_window is null or rate_window + ${rms} * interval '1 ms' <= now())`
  return withCtes(
    [
      [
        'keys(k)',
        sql`(select group_key from ${t.messages}
            where queue = ${q} and state = 'ready' and group_key > ${g.after}
            order by group_key limit 1)
          union all
          select (select m.group_key from ${t.messages} m
              where m.queue = ${q} and m.state = 'ready' and m.group_key > keys.k
              order by m.group_key limit 1)
          from keys where keys.k is not null`,
      ],
      ['cand', sql`select k from keys where k is not null limit ${g.scan}::int`],
      o.limited && lockedQueue(t, q),
      [
        'g',
        sql`select key, ${fresh} as fresh, ${rmax} as rmax, ${rms} as rms,
            case when ${fresh} then 0 else rate_count end as used,
            least(${gc} - active, coalesce(${rmax} - case when ${fresh} then 0 else rate_count end,
              ${o.n}::int)) as free
          from ${t.groups}
          where queue = ${q} and key in (select k from cand) and not paused and active < ${gc}
            and coalesce(limited_until, '-infinity') <= now()
            ${o.limited ? sql`` : sql`and ${queueOpen(t, q)}`}
          order by key
          for update skip locked`,
      ],
      [
        'pick',
        sql`select c.id from g cross join lateral (
            select id from ${t.messages} m
            where m.queue = ${q} and m.group_key = g.key and m.state = 'ready'
            order by priority, order_key limit greatest(g.free, 0)
            for update skip locked) c
          limit ${o.limited ? globalFree(o.n) : sql`${o.n}::int`}`,
      ],
      [
        'up',
        sql`update ${t.messages} m set ${set(t, o, o.limited ? sql`(select concurrency is not null from q)` : sql`false`)}
          from pick where m.id = pick.id
          returning ${cols('m')}`,
      ],
      [
        'gu',
        sql`update ${t.groups} r set active = r.active + c.n,
            rate_window = case when g.fresh then now() else r.rate_window end,
            rate_count = g.used + c.n,
            limited_until = case when g.rmax <= g.used + c.n
              then coalesce(case when g.fresh then now() end, r.rate_window) + g.rms * interval '1 ms'
              else r.limited_until end
          from (select group_key, count(*)::int as n from up group by 1) c join g on g.key = c.group_key
          where r.queue = ${q} and r.key = c.group_key`,
      ],
      o.limited && queueBump(t),
      watchCte(t, 'up'),
    ],
    (refs) => sql`select meta.*, ${cols('up')}
      from (select coalesce((select max(group_key) from up), (select max(k) from cand)) as cursor,
          (select count(*)::int from cand) as scanned, ${refs} as fx) meta
      left join up on true`,
    true,
  )
}

export async function claim(q: Q, t: Tables, o: ClaimOptions): Promise<MsgRow[]> {
  const rows = await run(q, o.limited ? 'claim-limited' : 'claim', claimSql(t, o))
  return sortRows(rows.map(msgRow))
}

export async function claimGroups(
  q: Q,
  t: Tables,
  o: ClaimOptions,
  g: GroupOptions,
): Promise<{ rows: MsgRow[]; cursor: string; scanned: number }> {
  const rows = await run(q, 'claim-groups', claimGroupsSql(t, o, g))
  const head = rows[0] ?? {}
  return {
    rows: sortRows(rows.filter((r) => r['id'] !== null).map(msgRow)),
    cursor: (head['cursor'] as string | null) ?? '',
    scanned: (head['scanned'] as number | undefined) ?? 0,
  }
}

// RETURNING order is unspecified.
const sortRows = (rows: MsgRow[]): MsgRow[] =>
  rows.sort((a, b) => a.priority - b.priority || (a.orderKey < b.orderKey ? -1 : 1))

/** S2: due delayed messages become ready at the back of their band; returns the next due time. */
export function promoteSql(t: Tables, queue: string, id?: bigint): F {
  return withCtes(
    [
      [
        'due',
        sql`select id from ${t.messages}
          where queue = ${queue} and state = 'delayed'
            ${id === undefined ? sql`and run_at <= now()` : sql`and id = ${id}::bigint`}
          order by run_at limit 1000 for update skip locked`,
      ],
      [
        'up',
        sql`update ${t.messages} m set state = 'ready', run_at = null,
            order_key = sign(m.order_key) * ${t.next}
          from due where m.id = due.id returning m.id, m.queue, m.state`,
      ],
      wakeCte(t, 'up'),
      watchCte(t, 'up'),
    ],
    (refs) => sql`select (select count(*)::int from up) as promoted, ${refs} as fx,
      greatest(0, extract(epoch from (select min(run_at) from ${t.messages}
        where queue = ${queue} and state = 'delayed' and run_at > now()) - now()) * 1000)::float8 as next_in`,
  )
}

/** Promotes due messages; `nextInMs` is null when nothing is delayed. */
export async function promote(
  q: Q,
  t: Tables,
  queue: string,
  id?: bigint,
): Promise<{ promoted: number; nextInMs: number | null }> {
  const r = await one(q, 'promote', promoteSql(t, queue, id))
  return { promoted: r['promoted'] as number, nextInMs: r['next_in'] as number | null }
}
