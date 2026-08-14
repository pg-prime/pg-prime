/**
 * Live-PostgreSQL harness for the fuzz oracles.
 *
 * `pg` is a root devDependency used ONLY in tests; nothing under `src/` imports it (the
 * package ships with zero dependencies).
 *
 * Requires a PostgreSQL 17 container:
 *   docker run -d --name pgorm-spike-sql -e POSTGRES_PASSWORD=pgorm -e POSTGRES_USER=pgorm \
 *     -e POSTGRES_DB=pgorm -p 54331:5432 postgres:17-alpine
 */

import pg from 'pg'

export const CONNECTION_STRING =
  process.env['PGORM_SQL_TEST_URL'] ?? 'postgres://pgorm:pgorm@127.0.0.1:54331/pgorm'

/** Fuzz budget. 10k per PR (03 Appendix B); override for the nightly 1M run. */
export const FUZZ_CASES = Number(process.env['PGORM_FUZZ_CASES'] ?? 10_000)
export const FUZZ_SEED = Number(process.env['PGORM_FUZZ_SEED'] ?? 0x5eed)

export async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: CONNECTION_STRING })
  await client.connect()
  return client
}

/** PostgreSQL SQLSTATE of a thrown driver error, if any. */
export function sqlState(e: unknown): string | undefined {
  return (e as { code?: string } | null)?.code
}
