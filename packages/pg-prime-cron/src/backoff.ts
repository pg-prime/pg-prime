export interface Backoff {
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  readonly jitter: 'full' | 'equal' | 'none'
}

export function backoffMs(p: Backoff, attempt: number, random: () => number = Math.random): number {
  // Clamped: `0 * 2 ** 1024` is NaN, and anything past 2 ** 62 is only ever capped by maxDelayMs.
  const ceiling = Math.min(
    p.maxDelayMs,
    p.baseDelayMs * 2 ** Math.min(62, Math.max(0, attempt - 1)),
  )
  if (p.jitter === 'none') return ceiling
  return p.jitter === 'equal' ? ceiling / 2 + random() * (ceiling / 2) : random() * ceiling
}
