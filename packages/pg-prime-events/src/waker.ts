import { UnsupportedInPoolerModeError } from 'pg-prime'
import type { Db, Subscription } from 'pg-prime'
import type { EventsHooks } from './hooks.js'

export type WakeReason = 'notify' | 'gap' | 'poll'

export interface WakerOptions {
  pollMs: number
  signal?: AbortSignal
  /** Receives `listen-unavailable` when the waker falls back to polling. */
  onInternal?: EventsHooks['onInternal']
}

/** A single-use async iterable of wake reasons, plus `wait(ms)` for loops with their own timers. */
export interface Waker extends AsyncIterable<WakeReason> {
  /** The next reason, waiting at most `ms` (default `pollMs`; a timeout is `'poll'`); `undefined` once closed. */
  wait(ms?: number): Promise<WakeReason | undefined>
  close(): Promise<void>
}

/**
 * Wakes on a NOTIFY on `channel`, a LISTEN `gap`, or `pollMs` of silence. LISTEN starts here; once
 * it is established the first reason is `'gap'`, since anything sent before it was missed. Behind
 * a transaction pooler without `directConnection` it only polls.
 */
export function waker(db: Db, channel: string, opts: WakerOptions): Waker {
  let sub: Subscription | undefined
  let listening: Promise<void> | undefined
  let unsupported = false
  let reported = false
  let flag: 'notify' | 'gap' | undefined
  let wake: (() => void) | undefined
  let closed = opts.signal?.aborted === true

  const raise = (kind: 'notify' | 'gap'): void => {
    if (kind === 'gap' || flag === undefined) flag = kind
    wake?.()
  }
  const listen = async (): Promise<void> => {
    try {
      const s = await db.listen(channel, () => raise('notify'))
      if (closed) return void (await s.close())
      s.on('gap', () => raise('gap'))
      sub = s
      reported = false
      raise('gap')
    } catch (e) {
      unsupported = e instanceof UnsupportedInPoolerModeError
      if (reported) return
      reported = true
      opts.onInternal?.({
        kind: 'listen-unavailable',
        message: `@pg-prime/events: cannot LISTEN on ${channel}; polling every ${opts.pollMs} ms.`,
        cause: e,
      })
    }
  }
  const close = async (): Promise<void> => {
    closed = true
    wake?.()
    const s = sub
    sub = undefined
    await s?.close()
  }
  const wait = async (ms = opts.pollMs): Promise<WakeReason | undefined> => {
    if (sub === undefined && !unsupported && !closed) {
      listening ??= listen()
      await listening
      listening = undefined
    }
    if (flag === undefined && !closed) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms)
        wake = () => {
          clearTimeout(t)
          resolve()
        }
      })
      wake = undefined
    }
    if (closed) return undefined
    const reason = flag ?? 'poll'
    flag = undefined
    return reason
  }

  opts.signal?.addEventListener('abort', () => void close(), { once: true })
  if (!closed) listening = listen()
  const it: AsyncIterator<WakeReason> = {
    next: async () => {
      const value = await wait()
      return value === undefined ? { done: true, value: undefined } : { done: false, value }
    },
    return: async () => {
      await close()
      return { done: true, value: undefined }
    },
  }
  return { wait, close, [Symbol.asyncIterator]: () => it }
}
