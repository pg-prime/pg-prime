import type { Db, Subscription } from 'pg-prime'
import type { Hooks } from '../context.js'

export interface Waker {
  /** Resolves on a NOTIFY, a `gap`, a `kick()` or after `ms`, whichever comes first. */
  wait(ms: number): Promise<void>
  kick(): void
  close(): Promise<void>
}

/** LISTEN when the pooler profile allows it; otherwise polling alone. */
export async function waker(db: Db, channel: string, hooks: Hooks): Promise<Waker> {
  let pending = false
  let wake: (() => void) | undefined
  const kick = (): void => {
    pending = true
    wake?.()
  }
  let sub: Subscription | undefined
  try {
    sub = await db.listen(channel, kick)
    sub.on('gap', kick)
  } catch (e) {
    hooks.internal(
      'listen-unavailable',
      '@pg-prime/outbox: LISTEN is unavailable, so the relay polls. Behind a transaction pooler, ' +
        'give pgPrime a directConnection for prompt wake-ups.',
      e,
    )
  }
  return {
    kick,
    wait: (ms) =>
      new Promise((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          wake = undefined
          pending = false
          resolve()
        }
        const timer = setTimeout(done, Math.max(0, ms))
        wake = done
        if (pending) done()
      }),
    close: async () => {
      kick()
      await sub?.close().catch(() => {})
    },
  }
}
