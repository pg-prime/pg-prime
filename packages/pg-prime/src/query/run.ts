/**
 * `pgPrime(config)` — design/07 §1.1's `createDb`, under the name the rename record fixed
 * (decision 1 of design/12 §1).
 *
 * ## Synchronous and lazy
 *
 * `pgPrime` opens no sockets. Importing a module that builds a handle is side-effect-free, which
 * matters for serverless cold starts and for the test file that imports the schema and never
 * queries. `connection:` therefore cannot build its pool here — building it needs
 * `await import('pg')` — so the driver is a **promise the first statement awaits**, and everything
 * downstream goes through one `driverOf()` that memoises it.
 *
 * ## What this file is and is not
 *
 * It is the assembly point: config → validation → `SessionState` → an `ExecutorImpl` with the
 * session methods installed. The behaviour lives in `src/session/`, `src/errors/`, `src/observe/`
 * and `src/pooler/`; the two runners that used to live here moved to `src/session/runner.ts`
 * because every cross-cutting concern in `07` lands on that seam.
 */

import type { CodecRegistry } from '../codec/index.js'
import { Registry, defaultRegistry } from '../codec/index.js'
import type { PgConnection, PgDriver } from '../driver/index.js'
import { pgDriver } from '../driver/index.js'
import type { PgLikePool } from '../driver/pg-like.js'
import { resolveErrorOptions } from '../errors/index.js'
import type { PoolStats, ResolvedErrorOptions } from '../errors/index.js'
import { HookBus, resolveLogOptions } from '../observe/index.js'
import type { QueryHooks, ResolvedLogOptions, SpanContext } from '../observe/index.js'
import { POOLER_PROFILES, alterRoleHint, diagnose, diagnosePooler } from '../pooler/index.js'
import type { DbDiagnosis, DiagnosePoolerOptions, PoolerDiagnosis, PoolerMode } from '../pooler/index.js'
import type { AnySchema, RelsRecord, Tables } from '../schema/index.js'
import { BuilderError } from '../sql/errors.js'
import {
  assertOneConnectionSource,
  assertStatementModeAllowed,
  inProduction,
  poolSizeWarning,
} from '../session/config.js'
import type { DbConfig } from '../session/config.js'
import {
  attachDeps,
  install,
  installGetter,
  installQueryable,
  runSession,
  runTransaction,
} from '../session/handles.js'
import type { CopyFromApi, CopyToApi, TxDeps } from '../session/handles.js'
import { ListenHub, listenUnsupported } from '../session/listen.js'
import { buildPool } from '../session/pg-lazy.js'
import { PoolRunner } from '../session/runner.js'
import type { SessionState } from '../session/runner.js'
import { resolveSessionSettings } from '../session/gucs.js'
import type { ListenOptions, NotificationHandler } from '../session/types.js'
import type { BuilderCtx } from './builder-state.js'
import { ExecutorImpl, makeExecutor } from './cte.js'
import type { ExecEnv, ExecOptions } from './executor.js'
import { makeEnv } from './executor.js'
import type { Db, Executor, Queryable } from './types.js'

/**
 * `07` §1.1's `DbConfig`, kept under the name every existing call site uses.
 *
 * The `driver:` form is what the whole test suite is written against and it stays; `connection:`
 * and `pool:` are the two `07` adds.
 */
export interface PgPrimeOptions<Sc extends AnySchema> extends DbConfig<Sc> {}

function handlesOf(schema: AnySchema): Readonly<Record<string, object>> {
  const h = (schema as { h?: Record<string, object> }).h
  if (h === undefined) {
    throw new BuilderError('pg-prime: pgPrime({ schema }) needs a schema from `defineSchema(...)`.')
  }
  return h
}

function relsOf(schema: AnySchema): RelsRecord<Tables> | undefined {
  return (schema as { rels?: RelsRecord<Tables> }).rels
}

function tablesOf(schema: AnySchema): Tables | undefined {
  return (schema as { tables?: Tables }).tables
}

/**
 * A driver that may not exist yet.
 *
 * `connection:` needs `await import('pg')`, and `pgPrime` is synchronous. Rather than make the
 * whole API async (which would make module-level `export const db = pgPrime(...)` impossible —
 * the very thing §1.1 wants), the driver is resolved on first use and memoised. Every entry point
 * that touches a connection goes through `driverOf`, and `PgDriver` itself is never handed out
 * half-built.
 */
class LazyDriver {
  #resolved: PgDriver | undefined
  #pending: Promise<PgDriver> | undefined
  readonly #make: () => Promise<PgDriver>
  /** For `diagnose()` and the pooler heuristic. Known only once the pool exists. */
  host: string | undefined
  database: string | undefined
  #pool: PgLikePool | undefined

  constructor(make: () => Promise<PgDriver>) {
    this.#make = make
  }

  get settled(): PgDriver | undefined {
    return this.#resolved
  }

  get pool(): PgLikePool | undefined {
    return this.#pool
  }

  setPool(pool: PgLikePool | undefined): void {
    this.#pool = pool
  }

  async get(): Promise<PgDriver> {
    if (this.#resolved !== undefined) return this.#resolved
    this.#pending ??= this.#make()
    this.#resolved = await this.#pending
    return this.#resolved
  }
}

/**
 * A `PgDriver` facade over {@link LazyDriver}.
 *
 * `SessionState.driver` is typed `PgDriver` and is used on every statement; making every call site
 * `await` a promise instead would spread the laziness through the whole runtime. Four methods
 * forward; `capabilities` reports the real ones once the driver exists and a conservative
 * placeholder before that (nothing reads it before the first connect except `diagnose()`).
 */
function facade(lazy: LazyDriver): PgDriver {
  const placeholder = {
    adapter: 'pending',
    execModes: ['unnamed', 'named', 'simple'] as const,
    binaryResults: false,
    paramTypeOids: true,
    describe: true,
    richFieldMetadata: true,
    cursors: true,
    copyIn: true,
    copyOut: true,
    listenNotify: true,
    cancel: 'pg_cancel_backend' as const,
    multipleStatementsPerSession: true,
    maxConnections: undefined,
    maxParams: 65535,
    serverVersionNum: undefined,
  }
  return {
    async init() {
      await (await lazy.get()).init()
    },
    async acquire(options) {
      return (await lazy.get()).acquire(options)
    },
    async release(connection, options) {
      return (await lazy.get()).release(connection, options)
    },
    async connect(options) {
      const d = await lazy.get()
      if (d.connect === undefined) return d.acquire(options)
      return d.connect(options)
    },
    async destroy() {
      if (lazy.settled === undefined) return
      await lazy.settled.destroy()
    },
    get capabilities() {
      return lazy.settled?.capabilities ?? placeholder
    },
  }
}

/**
 * `pgPrime(config)` — the one constructor.
 *
 * Everything that can be wrong about the configuration is decided here, eagerly, before a socket
 * exists: exactly one connection source, no named statements under a profile that forbids them,
 * no session GUCs under a transaction profile (with the `ALTER ROLE` fix named once, at `info`).
 */
export function pgPrime<Sc extends AnySchema>(config: PgPrimeOptions<Sc>): Db<Sc> {
  const source = assertOneConnectionSource(config as DbConfig<AnySchema>)
  assertStatementModeAllowed(config.statement, config.poolerMode)

  const poolerMode: PoolerMode = config.poolerMode ?? 'none'
  const profile = POOLER_PROFILES[poolerMode]
  const production = inProduction()
  const errors: ResolvedErrorOptions = resolveErrorOptions(config.errors, production)
  const hooks = new HookBus()
  hooks.add(config.hooks)

  let logLevel: string = config.log?.level ?? 'warn'
  const warn = (message: string): void => {
    if (logLevel === 'silent') return
    console.warn(message)
  }
  const log: ResolvedLogOptions = resolveLogOptions(config.log, production, warn)
  logLevel = log.level

  // A **fresh** registry per `pgPrime(...)`, not the process-wide default. A registry is per
  // physical database (`02` §4.6): `resolveDynamic` writes this database's enum and domain OIDs
  // into it, and those OIDs are not stable across databases.
  const registry: CodecRegistry = config.registry ?? new Registry()
  const execOptions: ExecOptions = config
  // One env per db, shared by `db` and every `tx` it opens: the prepared-statement downgrade is a
  // property of the *pool* (`07` §2.4 policy 4), so a transaction must not get a fresh counter.
  const env: ExecEnv = makeEnv(registry, execOptions)

  const { settings, skipped } = resolveSessionSettings(config.session, profile)
  if (skipped.length > 0) {
    const message =
      `pg-prime: session defaults (${skipped.join(', ')}) were NOT applied, because poolerMode ` +
      `'${poolerMode}' means a SET at connect lands on a server connection the pooler will hand to ` +
      `another client — the setting would leak across tenants (07 §3.6). ${alterRoleHint(skipped)}`
    if (log.level !== 'silent') console.info(message)
    hooks.internal({ kind: 'session-guc-skipped', message })
  }

  if (source !== 'connection' && config.session !== undefined && settings.length > 0) {
    if (log.level === 'debug') {
      console.info(
        `pg-prime: session defaults (${settings.map(([n]) => n).join(', ')}) will be applied with ` +
          `one set_config batch per physical connection, because pgPrime was given a ${source} ` +
          `rather than a connection string — there is no startup packet of ours to put them in ` +
          `(07 §3.6).`,
      )
    }
  }

  const lazy = new LazyDriver(async () => {
    if (source === 'driver') return config.driver as PgDriver
    if (source === 'pool') {
      lazy.setPool(config.pool)
      return pgDriver({ pool: config.pool as PgLikePool })
    }
    const built = await buildPool(
      config.connection as string,
      config.poolOptions,
      // When WE build the pool the GUCs ride the startup packet — zero per-query cost, and
      // `connectSettings` below is then empty so nothing is emitted per connection (07 §3.6).
      settings,
      config.session,
    )
    lazy.setPool(built.pool)
    lazy.host = built.host
    lazy.database = built.database
    const direct =
      config.directConnection === undefined
        ? undefined
        : await buildPool(config.directConnection as string, config.poolOptions, settings, config.session)
    if (direct !== undefined) lazy.setPool(built.pool)
    return pgDriver({
      pool: built.pool,
      ...(direct === undefined ? {} : { directPool: direct.pool }),
      createCancelClient: () => built.makeClient() as never,
      createDedicatedClient: () => (direct ?? built).makeClient() as never,
    })
  })

  const driver = facade(lazy)
  const poolStats = (): PoolStats | undefined => {
    const p = lazy.pool
    if (p === undefined) return undefined
    return {
      total: p.totalCount ?? 0,
      idle: p.idleCount ?? 0,
      waiting: p.waitingCount ?? 0,
      max: typeof p.options?.['max'] === 'number' ? (p.options['max'] as number) : undefined,
    }
  }

  const spanContext: SpanContext = {}
  const state: SessionState = {
    driver,
    schema: config.schema,
    env,
    hooks,
    errors,
    log,
    poolerMode,
    profile,
    devGuard: config.devGuard ?? !production,
    session: config.session,
    // `07` §3.6's mechanism, resolved per connection source:
    //
    //  - `connection:` — we built the pool, so `07` §3.6's own fallback applies: one `set_config`
    //    batch per **physical** connection. Not the startup packet's `options=`, which PgBouncer
    //    rejects with a FATAL — measured; see `src/session/pg-lazy.ts`. `application_name` is
    //    dropped from the batch because it rides the startup packet as pg's own field.
    //  - `pool:` / `driver:` — we did not build it, so we do not touch the session **unless the
    //    caller passed `session:` explicitly**. Reaching into somebody's Pool to `SET` things they
    //    did not ask for is exactly the surprise `02` §4.7 forbids ("pg-prime never SETs session
    //    GUCs; configure it on your own Pool"), and it would put a statement on the wire before
    //    every user's first query.
    //  - any transaction profile — always empty; `resolveSessionSettings` already refused, and the
    //    `info` line above named the settings and the `ALTER ROLE` fix.
    connectSettings:
      source === 'connection'
        ? settings.filter(([n]) => n !== 'application_name')
        : config.session === undefined
          ? EMPTY_SETTINGS
          : settings,
    transaction: config.transaction,
    signal: config.signal,
    spanContext,
    poolStats,
    configured: new WeakSet<object>(),
    ended: false,
    warn,
  }

  const runner = new PoolRunner(state, {}, 'db')
  const ctxSeed: BuilderCtx = {
    registry,
    runner: undefined,
    tables: tablesOf(config.schema),
    rels: relsOf(config.schema),
  }
  const handles = handlesOf(config.schema)
  const deps: TxDeps = { state, ctxSeed, handles }
  attachDeps(runner, deps)

  const db = makeExecutor({ ...ctxSeed, runner }, handles) as unknown as Db<Sc>
  installQueryable(db, state, runner, 'db')
  installDbMembers(db as unknown as object, state, deps, lazy, config)

  if (config.signal !== undefined) {
    config.signal.addEventListener('abort', () => void (db as { end(): Promise<void> }).end(), {
      once: true,
    })
  }
  maybeWarnAtStartup(state, lazy, config)
  return db
}

const EMPTY_SETTINGS: readonly (readonly [string, string])[] = Object.freeze([])

function installDbMembers(
  db: object,
  state: SessionState,
  deps: TxDeps,
  lazy: LazyDriver,
  config: DbConfig<AnySchema>,
): void {
  install(db, 'transaction', <T>(a: unknown, b?: unknown) =>
    runTransaction<T>(deps, 0, a as never, b as never),
  )
  install(db, 'session', <T>(fn: (s: object) => Promise<T>) => runSession(deps, fn))

  const listen = new ListenHub({
    async openDedicated() {
      if (state.profile.listen === 'unsupported' && config.directConnection === undefined) {
        throw listenUnsupported(state.poolerMode)
      }
      const d = state.driver
      if (d.connect === undefined) throw listenUnsupported(state.poolerMode)
      return d.connect(state.profile.listen === 'unsupported' ? { route: 'direct' } : undefined)
    },
    async closeDedicated(conn: PgConnection) {
      await state.driver.release(conn, { dispose: true })
    },
    errors: state.errors,
    reconnect: { baseDelayMs: 100, maxDelayMs: 30_000 },
    warn: state.warn,
    internal: (kind, message, cause) => state.hooks.internal({ kind, message, cause }),
  })

  install(db, 'listen', (channel: string, handler: NotificationHandler, opts?: ListenOptions) =>
    listen.subscribe(channel, handler, opts?.signal),
  )
  installGetter(db, 'listenBackendPid', () => listen.backendPid)

  install(db, 'stats', () => state.poolStats())

  install(db, 'observe', (hooks: QueryHooks) => state.hooks.add(hooks))

  install(db, 'connect', async () => {
    await state.driver.init()
  })

  install(db, 'diagnosePooler', async (opts?: DiagnosePoolerOptions): Promise<PoolerDiagnosis> =>
    diagnosePooler(state.driver, state.poolerMode, {
      ...opts,
      host: opts?.host ?? lazy.host ?? hostOfConfig(config),
    }),
  )

  install(db, 'diagnose', async (): Promise<DbDiagnosis> =>
    diagnose({
      driver: state.driver,
      poolerMode: state.poolerMode,
      poolStats: state.poolStats(),
      statements: {
        statement: state.env.statement,
        selfHeals: state.env.named.selfHeals,
        downgraded: state.env.named.downgraded,
        assertShape: state.env.assertShape,
      },
      notes: notesFor(state),
      pooler: undefined,
    }),
  )

  const end = async (): Promise<void> => {
    if (state.ended) return
    state.ended = true
    await listen.close().catch(() => {})
    await state.driver.destroy()
  }
  install(db, 'end', end)
  install(db, Symbol.asyncDispose as unknown as string, end)
}

function hostOfConfig(config: DbConfig<AnySchema>): string | undefined {
  const c = config.connection
  return typeof c === 'string' ? c : undefined
}

function notesFor(state: SessionState): readonly string[] {
  const notes: string[] = []
  if (state.env.named.downgraded) {
    notes.push(
      'This pool has PERMANENTLY downgraded to the unnamed extended protocol after repeated ' +
        'prepared-statement self-heals (07 §2.4 policy 4). It is a one-way door for the process ' +
        'lifetime.',
    )
  }
  if (state.connectSettings.length === 0 && state.profile.sessionGucsAtConnect === 'unsafe') {
    notes.push(
      `Session GUCs are not applied under poolerMode '${state.poolerMode}'. The values reported ` +
        'above are the server/role defaults; set them with ALTER ROLE (07 §3.6).',
    )
  }
  return notes
}

/**
 * `07` §5.4's dev-mode startup check: **once, asynchronously, non-blocking**, and never in
 * production.
 *
 * Blocking the first query on a heuristic would be startup latency for a guess (§8 rejection 25).
 * So this fires on the next tick after something has already connected, and only says something
 * when the probe and the configuration disagree.
 */
function maybeWarnAtStartup(state: SessionState, lazy: LazyDriver, config: DbConfig<AnySchema>): void {
  if (!state.devGuard) return
  const max = config.poolOptions?.max ?? 10
  const sizeWarning = poolSizeWarning(max, undefined)
  if (sizeWarning !== undefined) state.warn(sizeWarning)
  void lazy
}

/**
 * Executor-level counters, for diagnostics and for the tier-2 pin (`07` §2.4 policy 4).
 *
 * Folded into `db.diagnose().statements` as `07` §5.4 asks, and kept as a free function because it
 * is synchronous and `diagnose()` is not: a test that wants to know whether the pool downgraded
 * should not have to open a connection to find out.
 */
export interface StatementStats {
  readonly statement: 'unnamed' | 'named'
  /** Consecutive self-heal events since the last successful named execution (`07` §2.4). */
  readonly selfHeals: number
  /** True once the pool has permanently fallen back to unnamed. A one-way door. */
  readonly downgraded: boolean
  readonly assertShape: boolean
}

export function statementStats(db: Executor | Db<AnySchema> | Queryable<AnySchema>): StatementStats {
  const env = (db as unknown as ExecutorImpl).ctx?.runner?.env
  if (env === undefined) {
    throw new BuilderError(
      'pg-prime: statementStats() needs a db built by pgPrime({ driver, schema }); a compileOnly() ' +
        'executor has no runner and therefore no statistics.',
    )
  }
  return {
    statement: env.statement,
    selfHeals: env.named.selfHeals,
    downgraded: env.named.downgraded,
    assertShape: env.assertShape,
  }
}

/**
 * A builder with no database: `.compile()` works, `.execute()` throws with a sentence saying why.
 *
 * This is what the tier-0 suites use, and it is a real product surface — `.toSQL()` for a
 * migration tool, a lint rule, or a test that wants the SQL and nothing else.
 */
export function compileOnly<Sc extends AnySchema>(schema: Sc, registry?: CodecRegistry): Queryable<Sc> {
  const executor = makeExecutor(
    {
      registry: registry ?? defaultRegistry(),
      runner: undefined,
      tables: tablesOf(schema),
      rels: relsOf(schema),
    },
    handlesOf(schema),
  )
  installGetter(executor, 'schema', () => schema)
  installGetter(executor, 'kind', () => 'db')
  return executor as unknown as Queryable<Sc>
}

/** Re-exported so `pg-prime`'s barrel needs one import for the constructor and its config. */
export type { CopyFromApi, CopyToApi, DbConfig }
