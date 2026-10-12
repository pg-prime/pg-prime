import { describe, expect } from 'vitest'
import { pgPrime } from '../../src/query/run.js'
import { defineSchema } from '../../src/schema/index.js'
import { migrateOwnedSchema } from '../../src/session/owned-schema.js'
import type { OwnedMigration } from '../../src/session/owned-schema.js'
import { connect, liveTarget, requiresConcurrency } from '../live/_harness.js'

const NS = 'pgprime_pg_owned'
const migrations: OwnedMigration[] = [1, 2, 3].map((version) => ({
  version,
  name: `v${version}`,
  // A slow, non-idempotent step: an unserialized second migrator would fail on `create table`.
  up: (s) => [`select pg_sleep(0.05)`, `create table ${s}.t${version} (id int)`],
}))

describe('migrateOwnedSchema under concurrency', () => {
  requiresConcurrency()(
    '5 concurrent migrators apply each version exactly once',
    async () => {
      const c = await connect()
      await c.query(`drop schema if exists ${NS} cascade`)
      const dbs = Array.from({ length: 5 }, () =>
        pgPrime({
          schema: defineSchema({}),
          connection: liveTarget().url,
          poolOptions: { max: 1 },
        }),
      )
      try {
        const results = await Promise.all(
          dbs.map((db) => migrateOwnedSchema(db, { schema: NS, migrations })),
        )
        for (const r of results) expect(r.to).toBe(3)
        expect(results.filter((r) => r.from === 0).length).toBeGreaterThanOrEqual(1)
        const { rows } = await c.query(`select version from ${NS}.migrations order by version`)
        expect(rows.map((r) => r.version)).toStrictEqual([1, 2, 3])
      } finally {
        await Promise.all(dbs.map((db) => db.end()))
        await c.query(`drop schema if exists ${NS} cascade`)
        await c.end()
      }
    },
    60_000,
  )
})
