import { sql } from 'pg-prime'
import { ms, run, wakeCte, watchCte, withCtes } from './tables.js'
import type { Cte, F, Q, Tables } from './tables.js'

export type Terminal = 'completed' | 'failed' | 'cancelled'

/**
 * Who may finish the message: its owner (`token`), the lease-expiry scan (`expired`), a flow
 * cascade on a waiting parent (`blocked`), or a cancel of a message nobody runs (`idle`).
 */
export type Guard =
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'expired' }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'idle' }

export interface FinishArgs {
  readonly id: bigint
  readonly to: Terminal
  readonly guard: Guard
  /** Serialized JSON. */
  readonly result?: string | null
  readonly error?: string | null
  readonly stack?: string | null
  /** A completion on a queue that keeps no completed messages deletes the row. */
  readonly del?: boolean
}

export interface Settled {
  readonly queue: string
  /** A `fail`-policy cascade reached this parent while it was `blocked`: finish it next. */
  readonly cascadeTo: bigint | null
}

const fromActive = (g: Guard): boolean => g.kind === 'token' || g.kind === 'expired'

function guardSql(g: Guard): F {
  switch (g.kind) {
    case 'token':
      return sql`m.token = ${g.token} and m.state = 'active'`
    case 'expired':
      return sql`m.state = 'active' and m.lease_until < now()`
    case 'blocked':
      return sql`m.state = 'blocked'`
    case 'idle':
      return sql`m.state in ('ready', 'delayed', 'blocked')`
  }
}

const RETURNING = sql`m.id, m.queue, m.state, m.group_key, m.parent, m.dedup_key, m.counted, m.on_fail`

/**
 * `[deps]`: a settled child resolves its `deps` row and, unless it failed under `wait`, its
 * parent: a completed or ignored child decrements `pending_deps` (the last one releases a blocked
 * parent once, by EvalPlanQual on the parent row); a `fail` child flags `child_failed`.
 */
export function depsCtes(t: Tables, result: string | null): (Cte | false)[] {
  const release = sql`dp.status <> 'failed' and p.pending_deps = 1 and p.state = 'blocked'`
  return [
    [
      'dp',
      sql`update ${t.deps} d set
          status = (case when done.state = 'completed' then 'completed'
            when done.on_fail = 'ignore' then 'ignored' else 'failed' end)::${t.depStatus},
          value = ${result}::jsonb
        from done where d.parent = done.parent and d.child = done.id and d.status = 'pending'
        returning d.parent, d.status, done.on_fail`,
    ],
    [
      'pr',
      sql`update ${t.messages} p set
          pending_deps = p.pending_deps - case when dp.status = 'failed' then 0 else 1 end,
          child_failed = p.child_failed or dp.status = 'failed',
          state = case when ${release} then 'ready'::${t.msgState} else p.state end,
          order_key = case when ${release} then sign(p.order_key) * ${t.next} else p.order_key end
        from dp where p.id = dp.parent and (dp.status <> 'failed' or dp.on_fail = 'fail')
        returning p.id, p.queue, p.state, dp.status = 'failed' as cascade`,
    ],
    wakeCte(t, 'pr', sql`state = 'ready'`),
    watchCte(t, 'pr', sql`pr.state = 'ready' and not pr.cascade`),
  ]
}

/**
 * `[group]` then `[global]`: the counters of a message that leaves `active`. Each waits for the
 * previous fragment, so every settle locks message rows, then the group row, then the queue row;
 * claims take the queue row first and never wait on the others, so there is no cycle.
 */
function counterCtes(t: Tables, after: string | null, limitMs?: number): (Cte | false)[] {
  const gate = (cte: string | null): F =>
    cte === null ? sql`` : sql`and (select count(*) from ${sql.unsafeRaw(cte)}) >= 0`
  return [
    [
      'gd',
      sql`update ${t.groups} g set active = g.active - 1
        from done where g.queue = done.queue and g.key = done.group_key ${gate(after)}
        returning g.queue`,
    ],
    limitMs === undefined
      ? [
          'qd',
          sql`update ${t.queues} u set active = u.active - 1
            from done where u.name = done.queue and done.counted ${gate('gd')}
            returning u.name as queue`,
        ]
      : [
          'qd',
          sql`update ${t.queues} u set active = u.active - case when done.counted then 1 else 0 end,
              limited_until = greatest(coalesce(u.limited_until, '-infinity'), now() + ${ms(limitMs)})
            from done where u.name = done.queue ${gate('gd')}
            returning u.name as queue`,
        ],
    ['freed', sql`select queue from gd union select queue from qd`, true],
    wakeCte(t, 'freed'),
  ]
}

/** The one builder for every transition into `completed`, `failed` or `cancelled`. */
export function finishSql(t: Tables, a: FinishArgs): F {
  const active = fromActive(a.guard)
  const keep = a.to === 'completed' ? sql`keep_completed_ms` : sql`keep_failed_ms`
  const done = a.del
    ? sql`delete from ${t.messages} m where m.id = ${a.id}::bigint and ${guardSql(a.guard)}
        returning m.id, m.queue, 'completed'::${t.msgState} as state, m.group_key, m.parent,
          m.dedup_key, m.counted, m.on_fail`
    : sql`update ${t.messages} m set state = ${a.to}::${t.msgState}, result = ${a.result ?? null}::jsonb,
          error = ${a.error ?? null}::text, stack = ${a.stack ?? null}::text,
          finished_at = clock_timestamp(), attempts = m.attempts + ${active ? 1 : 0}::int,
          token = null, lease_until = null,
          expire_at = clock_timestamp() + (select ${keep} from ${t.queues} k where k.name = m.queue)
            * interval '1 ms'
        where m.id = ${a.id}::bigint and ${guardSql(a.guard)}
        returning ${RETURNING}`
  return withCtes(
    [
      ['done', done],
      [
        'dd',
        sql`delete from ${t.dedup} x using done
          where x.queue = done.queue and x.key = done.dedup_key and x.msg = done.id
            and x.expire_at is null`,
      ],
      ...depsCtes(t, a.result ?? null),
      ...(active ? counterCtes(t, 'pr') : []),
      watchCte(t, 'done'),
    ],
    (refs) => sql`select done.id, done.queue,
        (select id from pr where pr.cascade and pr.state = 'blocked') as cascade_to, ${refs} as fx
      from done`,
  )
}

/** `undefined`: the guard did not match (0 rows). */
export async function finish(q: Q, t: Tables, a: FinishArgs): Promise<Settled | undefined> {
  const [r] = await run(q, `finish-${a.to}`, finishSql(t, a))
  return r === undefined
    ? undefined
    : { queue: r['queue'] as string, cascadeTo: r['cascade_to'] as bigint | null }
}

/**
 * Locks the ancestors a `fail` cascade may reach, nearest first, before the child's own settle
 * takes any group or queue row: a cascade then never waits on a message while holding counters.
 */
export async function lockAncestors(q: Q, t: Tables, id: bigint): Promise<void> {
  await run(
    q,
    'lock-ancestors',
    sql`with recursive a(id, parent, on_fail, depth) as (
        select id, parent, on_fail, 0 from ${t.messages} where id = ${id}::bigint
        union all
        select m.id, m.parent, m.on_fail, a.depth + 1 from ${t.messages} m
        join a on m.id = a.parent where a.on_fail = 'fail'
      )
      select m.id from ${t.messages} m join a on a.id = m.id where a.depth > 0
      order by a.depth for update of m`,
  )
}

export type Move =
  /** S8r: a failed attempt with attempts left. */
  | {
      readonly kind: 'retry'
      readonly delayMs: number
      readonly error: string
      readonly stack: string | null
    }
  /** S12: `ctx.defer`, no attempt counted. */
  | { readonly kind: 'defer'; readonly delayMs?: number; readonly until?: Date }
  /** S13: `ctx.rateLimit` (with `limitMs`) or a shutdown release, no attempt counted. */
  | { readonly kind: 'release'; readonly limitMs?: number }
  /** S14: `ctx.waitForChildren`; refused while a `fail` child has failed. */
  | { readonly kind: 'wait' }

/** S8r, S12, S13, S14: token-guarded moves out of `active`, each with its counter decrements. */
export function moveSql(t: Tables, id: bigint, token: string, mv: Move): F {
  const guard = sql`m.id = ${id}::bigint and m.token = ${token} and m.state = 'active'`
  const fresh = sql`order_key = sign(m.order_key) * ${t.next}`
  let set: F
  switch (mv.kind) {
    case 'retry':
      set = sql`state = (case when ${mv.delayMs}::float8 > 0 then 'delayed' else 'ready' end)::${t.msgState},
        run_at = case when ${mv.delayMs}::float8 > 0 then now() + ${ms(mv.delayMs)} end, ${fresh},
        attempts = m.attempts + 1, error = ${mv.error}::text, stack = ${mv.stack}::text`
      break
    case 'defer':
      set = sql`state = 'delayed', run_at = coalesce(${mv.until ?? null}::timestamptz,
          now() + ${ms(mv.delayMs ?? 0)}), ${fresh}, claims = m.claims - 1`
      break
    case 'release':
      set = sql`state = 'ready', claims = m.claims - 1`
      break
    case 'wait':
      set = sql`state = 'blocked'`
      break
  }
  return withCtes(
    [
      [
        'done',
        sql`update ${t.messages} m set ${set}, token = null, lease_until = null
          where ${guard} ${mv.kind === 'wait' ? sql`and m.pending_deps > 0 and not m.child_failed` : sql``}
          returning ${RETURNING}`,
      ],
      ...counterCtes(t, null, mv.kind === 'release' ? mv.limitMs : undefined),
      mv.kind !== 'wait' && wakeCte(t, 'done'),
      watchCte(t, 'done'),
    ],
    (refs) => sql`select done.id, ${refs} as fx from done`,
  )
}

/** True when the token still held the message. */
export async function move(q: Q, t: Tables, id: bigint, token: string, mv: Move): Promise<boolean> {
  return (await run(q, mv.kind, moveSql(t, id, token, mv))).length === 1
}

export async function progress(
  q: Q,
  t: Tables,
  id: bigint,
  token: string,
  value: string,
): Promise<boolean> {
  const rows = await run(
    q,
    'progress',
    withCtes(
      [
        [
          'up',
          sql`update ${t.messages} m set progress = ${value}::jsonb
            where m.id = ${id}::bigint and m.token = ${token} and m.state = 'active'
            returning m.id, m.queue, m.state`,
        ],
        watchCte(t, 'up'),
      ],
      (refs) => sql`select up.id, ${refs} as fx from up`,
    ),
  )
  return rows.length === 1
}

export async function extend(
  q: Q,
  t: Tables,
  id: bigint,
  token: string,
  leaseMs: number,
): Promise<boolean> {
  const rows = await run(
    q,
    'extend',
    sql`update ${t.messages} set lease_until = now() + ${ms(leaseMs)}
      where id = ${id}::bigint and token = ${token} and state = 'active' returning id`,
  )
  return rows.length === 1
}
