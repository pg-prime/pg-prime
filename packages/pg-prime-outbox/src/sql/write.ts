import { randomUUID } from 'node:crypto'
import type { Queryable } from 'pg-prime'
import type { TopicCtx } from '../context.js'
import type { OutboxDef } from '../define.js'
import { NotStartedError, PayloadError } from '../errors.js'
import type { WriteOptions, WriteResult } from '../types.js'

export type WriteItem<T> = { payload: T } & Omit<WriteOptions, 'tx'>

export async function writeRecords<T>(
  ctx: TopicCtx<T>,
  items: readonly WriteItem<T>[],
  tx: Queryable<any>,
): Promise<WriteResult[]> {
  const { s, def, chan } = ctx
  const t = def.topic
  const rows = await Promise.all(
    items.map(async (i) => ({
      key: i.key,
      idem: i.idempotencyKey ?? randomUUID(),
      payload: await encode(def, i.payload),
      headers: i.headers,
    })),
  )
  if (rows.length === 0) return []
  let inserted: Record<string, unknown>[]
  try {
    // Key locks are taken in key order (batches cannot deadlock) and before the insert, so a
    // key's ids are assigned in commit order.
    inserted = await tx.withOptions({ label: 'outbox.write' }).sql`
      with src as (
        select r.* from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
          as r(key text, idem text, payload jsonb, headers jsonb)
      ), lk as (
        select pg_advisory_xact_lock(hashtextextended(${t}::text || '/' || key, 0))
        from (select distinct key from src where key is not null and ${def.ordered}::boolean order by key) k
      ), ins as (
        insert into ${s}.records (topic, key, partition, idem, payload, headers)
        select ${t}, key,
               case when key is null then floor(random() * p.n)::smallint
                    else abs(hashtextextended(key, 0) % p.n)::smallint end,
               idem, payload, headers
        from src, (select count(*) from lk) as locked,
             (select (select partitions from ${s}.topics where name = ${t}) as n) as p
        on conflict (topic, idem) do nothing
        returning id, idem
      )
      select ins.id, ins.idem,
             (select pg_notify(${chan}, '') where exists (select from ins)) is null as woke
      from ins`.execute()
  } catch (e) {
    // A topic without a `topics` row leaves `partition` null.
    if ((e as { code?: unknown }).code === '23502') {
      throw new NotStartedError(
        `@pg-prime/outbox: topic ${t} has no row in the outbox schema. Run ` +
          `await outbox.start() (or outbox.topic(def).start()) at boot.`,
        { cause: e },
      )
    }
    throw e
  }
  const ids = idMap(inserted)
  const fresh = new Set(ids.keys())
  const missing = rows.filter((r) => !ids.has(r.idem)).map((r) => r.idem)
  if (missing.length > 0) {
    const dups = await tx.withOptions({ label: 'outbox.write-duplicates' }).sql`
      select id, idem from ${s}.records where topic = ${t} and idem = any(${missing}::text[])`.execute()
    for (const [idem, id] of idMap(dups)) ids.set(idem, id)
  }
  const results = rows.map(({ idem }) => ({
    id: ids.get(idem) ?? 0n,
    idem,
    // The second of two inputs sharing an idem is a duplicate too.
    duplicate: !fresh.delete(idem),
  }))
  ctx.hooks.call('onWrite', {
    topic: t,
    count: rows.length,
    duplicates: results.filter((r) => r.duplicate).length,
  })
  return results
}

const idMap = (rows: readonly Record<string, unknown>[]): Map<string, bigint> =>
  new Map(rows.map((r) => [r['idem'] as string, r['id'] as bigint]))

async function encode<T>(def: OutboxDef<T>, payload: T): Promise<unknown> {
  let v: unknown = payload
  if (def.schema !== undefined) {
    const r = await def.schema['~standard'].validate(payload)
    if (r.issues !== undefined) {
      throw new PayloadError(
        `@pg-prime/outbox: topic ${def.topic}: payload rejected: ` +
          r.issues.map((i) => i.message).join('; '),
        r.issues,
      )
    }
    v = r.value
  }
  return def.codec === undefined ? v : def.codec.encode(v as T)
}
