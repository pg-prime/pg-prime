/**
 * Boot one PGlite behind one wire-protocol socket (`_pglite-bridge.ts`), on an ephemeral port.
 *
 * **One instance per test file**, not one per run — design/09 §2.2 specified per-run; measured
 * 2026-08-25 it cannot be. PGlite is a single backend, so with one shared instance every file's
 * temp tables, `set_config`, sequences and open transactions are visible to every other file:
 * `create temp table t` in one file makes `t` already exist in the next. A backend per file costs
 * ~1 s, restores R6 isolation without a schema-namespace dance, and hands WS2 its per-test DDL
 * mutation for free.
 *
 * Within a file PGlite is still one backend — that is what `requiresConcurrency()` is for
 * (design/08 §4.2), and what the bridge's transaction-ownership check enforces mechanically.
 */

import pg from 'pg'
import { serve } from './_pglite-bridge.js'

export interface PgliteServer {
  readonly url: string
  readonly versionNum: number
  readonly version: string
  stop(): Promise<void>
}

export async function startPglite(): Promise<PgliteServer> {
  // Imported lazily so `pnpm test` (the unit project) never pays for loading the WASM build.
  const { PGlite } = await import('@electric-sql/pglite')

  // PGlite takes its session TimeZone from the **host** (verified: `Etc/GMT-5` on a UTC+5
  // laptop) and ignores libpq startup `options`, so this is the only place it can be pinned —
  // and it must be, because `'…+00'::timestamptz` renders in the session zone and half the codec
  // goldens are timestamps. A stock `postgres:17` container is already UTC.
  //
  // Restored immediately: the *server* boots in UTC, the JS process keeps the zone it had.
  // `test/codec/date.test.ts` deliberately puts the process in `Asia/Tokyo` to prove what `pg`'s
  // own DATE parser does to a calendar day, and that must keep working.
  const hostTz = process.env['TZ']
  process.env['TZ'] = 'UTC'
  const db = new PGlite()
  try {
    await db.waitReady
  } finally {
    if (hostTz === undefined) delete process.env['TZ']
    else process.env['TZ'] = hostTz
  }

  // Ephemeral port: several checkouts, and a real 5432, coexist on one machine.
  const bridge = await serve(db)
  const url = `postgres://postgres:postgres@127.0.0.1:${bridge.port}/postgres`
  const { versionNum, version } = await probe(url)

  return {
    url,
    versionNum,
    version,
    stop: async () => {
      await bridge.close()
      await db.close()
    },
  }
}

/**
 * `server_version_num` + `version()` of whatever is answering at `url`, and the assertion that
 * its session zone is UTC.
 *
 * Asserted, never `SET`: design/02 §4.7's rule for the driver, applied to the harness. A server
 * in another zone would silently re-spell every `timestamptz` golden, so it fails here — once,
 * before any test runs — rather than as a diff in twenty files.
 */
export async function probe(url: string): Promise<{ versionNum: number; version: string }> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const r = await client.query<{ num: string; version: string; tzoffset: number }>(
      `select current_setting('server_version_num') as num,
              version() as version,
              extract(timezone from now())::int as tzoffset`,
    )
    const row = r.rows[0]!
    if (row.tzoffset !== 0) {
      throw new Error(
        `pgorm live tests need a server whose session TimeZone is UTC; this one is offset ` +
          `${row.tzoffset} s (${await currentZone(client)}). Start it with \`-c TimeZone=UTC\` ` +
          `(or \`TZ=UTC\` in the container's environment).`,
      )
    }
    return { versionNum: Number(row.num), version: row.version }
  } finally {
    await client.end()
  }
}

async function currentZone(client: pg.Client): Promise<string> {
  const r = await client.query<{ tz: string }>(`select current_setting('TimeZone') as tz`)
  return r.rows[0]!.tz
}
