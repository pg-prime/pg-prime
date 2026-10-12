import { describe, expect, it } from 'vitest'
import { ConfigError, UsageError } from 'pg-prime'
import type { Db } from 'pg-prime'
import { PayloadError, defineQueue, pgMq, spanAttributes } from '../../src/index.js'
import { createHooks } from '../../src/hooks.js'
import { MAX_PROGRESS, decodePayload, encodePayload, toJson } from '../../src/payload.js'
import { limiter } from '../../src/util.js'

describe('defineQueue', () => {
  it('fills the family defaults', () => {
    const q = defineQueue('q')
    expect([q.retry, q.keep, q.watch, q.rate, q.concurrency]).toStrictEqual([
      { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 60_000, jitter: 'full' },
      { completed: { ageMs: 86_400_000 }, failed: { ageMs: 604_800_000 } },
      false,
      undefined,
      undefined,
    ])
    expect(Object.isFrozen(q)).toBe(true)
  })

  it('refuses watch without kept completions, bad limits and bad retry policies', () => {
    expect(() => defineQueue('q', { watch: true, keep: { completed: false } })).toThrow(ConfigError)
    expect(() => defineQueue('q', { concurrency: 0 })).toThrow(ConfigError)
    expect(() => defineQueue('q', { rate: { max: 0, perMs: 10 } })).toThrow(ConfigError)
    expect(() => defineQueue('q', { retry: { maxAttempts: 0 } })).toThrow(ConfigError)
    expect(() => defineQueue('')).toThrow(UsageError)
  })

  it('queue() refuses an object defineQueue did not make', () => {
    const mq = pgMq({ db: {} as Db })
    expect(() => mq.queue({ kind: 'queue', name: 'q' } as never)).toThrow(UsageError)
    expect(() => mq.queue(defineQueue('q'))).not.toThrow()
  })
})

describe('payloads', () => {
  it('refuse NUL characters with their path and oversize values', async () => {
    const e = await encodePayload({}, { a: [{ b: 'x\u0000' }] }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(PayloadError)
    expect((e as PayloadError).path).toStrictEqual(['a', 0, 'b'])
    expect(() => toJson('x'.repeat(MAX_PROGRESS), MAX_PROGRESS, 'progress')).toThrow(
      /limit is 65536/,
    )
    expect(toJson(undefined, 10, 'result')).toBe('null')
  })

  it('apply the codec and the schema on both sides', async () => {
    const opts = {
      codec: {
        encode: (d: Date) => d.toISOString(),
        decode: (v: unknown) => new Date(v as string),
      },
    }
    const wire = await encodePayload(opts, new Date(0))
    expect(wire).toBe('"1970-01-01T00:00:00.000Z"')
    expect(await decodePayload(opts, JSON.parse(wire))).toStrictEqual(new Date(0))
  })
})

describe('hooks', () => {
  it('a throwing hook is reported as hook-failed and the others still run', () => {
    const seen: string[] = []
    const hooks = createHooks({
      onSend: () => {
        throw new Error('x')
      },
      onInternal: (e) => void seen.push(e.kind),
    })
    hooks.observe({ onSend: () => void seen.push('second') })
    hooks.emit('onSend', { queue: 'q', ids: [], inTx: false })
    expect(seen).toStrictEqual(['hook-failed', 'second'])
  })

  it('spanAttributes follows the OpenTelemetry messaging names', () => {
    expect(
      spanAttributes({ queue: 'q', id: 7n, outcome: 'completed', durationMs: 1, attempt: 2 }),
    ).toMatchObject({
      'messaging.system': 'pg-prime-mq',
      'messaging.destination.name': 'q',
      'messaging.message.id': '7',
      'messaging.operation.type': 'process',
    })
  })
})

describe('limiter', () => {
  it('allows max per sliding window', () => {
    const l = limiter({ max: 2, perMs: 100 })
    l.take(2, 0)
    expect([l.free(50), l.waitMs(50)]).toStrictEqual([0, 50])
    expect(l.free(100)).toBe(2)
    expect(limiter(undefined).free()).toBe(Infinity)
  })
})
