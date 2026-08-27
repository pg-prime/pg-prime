/**
 * The single live-PostgreSQL entry point for every tier-1 / tier-2 suite (design/09 §2.2, WS-L).
 *
 * One target, one env var:
 *
 *   `PGORM_TEST_URL` unset → `_setup.ts` boots this test file its own PGlite behind
 *                            `PGLiteSocketServer` on an ephemeral port. No Docker; identical on
 *                            ubuntu / macos / windows, which is design/08 §4.2's whole point.
 *   `PGORM_TEST_URL` set   → that server, whatever it is, shared by every file and partitioned by
 *                            schema namespace (R6). CI points it at PG 15/16/17/18.
 *
 * Either way the suite talks to the same `pg@8` driver over the same wire protocol. Nothing in a
 * test may branch on which target it got except through the two guards at the bottom of this file.
 *
 * `pg` is a root devDependency used ONLY in tests; nothing under `src/` imports it.
 */

import { inject, it } from 'vitest'
import pg from 'pg'
import { pgDriver } from '../../src/driver/index.js'
import type { PgDriver, PgLikePool } from '../../src/driver/index.js'

// ─────────────────────────────────────────────────────────────────────────────
// The target
// ─────────────────────────────────────────────────────────────────────────────

export interface LiveTarget {
  /** libpq connection string this test file talks to. */
  readonly url: string
  /** `pglite` ⇒ a *single* backend — see the tier-1 ban list, design/08 §4.2. */
  readonly kind: 'pglite' | 'pg'
  /** `server_version_num`, e.g. `170004`. */
  readonly versionNum: number
  /** `version()`, for the banner and for skip reasons. */
  readonly version: string
}

/**
 * What `_globalSetup.ts` knows before any worker starts. With a real server that is the whole
 * target; with PGlite only the kind, because each file gets its own instance on its own port
 * (`_pglite.ts`).
 */
export type LivePlan = { readonly kind: 'pglite' } | ({ readonly kind: 'pg' } & Omit<LiveTarget, 'kind'>)

declare module 'vitest' {
  interface ProvidedContext {
    pgormLivePlan: LivePlan
  }
}

let fileTarget: LiveTarget | undefined

/** Called by `_setup.ts` once per test file, before any test runs. Not for use in tests. */
export function setFileTarget(target: LiveTarget): void {
  fileTarget = target
}

const NO_TARGET =
  'No live target. `test/live/_setup.ts` did not run: this file belongs to the `live` or `pg` ' +
  'vitest project (packages/pgorm/vitest.config.ts), not to `unit`. ' +
  'Run `pnpm test:live` (PGlite, no Docker) or `pnpm test:pg` with PGORM_TEST_URL set.'

/** The target *this file* is pointed at. */
export function liveTarget(): LiveTarget {
  if (fileTarget) return fileTarget
  const plan = inject('pgormLivePlan') as LivePlan | undefined
  if (!plan || plan.kind !== 'pg') throw new Error(NO_TARGET)
  fileTarget = plan
  return fileTarget
}

/** `170004` → `17`. */
export function pgMajor(): number {
  return Math.floor(liveTarget().versionNum / 10_000)
}

// ─────────────────────────────────────────────────────────────────────────────
// Connections
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every connection this harness hands out is UTC — asserted once per target in `probe()`, not
 * `SET` per connection. A `SET` on connect would be a *second* thing on the wire while another
 * connection is mid-query, which on PGlite's single backend is exactly the interleaving that
 * `_pglite.ts` documents.
 */
export function makePool(max = 4): pg.Pool {
  return new pg.Pool({ connectionString: liveTarget().url, max })
}

/** Raw `pg.Client`, for probes that must not go through the adapter (the fuzz oracles). */
export async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: liveTarget().url })
  await client.connect()
  return client
}

/**
 * "Would PostgreSQL plan this?", as statements to run — the one check that catches SQL which is
 * well-formed but not *valid* (a `group by` that misses a column, a cast PostgreSQL will not make,
 * an operator that does not exist for those operand types).
 *
 * `EXPLAIN (GENERIC_PLAN)` is PG 16+. Below it, `PREPARE` / `DEALLOCATE` forces the same three
 * phases — parse, analyse, plan — over the exact text the builder produced, which is why the
 * fallback is equivalent rather than merely similar. design/09 §5 names this as the fallback;
 * before WS5 only `test/live-query/_db.ts` implemented it, and the two fuzz files that also
 * `explain (generic_plan)` were red on PG 15.
 */
export function planProbe(sql: string, major: number = pgMajor()): readonly string[] {
  if (major >= 16) return [`explain (generic_plan) ${sql}`]
  const name = `__pgorm_plan_${Math.abs(hashSql(sql))}`
  return [`prepare ${name} as ${sql}`, `deallocate ${name}`]
}

function hashSql(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

export interface Harness {
  driver: PgDriver
  pool: pg.Pool
  end(): Promise<void>
}

export async function makeHarness(max = 4): Promise<Harness> {
  const pool = makePool(max)
  // The structural cast is the whole point of design/02 §3: `pg.Pool` is not nominally our
  // `PgLikePool`, it merely has the right shape. If this line ever needs `as any`, the seam
  // has drifted. (The documented R12 exception.)
  const driver = pgDriver({ pool: pool as unknown as PgLikePool })
  try {
    await driver.init()
  } catch (e) {
    await pool.end().catch(() => {})
    throw new Error(
      `pgorm live tests could not reach ${liveTarget().url} (${liveTarget().kind}). ` +
        `Original error: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    )
  }
  return { driver, pool, end: async () => void (await driver.destroy()) }
}

/**
 * PostgreSQL SQLSTATE of a thrown error, if any (R13: assert this, never message text).
 *
 * Two shapes, because tests reach the server two ways: raw `pg` puts it on `.code`, and our own
 * adapter throws a `PgDriverError` carrying `PgDriverErrorData`, where it is `data.server.sqlstate`
 * (errors cross the driver seam as plain data — 02 §7 D12). Reading only `.code` made every
 * adapter-side error look like "no SQLSTATE" and silently bypassed R13.
 */
export function sqlState(e: unknown): string | undefined {
  const raw = e as { code?: string; pgorm?: { server?: { sqlstate?: string } } } | null
  return raw?.code ?? raw?.pgorm?.server?.sqlstate
}

/** Our parser neutralisation, for probing raw `pg` without going through the adapter. */
export const identity = (v: string): string => v
export function typeSourceRaw(oids: readonly number[]): unknown {
  const a = oids.slice() as number[] & { getTypeParser?: unknown }
  a.getTypeParser = () => identity
  return a
}

// ─────────────────────────────────────────────────────────────────────────────
// The two guards (design/09 §2.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Just enough of vitest's `it` to declare a test. `it` and `it.skip` are both assignable to it,
 * which `typeof it` is not — vitest's chained `it.skip` drops `.extend`/`.skipIf`.
 */
export type TestDecl = (name: string, fn: () => void | Promise<void>) => void

let skips = 0

/** Count of guard-skipped tests in this worker. Printed per skip so CI shows the total (design/09 §5). */
export function skipCount(): number {
  return skips
}

function skip(reason: string): TestDecl {
  skips += 1
  console.info(`[live] skip #${skips} (${liveTarget().kind}): ${reason}`)
  return it.skip
}

/**
 * The general form: run only against a real server, for the stated reason. Use the two named
 * wrappers below when they fit; use this one when the reason is a specific PGlite gap, and say
 * what it is — a skip whose reason is "PGlite" is a skip nobody can ever re-evaluate.
 *
 *   requiresRealPostgres('PGlite ignores CancelRequest')('…', async () => { … })
 */
export function requiresRealPostgres(reason: string): TestDecl {
  return liveTarget().kind === 'pglite' ? skip(reason) : it
}

/**
 * For anything whose correctness depends on a **second backend session**: `skip locked`, lock
 * waiting, `40001` retry, deadlock detection, cross-session LISTEN/NOTIFY, pool semantics.
 *
 * PGlite multiplexes every socket onto one backend (design/08 F8: both "connections" report
 * `pg_backend_pid() = 42`, and `pg_try_advisory_lock` on the second returns `true` where real
 * PostgreSQL returns `false`), so a broken implementation would test **green** here. Such tests
 * live in `test/pg/` and run only against `PGORM_TEST_URL`.
 *
 *   requiresConcurrency()('skip locked leaves the other rows visible', async () => { … })
 */
export function requiresConcurrency(): TestDecl {
  return requiresRealPostgres('needs a second backend session; PGlite is one backend (design/08 §4.2)')
}

/**
 * For SQL whose availability depends on the server major, e.g. `EXPLAIN (GENERIC_PLAN)` is 16+.
 *
 *   requiresVersion(16)('explain generic_plan', async () => { … })
 */
export function requiresVersion(minMajor: number): TestDecl {
  const major = pgMajor()
  return major < minMajor ? skip(`needs PostgreSQL ${minMajor}+, target is ${major}`) : it
}
