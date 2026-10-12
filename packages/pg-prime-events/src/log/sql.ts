import { sql } from 'pg-prime'
import type { Fragment, Queryable, RawRow } from 'pg-prime'
import type { Cursor, ReadView } from './cursor.js'

type Q = Queryable<any>

export interface EntryRow {
  readonly id: bigint
  readonly xid: bigint
  readonly type: string | null
  readonly key: string | null
  readonly payload: unknown
  readonly headers: Record<string, string> | null
  readonly at: Date
}

export interface LeaseRow {
  readonly token: string
  readonly cursor: Cursor
  readonly types: readonly string[] | null
  readonly headId: bigint | null
  readonly headSize: number
  readonly retryInMs: number
}

export interface NewEntry {
  readonly type: string | null
  readonly key: string | null
  readonly headers: Record<string, string> | null
  /** Serialized JSON. */
  readonly payload: string
}

export interface Statements {
  publish(q: Q, topic: string, channel: string, rows: readonly NewEntry[]): Promise<bigint[]>
  seedNow(q: Q): Promise<{ xmax: bigint; xip: bigint[] }>
  upsertTopic(q: Q, name: string, keepMs: number | null, untilConsumed: boolean): Promise<void>
  upsertSubscription(
    q: Q,
    t: string,
    s: string,
    types: readonly string[] | null,
    c: Cursor,
  ): Promise<void>
  lease(q: Q, t: string, s: string, leaseMs: number): Promise<LeaseRow | undefined>
  heartbeat(q: Q, t: string, s: string, token: string, leaseMs: number): Promise<boolean>
  release(q: Q, t: string, s: string, token: string): Promise<void>
  read(
    q: Q,
    t: string,
    c: Cursor,
    n: number,
    types: readonly string[] | null,
  ): Promise<{ view: ReadView; rows: EntryRow[] }>
  mark(
    q: Q,
    t: string,
    s: string,
    token: string,
    first: bigint,
    size: number,
  ): Promise<number | undefined>
  commit(q: Q, t: string, s: string, token: string, c: Cursor): Promise<boolean>
  /** The stored cursor, once any transaction updating it has ended. */
  stored(q: Q, t: string, s: string, token: string): Promise<Cursor | undefined>
  nack(q: Q, t: string, s: string, token: string, delayMs: number): Promise<boolean>
  park(
    q: Q,
    t: string,
    s: string,
    token: string,
    c: Cursor,
    entry: bigint,
    attempts: number,
    error: string | null,
  ): Promise<boolean>
  maintain(q: Q, t: string, everyMs: number): Promise<{ deleted: number; behind: boolean }>
  reset(q: Q, t: string, s: string, c: Cursor): Promise<boolean>
  lag(q: Q, t: string, s: string): Promise<{ entries: number; oldestAt: Date | null }>
  parked(
    q: Q,
    t: string,
    s: string,
    limit: number,
  ): Promise<(EntryRow & { attempts: number; error: string | null })[]>
  discard(q: Q, t: string, s: string, ids: readonly bigint[]): Promise<number>
  remove(q: Q, t: string, s: string): Promise<void>
  browse(q: Q, t: string, afterId: bigint, limit: number): Promise<EntryRow[]>
}

const run = (q: Q, label: string, f: Fragment<unknown>): Promise<RawRow[]> =>
  q.withOptions({ label: `events.${label}` }).sql`${f}`.execute()
/** For statements that always return one row (aggregates). */
const one = async (q: Q, label: string, f: Fragment<unknown>): Promise<RawRow> =>
  (await run(q, label, f))[0] as RawRow

const ENTRY = sql`id, xid::text as xid, type, key, payload, headers, at`

function entryRow(r: RawRow): EntryRow {
  return {
    id: r['id'] as bigint,
    xid: BigInt(r['xid'] as string),
    type: r['type'] as string | null,
    key: r['key'] as string | null,
    payload: r['payload'],
    headers: r['headers'] as Record<string, string> | null,
    at: r['at'] as Date,
  }
}

const xids = (c: Cursor): string[] => [...c.pending.keys()].map(String)
const afters = (c: Cursor): bigint[] => [...c.pending.values()]

function cursorOf(r: RawRow): Cursor {
  const p = (r['pending'] as string[]).map(BigInt)
  const a = r['pending_after'] as bigint[]
  return {
    xid: BigInt(r['last_xid'] as string),
    id: r['last_id'] as bigint,
    pending: new Map(p.map((x, i) => [x, a[i] as bigint])),
  }
}

export function statements(schema: string): Statements {
  const entries = sql.ident(schema, 'entries')
  const topics = sql.ident(schema, 'topics')
  const subs = sql.ident(schema, 'subscriptions')
  const parked = sql.ident(schema, 'parked')
  const setCursor = (c: Cursor): Fragment<unknown> =>
    sql`last_xid = ${String(c.xid)}::xid8, last_id = ${c.id}::bigint,
      pending = ${xids(c)}::xid8[], pending_after = ${afters(c)}::bigint[]`
  const guard = (t: string, s: string, token: string): Fragment<unknown> =>
    sql`topic = ${t} and name = ${s} and token = ${token}`

  return {
    async publish(q, topic, channel, rows) {
      const json = `[${rows
        .map(
          (r) =>
            `{"type":${JSON.stringify(r.type)},"key":${JSON.stringify(r.key)},` +
            `"headers":${JSON.stringify(r.headers)},"payload":${r.payload}}`,
        )
        .join(',')}]`
      const r = await one(
        q,
        'publish',
        sql`with e as (
          insert into ${entries} (topic, type, key, payload, headers)
          select ${topic}, r.type, r.key, coalesce(r.payload, 'null'::jsonb), r.headers
          from rows from (jsonb_to_recordset(${json}::jsonb)
            as (type text, key text, payload jsonb, headers jsonb)) with ordinality as r(type, key, payload, headers, n)
          order by r.n
          returning id
        )
        select array_agg(id order by id) as ids,
          (select pg_notify(${channel}, '') where exists (select from e)) is not null as woke
        from e`,
      )
      return r['ids'] as bigint[]
    },

    async seedNow(q) {
      const r = await one(
        q,
        'seed',
        sql`select pg_snapshot_xmax(s)::text as xmax, array(select pg_snapshot_xip(s))::text[] as xip
          from pg_current_snapshot() s`,
      )
      return { xmax: BigInt(r['xmax'] as string), xip: (r['xip'] as string[]).map(BigInt) }
    },

    async upsertTopic(q, name, keepMs, untilConsumed) {
      await run(
        q,
        'topic',
        sql`insert into ${topics} (name, keep_ms, keep_until_consumed)
          values (${name}, ${keepMs}::bigint, ${untilConsumed})
          on conflict (name) do update set keep_ms = excluded.keep_ms,
            keep_until_consumed = excluded.keep_until_consumed`,
      )
    },

    async upsertSubscription(q, t, s, types, c) {
      await run(
        q,
        'subscription',
        sql`insert into ${subs} (topic, name, types, last_xid, last_id, pending, pending_after)
          values (${t}, ${s}, ${types}::text[], ${String(c.xid)}::xid8, ${c.id}::bigint,
            ${xids(c)}::xid8[], ${afters(c)}::bigint[])
          on conflict (topic, name) do update set types = excluded.types`,
      )
    },

    async lease(q, t, s, leaseMs) {
      const [r] = await run(
        q,
        'lease',
        sql`update ${subs} set token = gen_random_uuid()::text,
            lease_until = now() + ${leaseMs}::bigint * interval '1 ms'
          where topic = ${t} and name = ${s} and (token is null or lease_until < now())
          returning token, last_xid::text as last_xid, last_id, pending::text[] as pending,
            pending_after, types, head_id, head_size,
            greatest(0, extract(epoch from head_retry_at - now()) * 1000)::float8 as retry_in`,
      )
      if (r === undefined) return undefined
      return {
        token: r['token'] as string,
        cursor: cursorOf(r),
        types: r['types'] as string[] | null,
        headId: r['head_id'] as bigint | null,
        headSize: r['head_size'] as number,
        retryInMs: (r['retry_in'] as number | null) ?? 0,
      }
    },

    async heartbeat(q, t, s, token, leaseMs) {
      const rows = await run(
        q,
        'heartbeat',
        sql`update ${subs} set lease_until = now() + ${leaseMs}::bigint * interval '1 ms'
          where ${guard(t, s, token)} returning 1`,
      )
      return rows.length === 1
    },

    async release(q, t, s, token) {
      await run(
        q,
        'release',
        sql`update ${subs} set token = null, lease_until = null where ${guard(t, s, token)}`,
      )
    },

    async read(q, t, c, n, types) {
      const rows = await run(
        q,
        'read',
        sql`with late as (
          select e.* from unnest(${xids(c)}::xid8[], ${afters(c)}::bigint[]) as p(xid, after)
          cross join lateral (
            select * from ${entries} e
            where e.topic = ${t} and e.xid = p.xid and e.id > p.after
            order by e.id limit ${n}::int
          ) e
          order by e.xid, e.id limit ${n}::int
        ), next as (
          select * from ${entries}
          where topic = ${t} and (xid, id) > (${String(c.xid)}::xid8, ${c.id}::bigint)
          order by xid, id limit ${n}::int - (select count(*) from late)
        ), pos as (
          select xid, id from next order by xid desc, id desc limit 1
        ), cut as (
          select xid, id from late order by xid, id offset ${n}::int - 1
        )
        select (select xid from pos)::text as pos_xid, (select id from pos) as pos_id,
          (select xid from cut)::text as late_xid, (select id from cut) as late_id,
          array(select pg_snapshot_xip(pg_current_snapshot()))::text[] as running,
          x.id, x.xid::text as xid, x.type, x.key, x.payload, x.headers, x.at
        from (select) m
        left join (select * from late union all select * from next) x
          on ${types}::text[] is null or x.type = any(${types}::text[])
        order by x.xid, x.id`,
      )
      const head = rows[0] as RawRow
      const at = (x: string): { xid: bigint; id: bigint } | null =>
        head[`${x}_xid`] === null
          ? null
          : { xid: BigInt(head[`${x}_xid`] as string), id: head[`${x}_id`] as bigint }
      return {
        view: {
          pos: at('pos'),
          late: at('late'),
          running: (head['running'] as string[]).map(BigInt),
        },
        rows: head['id'] === null ? [] : rows.map(entryRow),
      }
    },

    async mark(q, t, s, token, first, size) {
      const [r] = await run(
        q,
        'attempt',
        sql`update ${subs} set head_id = ${first}::bigint, head_size = ${size}::int,
            head_attempts = case when ${size}::int > 1 then 0
              when head_id = ${first}::bigint and head_size = 1 then head_attempts + 1
              else 1 end
          where ${guard(t, s, token)}
          returning head_attempts`,
      )
      return r?.['head_attempts'] as number | undefined
    },

    async commit(q, t, s, token, c) {
      const rows = await run(
        q,
        'commit',
        sql`update ${subs} set ${setCursor(c)}, head_id = null, head_size = 0, head_attempts = 0,
            head_retry_at = null, updated_at = now()
          where ${guard(t, s, token)} returning 1`,
      )
      return rows.length === 1
    },

    async stored(q, t, s, token) {
      const [r] = await run(
        q,
        'stored',
        sql`select last_xid::text as last_xid, last_id, pending::text[] as pending, pending_after
          from ${subs} where ${guard(t, s, token)} for share`,
      )
      return r === undefined ? undefined : cursorOf(r)
    },

    async nack(q, t, s, token, delayMs) {
      const rows = await run(
        q,
        'nack',
        sql`update ${subs} set head_retry_at = now() + ${delayMs}::float8 * interval '1 ms'
          where ${guard(t, s, token)} returning 1`,
      )
      return rows.length === 1
    },

    async park(q, t, s, token, c, entry, attempts, error) {
      const rows = await run(
        q,
        'park',
        sql`with c as (
          update ${subs} set ${setCursor(c)}, head_id = null, head_size = 0, head_attempts = 0,
            head_retry_at = null, updated_at = now()
          where ${guard(t, s, token)}
          returning topic, name
        )
        insert into ${parked} (topic, subscription, entry, attempts, error)
        select topic, name, ${entry}::bigint, ${attempts}::int, ${error}::text from c
        on conflict (topic, subscription, entry) do update set attempts = excluded.attempts,
          error = excluded.error, parked_at = clock_timestamp()
        returning 1`,
      )
      return rows.length === 1
    },

    async maintain(q, t, everyMs) {
      const [gate] = await run(
        q,
        'maintain',
        sql`update ${topics} set maint_at = now()
          where name = ${t} and keep_ms is not null
            and maint_at < now() - ${everyMs}::bigint * interval '1 ms'
          returning keep_ms, keep_until_consumed`,
      )
      if (gate === undefined) return { deleted: 0, behind: false }
      let deleted = 0
      let behind = false
      for (;;) {
        const r = await one(
          q,
          'retention',
          sql`with d as (
            delete from ${entries} where id in (
              select id from ${entries} e
              where e.topic = ${t} and e.at < now() - ${gate['keep_ms']}::bigint * interval '1 ms'
                and not exists (select from ${parked} p where p.topic = ${t} and p.entry = e.id)
                and (not ${gate['keep_until_consumed']}::boolean or not exists (
                  select from ${subs} s where s.topic = ${t}
                    and ((e.xid, e.id) > (s.last_xid, s.last_id) or e.xid = any(s.pending))))
              order by id limit 1000)
            returning xid, id
          )
          select count(*)::int as n, exists (select from d join ${subs} s on s.topic = ${t}
            and ((d.xid, d.id) > (s.last_xid, s.last_id) or d.xid = any(s.pending))) as behind
          from d`,
        )
        deleted += r['n'] as number
        behind ||= r['behind'] === true
        if ((r['n'] as number) < 1000) return { deleted, behind }
      }
    },

    async reset(q, t, s, c) {
      const rows = await run(
        q,
        'reset',
        sql`update ${subs} set ${setCursor(c)}, head_id = null, head_size = 0, head_attempts = 0,
            head_retry_at = null, token = null, lease_until = null, updated_at = now()
          where topic = ${t} and name = ${s} returning 1`,
      )
      return rows.length === 1
    },

    async lag(q, t, s) {
      const r = await one(
        q,
        'lag',
        sql`select count(e.id)::int as n, min(e.at) as oldest
          from ${subs} s join ${entries} e on e.topic = s.topic
            and ((e.xid, e.id) > (s.last_xid, s.last_id)
              or exists (select from unnest(s.pending, s.pending_after) p(xid, after)
                where p.xid = e.xid and e.id > p.after))
            and (s.types is null or e.type = any(s.types))
          where s.topic = ${t} and s.name = ${s}`,
      )
      return {
        entries: r['n'] as number,
        oldestAt: r['oldest'] as Date | null,
      }
    },

    async parked(q, t, s, limit) {
      const rows = await run(
        q,
        'parked',
        sql`select ${ENTRY}, p.attempts, p.error
          from ${parked} p join ${entries} e on e.id = p.entry
          where p.topic = ${t} and p.subscription = ${s}
          order by p.entry limit ${limit}::int`,
      )
      return rows.map((r) => ({
        ...entryRow(r),
        attempts: r['attempts'] as number,
        error: r['error'] as string | null,
      }))
    },

    async discard(q, t, s, ids) {
      const rows = await run(
        q,
        'discard',
        sql`delete from ${parked} where topic = ${t} and subscription = ${s}
          and entry = any(${ids}::bigint[]) returning 1`,
      )
      return rows.length
    },

    async remove(q, t, s) {
      await run(q, 'remove', sql`delete from ${subs} where topic = ${t} and name = ${s}`)
    },

    async browse(q, t, afterId, limit) {
      const rows = await run(
        q,
        'browse',
        sql`select ${ENTRY} from ${entries}
          where topic = ${t} and id > ${afterId}::bigint order by id limit ${limit}::int`,
      )
      return rows.map(entryRow)
    },
  }
}
