import type { TopicCtx } from '../context.js'
import type { OutboxStats, ParkedRecord, PartitionStats } from '../types.js'

/** Creates the topic and its partition rows; returns the stored (immutable) partition count. */
export async function createTopic({ db, s, def }: TopicCtx<unknown>): Promise<number> {
  const t = def.topic
  const [row] = await db.withOptions({ label: 'outbox.start' }).sql`
    with t as (
      insert into ${s}.topics (name, partitions, keep_delivered_ms)
      values (${t}, ${def.partitions}::smallint, ${def.keepDeliveredMs}::bigint)
      on conflict (name) do update set keep_delivered_ms = excluded.keep_delivered_ms
      returning partitions
    ), p as (
      insert into ${s}.partitions (topic, p)
      select ${t}, generate_series(0, (select partitions from t) - 1)
      on conflict do nothing
    )
    select partitions from t`.execute()
  return row?.['partitions'] as number
}

export async function listParked<T>(
  { db, s, def, decode }: TopicCtx<T>,
  limit: number,
  after: bigint,
): Promise<ParkedRecord<T>[]> {
  const rows = await db.withOptions({ label: 'outbox.parked-list' }).sql`
    select id, key, idem, payload, headers, attempts, created_at, error from ${s}.records
    where topic = ${def.topic} and state = 'parked' and id > ${after}::bigint
    order by id limit ${limit}::int`.execute()
  return rows.map((r) => ({ ...decode(r), error: r['error'] as string | null }))
}

/** Parked → pending with a fresh attempt count; unblocks their keys and wakes the relays. */
export async function replay(
  { db, s, def, chan }: TopicCtx<unknown>,
  ids: readonly bigint[],
): Promise<number> {
  const t = def.topic
  const [row] = await db.withOptions({ label: 'outbox.replay' }).sql`
    with r as (
      update ${s}.records set state = 'pending', attempts = 0, next_at = '-infinity', error = null
      where topic = ${t} and id = any(${[...ids]}::bigint[]) and state = 'parked'
      returning key
    ), b as (
      delete from ${s}.blocked where topic = ${t} and key in (select key from r where key is not null)
    )
    select count(*) as n, (select pg_notify(${chan}, '') where exists (select from r)) is null as woke
    from r`.execute()
  return Number(row?.['n'])
}

/** Deletes parked records; a discarded head releases its key. */
export async function discard(
  { db, s, def, chan }: TopicCtx<unknown>,
  ids: readonly bigint[],
): Promise<number> {
  const t = def.topic
  const [row] = await db.withOptions({ label: 'outbox.discard' }).sql`
    with d as (
      delete from ${s}.records
      where topic = ${t} and id = any(${[...ids]}::bigint[]) and state = 'parked'
      returning key
    ), b as (
      delete from ${s}.blocked where topic = ${t} and key in (select key from d where key is not null)
    )
    select count(*) as n, (select pg_notify(${chan}, '') where exists (select from d)) is null as woke
    from d`.execute()
  return Number(row?.['n'])
}

export async function setPaused(
  { db, s, def, chan }: TopicCtx<unknown>,
  paused: boolean,
): Promise<void> {
  await db.withOptions({ label: 'outbox.pause' }).sql`
    with u as (update ${s}.topics set paused = ${paused}::boolean where name = ${def.topic} returning 1)
    select (select pg_notify(${chan}, '') where not ${paused}::boolean and exists (select from u))
      is null as woke`.execute()
}

export async function stats({ db, s, def }: TopicCtx<unknown>): Promise<OutboxStats> {
  const t = def.topic
  const rows = await db.withOptions({ label: 'outbox.stats' }).sql`
    select p.p, p.owner, p.epoch, p.lease_until, c.pending, c.oldest_at,
           (select count(*) from ${s}.records where topic = ${t} and state = 'parked') as parked,
           (select count(*) from ${s}.blocked where topic = ${t} and until > now()) as blocked,
           (select paused from ${s}.topics where name = ${t}) as paused
    from ${s}.partitions p
    cross join lateral (
      select count(*) as pending, min(created_at) as oldest_at from ${s}.records r
      where r.topic = p.topic and r.partition = p.p and r.state = 'pending'
    ) c
    where p.topic = ${t} order by p.p`.execute()
  const partitions = rows.map((r): PartitionStats => ({
    partition: r['p'] as number,
    pending: Number(r['pending']),
    oldestAt: r['oldest_at'] as Date | null,
    owner: r['owner'] as string | null,
    epoch: r['epoch'] as bigint,
    leaseUntil: r['lease_until'] as Date | null,
  }))
  return {
    paused: rows[0]?.['paused'] === true,
    pending: partitions.reduce((n, p) => n + p.pending, 0),
    parked: Number(rows[0]?.['parked'] ?? 0),
    blockedKeys: Number(rows[0]?.['blocked'] ?? 0),
    partitions,
  }
}
