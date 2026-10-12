import { expect, expectTypeOf, it } from 'vitest'
import type { Db } from 'pg-prime'
import { defineQueue, pgMq } from '@pg-prime/mq'
import { defineSchedule, ScheduleError } from '../../src/index.js'
import type { CronEnqueuer } from '../../src/index.js'

it('pgMq satisfies CronEnqueuer', () => {
  expectTypeOf(pgMq({ db: {} as Db })).toExtend<CronEnqueuer>()
})

it('a queue target needs a queue declaration, not a bare name', () => {
  // @ts-expect-error a name-only object is not a queue declaration
  expect(() => defineSchedule('x', { everyMs: 1000 }, { queue: { name: 'jobs' } })).toThrow(
    ScheduleError,
  )
  expect(defineSchedule('x', { everyMs: 1000 }, { queue: defineQueue('jobs') }).name).toBe('x')
})
