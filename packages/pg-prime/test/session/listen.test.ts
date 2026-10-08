import { describe, expect, it } from 'vitest'
import type { PgConnection } from '../../src/driver/types.js'
import { resolveErrorOptions } from '../../src/errors/redact.js'
import { ListenHub } from '../../src/session/listen.js'

type Listener = (arg: unknown) => void

function fakeHost() {
  const sent: string[] = []
  const conns: Map<string, Listener>[] = []
  const hub = new ListenHub({
    async openDedicated() {
      const listeners = new Map<string, Listener>()
      conns.push(listeners)
      return {
        execute: async (q: { text: string }) => (sent.push(q.text), { rows: [], fields: [] }),
        on: (event: string, l: Listener) => (
          listeners.set(event, l),
          () => listeners.delete(event)
        ),
      } as unknown as PgConnection
    },
    async closeDedicated() {},
    errors: resolveErrorOptions(undefined, false),
    reconnect: { baseDelayMs: 0, maxDelayMs: 0 },
    warn() {},
    internal() {},
  })
  const last = () => conns.at(-1)!
  const notify = (channel: string, payload: string) =>
    last().get('notification')!({ channel, payload, processId: 1 })
  return { hub, sent, conns, notify, kill: () => last().get('error')!(new Error('terminated')) }
}

const tick = () => new Promise((r) => setTimeout(r, 10))

describe('ListenHub keeps one emitter per subscription', () => {
  it('gap and reconnect reach every subscription of a channel', async () => {
    const f = fakeHost()
    const a = await f.hub.subscribe('c', () => {}, undefined)
    const b = await f.hub.subscribe('c', () => {}, undefined)
    const seen: string[] = []
    a.on('gap', () => seen.push('a:gap'))
    b.on('gap', () => seen.push('b:gap'))
    b.on('reconnect', (i) => seen.push(`b:reconnect:${i.attempt}`))
    f.kill()
    await tick()
    expect(seen.sort()).toStrictEqual(['a:gap', 'b:gap', 'b:reconnect:1'])
    expect(f.conns).toHaveLength(2)
    expect(f.sent.filter((t) => t === 'listen "c"')).toHaveLength(2)
  })

  it('a throwing handler reports to its own subscription only', async () => {
    const f = fakeHost()
    const errors: string[] = []
    const a = await f.hub.subscribe(
      'c',
      () => {
        throw new Error('boom')
      },
      undefined,
    )
    const got: string[] = []
    const b = await f.hub.subscribe('c', (p) => got.push(p), undefined)
    a.on('error', () => errors.push('a'))
    b.on('error', () => errors.push('b'))
    f.notify('c', 'x')
    expect(errors).toStrictEqual(['a'])
    expect(got).toStrictEqual(['x'])
  })

  it('closing one subscription removes only its emitter; the last one unlistens', async () => {
    const f = fakeHost()
    const handler = () => {}
    const a = await f.hub.subscribe('c', handler, undefined)
    const b = await f.hub.subscribe('c', handler, undefined)
    const seen: string[] = []
    a.on('gap', () => seen.push('a'))
    b.on('gap', () => seen.push('b'))
    await a.close()
    await a.close()
    expect(f.sent).not.toContain('unlisten "c"')
    f.kill()
    await tick()
    expect(seen).toStrictEqual(['b'])
    await b.close()
    expect(f.sent).toContain('unlisten "c"')
    expect(f.hub.open).toBe(false)
  })
})
