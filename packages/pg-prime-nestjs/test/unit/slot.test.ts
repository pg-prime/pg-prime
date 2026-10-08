import { expect, it } from 'vitest'
import * as api from '../../src/index.js'
import * as testing from '../../src/testing.js'

it('the @pg-prime/nestjs entries load', () => {
  expect(typeof api).toBe('object')
  expect(typeof testing).toBe('object')
})
