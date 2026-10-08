import { ScheduleError } from './errors.js'

export interface Spec {
  readonly pattern: string | null
  readonly everyMs: number | null
  readonly at: Date | null
  readonly tz: string
  readonly startAt: Date | null
  readonly endAt: Date | null
  /** The `every` grid origin when `startAt` is null. */
  readonly anchorAt: Date
}

export interface Ticker {
  /** The first tick strictly after `after`, inside `[startAt, endAt]`. */
  next(after: Date): Date | null
  /** The last tick at or before `upTo`, not before `startAt`; the caller keeps `upTo <= endAt`. */
  last(upTo: Date): Date | null
}

// Lazy so croner stays off the start-up path until a pattern is evaluated.
let croner: Promise<typeof import('croner')> | undefined

export async function ticker(s: Spec): Promise<Ticker> {
  const start = s.startAt?.getTime() ?? -Infinity
  const end = s.endAt?.getTime() ?? Infinity
  let next: (from: number) => number | null
  let last: (upTo: number) => number | null
  if (s.pattern !== null) {
    const { Cron } = await (croner ??= import('croner'))
    let c: InstanceType<typeof Cron>
    try {
      c = new Cron(s.pattern, { timezone: s.tz, mode: '5-or-6-parts' })
      c.nextRun()
    } catch (e) {
      throw new ScheduleError('cron', `invalid cron pattern '${s.pattern}'`, { cause: e })
    }
    next = (from) => c.nextRun(new Date(from))?.getTime() ?? null
    // previousRuns is strictly before a whole-second reference; ticks are whole seconds.
    last = (upTo) =>
      c.previousRuns(1, new Date(Math.floor(upTo / 1000) * 1000 + 1000))[0]?.getTime() ?? null
  } else if (s.everyMs !== null) {
    const every = s.everyMs
    const anchor = s.startAt?.getTime() ?? s.anchorAt.getTime()
    next = (from) => anchor + (Math.floor((from - anchor) / every) + 1) * every
    last = (upTo) => anchor + Math.floor((upTo - anchor) / every) * every
  } else {
    const at = s.at!.getTime()
    next = (from) => (from < at ? at : null)
    last = (upTo) => (at <= upTo ? at : null)
  }
  return {
    next(after) {
      const t = next(Math.max(after.getTime(), start - 1))
      return t === null || t > end ? null : new Date(t)
    },
    last(upTo) {
      const t = last(upTo.getTime())
      return t === null || t < start ? null : new Date(t)
    },
  }
}

export function assertTz(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
  } catch (e) {
    throw new ScheduleError('tz', `invalid time zone '${tz}'`, { cause: e })
  }
}
