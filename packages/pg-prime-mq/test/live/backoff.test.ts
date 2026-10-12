import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { sql } from 'pg-prime'
import { backoffSql } from '../../src/sql/lease.js'
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
