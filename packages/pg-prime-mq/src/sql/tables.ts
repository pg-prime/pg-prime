import { engineChannelSql } from '@pg-prime/events'
import { quoteIdentPart, sql } from 'pg-prime'
import type { Fragment, Queryable, RawRow } from 'pg-prime'

export type Q = Queryable<any>
export type F = Fragment<unknown>

export interface Tables {
  readonly schema: string
  readonly messages: F
  readonly queues: F
  readonly groups: F
  readonly deps: F
  readonly dedup: F
  readonly msgState: F
  readonly depStatus: F
  readonly onFail: F
  /** `nextval(…)` of the id/order sequence. */
  readonly next: F
  /** False: no engine wake-up NOTIFYs (workers poll). */
  readonly notify: boolean
}

export function tables(schema: string, notify = true): Tables {
  const i = (n: string): F => sql.ident(schema, n)
  return {
    schema,
    messages: i('messages'),
    queues: i('queues'),
    groups: i('groups'),
    deps: i('deps'),
    dedup: i('dedup'),
    msgState: i('msg_state'),
    depStatus: i('dep_status'),
    onFail: i('on_fail'),
    next: sql`nextval(${`${quoteIdentPart(schema)}.msg_seq`}::regclass)`,
    notify,
  }
}

export const raw = (s: string): F => sql.unsafeRaw(s)

export const run = (q: Q, label: string, f: F): Promise<RawRow[]> =>
  q.withOptions({ label: `mq.${label}` }).sql`${f}`.execute()

/** For statements that always return one row. */
export const one = async (q: Q, label: string, f: F): Promise<RawRow> =>
  (await run(q, label, f))[0] as RawRow

export const ms = (n: number | null | undefined): F => sql`${n ?? null}::float8 * interval '1 ms'`

/**
 * A CTE: name, body, and whether it is a plain SELECT. A SELECT CTE nobody references never runs,
 * so `withCtes` references every one of them from the final select.
 */
export type Cte = readonly [name: string, body: F, select?: true]

export function withCtes(
  ctes: readonly (Cte | false | undefined)[],
  tail: (refs: F) => F,
  recursive = false,
): F {
  const list = ctes.filter((c): c is Cte => c !== false && c !== undefined)
  const refs = list.filter((c) => c[2]).map((c) => sql`(select count(*) from ${raw(c[0])})`)
  return sql`with ${raw(recursive ? 'recursive ' : '')}${sql.join(
    list.map(([n, f]) => sql`${raw(n)} as (${f})`),
    raw(',\n'),
  )}
  ${tail(refs.length === 0 ? sql`0` : sql.join(refs, raw(' + ')))}`
}

const COLS = [
  'id',
  'queue',
  'state',
  'payload',
  'key',
  'priority',
  'order_key',
  'run_at',
  'group_key',
  'attempts',
  'claims',
  'retry',
  'token',
  'progress',
  'result',
  'error',
  'parent',
  'on_fail',
  'pending_deps',
  'cancel',
  'child_failed',
  'created_at',
  'started_at',
  'finished_at',
]
/** The columns a message row is read with, qualified by `a`. */
export const cols = (a: string): F => raw(COLS.map((c) => `${a}.${c}`).join(', '))

/**
 * `[watch]`: `{ id, s }` on the watch channel for every row of `cte` whose queue is declared with
 * `watch: true`. Read from `queues`, so every process emits it, whatever it declared itself.
 */
export const watchCte = (t: Tables, cte: string, where: F = sql`true`): Cte => [
  `${cte}_ev`,
  sql`select pg_notify(${engineChannelSql(t.schema, 'q-watch', raw(`${cte}.queue`))},
      json_build_object('id', ${raw(cte)}.id::text, 's', ${raw(cte)}.state)::text)
    from ${raw(cte)} join ${t.queues} wq on wq.name = ${raw(cte)}.queue where wq.watch and ${where}`,
  true,
]

/** One wake NOTIFY per distinct queue of the `cte` rows matching `where`; none with `notify: false`. */
export const wakeCte = (t: Tables, cte: string, where: F = sql`true`): Cte | false =>
  t.notify && [
    `${cte}_wk`,
    sql`select pg_notify(${engineChannelSql(t.schema, 'q', raw('w.queue'))}, 'w')
      from (select distinct queue from ${raw(cte)} where ${where}) w`,
    true,
  ]
