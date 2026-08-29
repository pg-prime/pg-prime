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
      'pgPrime({ connection }) builds the pool with `pg`, which is not installed. It is an ' +
        'OPTIONAL peer dependency: install it (`npm i pg`), or pass `pool:` (any pg-like pool — ' +
        '@neondatabase/serverless and a Hyperdrive-fed pool both satisfy it structurally) or ' +
        '`driver:` (your own PgDriver) instead. Those two paths need nothing at all (07 §1.1).',
      { cause },
    )
  }
  const m = mod as {
    Pool?: unknown
    default?: { Pool?: unknown; Client?: unknown }
    Client?: unknown
  }
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
 * ⚠️ **`07` §3.6's primary mechanism does not survive contact with a pooler, and that is measured.**
 *
 * §3.6 says session GUCs ride the startup packet as libpq's `options=-c statement_timeout=30s …`,
 * at zero per-query cost, with "a single `SET` in pg-pool's onConnect hook" as the fallback *"if
 * the startup-parameter path proves unreliable for any setting at implementation time"*. It does:
 * **PgBouncer 1.25 rejects the whole connection with FATAL `08P01 unsupported startup parameter in
 * options: statement_timeout`** — so pointing `connection:` at a pooler while leaving `poolerMode`
 * at its default would not merely lose the GUCs, it would fail to connect at all. Measured against
 * `pgprime-s-bouncer`, `pool_mode=transaction`; the tier-2 test that found it is
 * `test/pg/session-pooler.test.ts`.
 *
 * So the fallback is the mechanism, uniformly: one `set_config` batch per **physical** connection
 * (`applyConnectSettings` in `src/session/runner.ts`), which costs one statement per connection
 * lifetime rather than one per query and works identically for `connection:`, `pool:` and
 * `driver:`. This function is kept because it is exactly the right shape if a future pooler
 * forwards `options` — and because deleting the measurement would invite someone to try it again.
 *
 * `application_name` is the exception and stays in the startup packet: it is pg's own top-level
 * connection field, not part of `options`, PgBouncer forwards it per client, and it changes no
 * query semantics — so it is free, safe in every profile, and it is the difference between a
 * readable and an unreadable `pg_stat_activity`.
 */
export function startupOptions(
  settings: readonly (readonly [string, string])[],
): string | undefined {
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
 * `pg.Pool` is an `EventEmitter`; {@link PgLikePool} does not require `on`, because a duck-typed
 * drop-in does not have to be one. Asked for optionally, so this file can subscribe when it is
 * there without widening the seam every user-supplied pool must satisfy.
 */
type MaybePoolEmitter = {
  on?: (event: 'error', listener: (err: unknown) => void) => unknown
}

/**
 * Build the pool `07` §1.2 describes, with the two `pg-pool` defaults §1.2 argues are hostile
 * overridden and everything else passed through untouched.
 *
 * `onIdleError` is not optional decoration — see the listener's own comment below.
 */
export async function buildPool(
  connection: string | ConnectionParams,
  poolOptions: PoolOptions | undefined,
  connectSettings: readonly (readonly [string, string])[],
  session: SessionDefaults | undefined,
  onIdleError?: (err: unknown) => void,
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
  // Deliberately NOT `base['options'] = startupOptions(connectSettings)` — see the docblock above.
  void connectSettings

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

  // ── The pool's own `error` listener, which is what keeps the process alive ─────────────────
  //
  // pg-pool hands each client an `idleListener` while it sits in the idle set
  // (`pg-pool/index.js` `makeIdleListener`): on an error it removes the client, closes it, and
  // re-emits `('error', err, client)` on the POOL. An `EventEmitter` `error` with no listener
  // throws, so `pg_terminate_backend` / `idle_session_timeout` / a server restart against an idle
  // pooled connection took the host process down — as an uncaught `57P01`, not a rejected promise.
  //
  // The shape is `pg-adapter.ts`'s `#onClientError` for a CHECKED-OUT client (~L200), one level up
  // and one degree quieter: there the adapter owns the connection, so it records the failure and
  // flips `usable`; here pg-pool has ALREADY removed and destroyed the client before it emits, so
  // there is no state of ours left to correct and nothing for the caller to catch — no statement
  // was in flight. What is left is observability, and the runtime already has exactly one channel
  // for "something we decided on our own": `hooks.onInternal` (`07` §7.1). Silence would be the
  // other defensible answer; it is rejected because a fleet losing idle connections is a real
  // signal (a failover, a pooler restart, a too-short `idle_session_timeout`) and an event nobody
  // subscribes to costs nothing.
  const emitter = pool as PgLikePool & MaybePoolEmitter
  if (typeof emitter.on === 'function') {
    emitter.on('error', (err) => onIdleError?.(err))
  }

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
