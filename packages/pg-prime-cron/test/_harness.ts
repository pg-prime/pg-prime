import { startPglite } from '@pg-prime/testing'
import { defineSchema, pgPrime, sql } from 'pg-prime'
import type { Db } from 'pg-prime'

/** `PG_PRIME_TEST_URL` when set, otherwise a PGlite of this file's own. */
export async function server(): Promise<{ url: string; pglite: boolean; stop(): Promise<void> }> {
  const url = process.env['PG_PRIME_TEST_URL']
  if (url) return { url, pglite: false, stop: async () => {} }
  const s = await startPglite()
  return { url: s.url, pglite: true, stop: () => s.stop() }
}

export const open = (url: string, max = 4): Db =>
  pgPrime({ connection: url, schema: defineSchema({}), poolOptions: { max } })

export async function dropSchema(db: Db, schema: string): Promise<void> {
  await db.sql`drop schema if exists ${sql.ident(schema)} cascade`.execute()
}

export async function until(f: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await f())) {
    if (Date.now() > end) throw new Error('until: timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function rows(db: Db, text: string): Promise<Record<string, unknown>[]> {
  return db.sql`${sql.unsafeRaw(text)}`.execute()
}
