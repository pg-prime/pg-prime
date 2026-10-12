import type { TopicCtx } from '../context.js'

export interface Lease {
  readonly p: number
  readonly token: string
  readonly epoch: bigint
}

/** Partitions a relay should hold: `ceil(P / live)`, counting relays that own nothing (X9). */
export const fairShare = (partitions: number, live: number): number =>
  Math.ceil(partitions / Math.max(live, 1))

/**
 * Membership upsert, stale-member cleanup and lease extension in one statement. A held
 * partition missing from `kept` was taken over.
 */
export async function heartbeat(
  { db, s, def }: TopicCtx<unknown>,
  owner: string,
  leaseMs: number,
  held: readonly Lease[],
): Promise<{ kept: Set<number>; live: number }> {
  const t = def.topic
  const [row] = await db.withOptions({ label: 'outbox.heartbeat' }).sql`
    with me as (
      insert into ${s}.relays (topic, owner) values (${t}, ${owner})
      on conflict (topic, owner) do update set seen_at = now()
    ), gone as (
      delete from ${s}.relays
      where topic = ${t} and owner <> ${owner} and seen_at < now() - ${leaseMs * 10}::float8 * interval '1 ms'
    ), ext as (
      update ${s}.partitions x set lease_until = now() + ${leaseMs}::float8 * interval '1 ms'
      from unnest(${held.map((l) => l.p)}::smallint[], ${held.map((l) => l.token)}::text[]) as h(p, tok)
      where x.topic = ${t} and x.p = h.p and x.token = h.tok
      returning x.p
    )
    select coalesce((select array_agg(p) from ext), '{}') as kept,
           (select count(*) from ${s}.relays
            where topic = ${t} and seen_at > now() - ${leaseMs}::float8 * interval '1 ms') as live`.execute()
  return {
    kept: new Set(row?.['kept'] as number[]),
    live: Number(row?.['live']),
  }
}

/**
 * L1: takes free or expired partitions, least recently served first, up to the fair share.
 * Also returns the live relay count it computed the share from.
 */
export async function acquire(
  { db, s, def }: TopicCtx<unknown>,
  owner: string,
  leaseMs: number,
): Promise<{ leases: Lease[]; live: number }> {
  const t = def.topic
  const [row] = await db.withOptions({ label: 'outbox.lease' }).sql`
    with live as (
      select count(*) as n from ${s}.relays
      where topic = ${t} and seen_at > now() - ${leaseMs}::float8 * interval '1 ms'
    ), mine as (
      select count(*) as n from ${s}.partitions
      where topic = ${t} and owner = ${owner} and lease_until > now()
    ), free as (
      select p from ${s}.partitions
      where topic = ${t} and (token is null or lease_until < now())
      order by served_at
      limit greatest(0, ceil(${def.partitions}::numeric / greatest((select n from live), 1))::int - (select n from mine))
      for update skip locked
    ), up as (
      update ${s}.partitions x set owner = ${owner}, token = gen_random_uuid()::text,
             epoch = x.epoch + 1, lease_until = now() + ${leaseMs}::float8 * interval '1 ms'
      from free where x.topic = ${t} and x.p = free.p
      returning x.p, x.token, x.epoch
    )
    select (select n from live) as live, coalesce(array_agg(p), '{}') as ps,
           coalesce(array_agg(token), '{}') as tokens, coalesce(array_agg(epoch), '{}') as epochs
    from up`.execute()
  const ps = row?.['ps'] as number[]
  const tokens = row?.['tokens'] as string[]
  const epochs = row?.['epochs'] as bigint[]
  return {
    leases: ps.map((p, i) => ({ p, token: tokens[i]!, epoch: epochs[i]! })),
    live: Number(row?.['live']),
  }
}

/** Gives partitions up at once (rebalance or close); `leave` also drops the membership row. */
export async function release(
  { db, s, def, chan }: TopicCtx<unknown>,
  owner: string,
  leases: readonly Lease[],
  leave: boolean,
): Promise<void> {
  const t = def.topic
  await db.withOptions({ label: 'outbox.release' }).sql`
    with r as (
      update ${s}.partitions x set owner = null, token = null, lease_until = null
      from unnest(${leases.map((l) => l.p)}::smallint[], ${leases.map((l) => l.token)}::text[]) as h(p, tok)
      where x.topic = ${t} and x.p = h.p and x.token = h.tok
      returning x.p
    ), d as (
      delete from ${s}.relays where ${leave}::boolean and topic = ${t} and owner = ${owner}
    )
    select (select pg_notify(${chan}, '') where exists (select from r)) is null as woke`.execute()
}
