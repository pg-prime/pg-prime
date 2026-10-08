import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { waves } from '../../src/relay/deliver.js'
import { fairShare } from '../../src/relay/lease.js'
import { backoffMs } from '../../src/relay/relay.js'

const rec = (id: number, key: string | null) => ({ id, key })
const ids = (ws: Iterable<{ id: number }[]>) => [...ws].map((w) => w.map((r) => r.id))

describe('waves', () => {
  it('wave k holds the k-th record of every key, unkeyed records go first', () => {
    const rows = [rec(1, 'a'), rec(2, 'b'), rec(3, 'a'), rec(4, null), rec(5, 'a'), rec(6, 'b')]
    expect(ids(waves(rows, new Set()))).toStrictEqual([[1, 2, 4], [3, 6], [5]])
  })

  it('never puts one key twice in a wave', () => {
    const rows = Array.from({ length: 200 }, (_, i) => rec(i, `k${(i * 7) % 13}`))
    for (const w of waves(rows, new Set())) {
      expect(new Set(w.map((r) => r.key)).size).toBe(w.length)
    }
  })

  it('drops a failed key from every later wave', () => {
    const failed = new Set<string>()
    const rows = [rec(1, 'a'), rec(2, 'b'), rec(3, 'a'), rec(4, 'b'), rec(5, 'a')]
    const seen: number[][] = []
    for (const w of waves(rows, failed)) {
      seen.push(w.map((r) => r.id))
      failed.add('a')
    }
    expect(seen).toStrictEqual([[1, 2], [4]])
  })
})

describe('fair share', () => {
  it('counts relays that own nothing, so an incumbent yields to a newcomer', () => {
    expect(fairShare(16, 1)).toBe(16)
    expect(fairShare(16, 2)).toBe(8)
    expect(fairShare(16, 3)).toBe(6)
    expect(fairShare(16, 4)).toBe(4)
    expect(fairShare(16, 32)).toBe(1)
    expect(fairShare(16, 0)).toBe(16)
  })
})

describe('backoffMs', () => {
  const vectors = JSON.parse(
    readFileSync(new URL('../../../../fixtures/backoff/vectors.json', import.meta.url), 'utf8'),
  ) as {
    vectors: {
      policy: { baseDelayMs: number; maxDelayMs: number; jitter: 'full' | 'equal' | 'none' }
      attempt: number
      random: number
      delayMs: number
    }[]
  }

  it.each(vectors.vectors)('matches the family vector %#', (v) => {
    expect(backoffMs(v.policy, v.attempt, () => v.random)).toBe(v.delayMs)
  })
})
