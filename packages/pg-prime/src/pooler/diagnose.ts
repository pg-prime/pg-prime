/**
 * `db.diagnosePooler()` and `db.diagnose()` (design/07 §5.4).
 *
 * ## It reports. It never reconfigures.
 *
 * That sentence is the whole design and it is `07` §5.4's own: *the ecosystem's answer to pooler
 * detection is to make the safe thing the default so detection is unnecessary*, and Prisma #21799
 * is the case study in what happens when a client-side pooler workaround outlives the pooler bug
 * it worked around. A false negative on this heuristic costs performance; a false positive that
 * silently switched modes would cost correctness. So `confidence` is never `'high'` — that is a
 * property of the type, not of a code path — and nothing here writes to the configuration.
 *
 * ## Six probes, one of them opt-in
 *
 * `application-name-sticky` writes session state, which under a pooler leaks a value onto a shared
 * server connection. It is off by default and asks for `{ probeSessionState: true }`.
 */

import type { PgConnection, PgDriver } from '../driver/types.js'
import type { PoolStats } from '../errors/index.js'
import type { PoolerMode } from './profiles.js'

export interface DiagnosticSignal {
  readonly name:
    | 'backend-pid-across-statements'
    | 'backend-pid-within-transaction'
    | 'named-statement-survives'
    | 'application-name-sticky'
    | 'hostname-heuristic'
    | 'server-version'
  readonly result:
    | 'supports-direct'
    | 'supports-transaction-pooling'
    | 'supports-session-pooling'
    | 'inconclusive'
  readonly detail: string
}

export interface PoolerDiagnosis {
  readonly verdict: 'direct' | 'likely-session-pooled' | 'likely-transaction-pooled' | 'inconclusive'
  /** Never `'high'`. This is a heuristic, by construction. */
  readonly confidence: 'low' | 'medium'
  readonly recommendedPoolerMode: PoolerMode
  readonly configuredPoolerMode: PoolerMode
  readonly agrees: boolean
  readonly signals: readonly DiagnosticSignal[]
  readonly warnings: readonly string[]
}

export interface DiagnosePoolerOptions {
  /** Turns on `application-name-sticky`, which writes session state. Off by default. */
  readonly probeSessionState?: boolean
  /** The URL or host we were configured with, for the zero-cost hostname heuristic. */
  readonly host?: string | undefined
}

export interface DbDiagnosis {
  readonly serverVersion: string | undefined
  readonly serverVersionNum: number | undefined
  readonly pool: PoolStats | undefined
  /** The GUCs that actually apply on a fresh connection, read back with `SHOW`. */
  readonly effectiveSettings: Readonly<Record<string, string>>
  /** `07` §1.2's arithmetic, with the observed numbers. */
  readonly connections: {
    readonly maxConnections: number | undefined
    readonly superuserReserved: number | undefined
    readonly inUse: number | undefined
    /** `instances × poolOptions.max ≤ pooler default_pool_size` — our half of it. */
    readonly poolMax: number | undefined
    readonly headroom: number | undefined
  }
  /** The exec-mode downgrade of `07` §2.4 policy 4, if it has happened. */
  readonly statements: {
    readonly statement: 'unnamed' | 'named'
    readonly selfHeals: number
    readonly downgraded: boolean
    readonly assertShape: boolean
  }
  readonly poolerMode: PoolerMode
  readonly pooler: PoolerDiagnosis | undefined
  readonly notes: readonly string[]
}

type Exec = (conn: PgConnection, sql: string, params?: readonly string[]) => Promise<readonly (readonly unknown[])[]>

const exec: Exec = async (conn, sql, params = []) => {
  const r = await conn.execute({ text: sql, params: params as string[] })
  return r.rows as readonly (readonly unknown[])[]
}

function cell(rows: readonly (readonly unknown[])[]): string | undefined {
  const v = rows[0]?.[0]
  return v === null || v === undefined ? undefined : String(v)
}

/**
 * The behavioural probe.
 *
 * Probe 1 and 2 are the classic pair — the same `pg_backend_pid()` twice, once as two autocommit
 * statements and once inside a transaction. Different pids across statements is strong evidence of
 * transaction pooling; different pids *within* one transaction means something is badly broken and
 * we say so loudly rather than guessing.
 *
 * Probe 3 is the decisive one for the question we actually care about, which is not "is there a
 * pooler" but "can I use named statements": prepare a trivial named statement, then execute it by
 * name in a *separate* protocol exchange. Success means named statements are usable (direct,
 * session, or PgBouncer ≥ 1.24); `26000` means they are not. It is the only probe that
 * distinguishes `pgbouncer-transaction` from `transaction`.
 */
export async function diagnosePooler(
  driver: PgDriver,
  configured: PoolerMode,
  opts: DiagnosePoolerOptions = {},
): Promise<PoolerDiagnosis> {
  const signals: DiagnosticSignal[] = []
  const warnings: string[] = []

  const hostSignal = hostnameHeuristic(opts.host)
  if (hostSignal !== undefined) signals.push(hostSignal)

  const conn = await driver.acquire()
  let namedWorks: boolean | undefined
  let pidsDiffer = false
  try {
    const version = cell(await exec(conn, 'select version()'))
    signals.push({
      name: 'server-version',
      result: 'inconclusive',
      detail: version ?? 'version() returned nothing',
    })

    // 1 — the same statement twice on the same pool client, then again UNDER CONTENTION.
    //
    // ⚠️ **`07` §5.4's probe 1 as written is a false negative, and this is measured.** Two
    // consecutive autocommit statements through an *idle* PgBouncer land on the SAME server
    // connection — the pooler has no reason to reassign one — so "different pids ⇒ transaction
    // pooling" never fires for the one-client case that a diagnostic is most often run in.
    // Measured against `pgprime-s-bouncer` (`pool_mode=transaction`): 343, 343. Occupy the other
    // server connections first and the same probe reads 343, 364, while a direct connection reads
    // 359, 359 either way — because a real backend is *ours* and cannot be reassigned. So the
    // probe creates the contention it needs, and only reports `supports-direct` when the pid held
    // still under it.
    const a = cell(await exec(conn, 'select pg_catalog.pg_backend_pid()'))
    const b = cell(await exec(conn, 'select pg_catalog.pg_backend_pid()'))
    let c2 = b
    if (a === b) c2 = await pidUnderContention(driver, conn, a)
    pidsDiffer = a !== b || a !== c2
    signals.push({
      name: 'backend-pid-across-statements',
      result: pidsDiffer ? 'supports-transaction-pooling' : 'supports-direct',
      detail: pidsDiffer
        ? `this client's statements ran on backends ${String(a)} and ${String(a === b ? c2 : b)}. ` +
          `A real backend belongs to the connection and cannot be reassigned, so something is ` +
          `pooling — though a reconnect between them would look identical, which is why confidence ` +
          `is never better than medium.`
        : `the same backend (${String(a)}) answered every statement, including under contention ` +
          `from other pooled connections.`,
    })

    // 2 — the same pair inside one transaction. They MUST be equal.
    await exec(conn, 'begin')
    const c = cell(await exec(conn, 'select pg_catalog.pg_backend_pid()'))
    const d = cell(await exec(conn, 'select pg_catalog.pg_backend_pid()'))
    await exec(conn, 'commit')
    const stableInTx = c === d
    if (!stableInTx) {
      warnings.push(
        `pg-prime: two statements INSIDE one transaction ran on different backends (${String(c)} vs ` +
          `${String(d)}). That is not transaction pooling, it is broken — no correct pooler ` +
          `reassigns a connection mid-transaction. Investigate the proxy before trusting anything ` +
          `else in this report.`,
      )
    }
    signals.push({
      name: 'backend-pid-within-transaction',
      result: stableInTx ? 'supports-direct' : 'inconclusive',
      detail: stableInTx
        ? `stable within a transaction (${String(c)}), as any correct pooler guarantees.`
        : `UNSTABLE within a transaction — see the warning.`,
    })

    // 3 — the decisive probe.
    namedWorks = await namedStatementSurvives(conn)
    signals.push({
      name: 'named-statement-survives',
      result: namedWorks ? 'supports-session-pooling' : 'supports-transaction-pooling',
      detail: namedWorks
        ? 'a named statement prepared in one exchange executed in another, so protocol-level ' +
          'prepared statements are usable here.'
        : 'a named statement did not survive to a second exchange (26000), so this is a ' +
          'transaction pooler without prepared-statement tracking.',
    })

    // 4 — opt-in, because it writes session state.
    if (opts.probeSessionState === true) {
      const marker = `pgprime_probe_${Math.random().toString(36).slice(2, 10)}`
      await exec(conn, 'select set_config($1,$2,false)', ['application_name', marker])
      const read = cell(await exec(conn, 'select current_setting($1)', ['application_name']))
      const sticky = read === marker
      signals.push({
        name: 'application-name-sticky',
        result: sticky ? 'supports-direct' : 'supports-transaction-pooling',
        detail: sticky
          ? 'session state set on one statement was visible on the next.'
          : 'session state set on one statement was NOT visible on the next.',
      })
    }
  } finally {
    await driver.release(conn, { dispose: true })
  }

  const verdict: PoolerDiagnosis['verdict'] = pidsDiffer
    ? 'likely-transaction-pooled'
    : namedWorks === false
      ? 'likely-transaction-pooled'
      : 'direct'
  const recommended: PoolerMode =
    verdict === 'direct'
      ? 'none'
      : namedWorks === true
        ? 'pgbouncer-transaction'
        : 'transaction'
  return Object.freeze({
    verdict,
    // Medium once the decisive probe answered; low when only the pid pair spoke.
    confidence: namedWorks === undefined ? 'low' : 'medium',
    recommendedPoolerMode: recommended,
    configuredPoolerMode: configured,
    agrees: agrees(recommended, configured),
    signals: Object.freeze(signals),
    warnings: Object.freeze(warnings),
  })
}

/**
 * A recommendation of `none` is *satisfied* by any configured mode — a profile only ever
 * restricts, so being more conservative than necessary is a performance choice and not a mismatch.
 * The other direction is what matters.
 */
function agrees(recommended: PoolerMode, configured: PoolerMode): boolean {
  if (recommended === configured) return true
  if (recommended === 'none') return true
  if (recommended === 'pgbouncer-transaction') return configured === 'transaction'
  return false
}

/**
 * Read the pid again while the other pooled connections are busy.
 *
 * A transaction pooler assigns a server connection per transaction, so it only *has* to move us
 * when the one we had is taken. Three concurrent sleeps are enough to make that happen and cost
 * about 60 ms. A pool of one cannot produce contention, so the answer is simply the original pid
 * and the probe stays silent rather than guessing.
 */
async function pidUnderContention(
  driver: PgDriver,
  conn: PgConnection,
  original: string | undefined,
): Promise<string | undefined> {
  // In parallel and on a 250 ms budget each: a pool that has nothing spare must not turn a
  // diagnostic into a `connectionTimeoutMillis` wait, and a pool of one cannot produce contention
  // at all — in which case the probe stays silent rather than guessing.
  const attempts = await Promise.all(
    [0, 1, 2].map(async () => {
      const signal = AbortSignal.timeout(250)
      return driver.acquire({ signal }).catch(() => undefined)
    }),
  )
  const others = attempts.filter((c): c is PgConnection => c !== undefined)
  if (others.length === 0) return original
  try {
    // The read happens **while** the others are still holding their server connections, not after
    // — a pooler only has to move us when the one we had is taken, and by the time three sleeps
    // have resolved it is free again. Measured: reading afterwards reports the same pid.
    const busy = others.map((c) => exec(c, 'select pg_catalog.pg_sleep(0.25)').catch(() => []))
    await new Promise((r) => setTimeout(r, 40))
    const pid = cell(await exec(conn, 'select pg_catalog.pg_backend_pid()'))
    await Promise.all(busy)
    return pid
  } finally {
    for (const c of others) await driver.release(c).catch(() => {})
  }
}

async function namedStatementSurvives(conn: PgConnection): Promise<boolean> {
  const name = `pgprime_probe_${Math.floor(Math.random() * 1e6).toString(36)}`
  try {
    await conn.execute({ text: 'select 1', params: [], mode: 'named', statementName: name })
    await conn.execute({ text: 'select 1', params: [], mode: 'named', statementName: name })
    return true
  } catch {
    return false
  } finally {
    // Protocol `Close`, never SQL `DEALLOCATE` — the ban in `07` §2.4 applies to our own probes too.
    await conn.closeStatement?.(name).catch(() => {})
  }
}

/** Zero cost, always run: the shapes of the four poolers people actually deploy. */
function hostnameHeuristic(host: string | undefined): DiagnosticSignal | undefined {
  if (host === undefined || host === '') return undefined
  const h = host.toLowerCase()
  const hit =
    h.includes('-pooler.') || h.includes('.pooler.supabase.com')
      ? 'a Neon -pooler / Supabase pooler hostname'
      : /:6543(\/|$|\?)/.test(h)
        ? 'Supabase port 6543, which is Supavisor in transaction mode'
        : /\.proxy-[a-z0-9]+\.[a-z0-9-]+\.rds\.amazonaws\.com/.test(h)
          ? 'an RDS Proxy endpoint'
          : undefined
  if (hit === undefined) {
    return {
      name: 'hostname-heuristic',
      result: 'inconclusive',
      detail: 'the host does not match a known pooler endpoint shape.',
    }
  }
  return {
    name: 'hostname-heuristic',
    result: 'supports-transaction-pooling',
    detail: `the host looks like ${hit}.`,
  }
}

/** The GUCs `07` §3.6 governs, read back with `SHOW` so `diagnose()` reports the *observed* values. */
const EFFECTIVE = [
  'application_name',
  'statement_timeout',
  'lock_timeout',
  'idle_in_transaction_session_timeout',
  'search_path',
  'TimeZone',
  'DateStyle',
  'default_transaction_isolation',
] as const

export interface DiagnoseInputs {
  readonly driver: PgDriver
  readonly poolerMode: PoolerMode
  readonly poolStats: PoolStats | undefined
  readonly statements: DbDiagnosis['statements']
  readonly notes: readonly string[]
  readonly pooler: PoolerDiagnosis | undefined
}

export async function diagnose(inputs: DiagnoseInputs): Promise<DbDiagnosis> {
  const conn = await inputs.driver.acquire()
  const settings: Record<string, string> = {}
  let maxConnections: number | undefined
  let superuserReserved: number | undefined
  let inUse: number | undefined
  let version: string | undefined
  try {
    version = cell(await exec(conn, 'select version()'))
    const rows = await exec(
      conn,
      'select name, setting from pg_catalog.pg_settings where name = any($1)',
      [`{${EFFECTIVE.join(',')}}`],
    )
    for (const row of rows) settings[String(row[0])] = String(row[1])
    maxConnections = numeric(settings['max_connections'] ?? cell(await exec(conn, 'show max_connections')))
    superuserReserved = numeric(cell(await exec(conn, 'show superuser_reserved_connections')))
    inUse = numeric(cell(await exec(conn, 'select count(*) from pg_catalog.pg_stat_activity')))
  } finally {
    await inputs.driver.release(conn)
  }
  const poolMax = inputs.poolStats?.max
  const headroom =
    maxConnections === undefined || inUse === undefined
      ? undefined
      : maxConnections - inUse - (superuserReserved ?? 0)
  return Object.freeze({
    serverVersion: version,
    serverVersionNum: inputs.driver.capabilities.serverVersionNum,
    pool: inputs.poolStats,
    effectiveSettings: Object.freeze(settings),
    connections: Object.freeze({ maxConnections, superuserReserved, inUse, poolMax, headroom }),
    statements: inputs.statements,
    poolerMode: inputs.poolerMode,
    pooler: inputs.pooler,
    notes: Object.freeze(inputs.notes),
  })
}

function numeric(v: string | undefined): number | undefined {
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
