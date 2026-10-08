import { ScheduleError } from './errors.js'
import { assertTz } from './ticks.js'
import type { ScheduleDef, ScheduleOptions, ScheduleTarget, ScheduleWhen } from './types.js'

/** A schedule's definition as `schedules` columns. */
export interface Cols {
  readonly pattern: string | null
  readonly every_ms: number | null
  readonly at: Date | null
  readonly tz: string
  readonly start_at: Date | null
  readonly end_at: Date | null
  readonly max_runs: number | null
  readonly overlap: 'skip' | 'allow'
  readonly misfire: 'skip' | 'once'
  readonly misfire_grace_ms: number
  readonly target: 'handler' | 'queue'
  readonly queue: string | null
  readonly payload: unknown
  readonly timeout_ms: number | null
  readonly retry: ScheduleOptions<unknown>['retry'] | null
  readonly keep_runs: number
  readonly keep_runs_ms: number
}

export function defineSchedule<P = undefined>(
  name: string,
  when: ScheduleWhen,
  target: ScheduleTarget<P>,
  opts: ScheduleOptions<P> = {},
): ScheduleDef<P> {
  if (typeof name !== 'string' || name === '') throw new ScheduleError('name', 'a schedule needs a name')
  const handler = 'handler' in target && typeof target.handler === 'function'
  const queue = 'queue' in target && typeof target.queue?.name === 'string'
  if (handler === queue) {
    throw new ScheduleError('target', `schedule '${name}' needs exactly one of { handler } or { queue }`)
  }
  const def = { name, when, target, options: opts }
  colsOf(def)
  return def
}

export function colsOf(def: ScheduleDef<any>): Cols {
  const { when, options: o, target } = def
  const at = 'at' in when ? when.at : null
  const every = 'everyMs' in when ? when.everyMs : null
  const pattern = 'cron' in when ? when.cron : null
  if ([pattern, every, at].filter((x) => x != null).length !== 1) {
    throw new ScheduleError('when', 'when needs exactly one of { cron }, { everyMs } or { at }')
  }
  if (pattern !== null && (typeof pattern !== 'string' || pattern.trim() === '')) {
    throw new ScheduleError('cron', 'cron must be a non-empty pattern')
  }
  const tz = ('tz' in when && when.tz) || 'UTC'
  assertTz(tz)
  if (every !== null && !(Number.isInteger(every) && every >= 1000)) {
    throw new ScheduleError('everyMs', `everyMs must be an integer >= 1000, got ${every}`)
  }
  date('at', at)
  date('startAt', o.startAt)
  date('endAt', o.endAt)
  if (o.startAt && o.endAt && o.endAt <= o.startAt) {
    throw new ScheduleError('endAt', 'endAt must be after startAt')
  }
  count('limit', o.limit, 1)
  count('misfireGraceMs', o.misfireGraceMs, 0)
  count('timeoutMs', o.timeoutMs, 1)
  count('history.keep', o.history?.keep, 0)
  count('history.ageMs', o.history?.ageMs, 1)
  count('retry.maxAttempts', o.retry?.maxAttempts, 1)
  if (o.overlap !== undefined && o.overlap !== 'skip' && o.overlap !== 'allow') {
    throw new ScheduleError('overlap', `overlap must be 'skip' or 'allow'`)
  }
  if (o.misfire !== undefined && o.misfire !== 'skip' && o.misfire !== 'once') {
    throw new ScheduleError('misfire', `misfire must be 'skip' or 'once'`)
  }
  return {
    pattern,
    every_ms: every,
    at,
    tz,
    start_at: o.startAt ?? null,
    end_at: o.endAt ?? null,
    max_runs: o.limit ?? null,
    overlap: o.overlap ?? 'skip',
    misfire: o.misfire ?? 'once',
    misfire_grace_ms: o.misfireGraceMs ?? 60_000,
    target: 'queue' in target ? 'queue' : 'handler',
    queue: 'queue' in target ? target.queue.name : null,
    payload: typeof o.payload === 'function' ? null : (o.payload ?? null),
    timeout_ms: o.timeoutMs ?? null,
    retry: o.retry ?? null,
    keep_runs: o.history?.keep ?? 100,
    keep_runs_ms: o.history?.ageMs ?? 2_592_000_000,
  }
}

/** 64-bit FNV-1a, hex. */
export function fnv(s: string): string {
  let h = 0xcbf29ce484222325n
  for (const b of new TextEncoder().encode(s)) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n)
  return h.toString(16)
}

function date(field: string, d: unknown): void {
  if (d != null && !(d instanceof Date && !Number.isNaN(d.getTime()))) {
    throw new ScheduleError(field, `${field} must be a valid Date`)
  }
}

function count(field: string, n: unknown, min: number): void {
  if (n !== undefined && !(Number.isInteger(n) && (n as number) >= min)) {
    throw new ScheduleError(field, `${field} must be an integer >= ${min}, got ${String(n)}`)
  }
}
