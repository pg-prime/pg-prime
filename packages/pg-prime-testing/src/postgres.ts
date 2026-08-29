/**
 * Tier 2 — a **real** PostgreSQL (design/08 §4.3). Two ways in, and they answer different
 * questions.
 *
 * - {@link startPostgres} pulls and starts a container through `@testcontainers/postgresql`. Use it
 *   when the suite must own the server: a specific major version, an extension, a `postgresql.conf`
 *   setting. It needs Docker, and it costs seconds, not milliseconds.
 * - {@link scratchDatabase} takes a server that already exists — `PG_PRIME_TEST_URL`, a CI service
 *   container, a local install — and carves an empty database out of it. That is the cheap path:
 *   `CREATE DATABASE` is ~100 ms and needs no image.
 *
 * Both hand back a URL, so the code under test never knows which it got.
 *
 * ## Talking to the admin database
 *
 * Through `pg-prime` itself. It is a **required** peer of this package, a test that wants a real
 * server has already installed the driver it needs, and a second wire client here would be a
 * second thing to keep in step with the one under test.
 */

import { defineSchema, pgPrime, sql } from 'pg-prime'
import type { Db, Schema } from 'pg-prime'
import type { TestServer } from './pglite.js'

/** The empty schema the admin handle runs on: this module only ever issues `db.sql` statements. */
type AdminSchema = Schema<{}, {}>

/**
 * A scratch database and the way to take it back.
 *
 * `drop()` is idempotent and safe to call from an `afterAll` that may run twice.
 */
export interface ScratchDatabase {
  /** A `postgres://` URL pointing at the new, empty database. */
  readonly url: string
  /** Its name — always `pgprime_test_<random>`. */
  readonly name: string
  drop(): Promise<void>
}

export interface StartPostgresOptions {
  /** The image. Default `postgres:17`, which is the version CI's `pg` job runs. */
  readonly image?: string
  /**
   * Extra `-c key=value` server settings. `TimeZone=UTC` is always applied first, for the reason
   * {@link startPglite} pins `TZ`: a server in another zone silently re-spells every
   * `timestamptz` golden.
   */
  readonly settings?: Readonly<Record<string, string>>
}

export interface PostgresServer extends TestServer {
  readonly kind: 'postgres'
}

/**
 * The one prefix this module will create, and the ONLY prefix it will ever drop.
 *
 * `scratchDatabase` refusing to drop a database it did not name is not paranoia: the admin URL a
 * suite is handed is frequently a developer's own server, and "the test suite dropped my
 * database" is a bug you get to make once.
 */
export const SCRATCH_PREFIX = 'pgprime_test_'

/** `pgprime_test_<12 hex>` — short enough to read in `\l`, wide enough not to collide. */
export function scratchDatabaseName(): string {
  let s = ''
  while (s.length < 12) s += Math.floor(Math.random() * 0x1_0000_0000).toString(16)
  return `${SCRATCH_PREFIX}${s.slice(0, 12)}`
}

/** `true` iff `name` is one of ours. Exported because the refusal is worth asserting in a test. */
export function isScratchDatabase(name: string): boolean {
  return name.startsWith(SCRATCH_PREFIX) && name.length > SCRATCH_PREFIX.length
}

/**
 * Create an empty `pgprime_test_<random>` on the server `adminUrl` points at.
 *
 * The database part of `adminUrl` is used to *connect* (so a server that has no `postgres`
 * database still works) and is replaced in the URL that comes back.
 */
export async function scratchDatabase(adminUrl: string): Promise<ScratchDatabase> {
  const name = scratchDatabaseName()
  await withAdmin(adminUrl, async (db) => {
    await db.sql`create database ${sql.ident(name)}`.execute()
  })

  let dropped = false
  return {
    url: databaseUrl(adminUrl, name),
    name,
    drop: async (): Promise<void> => {
      if (dropped) return
      dropped = true
      await dropScratchDatabase(adminUrl, name)
    },
  }
}

/**
 * Drop a scratch database, terminating whatever is still connected to it.
 *
 * **Refuses anything not named `pgprime_test_*`.** The `FORCE` half is the reason the refusal has
 * to be mechanical rather than a convention: a test that leaked a connection leaves a database
 * that a plain `DROP` cannot remove, so this one kills sessions first — and a helper that kills
 * sessions must not be able to be aimed at a database a human cares about.
 */
export async function dropScratchDatabase(adminUrl: string, name: string): Promise<void> {
  if (!isScratchDatabase(name)) {
    throw new Error(
      `@pg-prime/testing: refusing to drop ${JSON.stringify(name)} — dropScratchDatabase only ` +
        `touches databases named ${SCRATCH_PREFIX}*, which are the ones scratchDatabase() created.`,
    )
  }
  await withAdmin(adminUrl, async (db) => {
    await db.sql`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = ${name} and pid <> pg_backend_pid()`.execute()
    await db.sql`drop database if exists ${sql.ident(name)}`.execute()
  })
}

/**
 * Start a PostgreSQL container and wait for it to accept connections.
 *
 * `@testcontainers/postgresql` is an **optional** peer and Docker is not always there; both
 * failures are reported with a sentence naming what is missing, so a suite can catch it and skip
 * loudly rather than printing a stack trace about a socket.
 */
export async function startPostgres(options: StartPostgresOptions = {}): Promise<PostgresServer> {
  const { PostgreSqlContainer } = await importTestcontainers()
  const image = options.image ?? 'postgres:17'
  const settings = { TimeZone: 'UTC', ...options.settings }
  const args: string[] = []
  for (const [k, v] of Object.entries(settings)) args.push('-c', `${k}=${v}`)

  const container = await new PostgreSqlContainer(image).withCommand(['postgres', ...args]).start()
  const url = container.getConnectionUri()
  const { versionNum, version } = await probe(url)
  return {
    url,
    versionNum,
    version,
    kind: 'postgres',
    stop: async (): Promise<void> => {
      await container.stop()
    },
  }
}

/** `server_version_num` and `version()` of whatever answers at `url`. */
export async function probe(url: string): Promise<{ versionNum: number; version: string }> {
  return withAdmin(url, async (db) => {
    const rows = await db.sql`
      select current_setting('server_version_num') as num, version() as version`.execute()
    const row = rows[0]
    if (!row) throw new Error(`@pg-prime/testing: ${redact(url)} answered the probe with no rows`)
    return { versionNum: Number(row['num']), version: String(row['version']) }
  })
}

/** Replace the path (the database name) of a `postgres://` URL, keeping everything else. */
export function databaseUrl(url: string, database: string): string {
  const u = new URL(url)
  u.pathname = `/${encodeURIComponent(database)}`
  return u.toString()
}

/** A URL with the password blanked, for an error message. */
function redact(url: string): string {
  try {
    const u = new URL(url)
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return '<unparseable url>'
  }
}

/**
 * One short-lived, single-connection `pg-prime` handle on the admin database.
 *
 * `devGuard: false` and `max: 1` because this is plumbing, not the code under test: the guard's
 * `AsyncLocalStorage` buys nothing here and a second connection to run one `CREATE DATABASE` is a
 * connection a small `max_connections` does not have to spare.
 */
async function withAdmin<T>(url: string, fn: (db: Db<AdminSchema>) => Promise<T>): Promise<T> {
  const db = pgPrime({
    connection: url,
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

/** What `@testcontainers/postgresql` gives us, structurally — see `pglite-bridge.ts`'s note. */
interface StartedContainer {
  getConnectionUri(): string
  stop(): Promise<unknown>
}

interface ContainerBuilder {
  withCommand(command: string[]): ContainerBuilder
  start(): Promise<StartedContainer>
}

/** The optional peer, imported lazily, with a sentence rather than `ERR_MODULE_NOT_FOUND`. */
async function importTestcontainers(): Promise<{
  PostgreSqlContainer: new (image: string) => ContainerBuilder
}> {
  try {
    return (await import('@testcontainers/postgresql')) as unknown as {
      PostgreSqlContainer: new (image: string) => ContainerBuilder
    }
  } catch (cause) {
    throw new Error(
      `@pg-prime/testing: startPostgres() needs the optional peer '@testcontainers/postgresql'; ` +
        `install it (\`pnpm add -D @testcontainers/postgresql\`) or point scratchDatabase() at a ` +
        `server you already have.`,
      { cause },
    )
  }
}

/**
 * Is Docker answering? `startPostgres()` is worth skipping loudly rather than failing when it is
 * not — a contributor without Docker should still get a green `pnpm test:pg` for everything else.
 *
 * Cheap and cached: one `docker info`-equivalent through testcontainers' own client, asked once.
 */
let dockerProbe: Promise<boolean> | undefined
export function dockerAvailable(): Promise<boolean> {
  dockerProbe ??= (async (): Promise<boolean> => {
    try {
      const { PostgreSqlContainer } = await importTestcontainers()
      return typeof PostgreSqlContainer === 'function' && (await pingDocker())
    } catch {
      return false
    }
  })()
  return dockerProbe
}

/** `docker version` over the CLI: no extra dependency, and it answers in ~50 ms or not at all. */
async function pingDocker(): Promise<boolean> {
  const { spawn } = await import('node:child_process')
  return new Promise<boolean>((resolve) => {
    const child = spawn('docker', ['version', '--format', '{{.Server.Version}}'], {
      stdio: 'ignore',
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(false)
    }, 10_000)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}
