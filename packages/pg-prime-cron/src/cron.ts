import { ConfigError, migrateOwnedSchema, UsageError } from 'pg-prime'
import type { RawRow } from 'pg-prime'
import { colsOf, fnv, type Cols } from './define.js'
import { SchemaVersionError } from './errors.js'
import { migrations } from './migrations.js'
import { plan } from './planner.js'
import { runner, type Emit, type StartRun } from './runner.js'
import {
  advance,
  claim,
  due,
  pickup,
  trigger,
  wakeIn,
  type DueRow,
  type StartedRow,
} from './sql/claim.js'
import { expire, gate, reconcile, retain, unclaimed } from './sql/maintenance.js'
import { cancel } from './sql/runs.js'
import * as S from './sql/schedules.js'
import { tables, type Q } from './sql/tables.js'
import { queueTick, queueTrigger, startQueues } from './target/queue.js'
import { ticker, type Ticker } from './ticks.js'
import { waker } from './wake.js'
import type {
  Cron,
  CronConfig,
  RunContext,
  RunState,
  ScheduleDef,
  ScheduleOptions,
  ScheduleWhen,
} from './types.js'

const DISPOSE: symbol =
  (Symbol as { asyncDispose?: symbol }).asyncDispose ?? Symbol.for('Symbol.asyncDispose')

type SpecCols = Pick<Cols, 'pattern' | 'every_ms' | 'at' | 'tz' | 'start_at' | 'end_at'>

const spec = (c: SpecCols, anchorAt: Date) =>
  ticker({
    pattern: c.pattern,
    everyMs: c.every_ms,
    at: c.at,
    tz: c.tz,
    startAt: c.start_at,
    endAt: c.end_at,
    anchorAt,
  })

/** The first tick to store: a one-shot `at` in the past is kept, so the misfire policy sees it. */
const first = (tk: Ticker, at: Date | null, now: Date) =>
  tk.next(at !== null && at <= now ? new Date(at.getTime() - 1) : now)

const isQueue = (d: ScheduleDef<any>) => 'queue' in d.target
const handlerOf = (d: ScheduleDef<any>) =>
  (d.target as { handler: (run: RunContext<any>) => Promise<unknown> }).handler
const payloadOf = (d: ScheduleDef<any> | undefined, stored: unknown, tickAt: Date | null) => {
  const p = d?.options.payload
  return typeof p === 'function' ? p({ tickAt, manual: tickAt === null }) : stored
}
function defaultInstance(): string {
  const p = (globalThis as { process?: { pid?: number; env?: Record<string, string | undefined> } })
    .process
  const host = p?.env?.['HOSTNAME'] ?? p?.env?.['COMPUTERNAME'] ?? 'host'
  return `${host}:${p?.pid ?? 0}:${Math.random().toString(36).slice(2, 10)}`
}

const missing = (name: string) => new UsageError(`cron: no schedule '${name}'`)

export function pgCron(config: CronConfig): Cron {
  const { db } = config
  const schema = config.schema ?? 'pgprime_cron'
  const t = tables(schema)
  const channel = `cron_${fnv(schema)}`
  const instance = config.instance ?? defaultInstance()
  const pollMs = config.pollMs ?? 10_000
  const leaseMs = config.leaseMs ?? 30_000
  const maintenanceMs = config.maintenanceMs ?? 15_000
  const maxConcurrent = config.maxConcurrent ?? Infinity
  const defs = new Map<string, ScheduleDef<any>>()
  for (const d of config.schedules ?? []) {
    if (defs.has(d.name)) throw new UsageError(`cron: schedule '${d.name}' is declared twice`)
    defs.set(d.name, d)
  }

  const emit: Emit = (k, e) => {
    try {
      ;(config.hooks?.[k] as ((e: unknown) => void) | undefined)?.(e)
    } catch (err) {
      if (k !== 'onInternal') {
        emit('onInternal', { kind: 'hook-failed', message: `cron: hook ${k} threw`, cause: err })
      }
    }
  }
  const w = waker(db, channel, emit)
  const runs = runner(db, t, leaseMs, emit, () => w.wake())
  const queues = config.enqueuer && { db, t, enqueuer: config.enqueuer, instance }
  const names = (f: (d: ScheduleDef<any>) => boolean) =>
    [...defs.values()].filter(f).map((d) => d.name)
  const mine = () => names((d) => !isQueue(d) || queues !== undefined)

  let ready: Promise<void> | undefined
  let started: Promise<void> | undefined
  let loop: Promise<void> | undefined
  let beat: ReturnType<typeof setInterval> | undefined
  let closing: Promise<void> | undefined
  let lastMaintenance = -Infinity

  const clock = async () => (await S.dbNow(db).execute())[0]!['now'] as Date
  const notify = (name: string) => db.notify(channel, name)

  const ensure = () =>
    (ready ??= init().catch((e: unknown) => {
      ready = undefined
      throw e
    }))

  async function init() {
    let to: number
    try {
      ;({ to } = await migrateOwnedSchema(db, {
        schema,
        migrations,
        apply: config.autoMigrate !== false,
      }))
    } catch (e) {
      throw e instanceof ConfigError ? new SchemaVersionError(e.message, { cause: e }) : e
    }
    const latest = migrations.at(-1)!.version
    if (to < latest) {
      throw new SchemaVersionError(
        `schema ${schema} is at version ${to} and this client needs ${latest}; ` +
          `migrate it, or leave autoMigrate on`,
      )
    }
    const now = await clock()
    for (const d of defs.values()) await write(d, 'code', now, true)
  }

  async function write(def: ScheduleDef<any>, source: 'code' | 'api', now: Date, replace: boolean) {
    const cols = colsOf(def)
    const next = first(await spec(cols, now), cols.at, now)
    const u = { name: def.name, cols, hash: fnv(JSON.stringify(cols)), source, next, anchor: now }
    return (await S.upsert(db, t, u, replace).execute()).length > 0
  }

  async function tick(row: DueRow) {
    const def = defs.get(row.name)
    if (def === undefined) return
    const p = plan(
      {
        nextAt: row.next_at,
        dbNow: row.db_now,
        endAt: row.end_at,
        maxRuns: row.max_runs,
        runs: row.runs,
        misfire: row.misfire,
        graceMs: row.misfire_grace_ms,
      },
      await spec(row, row.anchor_at),
    )
    if (p.fire === null) return void (await advance(db, t, row.name, p.expect, p.next).execute())
    const payload = payloadOf(def, row.payload, p.fire)
    const fire = p.fire
    const report = (decision: RunState) => {
      if (p.misfired) {
        const n = p.decided === 'missed' ? p.missed + 1 : p.missed
        emit('onMisfire', { schedule: row.name, policy: row.misfire, missed: n })
      }
      emit('onTick', {
        schedule: row.name,
        tickAt: fire,
        decision,
        missed: p.missed,
        lateMs: p.lateMs,
      })
    }
    if (queues !== undefined && isQueue(def)) {
      const r = await queueTick(queues, def, row, p, payload)
      if (r !== undefined) report(r.state)
      return
    }
    const [r] = await claim(db, t, {
      name: row.name,
      expect: p.expect,
      fire: p.fire,
      decided: p.decided,
      missed: p.missed,
      next: p.next,
      leaseMs,
      instance,
      payload,
    }).execute()
    if (r === undefined) return
    report(r['state'] as RunState)
    if (r['state'] !== 'running') return
    const run: StartRun = {
      id: r['id'] as bigint,
      token: r['token'] as string,
      schedule: row.name,
      tickAt: fire,
      manual: false,
      missed: p.missed,
      payload: r['payload'],
      timeoutMs: row.timeout_ms,
      retry: row.retry,
    }
    runs.start(run, handlerOf(def))
  }

  async function iterate(): Promise<number> {
    const executable = mine()
    let full = false
    if (executable.length > 0) {
      for (const row of (await due(db, t, executable).execute()) as unknown as DueRow[]) {
        if (closing) return 0
        if (row.target === 'handler' && runs.size >= maxConcurrent) full = true
        else await tick(row).catch(failed)
      }
    }
    const room = Math.min(100, maxConcurrent - runs.size)
    const handlers = names((d) => !isQueue(d))
    if (handlers.length > 0 && room > 0 && !closing) {
      const picked = await pickup(db, t, {
        mine: handlers,
        limit: room,
        leaseMs,
        instance,
      }).execute()
      for (const r of picked as unknown as StartedRow[]) {
        const def = defs.get(r.schedule)
        if (def === undefined) continue
        const run: StartRun = {
          id: r.id,
          token: r.token,
          schedule: r.schedule,
          tickAt: r.tick_at,
          manual: r.manual,
          missed: r.missed,
          payload: r.payload,
          timeoutMs: r.timeout_ms,
          retry: r.retry,
        }
        runs.start(run, handlerOf(def))
      }
    }
    if (performance.now() - lastMaintenance >= maintenanceMs) {
      lastMaintenance = performance.now()
      await maintain()
    }
    if (full || executable.length === 0) return pollMs
    const ms = (await wakeIn(db, t, executable).execute())[0]?.['ms'] as number | null | undefined
    return ms == null ? pollMs : Math.min(pollMs, Math.max(10, ms))
  }

  async function maintain() {
    if ((await gate(db, t, maintenanceMs).execute()).length === 0) return
    await expire(db, t).execute()
    await reconcile(db, t)
    await retain(db, t).execute()
    const n = (await unclaimed(db, t, leaseMs).execute())[0]?.['n'] as number
    if (n > 0) {
      emit('onInternal', {
        kind: 'pending-unclaimed',
        message: `cron: ${n} manual run(s) pending for over ${leaseMs} ms; no live instance registered their handler`,
      })
    }
  }

  const failed = (e: unknown) =>
    emit('onInternal', { kind: 'loop-failed', message: 'cron: loop iteration failed', cause: e })

  async function run() {
    while (closing === undefined) {
      let wait = pollMs
      try {
        wait = await iterate()
      } catch (e) {
        failed(e)
      }
      if (closing !== undefined) return
      await w.sleep(wait)
    }
  }

  function close(): Promise<void> {
    return (closing ??= (async () => {
      w.wake()
      await started?.catch(() => {})
      await loop
      await runs.drain(config.graceMs ?? 10_000)
      clearInterval(beat)
      await w.close()
    })())
  }
  config.signal?.addEventListener('abort', () => void close(), { once: true })
  if (config.signal?.aborted === true) void close()

  async function lockedUpdate(name: string, f: (row: RawRow, tx: Q) => Promise<void>) {
    await ensure()
    await db.transaction(async (tx) => {
      const [row] = await S.lock(tx, t, name).execute()
      if (row === undefined) throw missing(name)
      await f(row, tx)
    })
    await notify(name)
  }

  async function flags(name: string, f: { paused?: boolean; enabled?: boolean; next?: null }) {
    await ensure()
    if ((await S.setFlags(db, t, name, f).execute()).length === 0) throw missing(name)
    await notify(name)
  }

  const cron = {
    start(): Promise<void> {
      if (closing !== undefined)
        return Promise.reject(new UsageError('cron: start() after close()'))
      return (started ??= (async () => {
        await ensure()
        if (queues !== undefined) await startQueues(queues, [...defs.values()].filter(isQueue))
        await w.listen()
        if (closing !== undefined) return
        beat = setInterval(() => void runs.heartbeat(), leaseMs / 3)
        loop = run()
      })())
    },
    close,

    async create(def: ScheduleDef<any>) {
      await ensure()
      if (queues !== undefined && isQueue(def)) await startQueues(queues, [def])
      if (!(await write(def, 'api', await clock(), false))) {
        throw new UsageError(`cron: schedule '${def.name}' already exists`)
      }
      defs.set(def.name, def)
      await notify(def.name)
    },

    update: (name: string, patch: Partial<{ when: ScheduleWhen } & ScheduleOptions<unknown>>) =>
      lockedUpdate(name, async (row, tx) => {
        const info = S.toInfo(row)
        const local = defs.get(name)
        const stored = Object.fromEntries(
          Object.entries({
            startAt: info.startAt,
            endAt: info.endAt,
            limit: info.limit,
            overlap: info.overlap,
            misfire: info.misfire,
            misfireGraceMs: info.misfireGraceMs,
            payload:
              typeof local?.options.payload === 'function' ? local.options.payload : info.payload,
            timeoutMs: info.timeoutMs,
            retry: row['retry'],
            history: { keep: row['keep_runs'], ageMs: row['keep_runs_ms'] },
          }).filter(([, v]) => v !== null),
        )
        const { when, ...options } = patch
        const def: ScheduleDef<any> = {
          name,
          when: when ?? info.when,
          target:
            local?.target ??
            (info.queue !== null
              ? { queue: { kind: 'queue', name: info.queue } }
              : { handler: async () => {} }),
          options: { ...stored, ...options },
        }
        const cols = colsOf(def)
        const now = row['db_now'] as Date
        const next = first(await spec(cols, now), cols.at, now)
        const u = {
          name,
          cols,
          hash: fnv(JSON.stringify(cols)),
          source: info.source,
          next,
          anchor: now,
        }
        await S.upsert(tx, t, u, true).execute()
        if (local !== undefined) defs.set(name, def)
      }),

    async remove(name: string, opts?: { force?: boolean }) {
      await ensure()
      const [r] = await S.remove(db, t, name, opts?.force === true).execute()
      if (r?.['deleted'] === 1) {
        defs.delete(name)
        return true
      }
      if (r?.['present'] === 1) {
        throw new UsageError(
          `cron: schedule '${name}' has open runs; remove(name, { force: true }) deletes them too`,
        )
      }
      return false
    },

    pause: (name: string) => flags(name, { paused: true }),
    resume: (name: string) => flags(name, { paused: false }),
    disable: (name: string) => flags(name, { enabled: false, next: null }),
    enable: (name: string) =>
      lockedUpdate(name, async (row, tx) => {
        if (row['enabled'] === true) return
        const c = row as unknown as SpecCols &
          Pick<Cols, 'max_runs'> & { runs: number; anchor_at: Date; db_now: Date }
        const ended = c.max_runs !== null && c.runs >= c.max_runs
        const next = ended ? null : first(await spec(c, c.anchor_at), c.at, c.db_now)
        await S.setFlags(tx, t, name, { enabled: true, next }).execute()
      }),

    async trigger(name: string, opts?: { payload?: unknown }) {
      await ensure()
      const def = defs.get(name)
      if (def !== undefined && isQueue(def)) {
        if (queues === undefined)
          throw new UsageError(
            `cron: '${name}' has a queue target and this instance has no enqueuer`,
          )
        return queueTrigger(queues, def, opts?.payload ?? payloadOf(def, undefined, null))
      }
      const payload = opts?.payload !== undefined ? opts.payload : payloadOf(def, undefined, null)
      const [r] = await trigger(db, t, { name, instance, payload, channel }).execute()
      if (r === undefined) {
        if ((await S.select(db, t, name).execute()).length === 0) throw missing(name)
        throw new UsageError(
          `cron: '${name}' has a queue target; trigger it on an instance that declared its queue`,
        )
      }
      if (r['state'] === 'pending' && def !== undefined) w.wake()
      return { runId: r['id'] as bigint, state: r['state'] as 'pending' | 'skipped' }
    },

    async cancel(runId: bigint) {
      await ensure()
      return cancel(db, t, runId)
    },

    async get(name: string) {
      await ensure()
      const [row] = await S.select(db, t, name).execute()
      return row === undefined ? undefined : S.toInfo(row)
    },

    async list() {
      await ensure()
      return (await S.select(db, t).execute()).map(S.toInfo)
    },

    async runs(name: string, opts?: { limit?: number; before?: bigint }) {
      await ensure()
      return (await S.history(db, t, name, opts?.limit ?? 50, opts?.before ?? null).execute()).map(
        S.toRun,
      )
    },

    async preview(when: ScheduleWhen, opts?: { count?: number; from?: Date }) {
      const cols = colsOf({
        name: 'preview',
        when,
        target: { handler: async () => {} },
        options: {},
      })
      const from = opts?.from ?? (await clock())
      const tk = await spec(cols, from)
      const out: Date[] = []
      for (let x = tk.next(from); x !== null && out.length < (opts?.count ?? 5); x = tk.next(x)) {
        out.push(x)
      }
      return out
    },

    async prune(keep: readonly string[]) {
      await ensure()
      return (await S.prune(db, t, keep).execute()).map((r) => r['name'] as string)
    },

    [DISPOSE]: close,
  }
  return cron as unknown as Cron
}
