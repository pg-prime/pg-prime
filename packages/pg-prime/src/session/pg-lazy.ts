/**
 * `connection: '<url>'` — building a pool from `pg`, without depending on `pg` (decision 2 of
 * design/12 §1).
 *
 * ## Why an *optional* peer, and why the import is dynamic
 *
 * `08` §6.2 #7 says zero peer dependencies, and `pool:` / `driver:` honour that literally — they
 * are the zero-dependency paths and they are what every test in this repo uses. But `07` §1.1 has
 * always said "we build the pool via the bundled `pg` adapter" for `connection:`, and you cannot
 * build a `pg.Pool` without `pg`. An optional peer (`peerDependenciesMeta`) resolved by a lazy
 * `import('pg')` **on the first connect** is the honest shape: nothing is required to install it,
 * nothing is required to import it, and a program that never writes `connection:` never loads it.
 *
 * The tree-shake golden is the enforcement: `fixtures/treeshake/connect-one-select` builds a
 * handle and runs a select, and its `expected-modules.json` contains no `pg`. A static import here
 * would put `pg` in that graph and the check would go red — which is exactly what it is for.
 */

import { ConfigError } from '../errors/index.js'
import type { PgLikePool } from '../driver/pg-like.js'
import type { ConnectionParams, PoolOptions, SessionDefaults } from './types.js'
import { POOL_DEFAULTS } from './config.js'

interface PgModule {
  readonly Pool: new (config: Record<string, unknown>) => PgLikePool
  readonly Client: new (config: Record<string, unknown>) => unknown
}

let cached: Promise<PgModule> | undefined

/** One dynamic import per process, memoised, with the error that names the package. */
export async function loadPg(): Promise<PgModule> {
  cached ??= importPg()
  return cached
}

async function importPg(): Promise<PgModule> {
  let mod: unknown
  try {
    mod = await import(/* @vite-ignore */ 'pg')
  } catch (cause) {
    cached = undefined
    throw new ConfigError(
      "pgPrime({ connection }) builds the pool with `pg`, which is not installed. It is an " +
        'OPTIONAL peer dependency: install it (`npm i pg`), or pass `pool:` (any pg-like pool — ' +
        '@neondatabase/serverless and a Hyperdrive-fed pool both satisfy it structurally) or ' +
        '`driver:` (your own PgDriver) instead. Those two paths need nothing at all (07 §1.1).',
      { cause },
    )
  }
  const m = mod as { Pool?: unknown; default?: { Pool?: unknown; Client?: unknown }; Client?: unknown }
  const Pool = (m.Pool ?? m.default?.Pool) as PgModule['Pool'] | undefined
  const Client = (m.Client ?? m.default?.Client) as PgModule['Client'] | undefined
  if (typeof Pool !== 'function' || typeof Client !== 'function') {
    cached = undefined
    throw new ConfigError(
      "pgPrime({ connection }) resolved 'pg' but it exports no Pool/Client constructor. Is it a " +
        'shim? Pass `pool:` with an already-constructed pool instead.',
    )
  }
  return { Pool, Client }
}

/**
 * `07` §3.6's primary mechanism: session GUCs in the **startup packet**, via libpq's `options`
 * parameter, at zero per-query cost.
 *
 * Only reachable when we build the pool, which is the only time we control the startup packet. The
 * `pool:` / `driver:` paths get the fallback — one `set_config` batch per physical connection,
 * `src/session/runner.ts`'s `applyConnectSettings`.
 *
 * Values are `-c name=value` and PostgreSQL's own parser handles them, so anything with a space is
 * backslash-escaped rather than quoted (`options` is space-separated).
 */
export function startupOptions(settings: readonly (readonly [string, string])[]): string | undefined {
  if (settings.length === 0) return undefined
  return settings.map(([n, v]) => `-c ${n}=${v.replace(/[\\ ]/g, (c) => `\\${c}`)}`).join(' ')
}

export interface BuiltPool {
  readonly pool: PgLikePool
  readonly makeClient: () => unknown
  readonly host: string | undefined
  readonly database: string | undefined
  readonly port: number | undefined
}

/**
 * Build the pool `07` §1.2 describes, with the two `pg-pool` defaults §1.2 argues are hostile
 * overridden and everything else passed through untouched.
 */
export async function buildPool(
  connection: string | ConnectionParams,
  poolOptions: PoolOptions | undefined,
  connectSettings: readonly (readonly [string, string])[],
  session: SessionDefaults | undefined,
): Promise<BuiltPool> {
  const { Pool, Client } = await loadPg()
  const base: Record<string, unknown> =
    typeof connection === 'string' ? { connectionString: connection } : { ...connection }
  if (typeof connection !== 'string' && connection.applicationName !== undefined) {
    base['application_name'] = connection.applicationName
    delete base['applicationName']
  }
  const appName = session?.applicationName
  if (appName !== undefined && base['application_name'] === undefined) {
    base['application_name'] = appName
  }
  const options = startupOptions(connectSettings)
  if (options !== undefined) base['options'] = options

  const config: Record<string, unknown> = {
    ...base,
    max: poolOptions?.max ?? POOL_DEFAULTS.max,
    min: poolOptions?.min ?? POOL_DEFAULTS.min,
    idleTimeoutMillis: poolOptions?.idleTimeoutMillis ?? POOL_DEFAULTS.idleTimeoutMillis,
    connectionTimeoutMillis:
      poolOptions?.connectionTimeoutMillis ?? POOL_DEFAULTS.connectionTimeoutMillis,
    maxLifetimeSeconds: poolOptions?.maxLifetimeSeconds ?? POOL_DEFAULTS.maxLifetimeSeconds,
    allowExitOnIdle: poolOptions?.allowExitOnIdle ?? POOL_DEFAULTS.allowExitOnIdle,
    ...(poolOptions?.maxUses === undefined ? {} : { maxUses: poolOptions.maxUses }),
  }
  const pool = new Pool(config)
  return {
    pool,
    // `07` §6.1's control connection: an UNCONNECTED client that knows how to open its own socket
    // and send a protocol CancelRequest. Derived from the same config, so the user never
    // configures one and we never own a second credential.
    makeClient: () => new Client(base),
    host: typeof base['host'] === 'string' ? base['host'] : hostOf(base['connectionString']),
    database: typeof base['database'] === 'string' ? base['database'] : undefined,
    port: typeof base['port'] === 'number' ? base['port'] : undefined,
  }
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}
