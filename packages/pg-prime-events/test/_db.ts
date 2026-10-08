import { afterAll, afterEach, beforeAll } from 'vitest'
import { defineSchema, pgPrime } from 'pg-prime'
import type { Db } from 'pg-prime'
import { startPglite } from '@pg-prime/testing'
import type { PgliteServer } from '@pg-prime/testing'

/** A server for this file: `PG_PRIME_TEST_URL` when set, otherwise one PGlite. */
export function useServer(): { url: () => string; db: (max?: number) => Db } {
  let server: PgliteServer | undefined
  let url = process.env['PG_PRIME_TEST_URL'] ?? ''
  const dbs: Db[] = []
  beforeAll(async () => {
    if (url === '') {
      server = await startPglite()
      url = server.url
    }
  })
  afterEach(async () => {
    await Promise.all(dbs.splice(0).map((d) => d.end()))
  })
  afterAll(async () => {
    await server?.stop()
  })
  return {
    url: () => url,
    db: (max = 1) => {
      // PGlite delivers a NOTIFY only to the sending socket, so there every wake-up is a poll.
      const d = pgPrime({
        connection: url,
        schema: defineSchema({}),
        poolOptions: { max },
        ...(server === undefined ? {} : { poolerMode: 'transaction' as const }),
      })
      dbs.push(d)
      return d
    },
  }
}

let n = 0
/** A schema name unique to this process and call, so tests never share log tables. */
export const freshSchema = (): string => `ev_t_${process.pid}_${++n}`

export async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting for a condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}
