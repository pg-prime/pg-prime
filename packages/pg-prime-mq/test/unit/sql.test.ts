import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compileOnly, defineSchema } from 'pg-prime'
import type { Fragment, Queryable, RawRow } from 'pg-prime'
import { defineQueue } from '../../src/index.js'
import * as admin from '../../src/sql/admin.js'
import { claimGroupsSql, claimSql, promoteSql } from '../../src/sql/claim.js'
import { expireSql, expiryGate, heartbeat } from '../../src/sql/lease.js'
import * as maintain from '../../src/sql/maintain.js'
import * as read from '../../src/sql/read.js'
import { dedupOwners, insertSql } from '../../src/sql/send.js'
import type { NewRow } from '../../src/sql/send.js'
import { extend, finishSql, lockAncestors, moveSql, progress } from '../../src/sql/settle.js'
import type { FinishArgs, Guard, Move } from '../../src/sql/settle.js'
import { tables } from '../../src/sql/tables.js'
import { backoffMs } from '../../src/util.js'

const base = compileOnly(defineSchema({}))
const render = (f: Fragment<unknown>) => base.sql`${f}`.toSQL()
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
const t = tables('pgprime_mq')
const quiet = tables('pgprime_mq', false)

/** A `Queryable` that compiles each statement, records it, and answers with empty rows. */
function recorder(answer: RawRow[] = []) {
  const seen: { label: string; sql: string }[] = []
  const q = {
    withOptions: ({ label }: { label: string }) => ({
      sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
        execute: async () => {
          seen.push({ label, sql: flat(base.sql(strings, ...values).toSQL().sql) })
          return answer
        },
      }),
    }),
  } as unknown as Queryable<any>
  return { q, seen }
}

const row = (o: Partial<NewRow> = {}): NewRow => ({
  n: 1,
  queue: 'jobs',
  parentN: null,
  kids: 0,
  onFail: 'wait',
  payload: '{"a":1}',
  key: null,
  priority: 0,
  lifo: false,
  delayMs: null,
  runAt: null,
  group: null,
  retry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 60_000, jitter: 'full' },
  dedup: null,
  dedupMs: null,
  ...o,
})

/** Every builder and fragment combination, labelled. */
function matrix(): [string, Fragment<unknown>][] {
  const out: [string, Fragment<unknown>][] = []
  const guards: Guard[] = [
    { kind: 'token', token: 'tok' },
    { kind: 'expired' },
    { kind: 'blocked' },
    { kind: 'idle' },
  ]
  for (const to of ['completed', 'failed', 'cancelled'] as const) {
    for (const guard of guards) {
      const a: FinishArgs = { id: 7n, to, guard, result: '1', error: 'e' }
      out.push([`finish ${to} ${guard.kind}`, finishSql(t, a)])
    }
  }
  out.push([
    'finish completed token delete',
    finishSql(t, { id: 7n, to: 'completed', guard: guards[0] as Guard, del: true }),
  ])
  out.push([
    'finish completed token no-notify',
    finishSql(quiet, { id: 7n, to: 'completed', guard: guards[0] as Guard }),
  ])
  const moves: Move[] = [
    { kind: 'retry', delayMs: 10, error: 'e', stack: null },
    { kind: 'defer', delayMs: 10 },
    { kind: 'defer', until: new Date(0) },
    { kind: 'release' },
    { kind: 'release', limitMs: 100 },
    { kind: 'wait' },
  ]
  for (const mv of moves)
    out.push([`move ${mv.kind} ${JSON.stringify(mv)}`, moveSql(t, 7n, 'tok', mv)])
  const claim = { queue: 'jobs', n: 4, leaseMs: 1000, token: null, consumer: 'c' }
  for (const limited of [false, true]) {
    out.push([`claim limited=${limited}`, claimSql(t, { ...claim, limited })])
    out.push([
      `claim-groups limited=${limited}`,
      claimGroupsSql(
        t,
        { ...claim, limited },
        { after: '', scan: 16, concurrency: 1, rate: { max: 2, perMs: 100 } },
      ),
    ])
  }
  out.push([
    'send',
    insertSql(t, [row(), row({ n: 2, group: 'g', delayMs: 5 })], { extend: false, flow: false }),
  ])
  out.push([
    'send dedup',
    insertSql(t, [row({ key: 'k', dedup: 'k' })], { extend: false, flow: false }),
  ])
  out.push([
    'send debounce',
    insertSql(t, [row({ key: 'k', dedup: 'k', dedupMs: 100 })], { extend: true, flow: false }),
  ])
  out.push(['send no-notify', insertSql(quiet, [row()], { extend: false, flow: false })])
  out.push([
    'flow dedup root',
    insertSql(
      t,
      [row({ key: 'k', dedup: 'k', kids: 1 }), row({ n: 2, parentN: 1, onFail: 'fail' })],
      { extend: false, flow: true },
    ),
  ])
  out.push([
    'spawn',
    insertSql(t, [row()], { extend: false, flow: false, parent: { id: 3n, token: 'tok' } }),
  ])
  out.push(['promote due', promoteSql(t, 'jobs')])
  out.push(['promote one', promoteSql(t, 'jobs', 7n)])
  out.push(['expire', expireSql(t, 'jobs')])
  out.push(['retry ids', admin.retrySql(t, 'jobs', { ids: [1n, 2n] })])
  out.push(['retry state', admin.retrySql(t, 'jobs', { state: 'failed', limit: 10 })])
  return out
}

async function recorded(): Promise<{ label: string; sql: string }[]> {
  const { q, seen } = recorder()
  const def = defineQueue('jobs', { rate: { max: 1, perMs: 1000 }, concurrency: 2, watch: true })
  await heartbeat(q, t, [{ id: 1n, token: 'a' }], 1000)
  await expiryGate(q, t, 'jobs', 1000)
  await lockAncestors(q, t, 1n)
  await progress(q, t, 1n, 'tok', '{}')
  await extend(q, t, 1n, 'tok', 1000)
  await dedupOwners(q, t, 'jobs', ['k'])
  await admin.upsertQueue(q, t, def)
  await admin.setPaused(q, t, 'jobs', true)
  await admin.flagCancel(q, t, 'jobs', 1n, 'why')
  await admin.withUnresolvedChildren(q, t, 'jobs', [1n])
  await admin.lockTree(q, t, 'jobs', 1n)
  await admin.deleteMessages(q, t, [1n]).catch(() => {})
  await admin.resolveRemoved(q, t, 1n, 2n)
  await admin.purgeBatch(q, t, 'jobs', ['failed'], 1000).catch(() => {})
  await admin.activeCount(q, t, 'jobs').catch(() => {})
  await admin.dropRows(q, t, 'jobs')
  await admin.setGroup(q, t, 'jobs', 'g', { concurrency: 1 })
  await maintain.maintenanceGate(q, t, 'jobs', 1000)
  await maintain.expireBatch(q, t).catch(() => {})
  await maintain.trimBatch(q, t, 'jobs', 'completed', 10).catch(() => {})
  await maintain.dedupBatch(q, t).catch(() => {})
  await maintain.reconcileGroups(recorder([{ key: 'g' }]).q, t, 'jobs')
  const r = recorder([{ key: 'g' }])
  await maintain.reconcileGroups(r.q, t, 'jobs')
  await maintain.reconcileQueue(q, t, 'jobs')
  await read.get(q, t, 'jobs', { key: 'k' })
  await read.byId(q, t, 1n)
  await read.list(q, t, 'jobs', ['ready'], 0n, 10)
  await read.counts(q, t, 'jobs')
  await read.deps(q, t, 1n)
  await read.holder(q, t, 1n)
  return [...seen, ...r.seen]
}

/** The tables each data-modifying CTE (or the main statement) writes. */
function writers(sql: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const add = (table: string, who: string) => out.set(table, [...(out.get(table) ?? []), who])
  const dml = '(?:update|insert into|delete from) "pgprime_mq"\\."(\\w+)"'
  for (const m of sql.matchAll(new RegExp(`(\\w+) as \\(${dml}`, 'g')))
    add(m[2] as string, m[1] as string)
  const main = new RegExp(`(?:^|\\) )${dml}`).exec(sql)
  if (main !== null) add(main[1] as string, 'main')
  return out
}

// Pairs that write different rows of one table by construction.
const DISJOINT = new Set([
  'messages:done,pr', // a settled child and its parent (a message is never its own parent)
  'messages:par,ins', // a spawning parent and the rows being inserted
])

describe('statements', () => {
  it('match the golden SQL, labelled mq.<op>', async () => {
    const text = matrix().map(([label, f]) => `-- ${label}\n${flat(render(f).sql)}`)
    expect(text.join('\n\n')).toMatchSnapshot()
    expect(
      (await recorded()).map((x) => `-- mq.${x.label}\n${x.sql}`).join('\n\n'),
    ).toMatchSnapshot()
  })

  it('never modify one row twice: two writers of a table must be a known-disjoint pair', async () => {
    const all = [
      ...matrix().map(([label, f]) => ({ label, sql: flat(render(f).sql) })),
      ...(await recorded()),
    ]
    for (const { label, sql } of all) {
      for (const [table, ctes] of writers(sql)) {
        if (ctes.length > 1)
          expect(DISJOINT.has(`${table}:${ctes.join(',')}`), `${label}: ${table} by ${ctes}`).toBe(
            true,
          )
      }
    }
  })

  it('finds every writer (a positive control for the check above)', () => {
    const [, f] = matrix().find(([l]) => l === 'finish completed token') as [
      string,
      Fragment<unknown>,
    ]
    expect(Object.fromEntries(writers(flat(render(f).sql)))).toStrictEqual({
      messages: ['done', 'pr'],
      dedup: ['dd'],
      deps: ['dp'],
      groups: ['gd'],
      queues: ['qd'],
    })
  })

  it('reference every SELECT CTE (each pg_notify) from the final select', () => {
    for (const [label, f] of matrix()) {
      const sql = flat(render(f).sql)
      const notifies = [...sql.matchAll(/(\w+) as \(select pg_notify/g)].map((m) => m[1])
      for (const n of notifies) expect(sql, label).toContain(`(select count(*) from ${n})`)
    }
  })

  it('settles take message rows, then the group row, then the queue row', () => {
    for (const [label, f] of matrix()) {
      const sql = flat(render(f).sql)
      if (!sql.includes('qd as (')) continue
      expect(sql, label).toMatch(/qd as \(.*\(select count\(\*\) from gd\) >= 0/)
      if (sql.includes('pr as ('))
        expect(sql, label).toMatch(/gd as \(.*\(select count\(\*\) from pr\) >= 0/)
    }
  })
})

describe('backoffMs', () => {
  it('matches the family fixed vectors', () => {
    const { vectors } = JSON.parse(
      readFileSync(new URL('../../../../fixtures/backoff/vectors.json', import.meta.url), 'utf8'),
    ) as {
      vectors: {
        policy: Parameters<typeof backoffMs>[0]
        attempt: number
        random: number
        delayMs: number
      }[]
    }
    expect(vectors.length).toBeGreaterThan(0)
    for (const v of vectors) expect(backoffMs(v.policy, v.attempt, () => v.random)).toBe(v.delayMs)
  })
})
