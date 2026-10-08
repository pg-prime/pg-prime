import type { Db } from 'pg-prime'
import { describe, expect, it } from 'vitest'
import { hooksOf } from '../../src/context.js'
import { waker } from '../../src/relay/waker.js'

function fakeDb(listenFails = false) {
  const handlers: Record<string, () => void> = {}
  let closed = false
  const db = {
    listen: (_chan: string, h: () => void) => {
      if (listenFails) return Promise.reject(new Error('transaction pooler'))
      handlers['notify'] = h
      return Promise.resolve({
        on: (ev: string, f: () => void) => (handlers[ev] = f),
        close: () => {
          closed = true
          return Promise.resolve()
        },
      })
    },
  } as unknown as Db
  return { db, fire: (ev: 'notify' | 'gap') => handlers[ev]?.(), closed: () => closed }
}

const timed = async (p: Promise<void>): Promise<number> => {
  const t = performance.now()
  await p
  return performance.now() - t
}

describe('waker', () => {
  it('wakes on NOTIFY, on gap and on the poll timer', async () => {
    const f = fakeDb()
    const w = await waker(f.db, 'ob_x', hooksOf(undefined))
    setTimeout(() => f.fire('notify'), 10)
    expect(await timed(w.wait(5_000))).toBeLessThan(1_000)
    setTimeout(() => f.fire('gap'), 10)
    expect(await timed(w.wait(5_000))).toBeLessThan(1_000)
    expect(await timed(w.wait(30))).toBeGreaterThanOrEqual(25)
  })

  it('a wake that arrives while nobody waits is not lost', async () => {
    const f = fakeDb()
    const w = await waker(f.db, 'ob_x', hooksOf(undefined))
    f.fire('notify')
    expect(await timed(w.wait(5_000))).toBeLessThan(100)
  })

  it('without LISTEN it reports listen-unavailable and polls', async () => {
    const kinds: string[] = []
    const w = await waker(
      fakeDb(true).db,
      'ob_x',
      hooksOf({ onInternal: (e) => kinds.push(e.kind) }),
    )
    expect(kinds).toStrictEqual(['listen-unavailable'])
    expect(await timed(w.wait(20))).toBeGreaterThanOrEqual(15)
    await w.close()
  })

  it('close wakes the waiter and unlistens', async () => {
    const f = fakeDb()
    const w = await waker(f.db, 'ob_x', hooksOf(undefined))
    const waiting = w.wait(5_000)
    await w.close()
    expect(await timed(waiting)).toBeLessThan(100)
    expect(f.closed()).toBe(true)
  })
})
