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

/** A host whose connections can be opened late, whose LISTEN can fail, and which records closes. */
function gatedHost() {
  const sent: string[] = []
  const attached: string[] = []
  const conns: PgConnection[] = []
  const closed: PgConnection[] = []
  const listeners: Map<string, Listener>[] = []
  let gate: Promise<void> | undefined
  let failListen = 0
  const hub = new ListenHub({
    async openDedicated() {
      await gate
      const own = new Map<string, Listener>()
      listeners.push(own)
      const conn = {
        execute: async (q: { text: string }) => {
          sent.push(q.text)
          if (q.text.startsWith('listen') && failListen > 0) {
            failListen -= 1
            throw new Error('listen refused')
          }
          return { rows: [], fields: [] }
        },
        on: (event: string, l: Listener) => (
          attached.push(event),
          own.set(event, l),
          () => own.delete(event)
        ),
      } as unknown as PgConnection
      conns.push(conn)
      return conn
    },
    async closeDedicated(conn) {
      closed.push(conn)
    },
    errors: resolveErrorOptions(undefined, false),
    reconnect: { baseDelayMs: 0, maxDelayMs: 0 },
    warn() {},
    internal() {},
  })
  return {
    hub,
    sent,
    attached,
    conns,
    closed,
    gate: (p: Promise<void>) => {
      gate = p
    },
    failListen: (n: number) => {
      failListen = n
    },
    notify: (channel: string, payload: string) =>
      listeners.at(-1)!.get('notification')!({ channel, payload, processId: 1 }),
    kill: () => listeners.at(-1)!.get('error')!(new Error('terminated')),
  }
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await tick()
  expect(cond()).toBe(true)
}

describe('ListenHub owns exactly one dedicated connection (07 §6.5)', () => {
  it('two concurrent first subscriptions share ONE connection and ONE set of listeners', async () => {
    const f = gatedHost()
    const got: string[] = []
    await Promise.all([
      f.hub.subscribe('a', (p) => got.push(`a:${p}`), undefined),
      f.hub.subscribe('b', (p) => got.push(`b:${p}`), undefined),
    ])
    expect(f.conns).toHaveLength(1)
    expect(f.attached).toStrictEqual(['notification', 'error'])
    f.notify('a', 'x')
    expect(got).toStrictEqual(['a:x'])
  })

  it('a LISTEN that fails during a reconnect closes that connection before the next attempt', async () => {
    const f = gatedHost()
    const errors: unknown[] = []
    const sub = await f.hub.subscribe('c', () => {}, undefined)
    sub.on('error', (e) => errors.push(e))
    f.failListen(1)
    f.kill()
    await until(() => f.hub.open)
    expect(f.conns).toHaveLength(3)
    expect(f.closed).toStrictEqual([f.conns[0], f.conns[1]])
    expect(errors).toHaveLength(1)
    expect(f.attached).toHaveLength(6)
  })

  it('close() during a reconnect closes the late connection and leaves nothing open', async () => {
    const f = gatedHost()
    await f.hub.subscribe('c', () => {}, undefined)
    let open!: () => void
    f.gate(new Promise<void>((r) => (open = r)))
    f.kill()
    await tick()
    await f.hub.close()
    open()
    await until(() => f.conns.length === 2)
    await tick()
    expect(f.closed).toStrictEqual(f.conns)
    expect(f.hub.open).toBe(false)
  })

  it('close() during the FIRST subscribe closes the late connection and rejects the subscribe', async () => {
    const f = gatedHost()
    let open!: () => void
    f.gate(new Promise<void>((r) => (open = r)))
    const p = f.hub.subscribe('c', () => {}, undefined)
    await f.hub.close()
    open()
    await expect(p).rejects.toThrow(/after db\.end\(\)/)
    expect(f.closed).toStrictEqual(f.conns)
    expect(f.hub.open).toBe(false)
  })
})

describe('ListenHub shares the reopen with a subscribe() that lands during a reconnect', () => {
  it('one live connection, one set of listeners, one NOTIFY per handler', async () => {
    const f = gatedHost()
    const got: string[] = []
    await f.hub.subscribe('c', (p) => got.push(`c:${p}`), undefined)
    let open!: () => void
    f.gate(new Promise<void>((r) => (open = r)))
    f.kill()
    await tick()
    const late = f.hub.subscribe('d', (p) => got.push(`d:${p}`), undefined)
    open()
    await late
    await until(() => f.hub.open && f.sent.filter((t) => t === 'listen "d"').length > 0)
    await tick()
    expect(f.conns).toHaveLength(2)
    expect(f.closed).toStrictEqual([f.conns[0]])
    expect(f.attached).toHaveLength(4)
    f.notify('c', 'x')
    f.notify('d', 'y')
    expect(got).toStrictEqual(['c:x', 'd:y'])
  })

  it('a LISTEN that fails leaves no channel behind, so the next subscriber LISTENs again', async () => {
    const f = gatedHost()
    f.failListen(1)
    await expect(f.hub.subscribe('c', () => {}, undefined)).rejects.toThrow(/listen refused/)
    await f.hub.subscribe('c', () => {}, undefined)
    expect(f.sent.filter((t) => t === 'listen "c"')).toHaveLength(2)
  })
})
