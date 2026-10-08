import { expectTypeOf, it } from 'vitest'
import type { Db } from 'pg-prime'
import { pgMq } from '@pg-prime/mq'
import type { CronEnqueuer } from '../../src/index.js'

it('pgMq satisfies CronEnqueuer', () => {
  expectTypeOf(pgMq({ db: {} as Db })).toExtend<CronEnqueuer>()
})
