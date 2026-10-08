import { afterAll, afterEach, beforeAll } from 'vitest'
import { defineSchema, pgPrime, sql } from 'pg-prime'
import type { Db, DbConfig } from 'pg-prime'
import { startPglite } from '@pg-prime/testing'
import type { PgliteServer } from '@pg-prime/testing'

const schemas: string[] = []
/** A schema name unique to this process and call, dropped when the file ends. */
export const freshSchema = (): string => {
  const s = `mq_t_${process.pid}_${schemas.length + 1}`
  schemas.push(s)
  return s
}

type Extra = Partial<DbConfig<any>>

/** A server for this file: `PG_PRIME_TEST_URL` when set, otherwise one PGlite. */
export function useServer(): { url: () => string; db: (max?: number, extra?: Extra) => Db } {
  let server: PgliteServer | undefined
  let url = process.env['PG_PRIME_TEST_URL'] ?? ''
  const dbs: Db[] = []
  const open = (max: number, extra: Extra = {}): Db =>
    pgPrime({
      connection: url,
      schema: defineSchema({}),
      poolOptions: { max },
      // PGlite delivers a NOTIFY only to the sending socket, so there every wake-up is a poll.
      ...(server === undefined ? {} : { poolerMode: 'transaction' as const }),
      ...extra,
    } as DbConfig<any>)
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
    const admin = open(1)
    for (const s of schemas.splice(0)) {
      await admin.sql`drop schema if exists ${sql.ident(s)} cascade`.execute()
    }
    await admin.end()
    await server?.stop()
  })
  return {
    url: () => url,
    db: (max = 1, extra?: Extra) => {
      const d = open(max, extra)
      dbs.push(d)
      return d
    },
  }
}

export async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting for a condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** `db`, except that `fn` runs once, right before or after the first statement labelled `label`. */
export function racing(
  db: Db,
  label: string,
  fn: () => Promise<unknown>,
  when: 'before' | 'after',
): Db {
  let done = false
  return new Proxy(db, {
    get(o, k) {
      if (k !== 'withOptions') {
        const v = Reflect.get(o, k)
        return typeof v === 'function' ? v.bind(o) : v
      }
      return (opts: { label?: string }) => {
        const q = o.withOptions(opts)
        if (opts.label !== label || done) return q
        done = true
        return {
          sql: (s: TemplateStringsArray, ...v: unknown[]) => ({
            execute: async () => {
              if (when === 'before') await fn()
              const rows = await q.sql(s, ...v).execute()
              if (when === 'after') await fn()
              return rows
            },
          }),
        }
      }
    },
  })
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function p95(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0
}
