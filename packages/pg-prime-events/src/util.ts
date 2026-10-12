export const ASYNC_DISPOSE: symbol =
  (Symbol as { asyncDispose?: symbol }).asyncDispose ?? Symbol.for('Symbol.asyncDispose')

/** Calls every observer; a throwing one neither stops the rest nor escapes. */
export function emitAll(observers: Iterable<(e: unknown) => void>, e: unknown): void {
  for (const h of observers) {
    try {
      h(e)
    } catch {}
  }
}

/** Resolves after `ms`, or early when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve()
    const done = (): void => {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const t = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

export function backoffMs(
  p: { baseDelayMs: number; maxDelayMs: number; jitter: 'full' | 'equal' | 'none' },
  attempt: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** Math.max(0, attempt - 1))
  if (p.jitter === 'none') return ceiling
  return p.jitter === 'equal' ? ceiling / 2 + random() * (ceiling / 2) : random() * ceiling
}
