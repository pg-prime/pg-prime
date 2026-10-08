export const ASYNC_DISPOSE: symbol =
  (Symbol as { asyncDispose?: symbol }).asyncDispose ?? Symbol.for('Symbol.asyncDispose')

/** Resolves after `ms`, or early when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve()
    const done = (): void => {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const t = setTimeout(done, Math.max(0, ms))
    signal?.addEventListener('abort', done, { once: true })
  })
}

export type Jitter = 'full' | 'equal' | 'none'

/** The family backoff (design/15 §0.2): `baseDelayMs × 2^(attempt−1)`, capped, then jittered. */
export function backoffMs(
  p: { baseDelayMs: number; maxDelayMs: number; jitter: Jitter },
  attempt: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** Math.max(0, attempt - 1))
  if (p.jitter === 'none') return ceiling
  return p.jitter === 'equal' ? ceiling / 2 + random() * (ceiling / 2) : random() * ceiling
}

export interface Limiter {
  /** How many may be taken now (`Infinity` without a rate). */
  free(now?: number): number
  take(n: number, now?: number): void
  /** Milliseconds until one more may be taken. */
  waitMs(now?: number): number
}

/** A sliding window of at most `max` takes per `perMs`. */
export function limiter(rate: { max: number; perMs: number } | undefined): Limiter {
  const taken: number[] = []
  const free = (now = Date.now()): number => {
    if (rate === undefined) return Infinity
    while (taken.length > 0 && (taken[0] as number) <= now - rate.perMs) taken.shift()
    return Math.max(0, rate.max - taken.length)
  }
  return {
    free,
    take(n, now = Date.now()) {
      if (rate !== undefined) for (let i = 0; i < n; i++) taken.push(now)
    },
    waitMs(now = Date.now()) {
      if (rate === undefined || free(now) > 0) return 0
      return (taken[taken.length - rate.max] as number) + rate.perMs - now
    },
  }
}
