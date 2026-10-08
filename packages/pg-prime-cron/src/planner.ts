import type { Ticker } from './ticks.js'

export interface PlanInput {
  readonly nextAt: Date
  readonly dbNow: Date
  readonly endAt: Date | null
  readonly maxRuns: number | null
  readonly runs: number
  readonly misfire: 'skip' | 'once'
  readonly graceMs: number
}

export interface Plan {
  /** The stored `next_at` the claim compares against. */
  readonly expect: Date
  /** The tick the run records; `null` when nothing is left inside `endAt`. */
  readonly fire: Date | null
  readonly decided: 'missed' | null
  /** Ticks folded into the run beside the one it records. */
  readonly missed: number
  readonly next: Date | null
  readonly lateMs: number
  readonly misfired: boolean
}

const MAX_COUNT = 10_000

export function plan(p: PlanInput, t: Ticker): Plan {
  const { nextAt, dbNow } = p
  const lateMs = dbNow.getTime() - nextAt.getTime()
  const h = p.endAt !== null && p.endAt < dbNow ? p.endAt : dbNow
  const base = { expect: nextAt, lateMs }
  if (nextAt > h)
    return { ...base, fire: null, decided: null, missed: 0, next: null, misfired: false }
  const ended = p.maxRuns !== null && p.runs + 1 >= p.maxRuns
  if (lateMs <= p.graceMs) {
    const next = ended ? null : t.next(nextAt)
    return { ...base, fire: nextAt, decided: null, missed: 0, next, misfired: false }
  }
  const last = t.last(h)
  const fire = last !== null && last > nextAt ? last : nextAt
  let count = 1
  for (let x = t.next(nextAt); x !== null && x <= fire && count < MAX_COUNT; x = t.next(x)) count++
  return {
    ...base,
    fire,
    decided: p.misfire === 'skip' ? 'missed' : null,
    missed: count - 1,
    next: ended ? null : t.next(dbNow),
    misfired: true,
  }
}
