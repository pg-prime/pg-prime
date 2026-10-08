import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NonRetryableSinkError, webhookSink } from '../../src/index.js'
import type { DeliveryContext, OutboxRecord } from '../../src/index.js'

interface Hit {
  path: string
  headers: IncomingHttpHeaders
  body: string
}
const hits: Hit[] = []
let base = ''
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c: Buffer) => (body += c.toString()))
  req.on('end', () => {
    hits.push({ path: req.url!, headers: req.headers, body })
    const status = Number(req.url!.split('/')[1])
    if (req.url!.startsWith('/slow')) setTimeout(() => res.end(), 2_000)
    else res.writeHead(Number.isNaN(status) ? 200 : status).end()
  })
})
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
})

const rec = (id: bigint, key: string | null = null): OutboxRecord<{ n: number }> => ({
  id,
  key,
  idem: `idem-${id}`,
  payload: { n: Number(id) },
  headers: null,
  attempts: 0,
  createdAt: new Date('2026-01-01T00:00:00Z'),
})
const ctx: DeliveryContext = { signal: new AbortController().signal, epoch: 9n, partition: 0 }

describe('webhookSink', () => {
  it('posts one JSON record with Idempotency-Key, epoch and an HMAC signature', async () => {
    hits.length = 0
    const sink = webhookSink({
      url: `${base}/ok`,
      headers: { authorization: 'Bearer t' },
      sign: { secret: 's' },
    })
    expect(await sink.deliver([rec(1n, 'k')], ctx)).toBeUndefined()
    const [h] = hits
    expect(JSON.parse(h!.body)).toStrictEqual({
      id: '1',
      key: 'k',
      idem: 'idem-1',
      payload: { n: 1 },
      headers: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(h!.headers['idempotency-key']).toBe('idem-1')
    expect(h!.headers['x-outbox-epoch']).toBe('9')
    expect(h!.headers['authorization']).toBe('Bearer t')
    expect(h!.headers['content-type']).toBe('application/json')
    expect(h!.headers['x-signature']).toBe(createHmac('sha256', 's').update(h!.body).digest('hex'))
  })

  it('batch mode posts one array per URL', async () => {
    hits.length = 0
    const sink = webhookSink<{ n: number }>({
      url: (r) => `${base}/${r.payload.n % 2 === 0 ? 'even' : 'odd'}`,
      mode: 'batch',
      sign: { secret: 's', header: 'X-Sig' },
    })
    await sink.deliver([rec(1n), rec(2n), rec(3n)], ctx)
    expect(hits.map((h) => [h.path, JSON.parse(h.body).length]).sort()).toStrictEqual([
      ['/even', 1],
      ['/odd', 2],
    ])
    expect(hits[0]!.headers['idempotency-key']).toBeUndefined()
    expect(hits[0]!.headers['x-sig']).toMatch(/^[0-9a-f]{64}$/)
  })

  it.each([
    [408, true],
    [425, true],
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [404, false],
    [422, false],
  ])('status %i is retryable: %s', async (status, retryable) => {
    const sink = webhookSink({ url: `${base}/${status}` })
    const res = await sink.deliver([rec(1n), rec(2n)], ctx)
    const errors = [...(res as { failed: Map<bigint, unknown> }).failed.values()]
    expect(errors.length).toBe(2)
    for (const e of errors) expect(e instanceof NonRetryableSinkError).toBe(!retryable)
  })

  it('a custom retryable() decides', async () => {
    const sink = webhookSink({ url: `${base}/500`, retryable: () => false })
    const res = await sink.deliver([rec(1n)], ctx)
    expect([...(res as { failed: Map<bigint, unknown> }).failed.values()][0]).toBeInstanceOf(
      NonRetryableSinkError,
    )
  })

  it('times out as a retryable failure', async () => {
    const sink = webhookSink({ url: `${base}/slow`, timeoutMs: 50 })
    const res = await sink.deliver([rec(1n)], ctx)
    const e = [...(res as { failed: Map<bigint, unknown> }).failed.values()][0]
    expect(e).toBeInstanceOf(Error)
    expect(e).not.toBeInstanceOf(NonRetryableSinkError)
  })

  it('a partial failure fails only its records', async () => {
    const sink = webhookSink<{ n: number }>({
      url: (r) => `${base}/${r.payload.n === 2 ? 503 : 200}`,
    })
    const res = await sink.deliver([rec(1n), rec(2n), rec(3n)], ctx)
    expect([...(res as { failed: Map<bigint, unknown> }).failed.keys()]).toStrictEqual([2n])
  })
})
