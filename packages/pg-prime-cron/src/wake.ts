import type { Db, Subscription } from 'pg-prime'
import type { Emit } from './runner.js'

export interface Waker {
  /** LISTEN when the pooler allows it; otherwise the loop polls. */
  listen(): Promise<void>
  wake(): void
  sleep(ms: number): Promise<void>
  close(): Promise<void>
}

export function waker(db: Db, channel: string, emit: Emit): Waker {
  let sub: Subscription | undefined
  let pending = false
  let resolve: (() => void) | undefined
  const wake = (): void => {
    pending = true
    resolve?.()
  }
  return {
    async listen() {
      try {
        sub = await db.listen(channel, wake)
        sub.on('gap', wake)
      } catch (e) {
        emit('onInternal', {
          kind: 'listen-unavailable',
          message: `cron: LISTEN unavailable, polling instead (${e instanceof Error ? e.message : String(e)})`,
          cause: e,
        })
      }
    },
    wake,
    sleep(ms) {
      return new Promise<void>((res) => {
        const done = () => {
          clearTimeout(timer)
          resolve = undefined
          pending = false
          res()
        }
        const timer = setTimeout(done, ms)
        resolve = done
        if (pending) done()
      })
    },
    async close() {
      wake()
      await sub?.close()
    },
  }
}
