import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { backoffMs } from '../../src/backoff.js'
import * as api from '../../src/index.js'

const root = join(import.meta.dirname, '..', '..')

describe('backoffMs', () => {
  it('matches the family vectors', () => {
    const { vectors } = JSON.parse(
      readFileSync(join(root, '../../fixtures/backoff/vectors.json'), 'utf8'),
    )
    for (const v of vectors) expect(backoffMs(v.policy, v.attempt, () => v.random)).toBe(v.delayMs)
  })
})

describe('@pg-prime/mq stays optional', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
    )

  for (const dir of ['src', 'dist']) {
    it(`${dir}/ names no @pg-prime/mq specifier`, () => {
      if (!existsSync(join(root, dir))) return
      const hits = files(join(root, dir)).filter(
        (f) => /\.(js|ts)$/.test(f) && /['"]@pg-prime\/mq['"/]/.test(readFileSync(f, 'utf8')),
      )
      expect(hits).toEqual([])
    })
  }
})

it('exports the API', () => {
  expect(Object.keys(api).sort()).toEqual([
    'CronLeaseLostError',
    'ScheduleError',
    'SchemaVersionError',
    'defineSchedule',
    'pgCron',
  ])
})
