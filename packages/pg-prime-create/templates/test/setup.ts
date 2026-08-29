import { readFileSync, readdirSync } from 'node:fs'
import pg from 'pg'
import { startPglite } from '@pg-prime/testing'
import { afterAll } from 'vitest'

// One PGlite per test FILE (see vitest.config.ts), started before the file's imports run so that
// `db.ts` — which reads DATABASE_URL at import time — points at it.
const server = await startPglite()
process.env['DATABASE_URL'] = server.url

// The schema comes from `migrations/`, not from a second copy of the DDL: a fixture that builds
// the tables its own way is a fixture that can pass while the migrations are broken. They are
// applied over the simple query protocol, one file at a time, because a migration file is a script
// and the extended protocol takes exactly one statement.
const MIGRATIONS = new URL('../migrations/', import.meta.url)
const client = new pg.Client({ connectionString: server.url })
await client.connect()
try {
  for (const file of readdirSync(MIGRATIONS).sort()) {
    if (!file.endsWith('.sql')) continue
    await client.query(readFileSync(new URL(file, MIGRATIONS), 'utf8'))
  }
} finally {
  await client.end()
}

afterAll(async () => {
  // The pool first, then the server: a pooled connection that is still open when PGlite goes away
  // surfaces as an `error` on the pool, and vitest reports that as an unhandled exception. `db.ts`
  // is imported here rather than at the top because it reads DATABASE_URL when it loads.
  const { db } = await import('../db.js')
  await db.end()
  await server.stop()
})
