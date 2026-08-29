/**
 * Tier 2 — the real-server fixtures, against a real server.
 *
 * Two halves with two different reasons to be skipped, and both skip **loudly**, through this
 * package's own guards:
 *
 *   `scratchDatabase` needs `PG_PRIME_TEST_URL`  → `requiresRealPostgres`
 *   `startPostgres`   needs Docker               → `withDocker`, below
 *
 * The refusal cases are the ones that must never be skipped: they are pure functions, they are the
 * safety property (`dropScratchDatabase` will not touch a database it did not name), and a test
 * for a refusal that only runs when a server is up is a test that does not run.
 */

import { defineSchema, pgPrime } from 'pg-prime'
import { describe, expect, it } from 'vitest'
import { requiresRealPostgres } from '../../src/guards.js'
import type { TestDecl } from '../../src/guards.js'
import {
  databaseUrl,
  dockerAvailable,
  dropScratchDatabase,
  isScratchDatabase,
  probe,
  SCRATCH_PREFIX,
  scratchDatabase,
  scratchDatabaseName,
  startPostgres,
} from '../../src/postgres.js'

const ADMIN_URL = process.env['PG_PRIME_TEST_URL']
const onServer: TestDecl = requiresRealPostgres(it, 'scratchDatabase needs a real PostgreSQL')

/**
 * The same shape as the two shipped guards, for the condition only this suite has. It is written
 * here rather than exported because "is Docker up" is a property of a CI runner, not of pg-prime:
 * `dockerAvailable()` is the shipped half, and how a suite spells the skip is the suite's choice.
 */
const docker = await dockerAvailable()
const withDocker: TestDecl = (() => {
  if (docker) return it
  process.stderr.write('[test] skip: startPostgres needs Docker, and nothing answered here\n')
  return it.skip
})()

describe('scratch database naming and the refusal', () => {
  it('names every scratch database pgprime_test_*', () => {
    const a = scratchDatabaseName()
    const b = scratchDatabaseName()
    expect(a.startsWith(SCRATCH_PREFIX)).toBe(true)
    expect(a).toHaveLength(SCRATCH_PREFIX.length + 12)
    expect(a).not.toBe(b)
    expect(isScratchDatabase(a)).toBe(true)
  })

  it('refuses to drop anything it did not name', async () => {
    for (const name of ['postgres', 'production', SCRATCH_PREFIX, 'pgprime_shadow_1', '']) {
      await expect(
        dropScratchDatabase('postgres://user:pass@127.0.0.1:1/postgres', name),
      ).rejects.toThrow(/refusing to drop/)
    }
    // …and it refuses BEFORE it opens a connection: the URL above points at nothing.
    expect(isScratchDatabase('postgres')).toBe(false)
  })

  it('swaps the database out of a URL and leaves the rest alone', () => {
    const url = databaseUrl(
      'postgres://u:p@db.example.com:6543/app?sslmode=require',
      'pgprime_test_x',
    )
    const parsed = new URL(url)
    expect(parsed.pathname).toBe('/pgprime_test_x')
    expect(parsed.host).toBe('db.example.com:6543')
    expect(parsed.username).toBe('u')
    expect(parsed.searchParams.get('sslmode')).toBe('require')
  })
})

describe('scratchDatabase', () => {
  onServer('creates an empty database, hands back a URL that works, and drops it', async () => {
    const scratch = await scratchDatabase(ADMIN_URL!)
    expect(isScratchDatabase(scratch.name)).toBe(true)

    const db = pgPrime({
      connection: scratch.url,
      schema: defineSchema({}),
      poolOptions: { max: 1 },
    })
    try {
      const here = await db.sql`select current_database() as db`.execute()
      expect(here[0]?.['db']).toBe(scratch.name)
      // Empty: nothing of ours, and nothing of anybody else's.
      const tables = await db.sql`
        select count(*)::int as n from pg_tables where schemaname = 'public'`.execute()
      expect(Number(tables[0]?.['n'])).toBe(0)
      await db.sql`create table t (a int)`.execute()
    } finally {
      await db.end()
    }

    await scratch.drop()
    const gone = await withAdmin(async (admin) =>
      admin.sql`select count(*)::int as n from pg_database where datname = ${scratch.name}`.execute(),
    )
    expect(Number(gone[0]?.['n'])).toBe(0)
  })

  onServer('drops a database that still has an open transaction on it', async () => {
    const scratch = await scratchDatabase(ADMIN_URL!)
    const holder = pgPrime({
      connection: scratch.url,
      schema: defineSchema({}),
      poolOptions: { max: 1 },
    })

    // A test that threw halfway leaves exactly this: a live session inside a transaction on the
    // database the fixture is about to reclaim. A plain `DROP DATABASE` fails on it with 55006,
    // which is why `dropScratchDatabase` terminates first — and why the refusal above has to be
    // mechanical rather than a convention.
    let letGo!: () => void
    const held = new Promise<void>((resolve) => {
      letGo = resolve
    })
    const inTx = holder
      .transaction(async (tx) => {
        await tx.sql`create table held (a int)`.execute()
        await held
      })
      // The backend is killed underneath it, so this rejects. That is the scenario.
      .catch(() => undefined)

    await new Promise((r) => setTimeout(r, 200))
    await scratch.drop()
    letGo()
    await inTx
    await holder.end().catch(() => undefined)

    const gone = await withAdmin(async (admin) =>
      admin.sql`select count(*)::int as n from pg_database where datname = ${scratch.name}`.execute(),
    )
    expect(Number(gone[0]?.['n'])).toBe(0)
  })

  onServer('drop() is idempotent', async () => {
    const scratch = await scratchDatabase(ADMIN_URL!)
    await scratch.drop()
    await scratch.drop()
  })

  onServer('probe reports the server version', async () => {
    const { versionNum, version } = await probe(ADMIN_URL!)
    expect(versionNum).toBeGreaterThanOrEqual(150_000)
    expect(version).toContain('PostgreSQL')
  })
})

describe('startPostgres', () => {
  withDocker(
    'starts a container, answers queries, and stops',
    async () => {
      const server = await startPostgres()
      try {
        expect(server.kind).toBe('postgres')
        expect(server.versionNum).toBeGreaterThanOrEqual(170_000)
        const db = pgPrime({
          connection: server.url,
          schema: defineSchema({}),
          poolOptions: { max: 1 },
        })
        try {
          // The container is started with `-c TimeZone=UTC`, for the same reason startPglite pins
          // TZ: a server in another zone silently re-spells every timestamptz golden.
          const rows = await db.sql`select current_setting('TimeZone') as tz`.execute()
          expect(rows[0]?.['tz']).toBe('UTC')
        } finally {
          await db.end()
        }
      } finally {
        await server.stop()
      }
    },
    300_000,
  )
})

/** One admin handle, built on demand — the suite only needs it to check that a drop happened. */
async function withAdmin<T>(
  fn: (db: ReturnType<typeof pgPrime<ReturnType<typeof defineSchema<{}>>>>) => Promise<T>,
): Promise<T> {
  const db = pgPrime({
    connection: ADMIN_URL!,
    schema: defineSchema({}),
    poolOptions: { max: 1 },
    devGuard: false,
  })
  try {
    return await fn(db)
  } finally {
    await db.end()
  }
}
