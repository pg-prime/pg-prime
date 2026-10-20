import { describe, expect, it } from 'vitest'
import { backoffMs } from '../../src/util.js'

describe('backoffMs', () => {
  it('saturates at maxDelayMs past the float8 exponent', () => {
    const policy = { baseDelayMs: 1, maxDelayMs: 1000, jitter: 'none' } as const
    expect([1024, 1101, 2 ** 31].map((a) => backoffMs(policy, a))).toStrictEqual([1000, 1000, 1000])
    expect(backoffMs({ ...policy, baseDelayMs: 0 }, 1101)).toBe(0)
  })
})
