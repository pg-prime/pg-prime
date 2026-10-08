import { defineSchema, pgPrime, sql } from 'pg-prime'
import type { Db, DbConfig } from 'pg-prime'
import { functionSink } from '../src/index.js'
import type { OutboxRecord, OutboxSink } from '../src/index.js'

export const schema = defineSchema({})

export function connectDb(url: string, extra: Partial<DbConfig<typeof schema>> = {}): Db {
  return pgPrime({ schema, connection: url, ...extra })
}

/** A schema name no other test file uses, so files can share one server. */
export const scratchSchema = (): string =>
  `pgprime_outbox_t_${Math.random().toString(16).slice(2, 10)}`

export async function dropSchema(db: Db, name: string): Promise<void> {
  await db.sql`drop schema if exists ${sql.ident(name)} cascade`.execute()
}

export async function until(cond: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('until(): timed out')
    await sleep(10)
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A sink that records every successful record; `fail` decides per record. */
export function recordingSink<T>(fail: (r: OutboxRecord<T>) => unknown = () => undefined): {
  sink: OutboxSink<T>
  got: OutboxRecord<T>[]
  sent: OutboxRecord<T>[]
} {
  const got: OutboxRecord<T>[] = []
  const sent: OutboxRecord<T>[] = []
  const sink = functionSink<T>(async (wave) => {
    sent.push(...wave)
    const failed = new Map<bigint, unknown>()
    for (const r of wave) {
      const e = fail(r)
      if (e === undefined) got.push(r)
      else failed.set(r.id, e)
    }
    return failed.size === 0 ? undefined : { failed }
  })
  return { sink, got, sent }
}
