import { sql } from 'pg-prime'
import type { AnyFragment } from 'pg-prime'
import { errorText } from '../context.js'
import type { TopicCtx } from '../context.js'
import { NonRetryableSinkError } from '../errors.js'
import type { OutboxRecord } from '../types.js'
import type { Lease } from './lease.js'

/** A record whose payload the codec rejects; it parks at once. */
export interface Undecodable {
  readonly id: bigint
  readonly key: string | null
  readonly attempts: number
  readonly error: NonRetryableSinkError
}

/** R1: the partition's deliverable head, in id order. The lease makes this relay its only reader. */
export async function readPartition<T>(
  { db, s, def, decode }: TopicCtx<T>,
  p: number,
  limit: number,
): Promise<(OutboxRecord<T> | Undecodable)[]> {
  const t = def.topic
  const rows = await db.withOptions({ label: 'outbox.read' }).sql`
    select r.id, r.key, r.idem, r.payload, r.headers, r.attempts, r.created_at
    from ${s}.records r
    where r.topic = ${t} and r.partition = ${p}::smallint and r.state = 'pending' and r.next_at <= now()
      and (r.key is null or not exists (
            select from ${s}.blocked b where b.topic = ${t} and b.key = r.key and b.until > now()))
      and not (select paused from ${s}.topics where name = ${t})
    order by r.id
    limit ${limit}::int`.execute()
  return rows.map((r) => {
    try {
      return decode(r)
    } catch (e) {
      const id = r['id'] as bigint
      const error = new NonRetryableSinkError(
        `@pg-prime/outbox: ${t}: record ${id} does not decode: ${errorText(e)}`,
        { cause: e },
      )
      return { id, key: r['key'] as string | null, attempts: r['attempts'] as number, error }
    }
  })
}

/**
 * Wave k holds the k-th record of every key (and wave 0 every unkeyed one), so no wave holds a
 * key twice. Keys in `failed` are dropped from every wave yielded after they were added.
 */
export function* waves<R extends { readonly key: string | null }>(
  rows: readonly R[],
  failed: ReadonlySet<string>,
): Generator<R[]> {
  const split: R[][] = []
  const depth = new Map<string, number>()
  for (const r of rows) {
    const k = r.key === null ? 0 : (depth.get(r.key) ?? 0)
    if (r.key !== null) depth.set(r.key, k + 1)
    ;(split[k] ??= []).push(r)
  }
  for (const w of split) {
    const live = w.filter((r) => r.key === null || !failed.has(r.key))
    if (live.length > 0) yield live
  }
}

/** D1: marks delivered (or deletes, with `keepDeliveredMs: 0`); returns how many settled. */
export async function settleDelivered(
  { db, s, def }: TopicCtx<unknown>,
  lease: Lease,
  ids: readonly bigint[],
): Promise<number> {
  const t = def.topic
  const mark =
    def.keepDeliveredMs === 0
      ? sql`delete from ${s}.records
          where id = any(${ids}::bigint[]) and state = 'pending' and exists (select from l) returning key`
      : sql`update ${s}.records set state = 'delivered', delivered_at = clock_timestamp()
          where id = any(${ids}::bigint[]) and state = 'pending' and exists (select from l) returning key`
  const [row] = await db.withOptions({ label: 'outbox.delivered' }).sql`
    with l as (${locked(s, t, lease)}), d as (${mark}), ub as (
      delete from ${s}.blocked where topic = ${t} and key in (select key from d where key is not null)
    ), sv as (
      update ${s}.partitions set served_at = clock_timestamp()
      where topic = ${t} and p = ${lease.p}::smallint and exists (select from l)
    )
    select count(*) as n from d`.execute()
  return Number(row?.['n'])
}

/** F1: a keyed failure blocks its key; an unkeyed one delays itself. Returns 0 if the lease is gone. */
export async function settleFailed(
  { db, s, def }: TopicCtx<unknown>,
  lease: Lease,
  id: bigint,
  error: string,
  delayMs: number,
): Promise<number> {
  const t = def.topic
  const rows = await db.withOptions({ label: 'outbox.failed' }).sql`
    with l as (${locked(s, t, lease)}), r as (
      update ${s}.records set attempts = attempts + 1, error = ${error},
             next_at = case when key is null then now() + ${delayMs}::float8 * interval '1 ms' else next_at end
      where id = ${id}::bigint and state = 'pending' and exists (select from l) returning key, attempts
    ), b as (
      insert into ${s}.blocked (topic, key, until, attempts, error)
      select ${t}, key, now() + ${delayMs}::float8 * interval '1 ms', attempts, ${error} from r where key is not null
      on conflict (topic, key) do update set until = excluded.until, attempts = excluded.attempts, error = excluded.error
    )
    select count(*) as n from r`.execute()
  return Number(rows[0]?.['n'])
}

/** K1: parks the record; its key stays blocked until `replay` or `discard`. */
export async function settleParked(
  { db, s, def }: TopicCtx<unknown>,
  lease: Lease,
  id: bigint,
  error: string,
): Promise<number> {
  const t = def.topic
  const [row] = await db.withOptions({ label: 'outbox.parked' }).sql`
    with l as (${locked(s, t, lease)}), r as (
      update ${s}.records set state = 'parked', attempts = attempts + 1, error = ${error}
      where id = ${id}::bigint and state = 'pending' and exists (select from l) returning key
    ), b as (
      insert into ${s}.blocked (topic, key, until, attempts, error)
      select ${t}, key, 'infinity', 0, ${error} from r where key is not null
      on conflict (topic, key) do update set until = 'infinity', error = excluded.error
    )
    select count(*) as n from r`.execute()
  return Number(row?.['n'])
}

/**
 * Deletes up to `limit` delivered records past `keep_delivered_ms`. Without `force`, only the
 * caller that wins the `maint_at` CAS (once per `everyMs` across relays) sweeps.
 */
export async function sweep(
  { db, s, def }: TopicCtx<unknown>,
  everyMs: number,
  limit: number,
  force: boolean,
): Promise<number> {
  const t = def.topic
  const [row] = await db.withOptions({ label: 'outbox.retention' }).sql`
    with gate as (
      update ${s}.topics set maint_at = now()
      where name = ${t} and (${force}::boolean or maint_at < now() - ${everyMs}::float8 * interval '1 ms')
      returning keep_delivered_ms
    ), del as (
      delete from ${s}.records where id in (
        select id from ${s}.records
        where topic = ${t} and state = 'delivered'
          and delivered_at < now() - (select keep_delivered_ms from gate) * interval '1 ms'
        order by delivered_at
        limit ${limit}::int)
      returning 1
    )
    select count(*) as n from del`.execute()
  return Number(row?.['n'])
}

/** The settle's lease check, under the partition row's lock. */
const locked = (s: AnyFragment, t: string, lease: Lease): AnyFragment =>
  sql`select 1 from ${s}.partitions
    where topic = ${t} and p = ${lease.p}::smallint and token = ${lease.token} and lease_until > now()
    for update`
