import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { retryDelayMs } from '../../src/session/transaction.js'

const { vectors } = JSON.parse(
  readFileSync(new URL('../../../../fixtures/backoff/vectors.json', import.meta.url), 'utf8'),
) as { vectors: { policy: never; attempt: number; random: number; delayMs: number }[] }

it("the family's backoff vectors agree with core's retry delay", () => {
  expect(vectors).toHaveLength(15)
  for (const v of vectors) expect(retryDelayMs(v.policy, v.attempt, () => v.random)).toBe(v.delayMs)
})
