import { expect, it } from 'vitest'
import * as api from '../../src/index.js'

it('the @pg-prime/mq entry loads', () => {
  expect(typeof api).toBe('object')
})
