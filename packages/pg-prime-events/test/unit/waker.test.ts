import { describe, expect, it } from 'vitest'
import { UnsupportedInPoolerModeError } from 'pg-prime'
import { waker } from '../../src/index.js'
import { fakeDb } from './_fake.js'

describe('waker', () => {
  it("starts with 'gap' once LISTEN is up, then yields notify, gap and poll", async () => {
    const f = fakeDb()
    const w = waker(f.db, 'ch', { pollMs: 20 })
    expect(await w.wait()).toBe('gap')
    f.deliver('ch', '')
    f.deliver('ch', '')
    expect(await w.wait()).toBe('notify')
    f.deliver('ch', '')
    f.gap('ch')
    expect(await w.wait()).toBe('gap')
    expect(await w.wait()).toBe('poll')
    const t = Date.now()
    expect(await w.wait(50)).toBe('poll')
    expect(Date.now() - t).toBeGreaterThanOrEqual(40)
  })

  it('wakes a waiting caller as soon as a notification arrives', async () => {
    const f = fakeDb()
    const w = waker(f.db, 'ch', { pollMs: 10_000 })
    await w.wait()
    const next = w.wait()
    setTimeout(() => f.deliver('ch', ''), 10)
    expect(await next).toBe('notify')
    await w.close()
  })

  it('is an async iterable that ends when the signal aborts, closing its LISTEN', async () => {
    const f = fakeDb()
    const stop = new AbortController()
    const seen: string[] = []
    for await (const r of waker(f.db, 'ch', { pollMs: 5, signal: stop.signal })) {
      seen.push(r)
      if (seen.length === 3) stop.abort()
    }
    expect(seen).toStrictEqual(['gap', 'poll', 'poll'])
    expect(f.closed()).toBe(1)
  })

  it('polls behind a transaction pooler, reporting listen-unavailable once', async () => {
    const f = fakeDb(() => Promise.reject(new UnsupportedInPoolerModeError('no listen')))
    const internal: string[] = []
    const w = waker(f.db, 'ch', { pollMs: 5, onInternal: (e) => void internal.push(e.kind) })
    expect([await w.wait(), await w.wait(), await w.wait()]).toStrictEqual(['poll', 'poll', 'poll'])
    expect(internal).toStrictEqual(['listen-unavailable'])
    await w.close()
    expect(await w.wait()).toBeUndefined()
  })

  it('retries a failed LISTEN at each wait and reports the outage once', async () => {
    let fail = 2
    const f = fakeDb(async () => {
      if (fail-- > 0) throw new Error('connection refused')
    })
    const internal: string[] = []
    const w = waker(f.db, 'ch', { pollMs: 5, onInternal: (e) => void internal.push(e.kind) })
    expect([await w.wait(), await w.wait(), await w.wait()]).toStrictEqual(['poll', 'poll', 'gap'])
    expect(f.listening()).toBe(1)
    expect(internal).toStrictEqual(['listen-unavailable'])
    await w.close()
  })
})
