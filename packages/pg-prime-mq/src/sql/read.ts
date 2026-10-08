import { sql } from 'pg-prime'
import type { RawRow } from 'pg-prime'
import type { RetryPolicy } from '../define.js'
import type { OnFail } from './send.js'
import { cols, run } from './tables.js'
import type { Q, Tables } from './tables.js'

export type MessageState =
  | 'ready'
  | 'delayed'
  | 'active'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'

export const STATES: readonly MessageState[] = [
  'ready',
  'delayed',
  'active',
  'completed',
  'failed',
  'cancelled',
  'blocked',
]

export interface MsgRow {
  readonly id: bigint
  readonly queue: string
  readonly state: MessageState
  readonly payload: unknown
  readonly key: string | null
  readonly priority: number
  readonly orderKey: bigint
  readonly runAt: Date | null
  readonly group: string | null
  readonly attempts: number
  readonly claims: number
  readonly retry: RetryPolicy
  readonly token: string | null
  readonly progress: unknown
  readonly result: unknown
  readonly error: string | null
  readonly parent: bigint | null
  readonly onFail: OnFail
  readonly pendingDeps: number
  readonly cancel: boolean
  readonly childFailed: boolean
  readonly createdAt: Date
  readonly startedAt: Date | null
  readonly finishedAt: Date | null
}

export function msgRow(r: RawRow): MsgRow {
  return {
    id: r['id'] as bigint,
    queue: r['queue'] as string,
    state: r['state'] as MessageState,
    payload: r['payload'],
    key: r['key'] as string | null,
    priority: r['priority'] as number,
    orderKey: r['order_key'] as bigint,
    runAt: r['run_at'] as Date | null,
    group: r['group_key'] as string | null,
    attempts: r['attempts'] as number,
    claims: r['claims'] as number,
    retry: r['retry'] as RetryPolicy,
    token: r['token'] as string | null,
    progress: r['progress'] ?? null,
    result: r['result'] ?? null,
    error: r['error'] as string | null,
    parent: r['parent'] as bigint | null,
    onFail: r['on_fail'] as OnFail,
    pendingDeps: r['pending_deps'] as number,
    cancel: r['cancel'] as boolean,
    childFailed: r['child_failed'] as boolean,
    createdAt: r['created_at'] as Date,
    startedAt: r['started_at'] as Date | null,
    finishedAt: r['finished_at'] as Date | null,
  }
}

export type Ref = { readonly id: bigint } | { readonly key: string }

export async function get(q: Q, t: Tables, queue: string, ref: Ref): Promise<MsgRow | undefined> {
  const where = 'id' in ref ? sql`id = ${ref.id}::bigint` : sql`key = ${ref.key}`
  const [r] = await run(
    q,
    'get',
    sql`select ${cols('m')} from ${t.messages} m where queue = ${queue} and ${where}
      order by id desc limit 1`,
  )
  return r === undefined ? undefined : msgRow(r)
}

/** A message's row by id alone (any queue). */
export async function byId(q: Q, t: Tables, id: bigint): Promise<MsgRow | undefined> {
  const [r] = await run(
    q,
    'get',
    sql`select ${cols('m')} from ${t.messages} m where id = ${id}::bigint`,
  )
  return r === undefined ? undefined : msgRow(r)
}

export async function list(
  q: Q,
  t: Tables,
  queue: string,
  states: readonly MessageState[] | null,
  after: bigint,
  limit: number,
): Promise<MsgRow[]> {
  const rows = await run(
    q,
    'list',
    sql`select ${cols('m')} from ${t.messages} m
      where queue = ${queue} and id > ${after}::bigint
        and (${states}::text[] is null or state::text = any(${states}::text[]))
      order by id limit ${limit}::int`,
  )
  return rows.map(msgRow)
}

export async function counts(
  q: Q,
  t: Tables,
  queue: string,
): Promise<Record<MessageState, number>> {
  const rows = await run(
    q,
    'counts',
    sql`select state::text as state, count(*)::int as n from ${t.messages}
      where queue = ${queue} group by state`,
  )
  const out = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<MessageState, number>
  for (const r of rows) out[r['state'] as MessageState] = r['n'] as number
  return out
}

export interface DepRow {
  readonly child: bigint
  readonly queue: string
  readonly status: 'pending' | 'completed' | 'failed' | 'ignored'
  readonly value: unknown
}

export async function deps(q: Q, t: Tables, parent: bigint): Promise<DepRow[]> {
  const rows = await run(
    q,
    'child-results',
    sql`select child, child_queue, status::text as status, value from ${t.deps}
      where parent = ${parent}::bigint order by child`,
  )
  return rows.map((r) => ({
    child: r['child'] as bigint,
    queue: r['child_queue'] as string,
    status: r['status'] as DepRow['status'],
    value: r['value'] ?? undefined,
  }))
}

/** An unlocked look at who holds a message: `undefined` when the row is gone. */
export async function holder(
  q: Q,
  t: Tables,
  id: bigint,
): Promise<
  | { state: MessageState; token: string | null; childFailed: boolean; pendingDeps: number }
  | undefined
> {
  const [r] = await run(
    q,
    'holder',
    sql`select state, token, child_failed, pending_deps from ${t.messages} where id = ${id}::bigint`,
  )
  return r === undefined
    ? undefined
    : {
        state: r['state'] as MessageState,
        token: r['token'] as string | null,
        childFailed: r['child_failed'] as boolean,
        pendingDeps: r['pending_deps'] as number,
      }
}
