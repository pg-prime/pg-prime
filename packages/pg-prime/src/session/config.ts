/**
 * `pgPrime(config)` — design/07 §1.1's `createDb`, under the name the rename record fixed
 * (decision 1 of design/12 §1).
 *
 * `pgPrime` is **synchronous and lazy**: it opens no sockets, so importing a module that builds a
 * handle is side-effect-free. That matters for serverless cold starts and for the test file that
 * imports the schema and never queries.
 *
 * Everything that can be wrong about a configuration is caught **here**, eagerly, with a
 * `ConfigError` naming the key — never at the first query. `07` §2.3: *"restriction is loud and
 * immediate — we never silently downgrade a mode the user explicitly asked for, because a silent
 * downgrade is how Prisma #21799 happened."*
 */

import type { CodecRegistry } from '../codec/index.js'
import type { PgDriver } from '../driver/types.js'
import type { PgLikePool } from '../driver/pg-like.js'
import { ConfigError } from '../errors/index.js'
import type { ErrorOptions } from '../errors/index.js'
import type { LogOptions, QueryHooks } from '../observe/index.js'
import type { PoolerMode } from '../pooler/profiles.js'
import { POOLER_PROFILES } from '../pooler/profiles.js'
import type { ExecOptions } from '../query/executor.js'
import type { AnySchema } from '../schema/index.js'
import type {
  ConnectionParams,
  PoolOptions,
  SessionDefaults,
  TransactionDefaults,
} from './types.js'

export interface DbConfig<Sc extends AnySchema> extends ExecOptions {
  /** Powers typing, codec resolution for user types, and constraint→table error mapping (§4.4). */
  readonly schema: Sc

  // ── Connection: exactly one of these three ─────────────────────────────────
  /**
   * Connection string or discrete params. We build the pool through the bundled `pg` adapter,
   * which means a lazy `import('pg')` on the first connect and an **optional** peer dependency
   * (decision 2 of design/12 §1). `pool:` and `driver:` remain the zero-dependency paths.
   */
  readonly connection?: string | ConnectionParams
  /**
   * Bring your own pool. Structurally typed — `pg.Pool`, `@neondatabase/serverless`'s Pool and a
   * Hyperdrive-fed pool all satisfy it with zero adapter code (`02` §3).
   */
  readonly pool?: PgLikePool
  /** Full seam override: your own driver implementation. What every existing test uses. */
  readonly driver?: PgDriver

  /**
   * A second, non-pooled URL. Required when `poolerMode` is a transaction mode **and** you use
   * migrations, `db.listen()`, session advisory locks or `WITH HOLD` cursors. Routed *by feature,
   * not by call site* — the user never picks a connection manually.
   */
  readonly directConnection?: string | ConnectionParams

  // ── Execution policy ───────────────────────────────────────────────────────
  /** Default `'none'`. §5. A profile can only ever restrict. */
  readonly poolerMode?: PoolerMode

  // ── Pool ───────────────────────────────────────────────────────────────────
  /** §1.2. Only consulted when **we** build the pool; named to avoid colliding with `pool`. */
  readonly poolOptions?: PoolOptions

  // ── Session GUCs at connection setup (poolerMode 'none' | 'session' only) ──
  readonly session?: SessionDefaults

  // ── Types ──────────────────────────────────────────────────────────────────
  /** Overrides on top of the ORM-owned OID→codec table. We NEVER call pg's global `setTypeParser`. */
  readonly registry?: CodecRegistry

  // ── Transactions ───────────────────────────────────────────────────────────
  readonly transaction?: TransactionDefaults

  // ── Observability & errors ─────────────────────────────────────────────────
  readonly hooks?: QueryHooks
  readonly log?: LogOptions
  /** §4.3 — the redaction policy. */
  readonly errors?: ErrorOptions
  /** Default: `NODE_ENV !== 'production'`. §1.5 layer 3. */
  readonly devGuard?: boolean

  /** Abort → graceful pool drain. Lets `pgPrime` participate in a process lifecycle signal. */
  readonly signal?: AbortSignal
}

/**
 * Presets ship as plain functions returning a partial config, so they **compose and are
 * inspectable** — `{ ...presets.serverless(), max: 3 }` is a legal thing to write and to read.
 */
export const presets = {
  serverless: (): Partial<DbConfig<never>> => ({
    poolOptions: {
      max: 1,
      idleTimeoutMillis: 1_000,
      allowExitOnIdle: true,
      connectionTimeoutMillis: 5_000,
    },
  }),
  neonPooled: (): Partial<DbConfig<never>> => ({
    poolerMode: 'pgbouncer-transaction',
    ...presets.serverless(),
  }),
  /** Supavisor at `:6543` does not carry named statements through. */
  supabaseTransaction: (): Partial<DbConfig<never>> => ({ poolerMode: 'transaction' }),
  rdsProxy: (): Partial<DbConfig<never>> => ({ poolerMode: 'pgbouncer-transaction' }),
} as const

// ─────────────────────────────────────────────────────────────────────────────
// Validation — everything here throws at construction, never at the first query
// ─────────────────────────────────────────────────────────────────────────────

/** `07` §1.2's defaults, with the two `pg-pool` overrides that §1.2 argues for. */
export const POOL_DEFAULTS: Required<Pick<
  PoolOptions,
  'max' | 'min' | 'idleTimeoutMillis' | 'connectionTimeoutMillis' | 'maxLifetimeSeconds' | 'allowExitOnIdle'
>> = Object.freeze({
  max: 10,
  min: 0,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
  maxLifetimeSeconds: 1_800,
  allowExitOnIdle: false,
})

export function assertOneConnectionSource(config: DbConfig<AnySchema>): 'connection' | 'pool' | 'driver' {
  const given: string[] = []
  if (config.connection !== undefined) given.push('connection')
  if (config.pool !== undefined) given.push('pool')
  if (config.driver !== undefined) given.push('driver')
  if (given.length === 1) return given[0] as 'connection' | 'pool' | 'driver'
  if (given.length === 0) {
    throw new ConfigError(
      'pgPrime(config) needs exactly one of `connection` (a URL or params — we build the pool ' +
        'through the bundled pg adapter), `pool` (your own pg-like pool) or `driver` (your own ' +
        'PgDriver). None was given.',
    )
  }
  throw new ConfigError(
    `pgPrime(config) needs exactly ONE of \`connection\`, \`pool\` and \`driver\`; ${given.length} ` +
      `were given (${given.join(', ')}). They are three ways to say the same thing and there is no ` +
      `sensible precedence between them.`,
  )
}

/**
 * `execMode: 'prepared'` under a profile that forbids it throws **at construction** (`07` §2.3 and
 * §5.2's matrix), naming the profile. This is the loud half of "restriction is loud and immediate".
 */
export function assertStatementModeAllowed(
  statement: string | undefined,
  poolerMode: PoolerMode | undefined,
): void {
  if (statement !== 'named') return
  const mode = poolerMode ?? 'none'
  if (POOLER_PROFILES[mode].namedPreparedStatements !== 'unsupported') return
  throw new ConfigError(
    `statement: 'named' is not available under poolerMode: '${mode}', which is the profile for a ` +
      `transaction pooler WITHOUT protocol-level prepared statements (Supavisor :6543, PgBouncer ` +
      `with max_prepared_statements=0). Named statements would be lost between transactions and ` +
      `every execution would 26000. Use the default (unnamed extended protocol), which is one ` +
      `round trip and safe on every pooler, or switch to poolerMode: 'pgbouncer-transaction' if ` +
      `your pooler does track them (07 §5.2).`,
  )
}

/** `07` §1.2's multiplication warning, as a dev-mode startup check. */
export function poolSizeWarning(max: number, maxConnections: number | undefined): string | undefined {
  if (max > 20) {
    return (
      `pg-prime: poolOptions.max is ${max}. Node is single-threaded — past roughly 10 in-flight ` +
      `queries one process is almost always bottlenecked on the event loop or on PostgreSQL's own ` +
      `CPU, not on connection count. The number that actually matters is instances × max (07 §1.2).`
    )
  }
  if (maxConnections !== undefined && max * 4 > maxConnections) {
    return (
      `pg-prime: poolOptions.max (${max}) × 4 exceeds the server's max_connections ` +
      `(${maxConnections}). Four app instances would exhaust it. See db.diagnose() for the full ` +
      `arithmetic (07 §1.2).`
    )
  }
  return undefined
}

/** Resolved once, cached; the same rule `src/query/executor.ts` follows and for the same reasons. */
let productionDefault: boolean | undefined
export function inProduction(): boolean {
  productionDefault ??=
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
      'NODE_ENV'
    ] === 'production'
  return productionDefault
}

/** @internal — tests flip `NODE_ENV` between cases and need the memo cleared. */
export function resetProductionMemo(): void {
  productionDefault = undefined
}
