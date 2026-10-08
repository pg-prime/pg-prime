import { sql } from 'pg-prime'
import type { RawQuery, RawRow } from 'pg-prime'
import type { Cols } from '../define.js'
import type { RunInfo, RunState, ScheduleInfo } from '../types.js'
import { json, type Q, type Tables } from './tables.js'

export interface Upsert {
  readonly name: string
  readonly cols: Cols
  readonly hash: string
  readonly source: 'code' | 'api'
  readonly next: Date | null
  readonly anchor: Date
}

const TIMING = sql.unsafeRaw(
  '(x.pattern, x.every_ms, x.at, x.tz, x.start_at, x.end_at, x.max_runs) is distinct from ' +
    '(excluded.pattern, excluded.every_ms, excluded.at, excluded.tz, excluded.start_at, excluded.end_at, excluded.max_runs)',
)

/**
 * Inserts a schedule, or, with `replace`, updates its definition when `spec_hash` changed:
 * `paused` and `enabled` are kept, and `next_at`/`anchor_at` move only when the timing did.
 */
export const upsert = (q: Q, t: Tables, u: Upsert, replace: boolean): RawQuery => {
  const c = u.cols
  return q.sql`
    insert into ${t.s} as x (name, pattern, every_ms, at, tz, start_at, end_at, max_runs, overlap,
      misfire, misfire_grace_ms, target, queue, payload, timeout_ms, retry, keep_runs, keep_runs_ms,
      source, spec_hash, next_at, anchor_at)
    values (${u.name}::text, ${c.pattern}::text, ${c.every_ms}::bigint, ${c.at}::timestamptz,
      ${c.tz}::text, ${c.start_at}::timestamptz, ${c.end_at}::timestamptz, ${c.max_runs}::int,
      ${c.overlap}::text, ${c.misfire}::text, ${c.misfire_grace_ms}::int, ${c.target}::text,
      ${c.queue}::text, ${json(c.payload)}::jsonb, ${c.timeout_ms}::int, ${json(c.retry)}::jsonb,
      ${c.keep_runs}::int, ${c.keep_runs_ms}::bigint, ${u.source}::text, ${u.hash}::text,
      ${u.next}::timestamptz, ${u.anchor}::timestamptz)
    on conflict (name) do ${
      replace
        ? sql`update set
      pattern = excluded.pattern, every_ms = excluded.every_ms, at = excluded.at, tz = excluded.tz,
      start_at = excluded.start_at, end_at = excluded.end_at, max_runs = excluded.max_runs,
      overlap = excluded.overlap, misfire = excluded.misfire,
      misfire_grace_ms = excluded.misfire_grace_ms, target = excluded.target, queue = excluded.queue,
      payload = excluded.payload, timeout_ms = excluded.timeout_ms, retry = excluded.retry,
      keep_runs = excluded.keep_runs, keep_runs_ms = excluded.keep_runs_ms,
      source = excluded.source, spec_hash = excluded.spec_hash, updated_at = now(),
      anchor_at = case when ${TIMING} then excluded.anchor_at else x.anchor_at end,
      next_at = case when not x.enabled then null
                     when not ${TIMING} then x.next_at
                     when x.runs >= excluded.max_runs then null
                     else excluded.next_at end
    where x.spec_hash <> excluded.spec_hash`
        : sql`nothing`
    }
    returning name`
}

const COLS = sql.unsafeRaw(
  'name, pattern, every_ms::float8 as every_ms, at, tz, start_at, end_at, max_runs, runs, ' +
    'overlap, misfire, misfire_grace_ms, target, queue, payload, timeout_ms, retry, ' +
    'keep_runs, keep_runs_ms::float8 as keep_runs_ms, enabled, paused, next_at, running, source, ' +
    'anchor_at, updated_at',
)

export const select = (q: Q, t: Tables, name?: string): RawQuery =>
  name === undefined
    ? q.sql`select ${COLS} from ${t.s} order by name`
    : q.sql`select ${COLS} from ${t.s} where name = ${name}`

export const lock = (q: Q, t: Tables, name: string): RawQuery =>
  q.sql`select ${COLS}, now() as db_now from ${t.s} where name = ${name} for update`

export const setFlags = (
  q: Q,
  t: Tables,
  name: string,
  f: { paused?: boolean; enabled?: boolean; next?: Date | null },
): RawQuery => q.sql`
  update ${t.s} set updated_at = now()
    ${f.paused === undefined ? sql`` : sql`, paused = ${f.paused}::boolean`}
    ${f.enabled === undefined ? sql`` : sql`, enabled = ${f.enabled}::boolean`}
    ${f.next === undefined ? sql`` : sql`, next_at = ${f.next}::timestamptz`}
  where name = ${name}
  returning name`

export const remove = (q: Q, t: Tables, name: string, force: boolean): RawQuery => q.sql`
  with d as (
    delete from ${t.s} where name = ${name}
      and (${force}::boolean or not exists (select 1 from ${t.r}
           where schedule = ${name} and state in ('pending', 'running', 'cancelling')))
    returning 1
  )
  select (select count(*)::int from d) as deleted,
         (select count(*)::int from ${t.s} where name = ${name}) as present`

export const prune = (q: Q, t: Tables, keep: readonly string[]): RawQuery => q.sql`
  delete from ${t.s} where source = 'code' and name <> all(${keep}::text[]) returning name`

export const history = (
  q: Q,
  t: Tables,
  name: string,
  limit: number,
  before: bigint | null,
): RawQuery => q.sql`
  select id, schedule, tick_at, manual, state::text as state, attempts, missed, instance, message_id,
         payload, started_at, finished_at, error, result, created_at
  from ${t.r}
  where schedule = ${name} and (${before}::bigint is null or id < ${before}::bigint)
  order by id desc limit ${limit}::int`

export const dbNow = (q: Q): RawQuery => q.sql`select now() as now`

export function toInfo(r: RawRow): ScheduleInfo {
  const n = (k: string) => (r[k] === null ? null : Number(r[k]))
  return {
    name: r['name'] as string,
    when:
      r['pattern'] !== null
        ? { cron: r['pattern'] as string, tz: r['tz'] as string }
        : r['every_ms'] !== null
          ? { everyMs: Number(r['every_ms']) }
          : { at: r['at'] as Date },
    target: r['target'] as 'handler' | 'queue',
    queue: r['queue'] as string | null,
    startAt: r['start_at'] as Date | null,
    endAt: r['end_at'] as Date | null,
    limit: n('max_runs'),
    overlap: r['overlap'] as 'skip' | 'allow',
    misfire: r['misfire'] as 'skip' | 'once',
    misfireGraceMs: Number(r['misfire_grace_ms']),
    payload: r['payload'],
    timeoutMs: n('timeout_ms'),
    enabled: r['enabled'] as boolean,
    paused: r['paused'] as boolean,
    nextAt: r['next_at'] as Date | null,
    runs: Number(r['runs']),
    running: Number(r['running']),
    source: r['source'] as 'code' | 'api',
    updatedAt: r['updated_at'] as Date,
  }
}

export function toRun(r: RawRow): RunInfo {
  return {
    id: r['id'] as bigint,
    schedule: r['schedule'] as string,
    tickAt: r['tick_at'] as Date | null,
    manual: r['manual'] as boolean,
    state: r['state'] as RunState,
    attempts: Number(r['attempts']),
    missed: Number(r['missed']),
    instance: r['instance'] as string | null,
    messageId: r['message_id'] as bigint | null,
    payload: r['payload'],
    startedAt: r['started_at'] as Date | null,
    finishedAt: r['finished_at'] as Date | null,
    error: r['error'] as string | null,
    result: r['result'],
    createdAt: r['created_at'] as Date,
  }
}
