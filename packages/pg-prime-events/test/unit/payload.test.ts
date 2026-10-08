import { describe, expect, it } from 'vitest'
import { PayloadError } from '../../src/errors.js'
import { decodePayload, encodePayload } from '../../src/payload.js'
import type { StandardSchemaV1 } from '../../src/payload.js'

const positive = (async = false): StandardSchemaV1<unknown, { n: number }> => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (v) => {
      const r =
        typeof (v as { n?: unknown }).n === 'number' && (v as { n: number }).n > 0
          ? { value: v as { n: number } }
          : { issues: [{ message: 'must be positive', path: [{ key: 'n' }] }] }
      return async ? Promise.resolve(r) : r
    },
  },
})

describe('payloads', () => {
  it('serializes plain JSON', async () => {
    expect(await encodePayload({}, { a: [1, 'x', null] })).toBe('{"a":[1,"x",null]}')
  })

  it('applies the codec both ways', async () => {
    const codec = {
      encode: (d: Date) => d.toISOString(),
      decode: (v: unknown) => new Date(v as string),
    }
    const d = new Date('2026-10-08T00:00:00Z')
    const json = await encodePayload({ codec }, d)
    expect(json).toBe('"2026-10-08T00:00:00.000Z"')
    expect(await decodePayload({ codec }, JSON.parse(json))).toStrictEqual(d)
  })

  it('validates with a Standard Schema, sync or async, on both sides', async () => {
    for (const schema of [positive(), positive(true)]) {
      expect(await encodePayload({ schema }, { n: 1 })).toBe('{"n":1}')
      const e = await encodePayload({ schema }, { n: -1 }).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(PayloadError)
      expect((e as PayloadError).path).toStrictEqual(['n'])
      expect((e as PayloadError).message).toMatch(/at n: must be positive/)
      await expect(decodePayload({ schema }, { n: 0 })).rejects.toBeInstanceOf(PayloadError)
    }
  })

  it('refuses NUL in values and keys, with the path', async () => {
    const at = async (v: unknown) =>
      ((await encodePayload({}, v).catch((e: unknown) => e)) as PayloadError).path
    expect(await at('a\u0000')).toStrictEqual([])
    expect(await at({ a: { b: ['ok', 'x\u0000'] } })).toStrictEqual(['a', 'b', 1])
    expect(await at({ 'k\u0000': 1 })).toStrictEqual(['k\u0000'])
  })

  it('refuses oversize payloads and values that are not JSON', async () => {
    await expect(encodePayload({}, 'xy', 3)).rejects.toThrow(/4 bytes; the limit is 3/)
    await expect(encodePayload({}, () => 1)).rejects.toBeInstanceOf(PayloadError)
  })
})
