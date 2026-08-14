/**
 * Live-PG harness for the driver/codec spike. Every assertion in `test/driver` and `test/codec`
 * is measured against a real server — nothing here is mocked.
 *
 * Requires a PostgreSQL ≥ 15 container (the spike was measured on 17.11):
 *
 *   docker run -d --name pgorm-spike-driver -e POSTGRES_PASSWORD=pgorm -e POSTGRES_USER=pgorm \
 *     -e POSTGRES_DB=pgorm -p 54330:5432 postgres:17
 *
 * Override the target with `PGORM_TEST_URL`.
 *
 * `pg` is a devDependency used ONLY here and as the adapter's structural target. Nothing under
 * `src/` imports it — see the grep gate in the spike report.
 */

import pg from 'pg'
import { pgDriver } from '../../src/driver/index.js'
import type { PgDriver, PgLikePool } from '../../src/driver/index.js'

export const CONNECTION_STRING =
  process.env['PGORM_TEST_URL'] ?? 'postgres://pgorm:pgorm@127.0.0.1:54330/pgorm'

export function makePool(max = 4): pg.Pool {
  return new pg.Pool({ connectionString: CONNECTION_STRING, max })
}

export interface Harness {
  driver: PgDriver
  pool: pg.Pool
  end(): Promise<void>
}

export async function makeHarness(): Promise<Harness> {
  const pool = makePool()
  // The structural cast is the whole point of §3: `pg.Pool` is not nominally our `PgLikePool`,
  // it merely has the right shape. If this line ever needs `as any`, the seam has drifted.
  const driver = pgDriver({ pool: pool as unknown as PgLikePool })
  try {
    await driver.init()
  } catch (e) {
    await pool.end().catch(() => {})
    throw new Error(
      `pgorm live tests need a PostgreSQL server at ${CONNECTION_STRING}.\n` +
        `  docker run -d --name pgorm-spike-driver -e POSTGRES_PASSWORD=pgorm ` +
        `-e POSTGRES_USER=pgorm -e POSTGRES_DB=pgorm -p 54330:5432 postgres:17\n` +
        `(or set PGORM_TEST_URL). Original error: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    )
  }
  return {
    driver,
    pool,
    end: async () => {
      await driver.destroy()
    },
  }
}

/** Raw pg query with our neutralisation, for probing without going through the adapter. */
export const identity = (v: string): string => v
export function typeSourceRaw(oids: readonly number[]): unknown {
  const a = oids.slice() as number[] & { getTypeParser?: unknown }
  a.getTypeParser = () => identity
  return a
}
