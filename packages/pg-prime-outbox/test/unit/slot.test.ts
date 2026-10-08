import { expect, it } from 'vitest'
import * as api from '../../src/index.js'

it('the @pg-prime/outbox entry loads', () => {
  expect(typeof api).toBe('object')
})
