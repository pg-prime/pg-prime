import type { Db } from 'pg-prime'
import { backoffMs } from './backoff.js'
import { CronLeaseLostError } from './errors.js'
import { finish, heartbeat, markCancelling, type Finish } from './sql/runs.js'
import type { Tables } from './sql/tables.js'
import type { CronHooks, RunContext, ScheduleOptions } from './types.js'

export interface StartRun {
  readonly id: bigint
  readonly token: string
  readonly schedule: string
  readonly tickAt: Date | null
  readonly manual: boolean
  readonly missed: number
  readonly payload: unknown
  readonly timeoutMs: number | null
  readonly retry: ScheduleOptions<unknown>['retry'] | null
}

type Reason = 'cancel' | 'timeout' | 'close' | 'lost'

interface Active {
  readonly run: StartRun
  readonly ac: AbortController
  reason?: Reason
  done: Promise<void>
}

export type Emit = <K extends keyof CronHooks>(
  k: K,
  e: Parameters<NonNullable<CronHooks[K]>>[0],
) => void

export interface Runner {
  readonly size: number
  start(run: StartRun, handler: (ctx: RunContext<any>) => Promise<unknown>): void
  heartbeat(): Promise<void>
  /** Waits `graceMs`, aborts what is left, then waits `graceMs` more for it to settle. */
  drain(graceMs: number): Promise<void>
}

export function runner(db: Db, t: Tables, leaseMs: number, emit: Emit, onEnd: () => void): Runner {
  const active = new Map<bigint, Active>()

  const abort = (a: Active, reason: Reason): void => {
    if (a.reason !== undefined) return
    a.reason = reason
    a.ac.abort(reason)
    if (reason === 'timeout' || reason === 'close') {
      markCancelling(db, t, a.run.id, a.run.token)
        .execute()
        .catch((e: unknown) => internal('could not mark the run cancelling', e))
    }
  }

  const internal = (message: string, cause: unknown): void =>
    emit('onInternal', { kind: 'heartbeat-failed', message, cause })

  async function execute(a: Active, handler: (ctx: RunContext<any>) => Promise<unknown>) {
    const { run, ac } = a
    const t0 = performance.now()
    emit('onRunStart', { schedule: run.schedule, runId: run.id, manual: run.manual })
    const timer =
      run.timeoutMs === null ? undefined : setTimeout(() => abort(a, 'timeout'), run.timeoutMs)
    const r = run.retry ?? {}
    const max = r.maxAttempts ?? 1
    const policy = {
      baseDelayMs: r.baseDelayMs ?? 1000,
      maxDelayMs: r.maxDelayMs ?? 60_000,
      jitter: r.jitter ?? 'full',
    }
    let attempt = 0
    let ok = false
    let result: unknown
    let error: unknown
    for (;;) {
      attempt++
      try {
        result = await handler({
          schedule: run.schedule,
          tickAt: run.tickAt,
          manual: run.manual,
          payload: run.payload,
          missed: run.missed,
          attempt,
          signal: ac.signal,
        })
        ok = true
        break
      } catch (e) {
        error = e
        if (a.reason !== undefined || attempt >= max) break
        await sleep(backoffMs(policy, attempt), ac.signal)
        if (a.reason !== undefined) break
      }
    }
    clearTimeout(timer)
    if (a.reason === 'lost') return
    const state: Finish['state'] =
      a.reason === 'cancel' || a.reason === 'close'
        ? 'cancelled'
        : a.reason === 'timeout' || !ok
          ? 'failed'
          : 'succeeded'
    const message = a.reason === 'timeout' ? 'timeout' : state === 'failed' ? describe(error) : null
    let finished
    try {
      finished = await finish(db, t, {
        id: run.id,
        token: run.token,
        state,
        error: message,
        result: state === 'succeeded' ? storable(result) : null,
        attempts: attempt,
      }).execute()
    } catch (e) {
      return internal(`could not finish run ${run.id}`, e)
    }
    if (finished.length === 0) {
      return internal(`run ${run.id} lost its lease`, new CronLeaseLostError(run.id))
    }
    emit('onRunEnd', {
      schedule: run.schedule,
      runId: run.id,
      state,
      durationMs: performance.now() - t0,
      ...(state === 'failed' ? { error: a.reason === 'timeout' ? 'timeout' : error } : {}),
    })
  }

  return {
    get size() {
      return active.size
    },
    start(run, handler) {
      const a = { run, ac: new AbortController() } as Active
      active.set(run.id, a)
      a.done = execute(a, handler).finally(() => {
        active.delete(run.id)
        onEnd()
      })
    },
    async heartbeat() {
      const live = [...active.values()]
      if (live.length === 0) return
      let rows
      try {
        rows = await heartbeat(
          db,
          t,
          live.map((a) => a.run),
          leaseMs,
        ).execute()
      } catch (e) {
        return internal('heartbeat failed', e)
      }
      const states = new Map(rows.map((r) => [r['id'] as bigint, r['state']]))
      for (const a of live) {
        const s = states.get(a.run.id)
        if (s === undefined && active.has(a.run.id)) {
          abort(a, 'lost')
          internal(`run ${a.run.id} lost its lease`, new CronLeaseLostError(a.run.id))
        } else if (s === 'cancelling') abort(a, 'cancel')
      }
    },
    async drain(graceMs) {
      const settled = () => Promise.all([...active.values()].map((a) => a.done))
      if (await within(settled(), graceMs)) return
      for (const a of active.values()) abort(a, 'close')
      await within(settled(), graceMs)
    },
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done)
  })
}

async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const r = await Promise.race([
    p.then(() => true),
    new Promise<false>((res) => (timer = setTimeout(res, ms, false))),
  ])
  clearTimeout(timer)
  return r
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function storable(v: unknown): unknown {
  try {
    JSON.stringify(v)
    return v
  } catch {
    return null
  }
}
