import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { sql } from 'pg-prime'
import { backoffSql } from '../../src/sql/lease.js'
import { backoffMs } from '../../src/util.js'
import { useServer } from '../_db.js'

const server = useServer()

it("S9's SQL backoff matches the family fixed vectors exactly", async () => {
  const { vectors } = JSON.parse(
    readFileSync(new URL('../../../../fixtures/backoff/vectors.json', import.meta.url), 'utf8'),
  ) as { vectors: { policy: object; attempt: number; random: number; delayMs: number }[] }
  const db = server.db()
  for (const v of vectors) {
    const retry = sql`${JSON.stringify(v.policy)}::jsonb`
    const f = backoffSql(retry, sql`${v.attempt - 1}::int`, sql`${v.random}::float8`)
    const [r] = await db.sql`select (${f})::float8 as d`.execute()
    expect(r?.['d'], JSON.stringify(v)).toBeCloseTo(v.delayMs, 6)
  }
})

it('saturates at maxDelayMs past the float8 exponent, like backoffMs', async () => {
  const db = server.db()
  const policy = { maxAttempts: 2 ** 31, baseDelayMs: 1, maxDelayMs: 1000, jitter: 'none' } as const
  const retry = sql`${JSON.stringify(policy)}::jsonb`
  for (const attempts of [9, 10, 62, 63, 1023, 1024, 1100, 2 ** 31 - 1]) {
    const f = backoffSql(retry, sql`${attempts}::int`)
    const [r] = await db.sql`select (${f})::float8 as d`.execute()
    expect(r?.['d'], String(attempts)).toBe(backoffMs(policy, attempts + 1))
  }
  const zero = sql`${JSON.stringify({ ...policy, baseDelayMs: 0 })}::jsonb`
  const [r] = await db.sql`select (${backoffSql(zero, sql`1100::int`)})::float8 as d`.execute()
  expect([r?.['d'], backoffMs({ ...policy, baseDelayMs: 0 }, 1101)]).toStrictEqual([0, 0])
})
