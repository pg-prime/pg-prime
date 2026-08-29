/**
 * Tier 1 — `startPglite()` really boots a PostgreSQL, and the real `pg` driver behind `pg-prime`
 * really talks to it over the wire.
 *
 * One instance for this file, torn down at the end: that is the granularity the fixture's own
 * docblock argues for, and using it here is the cheapest way to keep the documentation honest.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defineSchema, pgPrime, pgTable } from 'pg-prime'
import { startPglite } from '../../src/pglite.js'
import type { PgliteServer } from '../../src/pglite.js'

const notes = pgTable('notes', (t) => ({
  id: t.integer().primaryKey(),
  body: t.text(),
  at: t.timestamptz(),
}))
const schema = defineSchema({ notes })

let server: PgliteServer

beforeAll(async () => {
  server = await startPglite()
})

afterAll(async () => {
  await server.stop()
})

describe('startPglite', () => {
  it('returns a wire URL, a version and the kind', () => {
    expect(server.kind).toBe('pglite')
    expect(server.url).toMatch(/^postgres:\/\/postgres:postgres@127\.0\.0\.1:\d+\/postgres$/)
    // PGlite is PostgreSQL 17+; the point of the number is that a version-gated test can read it.
    expect(server.versionNum).toBeGreaterThanOrEqual(150_000)
    expect(server.version).toContain('PostgreSQL')
  })

  it('picks an ephemeral port, never 5432', () => {
    const port = Number(new URL(server.url).port)
    expect(port).toBeGreaterThan(1024)
    expect(port).not.toBe(5432)
  })

  it('pins the server session to UTC whatever the host TZ is', async () => {
    const db = pgPrime({ connection: server.url, schema, poolOptions: { max: 1 } })
    try {
      const rows = await db.sql`select current_setting('TimeZone') as tz`.execute()
      expect(rows[0]?.['tz']).toBe('UTC')
    } finally {
      await db.end()
    }
  })

  it('runs DDL, an insert and a select through pg-prime over the bridge', async () => {
    const db = pgPrime({ connection: server.url, schema, poolOptions: { max: 1 } })
    try {
      await db.sql`create table notes (id int primary key, body text, at timestamptz)`.execute()
      await db
        .insertInto(db.h.notes)
        .values({ id: 1, body: 'hello', at: new Date('2026-01-02T03:04:05Z') })
        .execute()
      const rows = await db
        .from(db.h.notes)
        .select(({ notes: n }) => ({ id: n.id, body: n.body, at: n.at }))
        .execute()
      expect(rows).toEqual([{ id: 1, body: 'hello', at: new Date('2026-01-02T03:04:05Z') }])
    } finally {
      await db.end()
    }
  })

  it('keeps the session usable after a SQLSTATE — the spurious ReadyForQuery is stripped', async () => {
    // This is the bridge's reason for existing (design/08 §4.2 addendum): PGlite answers a failed
    // extended-protocol message with an extra ReadyForQuery, and without the strip the NEXT query
    // on the same connection dies with "unexpected rowDescription". One erroring parameterised
    // query followed by a good one is the whole regression.
    const db = pgPrime({ connection: server.url, schema, poolOptions: { max: 1 } })
    try {
      await expect(db.sql`select 1 / ${0}::int as n`.execute()).rejects.toThrow(/division by zero/)
      const rows = await db.sql`select 42 as n`.execute()
      expect(Number(rows[0]?.['n'])).toBe(42)
    } finally {
      await db.end()
    }
  })
})
