import { sql } from 'pg-prime'
import type { Keep, QueueDef } from '../define.js'
import { depsCtes } from './settle.js'
import type { MessageState } from './read.js'
import { ms, one, raw, run, wakeCte, watchCte, withCtes } from './tables.js'
import type { F, Q, Tables } from './tables.js'

const keepMs = (k: Keep): number | null => (k === false ? 0 : (k.ageMs ?? null))
const keepN = (k: Keep): number | null => (k === false ? null : (k.count ?? null))

/** `start()`: the declared configuration, synced to the queue's row (D10). */
export async function upsertQueue(q: Q, t: Tables, def: QueueDef<any, any>): Promise<void> {
  await run(
    q,
    'queue',
    sql`insert into ${t.queues} as u (name, rate_max, rate_ms, concurrency, keep_completed_ms,
        keep_completed_n, keep_failed_ms, keep_failed_n, watch)
      values (${def.name}, ${def.rate?.max ?? null}::int, ${def.rate?.perMs ?? null}::int,
        ${def.concurrency ?? null}::int, ${keepMs(def.keep.completed)}::bigint,
        ${keepN(def.keep.completed)}::int, ${keepMs(def.keep.failed)}::bigint,
        ${keepN(def.keep.failed)}::int, ${def.watch})
      on conflict (name) do update set rate_max = excluded.rate_max, rate_ms = excluded.rate_ms,
        concurrency = excluded.concurrency, keep_completed_ms = excluded.keep_completed_ms,
        keep_completed_n = excluded.keep_completed_n, keep_failed_ms = excluded.keep_failed_ms,
        keep_failed_n = excluded.keep_failed_n, watch = excluded.watch,
        limited_until = case when excluded.rate_max is null then null else u.limited_until end`,
  )
}

export async function setPaused(q: Q, t: Tables, queue: string, paused: boolean): Promise<void> {
  await run(
    q,
    paused ? 'pause' : 'resume',
    sql`update ${t.queues} set paused = ${paused} where name = ${queue}`,
  )
}

/** An active message is cancelled by its worker: the next heartbeat sees the flag. */
export async function flagCancel(
  q: Q,
  t: Tables,
  queue: string,
  id: bigint,
  reason: string | null,
): Promise<boolean> {
  const rows = await run(
    q,
    'cancel',
    sql`update ${t.messages} set cancel = true, error = coalesce(${reason}::text, error)
      where id = ${id}::bigint and queue = ${queue} and state = 'active' returning id`,
  )
  return rows.length === 1
}

export type RetrySel =
  | { readonly ids: readonly bigint[] }
  | { readonly state: 'failed' | 'cancelled' | 'completed'; readonly limit?: number }

const unresolved = (t: Tables, m: string): F =>
  sql`exists (select from ${t.deps} d where d.parent = ${raw(m)}.id and d.status in ('pending', 'failed'))`

/** Finished messages of `ids` whose children are not all resolved (retry refuses them). */
export async function withUnresolvedChildren(
  q: Q,
  t: Tables,
  queue: string,
  ids: readonly bigint[],
): Promise<bigint[]> {
  const rows = await run(
    q,
    'retry-check',
    sql`select m.id from ${t.messages} m where m.queue = ${queue} and m.id = any(${ids}::bigint[])
      and m.state in ('completed', 'failed', 'cancelled') and ${unresolved(t, 'm')}`,
  )
  return rows.map((r) => r['id'] as bigint)
}

/** A-retry: finished → ready with a clean slate; a failed `deps` row goes back to `pending`. */
export function retrySql(t: Tables, queue: string, sel: RetrySel): F {
  const which =
    'ids' in sel
      ? sql`m.id = any(${sel.ids}::bigint[])`
      : sql`m.state = ${sel.state}::${t.msgState}`
  return withCtes(
    [
      [
        'sel',
        sql`select m.id from ${t.messages} m
          where m.queue = ${queue} and m.state in ('completed', 'failed', 'cancelled') and ${which}
            and not ${unresolved(t, 'm')}
          order by m.id limit ${'ids' in sel ? sel.ids.length : (sel.limit ?? 1000)}::int
          for update skip locked`,
      ],
      [
        'up',
        sql`update ${t.messages} m set state = 'ready', run_at = null,
            order_key = sign(m.order_key) * ${t.next}, attempts = 0, expire_at = null,
            finished_at = null, started_at = null, result = null, error = null, stack = null,
            progress = null, cancel = false, child_failed = false, token = null, lease_until = null
          from sel where m.id = sel.id
          returning m.id, m.queue, m.state, m.parent`,
      ],
      [
        'dr',
        sql`update ${t.deps} d set status = 'pending', value = null
          from up where d.parent = up.parent and d.child = up.id and d.status = 'failed'`,
      ],
      wakeCte(t, 'up'),
      watchCte(t, 'up'),
    ],
    (refs) => sql`select (select count(*)::int from up) as n, ${refs} as fx`,
  )
}

export async function retry(q: Q, t: Tables, queue: string, sel: RetrySel): Promise<number> {
  return (await one(q, 'retry', retrySql(t, queue, sel)))['n'] as number
}

/** The message and its descendants, rows locked without waiting. */
export async function lockTree(
  q: Q,
  t: Tables,
  queue: string,
  id: bigint,
): Promise<{ ids: bigint[]; states: MessageState[]; parent: bigint | null; complete: boolean }> {
  const rows = await run(
    q,
    'remove-lock',
    sql`with recursive tree(id) as (
        select id from ${t.messages} where id = ${id}::bigint and queue = ${queue}
        union all
        select m.id from ${t.messages} m join tree on m.parent = tree.id
      ), locked as (
        select m.id, m.state, m.parent from ${t.messages} m where m.id in (select id from tree)
        for update skip locked
      )
      select (select count(*)::int from tree) as total, l.id, l.state::text as state, l.parent
      from (select) x left join locked l on true`,
  )
  const got = rows.filter((r) => r['id'] !== null)
  const root = got.find((r) => r['id'] === id)
  return {
    ids: got.map((r) => r['id'] as bigint),
    states: got.map((r) => r['state'] as MessageState),
    parent: (root?.['parent'] as bigint | null | undefined) ?? null,
    complete:
      got.length === ((rows[0]?.['total'] as number | undefined) ?? 0) && root !== undefined,
  }
}

/** Deletes messages (their `deps` rows cascade) and their `until-done` dedup rows. */
export async function deleteMessages(q: Q, t: Tables, ids: readonly bigint[]): Promise<number> {
  const r = await one(
    q,
    'remove',
    sql`with del as (
        delete from ${t.messages} where id = any(${ids}::bigint[]) returning id, queue, dedup_key
      ), dd as (
        delete from ${t.dedup} x using del
        where x.queue = del.queue and x.key = del.dedup_key and x.msg = del.id and x.expire_at is null
      )
      select count(*)::int as n from del`,
  )
  return r['n'] as number
}

/** A removed child counts as ignored for its parent, which may be released by it. */
export async function resolveRemoved(
  q: Q,
  t: Tables,
  child: bigint,
  parent: bigint,
): Promise<void> {
  await run(
    q,
    'remove-parent',
    withCtes(
      [
        [
          'done',
          sql`select ${child}::bigint as id, ${parent}::bigint as parent,
            'cancelled'::text as state, 'ignore'::text as on_fail`,
        ],
        ...depsCtes(t, null, true),
      ],
      (refs) => sql`select ${refs} as fx`,
    ),
  )
}

/** One batch of A-purge: ≤ 1 000 messages in `states` older than `olderThanMs`. */
export async function purgeBatch(
  q: Q,
  t: Tables,
  queue: string,
  states: readonly MessageState[] | null,
  olderThanMs: number | null,
): Promise<number> {
  const r = await one(
    q,
    'purge',
    sql`with del as (
        delete from ${t.messages} where id in (
          select id from ${t.messages}
          where queue = ${queue} and (${states}::text[] is null or state::text = any(${states}::text[]))
            and (${olderThanMs}::float8 is null or coalesce(finished_at, created_at) < now() - ${ms(olderThanMs)})
          limit 1000 for update skip locked)
        returning id, queue, dedup_key
      ), dd as (
        delete from ${t.dedup} x using del
        where x.queue = del.queue and x.key = del.dedup_key and x.msg = del.id and x.expire_at is null
      )
      select count(*)::int as n from del`,
  )
  return r['n'] as number
}

export async function activeCount(q: Q, t: Tables, queue: string): Promise<number> {
  const r = await one(
    q,
    'active',
    sql`select count(*)::int as n from ${t.messages} where queue = ${queue} and state = 'active'`,
  )
  return r['n'] as number
}

/** `drop()`'s last step, after the messages are gone. */
export async function dropRows(q: Q, t: Tables, queue: string): Promise<void> {
  await run(
    q,
    'drop',
    sql`with g as (delete from ${t.groups} where queue = ${queue}),
        d as (delete from ${t.dedup} where queue = ${queue})
      delete from ${t.queues} where name = ${queue}`,
  )
}

export interface GroupLimits {
  readonly concurrency?: number | null
  readonly rate?: { readonly max: number; readonly perMs: number } | null
}

/** Upserts a group row: `paused`, or limits where `undefined` keeps and `null` clears. */
export async function setGroup(
  q: Q,
  t: Tables,
  queue: string,
  key: string,
  s: { readonly paused?: boolean } & GroupLimits,
): Promise<void> {
  const keep = (v: unknown, col: string, val: F): F =>
    v === undefined ? sql`${raw(col)} = r.${raw(col)}` : sql`${raw(col)} = ${val}`
  await run(
    q,
    'group',
    sql`insert into ${t.groups} as r (queue, key, paused, concurrency, rate_max, rate_ms)
      values (${queue}, ${key}, ${s.paused ?? false}, ${s.concurrency ?? null}::int,
        ${s.rate?.max ?? null}::int, ${s.rate?.perMs ?? null}::int)
      on conflict (queue, key) do update set
        ${keep(s.paused, 'paused', sql`excluded.paused`)},
        ${keep(s.concurrency, 'concurrency', sql`excluded.concurrency`)},
        ${keep(s.rate, 'rate_max', sql`excluded.rate_max`)},
        ${keep(s.rate, 'rate_ms', sql`excluded.rate_ms`)}`,
  )
}
