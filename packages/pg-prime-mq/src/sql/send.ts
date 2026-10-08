import { sql } from 'pg-prime'
import type { RetryPolicy } from '../define.js'
import { run, wakeCte, watchCte, withCtes } from './tables.js'
import type { Cte, F, Q, Tables } from './tables.js'

export type OnFail = 'wait' | 'fail' | 'ignore'

export interface NewRow {
  /** 1-based position in the batch. */
  readonly n: number
  readonly queue: string
  /** Flows: the parent's `n`. */
  readonly parentN: number | null
  /** Flows: the number of children (an inner node starts `blocked`). */
  readonly kids: number
  readonly onFail: OnFail
  /** Serialized JSON. */
  readonly payload: string
  readonly key: string | null
  readonly priority: number
  readonly lifo: boolean
  readonly delayMs: number | null
  readonly runAt: Date | null
  readonly group: string | null
  readonly retry: RetryPolicy
  readonly dedup: string | null
  readonly dedupMs: number | null
}

export interface InsertOptions {
  /** One dedup mode per statement: a duplicate extends the window (debounce). */
  readonly extend: boolean
  /** All or nothing: a deduplicated root skips its whole flow. */
  readonly flow: boolean
  /** `ctx.spawn`: the active parent, token-guarded; its `pending_deps` grows by the batch. */
  readonly parent?: { readonly id: bigint; readonly token: string }
}

export interface Inserted {
  readonly n: number
  /** Null: deduplicated (or the spawn's lease was lost). */
  readonly id: bigint | null
  /** The surviving message when the dedup row came back (the debounce path). */
  readonly existing: bigint | null
}

const json = (rows: readonly NewRow[]): string =>
  `[${rows
    .map(
      (r) =>
        `{"n":${r.n},"queue":${JSON.stringify(r.queue)},"parent_n":${r.parentN},"kids":${r.kids},` +
        `"on_fail":"${r.onFail}","payload":${r.payload},"key":${JSON.stringify(r.key)},` +
        `"priority":${r.priority},"lifo":${r.lifo},"delay_ms":${r.delayMs},` +
        `"run_at":${JSON.stringify(r.runAt?.toISOString() ?? null)},"group_key":${JSON.stringify(r.group)},` +
        `"retry":${JSON.stringify(r.retry)},"dedup":${JSON.stringify(r.dedup)},"dedup_ms":${r.dedupMs}}`,
    )
    .join(',')}]`

/**
 * S1/F1/spawn: the only way a message is inserted. Dedup is decided only from the locked dedup
 * row; groups get a row when new (an existing one is never locked); deps rows come with their
 * waiter (D11).
 */
export function insertSql(t: Tables, rows: readonly NewRow[], o: InsertOptions): F {
  const dedup = rows.some((r) => r.dedup !== null)
  const survives = sql`exists (select from d where d.key = s.dedup and d.msg = s.id)`
  const ctes: (Cte | false)[] = [
    [
      'src',
      sql`select ${t.next} as id, r.* from rows from (jsonb_to_recordset(${json(rows)}::jsonb) as (
          n int, queue text, parent_n int, kids int, on_fail text, payload jsonb, key text,
          priority int, lifo boolean, delay_ms float8, run_at timestamptz, group_key text,
          retry jsonb, dedup text, dedup_ms float8)) r
        order by r.n`,
    ],
    o.parent !== undefined && [
      'par',
      sql`update ${t.messages} set pending_deps = pending_deps + ${rows.length}::int
        where id = ${o.parent.id}::bigint and token = ${o.parent.token} and state = 'active'
        returning id`,
    ],
    dedup && [
      'd',
      sql`insert into ${t.dedup} as x (queue, key, msg, expire_at)
        select queue, dedup, id, now() + dedup_ms * interval '1 ms' from src where dedup is not null
        on conflict (queue, key) do update
          set msg = case when x.expire_at <= now() then excluded.msg else x.msg end,
              expire_at = excluded.expire_at
          where x.expire_at <= now() or (excluded.expire_at is not null and ${o.extend}::boolean)
        returning key, msg`,
    ],
    [
      'ins',
      sql`insert into ${t.messages} (id, queue, state, payload, key, priority, order_key, run_at,
          group_key, retry, dedup_key, parent, on_fail, pending_deps)
        select s.id, s.queue, (case when s.kids > 0 then 'blocked' when s.at > now() then 'delayed'
            else 'ready' end)::${t.msgState},
          s.payload, s.key, s.priority, case when s.lifo then -s.id else s.id end,
          case when s.kids = 0 and s.at > now() then s.at end,
          s.group_key, s.retry, s.dedup, ${o.parent === undefined ? sql`p.id` : sql`${o.parent.id}::bigint`},
          s.on_fail::${t.onFail}, s.kids
        from (select src.*, coalesce(run_at, now() + delay_ms * interval '1 ms') as at from src) s
        left join src p on p.n = s.parent_n
        where true
          ${dedup ? sql`and (s.dedup is null or ${survives})` : sql``}
          ${o.flow && dedup ? sql`and not exists (select from src s where s.dedup is not null and not ${survives})` : sql``}
          ${o.parent === undefined ? sql`` : sql`and exists (select from par)`}
        returning id, queue, state, group_key, parent`,
    ],
    [
      'dps',
      sql`insert into ${t.deps} (parent, child, child_queue)
        select parent, id, queue from ins where parent is not null`,
    ],
    [
      'grp',
      sql`insert into ${t.groups} (queue, key)
        select distinct queue, group_key from ins where group_key is not null
        on conflict do nothing`,
    ],
    wakeCte(t, 'ins', sql`state <> 'blocked'`),
    watchCte(t, 'ins'),
  ]
  return withCtes(
    ctes,
    (
      refs,
    ) => sql`select src.n, ins.id, ${dedup ? sql`d.msg` : sql`null::bigint`} as existing, ${refs} as fx
      from src left join ins on ins.id = src.id
      ${dedup ? sql`left join d on d.key = src.dedup and d.msg <> src.id` : sql``}
      order by src.n`,
  )
}

export async function insert(
  q: Q,
  t: Tables,
  rows: readonly NewRow[],
  o: InsertOptions,
): Promise<Inserted[]> {
  const r = await run(q, o.parent ? 'spawn' : o.flow ? 'flow' : 'send', insertSql(t, rows, o))
  return r.map((x) => ({
    n: x['n'] as number,
    id: x['id'] as bigint | null,
    existing: x['existing'] as bigint | null,
  }))
}

/** The message currently holding each dedup key; a fresh snapshot sees the winner of a race. */
export async function dedupOwners(
  q: Q,
  t: Tables,
  queue: string,
  keys: readonly string[],
): Promise<Map<string, bigint>> {
  const r = await run(
    q,
    'dedup',
    sql`select key, msg from ${t.dedup} where queue = ${queue} and key = any(${keys}::text[])`,
  )
  return new Map(r.map((x) => [x['key'] as string, x['msg'] as bigint]))
}
