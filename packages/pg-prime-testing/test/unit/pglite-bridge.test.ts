import { once } from 'node:events'
import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { serve } from '../../src/pglite-bridge.js'
import type { PgliteLike } from '../../src/pglite-bridge.js'

const ready = (status: 'I' | 'T'): Uint8Array =>
  new Uint8Array([0x5a, 0, 0, 0, 5, status.charCodeAt(0)])

/** A backend that only tracks the transaction state of simple queries. */
function fakeBackend(): PgliteLike & { executed: string[]; queries: string[] } {
  let inTx = false
  const executed: string[] = []
  const queries: string[] = []
  return {
    executed,
    queries,
    async execProtocolRaw(m) {
      const type = String.fromCharCode(m[0]!)
      executed.push(type)
      if (type === 'Q') {
        const q = Buffer.from(m.subarray(5)).toString('utf8').replace(/\0$/, '')
        queries.push(q)
        if (q === 'begin') inTx = true
        if (q === 'commit' || q === 'rollback') inTx = false
      }
      return ready(inTx ? 'T' : 'I')
    },
    isInTransaction: () => inTx,
  }
}

const message = (type: string, body = ''): Buffer => {
  const b = Buffer.from(body)
  const m = Buffer.alloc(5 + b.length)
  m.write(type, 0)
  m.writeInt32BE(4 + b.length, 1)
  b.copy(m, 5)
  return m
}
const query = (text: string): Buffer => message('Q', `${text}\0`)
const STARTUP = Buffer.from([0, 0, 0, 8, 0, 3, 0, 0])

async function client(port: number): Promise<Socket> {
  const s = connect(port, '127.0.0.1')
  await once(s, 'connect')
  s.write(STARTUP)
  await once(s, 'data')
  return s
}

afterEach(() => vi.restoreAllMocks())

it("a refused socket's pipelined Sync neither runs nor takes over the transaction", async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const db = fakeBackend()
  const bridge = await serve(db)
  try {
    const a = await client(bridge.port)
    const b = await client(bridge.port)
    a.write(query('begin'))
    await once(a, 'data')

    b.write(
      Buffer.concat([message('P', 'x\0'), message('B'), message('D'), message('E'), message('S')]),
    )
    await once(b, 'close')

    a.write(query('select 1'))
    const [out] = (await once(a, 'data')) as [Buffer]
    expect([out[0], out[5], db.isInTransaction()]).toStrictEqual([0x5a, 'T'.charCodeAt(0), true])
    expect(db.executed.filter((t) => t !== 'Q' && t !== '\0')).toStrictEqual([])
    expect(db.queries).toStrictEqual(['begin', 'select 1'])
    a.destroy()
  } finally {
    await bridge.close()
  }
})
