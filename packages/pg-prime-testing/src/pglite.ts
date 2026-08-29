/**
 * `startPglite()` — tier 1 (design/08 §4.2). A real PostgreSQL 18 in the test process, behind a
 * real wire-protocol socket, in about a second and with no Docker.
 *
 * ```ts
 * const server = await startPglite()
 * const db = pgPrime({ connection: server.url, schema })
 * // …
 * await db.end()
 * await server.stop()
 * ```
 *
 * ## One instance per test FILE
 *
 * PGlite is a **single backend**. One shared instance makes every file's temp tables,
 * `set_config`, sequences and open transactions visible to every other file: `create temp table t`
 * in one file makes `t` already exist in the next. So call this from the runner's per-file setup
 * (vitest's `setupFiles`, not `globalSetup`), which costs ~1 s per file and restores real
 * isolation with no schema-namespace dance. Within a file it is still one backend — that is what
 * {@link requiresConcurrency} is for.
 *
 * ## `@electric-sql/pglite` is an optional peer
 *
 * It is imported lazily, from here and nowhere else, so a project that only uses
 * {@link createMockPool} never installs a WASM build and `pnpm test` never pays to load one.
 */

import { serve } from './pglite-bridge.js'
import type { PgliteLike } from './pglite-bridge.js'

/** A started server, whichever tier produced it — `startPglite` and `startPostgres` both return this. */
export interface TestServer {
  /** A `postgres://` URL the real `pg` driver can connect to. */
  readonly url: string
  /** `server_version_num`, e.g. `180003`. The number to gate a version-dependent test on. */
  readonly versionNum: number
  /** `version()` in full. */
  readonly version: string
  /** Which fixture produced it, for a test that must say "not on PGlite" in its own words. */
  readonly kind: 'pglite' | 'postgres'
  stop(): Promise<void>
}

export interface PgliteServer extends TestServer {
  readonly kind: 'pglite'
}

/** The members of PGlite's handle this fixture uses, beyond the two the bridge drives. */
interface PgliteHandle extends PgliteLike {
  readonly waitReady: Promise<void>
  query<T>(query: string): Promise<{ rows: T[] }>
  close(): Promise<void>
}

/** Boot one PGlite behind one wire-protocol socket on an ephemeral port. */
export async function startPglite(): Promise<PgliteServer> {
  const { PGlite } = await importPglite()

  // PGlite takes its session TimeZone from the HOST (verified: `Etc/GMT-5` on a UTC+5 laptop) and
  // ignores libpq startup `options`, so this is the only place it can be pinned — and it must be,
  // because `'…+00'::timestamptz` renders in the session zone and half of anyone's temporal
  // goldens are timestamps. A stock `postgres:17` container is already UTC.
  //
  // Restored immediately: the *server* boots in UTC, the JS process keeps the zone it had. A test
  // that deliberately puts the process in `Asia/Tokyo` to prove what a DATE parser does to a
  // calendar day must keep working.
  const hostTz = process.env['TZ']
  process.env['TZ'] = 'UTC'
  const db = new PGlite()
  try {
    await db.waitReady
  } finally {
    if (hostTz === undefined) delete process.env['TZ']
    else process.env['TZ'] = hostTz
  }

  // The version is read through PGlite's OWN handle, not over the socket: `pg` is not a dependency
  // of this package, and asking the thing we just booted what it is needs no wire client
  // (design/13 decision 2).
  const { versionNum, version } = await probePglite(db)

  // Ephemeral port: several checkouts, and a real 5432, coexist on one machine.
  const bridge = await serve(db)

  return {
    url: `postgres://postgres:postgres@127.0.0.1:${bridge.port}/postgres`,
    versionNum,
    version,
    kind: 'pglite',
    stop: async (): Promise<void> => {
      await bridge.close()
      await db.close()
    },
  }
}

/**
 * `server_version_num` + `version()`, and the assertion that the session zone is UTC.
 *
 * Asserted, never `SET`: a server in another zone silently re-spells every `timestamptz` golden,
 * so it fails here — once, before any test runs — rather than as a diff in twenty files.
 */
async function probePglite(db: PgliteHandle): Promise<{ versionNum: number; version: string }> {
  const res = await db.query<{ num: string; version: string; tzoffset: number }>(
    `select current_setting('server_version_num') as num,
            version() as version,
            extract(timezone from now())::int as tzoffset`,
  )
  const row = res.rows[0]
  if (!row) throw new Error('@pg-prime/testing: PGlite answered the version probe with no rows')
  if (Number(row.tzoffset) !== 0) {
    throw new Error(
      `@pg-prime/testing: startPglite() booted a server whose session TimeZone is offset ` +
        `${String(row.tzoffset)} s, not UTC. That means the host TZ leaked past the pin in ` +
        `startPglite(); every timestamptz value would render in that zone.`,
    )
  }
  return { versionNum: Number(row.num), version: row.version }
}

/** The optional peer, imported lazily, with a sentence rather than `ERR_MODULE_NOT_FOUND`. */
async function importPglite(): Promise<{ PGlite: new () => PgliteHandle }> {
  try {
    return (await import('@electric-sql/pglite')) as unknown as {
      PGlite: new () => PgliteHandle
    }
  } catch (cause) {
    throw new Error(
      `@pg-prime/testing: startPglite() needs the optional peer '@electric-sql/pglite'; install it ` +
        `(\`pnpm add -D @electric-sql/pglite\`) or use startPostgres() / scratchDatabase() instead.`,
      { cause },
    )
  }
}
