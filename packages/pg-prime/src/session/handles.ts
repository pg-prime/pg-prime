/**
 * `Db`, `Tx` and `Session` at runtime (design/07 §1.3, §1.4, §3, §6).
 *
 * ## Three handles, one query surface
 *
 * `07` §1.4 is the argument for the third: "I need the same backend for several statements but I
 * do not want a transaction" is a real, currently unserved need — a session advisory lock held
 * across several transactions, a `CREATE TEMP TABLE` staging area, `SET search_path` for a legacy
 * path, `pg_backend_pid()` diagnostics. It costs one type and about forty lines, and it gives the
 * pooler matrix a natural home: `Session` is *precisely* the handle a transaction pooler cannot
 * support, so `poolerMode` gates one type instead of being sprinkled through the codebase.
 *
 * ## Why the methods are installed rather than inherited
 *
 * The builder surface (`from` / `insertInto` / `update` / `deleteFrom` / `with` / `sql`) lives on
 * `ExecutorImpl`, which `src/query/cte.ts` owns and which this workstream must not touch. So a
 * handle **is** an `ExecutorImpl` with the session methods defined on the instance. That is not a
 * workaround: `db.with(...)` returns a plain executor by design — a CTE builder is not a handle
 * and should not sprout `transaction()`.
 */

import type { Compiled } from '../compile/contract.js'
import type { PgConnection } from '../driver/types.js'
import {
  AbortError,
  IndeterminateCommitError,
  TransactionRollback,
  UnsupportedInPoolerModeError,
  UsageError,
  captureCallSite,
  mapError,
  sqlStateOfError,
} from '../errors/index.js'
import type { PgPrimeError } from '../errors/index.js'
import { nextTxId } from '../observe/index.js'
import { isTransactionPooled } from '../pooler/profiles.js'
import type { BuilderCtx } from '../query/builder-state.js'
import { ExecutorImpl, makeExecutor } from '../query/cte.js'
import type { ExplainOptions, ExplainResult, RunOptions, StreamOptions } from '../query/executor.js'
import { streamBatchesOn, streamOn } from '../query/executor.js'
import { explainWith } from '../query/terminals.js'
import { metaOf } from '../query/meta.js'
import type { TableLike } from '../query/meta.js'
import {
  assertCopyIn,
  assertCopyOut,
  copyColumns,
  copyFromSql,
  copyLines,
  encodeCopyRows,
} from './copy.js'
import { assertPayloadSize } from './listen.js'
import { quoteIdentPart } from '../sql/ident.js'
import type { AnyMaterializedView } from '../schema/index.js'
import { ASYNC_DISPOSE, ensureGuardStore, withFrame, withoutFrames } from './guard.js'
import { ConnRunner, PoolRunner, acquire, release } from './runner.js'
import type { SessionState, StatementOptions, TxRuntime } from './runner.js'
import {
  advisoryFn,
  advisoryKey,
  advisoryUnlockFn,
  assertGucName,
  beginSql,
  releaseSavepointSql,
  resolveRetry,
  retryDelayMs,
  rollbackToSavepointSql,
  savepointSql,
  setConfigParams,
  setConfigSql,
} from './transaction.js'
import type {
  AccessMode,
  AdvisoryLock,
  AdvisoryLockOptions,
  CallOptions,
  CopyOptions,
  CopyResult,
  IsolationLevel,
  Runnable,
  RunCallOptions,
  SavepointOptions,
  StreamCallOptions,
  TxOptions,
} from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Shared plumbing
// ─────────────────────────────────────────────────────────────────────────────

type AnyRunner = PoolRunner | ConnRunner

function compiledOf<O>(q: Runnable<O>): Compiled<O> {
  const c = q as { compile?: () => Compiled<O> }
  if (typeof c.compile === 'function') return c.compile()
  const maybe = q as Partial<Compiled<O>>
  if (typeof maybe.sql === 'string' && Array.isArray(maybe.binds)) return q as Compiled<O>
  throw new UsageError(
    'pg-prime: run(q) takes a query builder, a prepared query or a Compiled. It cannot take a ' +
      '`db.sql`…`` statement, which has no static decode plan by design (03 §1.4c) — call ' +
      '.execute() on it, or db.withOptions({ … }).sql`…`.execute() if you wanted the options.',
  )
}

/**
 * `undefined` rather than `{}` when the caller passed nothing: `BaseRunner.merged` returns its
 * defaults unchanged for `undefined` and builds a seven-way spread for anything else, so the empty
 * object this used to mint cost two allocations per `run(q)` to say "no options".
 */
function runOptions(o: RunCallOptions | undefined): RunOptions | undefined {
  return o as RunOptions | undefined
}

/** Define a method that does not show up in `Object.keys(db)` — handles stay printable. */
function install(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, {
    value,
    enumerable: false,
    configurable: true,
    writable: false,
  })
}

function installGetter(target: object, name: string, get: () => unknown): void {
  Object.defineProperty(target, name, { get, enumerable: false, configurable: true })
}

/**
 * The `Queryable` half every handle shares (`07` §1.3): `run`, `explain`, `stream`,
 * `streamBatches`, `notify`, `withOptions`, plus the `schema` back-reference.
 */
function installQueryable(
  handle: object,
  state: SessionState,
  runner: AnyRunner,
  kind: 'db' | 'tx' | 'session',
): void {
  installGetter(handle, 'kind', () => kind)
  installGetter(handle, 'schema', () => state.schema)

  install(handle, 'run', <O>(q: Runnable<O>, opts?: RunCallOptions): Promise<O[]> =>
    runner.run(compiledOf(q), runOptions(opts)),
  )

  install(handle, 'explain', <O>(q: Runnable<O>, opts?: ExplainOptions): Promise<ExplainResult> =>
    explainWith(ctxOf(handle), compiledOf(q) as Compiled<unknown>, opts),
  )

  install(handle, 'stream', <O>(q: Runnable<O>, opts?: StreamCallOptions): AsyncIterable<O> => {
    const compiled = compiledOf(q)
    const scoped = withStreamOptions(runner, opts)
    return scoped.scope((conn) => streamOn(conn, compiled, state.env, streamOpts(opts)))
  })

  install(
    handle,
    'streamBatches',
    <O>(q: Runnable<O>, opts?: StreamCallOptions): AsyncIterable<O[]> => {
      const compiled = compiledOf(q)
      const scoped = withStreamOptions(runner, opts)
      return scoped.scope((conn) => streamBatchesOn(conn, compiled, state.env, streamOpts(opts)))
    },
  )

  /**
   * `pg_notify($1, $2)`, never `NOTIFY chan, 'literal'` — the SQL form needs identifier quoting for
   * the channel and literal escaping for the payload, i.e. two injection surfaces for zero
   * benefit. Works inside a transaction, delivering on commit, which is usually what you want.
   */
  install(handle, 'notify', async (channel: string, payload = ''): Promise<void> => {
    assertPayloadSize(payload)
    await runner.use(async (conn) => {
      await conn.execute({ text: 'select pg_catalog.pg_notify($1,$2)', params: [channel, payload] })
    })
  })

  // COPY is on every handle: it is transaction-scoped, so it works in every pooler profile, and
  // the common shape is a load inside the transaction that also writes the audit row.
  install(handle, 'copyFrom', makeCopyFrom(state, runner))
  install(handle, 'copyTo', makeCopyTo(state, runner))

  // REFRESH MATERIALIZED VIEW, for the same reason (design/01 §3 row 58).
  install(
    handle,
    'refreshMaterializedView',
    async (view: AnyMaterializedView, opts?: RefreshMaterializedViewOptions): Promise<void> => {
      const text = refreshSql(view, opts)
      // `runRaw`, not `use`: a refresh is a statement, so it earns `07` §7.1's start/end/error
      // events, §7.3's slow-query record, §4's error mapping and §6.2's per-statement timeout —
      // exactly like `db.sql`…``. Going straight to `conn.execute` would have made the one
      // statement in the API that people most want to see in a log the one they cannot.
      await runner.runRaw<never>({
        sql: text,
        paramCount: 0,
        paramTypes: EMPTY_OIDS,
        operation: 'other',
        tables: [view.$.view.name],
        paramValues: () => EMPTY_PARAMS,
        async perform(conn, _env, o) {
          const r = await conn.execute({
            text,
            params: [],
            ...(o.signal === undefined ? {} : { signal: o.signal }),
          })
          return { rows: [], rowCount: r.rowCount ?? 0 }
        },
      })
    },
  )

  // Installed here only for the ROOT handle, whose scoped clone is a plain `Queryable`. A `Tx` and
  // a `Session` re-install their own, because their scoped clone must still be a `Tx` / a `Session`
  // — the type says so, and a clone that had lost `savepoint` or `set` would be a runtime
  // `TypeError` behind a green compile.
  if (kind === 'db') {
    install(handle, 'withOptions', (opts: CallOptions) => makeScoped(state, runner, kind, opts))
    install(handle, 'outsideTransaction', () =>
      makeScoped(state, runner, kind, { outsideTransaction: true }),
    )
  }
}

function streamOpts(opts: StreamCallOptions | undefined): (StreamOptions & RunOptions) | undefined {
  if (opts === undefined) return undefined
  return {
    ...(opts.batchSize === undefined ? {} : { batchSize: opts.batchSize }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    ...(opts.statement === undefined ? {} : { statement: opts.statement }),
  }
}

function withStreamOptions(runner: AnyRunner, opts: StreamCallOptions | undefined): AnyRunner {
  if (opts === undefined) return runner
  const extra: StatementOptions = {
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    ...(opts.label === undefined ? {} : { label: opts.label }),
  }
  const withTimeout =
    opts.statementTimeoutMs === undefined
      ? extra
      : { ...extra, statementTimeoutMs: opts.statementTimeoutMs }
  return runner.with(withTimeout as StatementOptions)
}

function ctxOf(handle: object): BuilderCtx {
  return (handle as unknown as ExecutorImpl).ctx
}

/**
 * `db.withOptions({ signal, timeoutMs, label })` — the same handle kind, with per-statement
 * defaults folded into a sibling runner.
 *
 * This is where `07` §6.1's per-terminal `.signal(s)` and `.timeout(ms)` land as built. Those two
 * are specified as methods on the *builder*, which would mean editing `Query` in
 * `src/query/types.ts` and `src/query/select.ts` — both owned by another workstream this round —
 * so the capability ships one level up, on the handle, where the session layer owns every file:
 * `db.withOptions({ signal }).from(users)…execute()` is the same statement with the same signal,
 * and `run(q, { signal })` is the other spelling and needs no scope at all.
 */
function makeScoped(
  state: SessionState,
  runner: AnyRunner,
  kind: 'db' | 'tx' | 'session',
  opts: CallOptions,
): object {
  const deps = depsOf(runner)
  const next = runner.with(opts as StatementOptions) as AnyRunner
  attachDeps(next, deps)
  const scoped = makeExecutor({ ...deps.ctxSeed, runner: next }, deps.handles)
  installQueryable(scoped, state, next, kind)
  return scoped
}

/** The seeds a scoped clone needs, carried on the runner so `Runner` does not have to widen. */
const DEPS = Symbol('pg-prime.deps')

function attachDeps(runner: AnyRunner, deps: TxDeps): void {
  Object.defineProperty(runner, DEPS, { value: deps, enumerable: false, configurable: true })
}

function depsOf(runner: AnyRunner): TxDeps {
  const deps = (runner as unknown as Record<symbol, TxDeps | undefined>)[DEPS]
  if (deps === undefined) {
    throw new UsageError(
      'pg-prime: this handle was built without session deps. This is a bug in pg-prime.',
    )
  }
  return deps
}

// ─────────────────────────────────────────────────────────────────────────────
// Transactions (§3)
// ─────────────────────────────────────────────────────────────────────────────

export interface TxDeps {
  readonly state: SessionState
  readonly ctxSeed: BuilderCtx
  readonly handles: Readonly<Record<string, object>>
}

type Callback<T> = (tx: object) => Promise<T>

function splitArgs<T>(
  a: Callback<T> | TxOptions | undefined,
  b: Callback<T> | TxOptions | undefined,
): { fn: Callback<T>; opts: TxOptions } {
  if (typeof a === 'function') return { fn: a, opts: (b as TxOptions | undefined) ?? {} }
  if (typeof b === 'function') return { fn: b, opts: (a as TxOptions | undefined) ?? {} }
  throw new UsageError(
    'pg-prime: db.transaction(fn, opts?) or db.transaction(opts, fn) — one of the two arguments ' +
      'must be the callback.',
  )
}

/** A sentinel the runner throws through so `rollbackWith(v)` can resolve with `v`. */
const DOOMED = Symbol('pg-prime.rollbackWith')
interface Doomed {
  readonly [DOOMED]: true
  readonly value: unknown
}
function isDoomed(v: unknown): v is Doomed {
  return typeof v === 'object' && v !== null && DOOMED in v
}

/**
 * The outermost `transaction()`: acquire, `BEGIN`, run, `COMMIT`/`ROLLBACK`, release — with `07`
 * §3.4's retry loop around the whole thing.
 *
 * Two properties are worth reading the code for.
 *
 * **The `finally` destroys a connection whose `transactionStatus` is not `'I'`.** A connection
 * returned to the pool in state `T` or `E` becomes the *next* borrower's transaction: their first
 * statement silently joins it, and an eventual `ROLLBACK` throws away work they never saw. `02`'s
 * adapter checks this too; doing it here as well means the invariant does not depend on which
 * adapter you plugged in.
 *
 * **`commitWritten` is what makes `IndeterminateCommitError` possible.** If the connection dies
 * after we wrote `COMMIT` and before we read the response, the transaction **may have committed**.
 * Retrying is a correctness bug, not a latency trade-off — it is how you double-charge a card — so
 * the flag is set immediately before the await and the connection-loss branch below raises the one
 * error class in this library that is deliberately not a `ConnectionError`.
 */
export async function runTransaction<T>(
  deps: TxDeps,
  parentDepth: number,
  a: Callback<T> | TxOptions | undefined,
  b: Callback<T> | TxOptions | undefined,
): Promise<T> {
  const { fn, opts } = splitArgs(a, b)
  const state = deps.state
  const defaults = state.transaction
  const isolation = (opts.isolation ?? defaults?.isolation) as IsolationLevel | undefined
  const accessMode = (opts.accessMode ?? defaults?.accessMode) as AccessMode | undefined
  const label = opts.label ?? defaults?.label
  const retry = resolveRetry(opts.retry ?? defaults?.retry, isolation)
  const begin = beginSql({
    ...(isolation === undefined ? {} : { isolation }),
    ...(accessMode === undefined ? {} : { accessMode }),
    ...((opts as { deferrable?: boolean }).deferrable === undefined
      ? {}
      : { deferrable: (opts as { deferrable?: boolean }).deferrable }),
  })
  const timeoutMs = opts.timeoutMs ?? defaults?.timeoutMs
  const lockTimeoutMs = opts.lockTimeoutMs ?? defaults?.lockTimeoutMs
  const txId = nextTxId()
  const openedAt = state.errors.captureCallSite ? captureCallSite(runTransaction) : undefined

  // The dev guard's AsyncLocalStorage is imported here, lazily, inside an `await` that already
  // exists — so `node:async_hooks` never enters a bundle that does not open a transaction, and
  // the tree-shake golden can assert it (07 §1.6).
  if (state.devGuard) await ensureGuardStore()

  let attempt = 0
  for (;;) {
    attempt += 1
    const startedAt = performance.now()
    state.hooks.transactionStart({
      txId,
      depth: parentDepth,
      attempt,
      isolation,
      accessMode,
      startedAt,
      ...(label === undefined ? {} : { label }),
    })
    let outcome: 'commit' | 'rollback' | 'error' = 'error'
    let thrown: PgPrimeError | undefined
    try {
      const value = await once(deps, {
        begin,
        txId,
        attempt,
        depth: parentDepth,
        ...(label === undefined ? {} : { label }),
        ...(isolation === undefined ? {} : { isolation }),
        ...(accessMode === undefined ? {} : { accessMode }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
        ...(opts.localSettings === undefined ? {} : { localSettings: opts.localSettings }),
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        ...(openedAt === undefined ? {} : { openedAt }),
        fn,
      })
      outcome = value.rolledBack ? 'rollback' : 'commit'
      return value.result as T
    } catch (e) {
      thrown = e as PgPrimeError
      const decision = shouldRetry(e, retry, attempt)
      if (decision === undefined) throw e
      const delayMs = retryDelayMs(retry, attempt)
      // The FIRST retry logs at warn, so retries are visible in production rather than silent.
      if (attempt === 1) {
        state.warn(
          `pg-prime: retrying transaction${label === undefined ? '' : ` "${label}"`} after ` +
            `SQLSTATE ${decision} (attempt ${attempt} of ${retry.maxAttempts}, sleeping ` +
            `${delayMs.toFixed(0)} ms). Your callback must be idempotent — every non-database ` +
            `side effect in it runs again (07 §3.4).`,
        )
      }
      const info = { err: e, attempt, delayMs, ...(label === undefined ? {} : { label }) }
      state.hooks.retry({
        err: e as PgPrimeError,
        attempt,
        delayMs,
        txId,
        ...(label === undefined ? {} : { label }),
      })
      retry.onRetry?.(info)
      await sleep(delayMs)
    } finally {
      state.hooks.transactionEnd({
        txId,
        depth: parentDepth,
        attempt,
        isolation,
        accessMode,
        startedAt,
        outcome,
        durationMs: performance.now() - startedAt,
        ...(label === undefined ? {} : { label }),
        ...(thrown === undefined ? {} : { error: thrown }),
      })
    }
  }
}

interface OnceArgs<T> {
  readonly begin: string
  readonly txId: string
  readonly attempt: number
  readonly depth: number
  readonly label?: string
  readonly isolation?: IsolationLevel
  readonly accessMode?: AccessMode
  readonly timeoutMs?: number
  readonly lockTimeoutMs?: number
  readonly localSettings?: Readonly<Record<string, string | number | boolean>>
  readonly signal?: AbortSignal
  readonly openedAt?: string
  readonly fn: Callback<T>
}

async function once<T>(
  deps: TxDeps,
  a: OnceArgs<T>,
): Promise<{ result: unknown; rolledBack: boolean }> {
  const state = deps.state
  const lease = await acquire(state, a.signal ?? state.signal)
  const tx: TxRuntime = {
    txId: a.txId,
    attempt: a.attempt,
    depth: a.depth,
    doomed: false,
    closed: false,
    poison: { error: undefined },
    inFlight: 0,
    warned: false,
    localTimeoutMs: undefined,
    baselineTimeoutMs: a.timeoutMs,
    label: a.label,
  }
  let commitWritten = false
  let dispose = false
  try {
    await lease.conn.execute({ text: a.begin, params: [], mode: 'simple' })
    // §3.5: `localSettings` and the two timeouts go out in ONE round trip, immediately after BEGIN.
    const settings: Record<string, string | number | boolean> = { ...a.localSettings }
    if (a.timeoutMs !== undefined) settings['statement_timeout'] = a.timeoutMs
    if (a.lockTimeoutMs !== undefined) settings['lock_timeout'] = a.lockTimeoutMs
    const names = Object.keys(settings)
    if (names.length > 0) {
      await lease.conn.execute({
        text: setConfigSql(names.length, true),
        params: setConfigParams(settings) as string[],
      })
      if (a.timeoutMs !== undefined) tx.localTimeoutMs = a.timeoutMs
    }

    const handle = makeTxHandle(deps, lease.conn, tx, {
      ...(a.isolation === undefined ? {} : { isolation: a.isolation }),
      ...(a.accessMode === undefined ? {} : { accessMode: a.accessMode }),
      ...(a.signal === undefined ? {} : { signal: a.signal }),
      ...(a.label === undefined ? {} : { label: a.label }),
    })

    let result: unknown
    try {
      result = await withFrame(
        { txId: a.txId, label: a.label, openedAt: a.openedAt, depth: a.depth },
        () => a.fn(handle),
      )
    } catch (e) {
      if (isDoomed(e)) {
        await lease.conn.execute({ text: 'rollback', params: [], mode: 'simple' }).catch(() => {})
        return { result: e.value, rolledBack: true }
      }
      throw e
    }
    if (tx.doomed) {
      await lease.conn.execute({ text: 'rollback', params: [], mode: 'simple' }).catch(() => {})
      return { result, rolledBack: true }
    }
    commitWritten = true
    await lease.conn.execute({ text: 'commit', params: [], mode: 'simple' })
    commitWritten = false
    return { result, rolledBack: false }
  } catch (raw) {
    const mapped = mapError(raw, {
      context: {
        handle: 'tx',
        attempt: a.attempt,
        depth: a.depth,
        txId: a.txId,
        ...(a.label === undefined ? {} : { label: a.label }),
      },
      errors: state.errors,
      schema: state.schema,
    })
    if (commitWritten && lostConnection(raw)) {
      dispose = true
      throw new IndeterminateCommitError(
        `pg-prime: the connection was lost after COMMIT was written and before it was ` +
          `acknowledged, so THIS TRANSACTION MAY HAVE COMMITTED. It is not retried and never will ` +
          `be — re-running the callback is how you double-charge a card. Determine the outcome ` +
          `from the data (an idempotency key, a unique constraint, a read of the row) before you ` +
          `act (07 §3.4, §4.2).`,
        {
          cause: mapped,
          context: {
            handle: 'tx',
            attempt: a.attempt,
            depth: a.depth,
            txId: a.txId,
            ...(a.label === undefined ? {} : { label: a.label }),
          },
        },
      )
    }
    if (!commitWritten) {
      await lease.conn.execute({ text: 'rollback', params: [], mode: 'simple' }).catch(() => {
        // A ROLLBACK that itself fails means the connection is gone; destroy rather than reuse.
        dispose = true
      })
    }
    throw mapped
  } finally {
    tx.closed = true
    // §3.1: a connection returning to the pool in 'T' or 'E' is a bug. `undefined` means the
    // adapter cannot tell us, and disposing on "don't know" would recycle every connection.
    const status = lease.conn.transactionStatus
    if (status === 'T' || status === 'E') {
      dispose = true
      state.warn(
        `pg-prime: a connection was about to return to the pool with transactionStatus '${status}' ` +
          `(an open or failed transaction). It has been destroyed instead — the next borrower would ` +
          `have silently joined it (07 §3.1).`,
      )
    }
    if (!lease.conn.usable) dispose = true
    await release(state, lease, dispose)
  }
}

/**
 * The SQLSTATE we are retrying on, or `undefined` for "do not retry" (`07` §3.4).
 *
 * The three hard exclusions come **first and unconditionally**, above `shouldRetry`, because §3.4
 * calls them hard: a user predicate that returns `true` for everything must not be able to
 * re-run a transaction that may have committed, that the caller aborted, or that failed for a
 * reason no database produced. `shouldRetry` is the *last word on a retryable error*, not a
 * licence.
 */
function shouldRetry(
  e: unknown,
  retry: ReturnType<typeof resolveRetry>,
  attempt: number,
): string | undefined {
  if (attempt >= retry.maxAttempts) return undefined

  // Exclusion 1: the transaction MAY HAVE COMMITTED. Retrying is how you double-charge a card.
  if (e instanceof IndeterminateCommitError) return undefined
  // Exclusion 2: the caller's signal fired; retrying contradicts the caller.
  if (e instanceof AbortError) return undefined
  // Exclusion 4: a UsageError is our bug or yours, never a transient database condition — and
  // that includes `rollback()`, which is a deliberate abort wearing an error.
  if (e instanceof UsageError) return undefined

  const state = sqlStateOfError(e) ?? (e as { code?: string } | undefined)?.code
  if (state === undefined || !retry.on.includes(state)) {
    return retry.shouldRetry?.(e, attempt) === true ? (state ?? 'unknown') : undefined
  }
  // Exclusion 3 lives where it is observable: a partially-consumed stream cannot reach here,
  // because `PoolRunner.scope` owns its own transaction and never enters this loop.
  if (retry.shouldRetry !== undefined && !retry.shouldRetry(e, attempt)) return undefined
  return state
}

function lostConnection(e: unknown): boolean {
  const data = (
    e as { pgPrime?: { kind?: string; connectionUnusable?: boolean } } | null | undefined
  )?.pgPrime
  if (data !== undefined) {
    if (data.kind === 'connection' || data.kind === 'protocol' || data.kind === 'timeout')
      return true
    if (data.connectionUnusable === true) return true
  }
  const state = sqlStateOfError(e)
  return state !== undefined && (state.startsWith('08') || state === '57P01')
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((r) => {
    const t = setTimeout(r, ms)
    ;(t as unknown as { unref?: () => void }).unref?.()
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// The Tx handle
// ─────────────────────────────────────────────────────────────────────────────

interface TxShape {
  readonly isolation?: IsolationLevel
  readonly accessMode?: AccessMode
  readonly signal?: AbortSignal
  readonly label?: string
}

export function makeTxHandle(
  deps: TxDeps,
  conn: PgConnection,
  tx: TxRuntime,
  shape: TxShape,
  extra: CallOptions = {},
): object {
  const state = deps.state
  const defaults: StatementOptions = {
    ...(shape.signal === undefined ? {} : { signal: shape.signal }),
    ...(shape.label === undefined ? {} : { label: shape.label }),
    ...extra,
  }
  const runner = new ConnRunner(state, defaults, conn, tx, 'tx')
  const ctx: BuilderCtx = { ...deps.ctxSeed, runner }
  const handle = makeExecutor(ctx, deps.handles)
  attachDeps(runner, deps)
  installQueryable(handle, state, runner, 'tx')

  installGetter(handle, 'attempt', () => tx.attempt)
  installGetter(handle, 'depth', () => tx.depth)
  installGetter(handle, 'isolation', () => shape.isolation ?? 'read committed')
  installGetter(handle, 'accessMode', () => shape.accessMode ?? 'read write')
  installGetter(handle, 'status', () => {
    const s = conn.transactionStatus
    return s === 'E' ? 'failed' : s === 'T' ? 'active' : 'idle'
  })

  const savepoint = <T>(fn: Callback<T>, o?: SavepointOptions): Promise<T> =>
    runSavepoint(deps, conn, tx, shape, fn, o)
  install(handle, 'transaction', savepoint)
  install(handle, 'savepoint', savepoint)

  install(handle, 'setLocal', (a: unknown, b?: unknown) => setLocalOn(runner, a, b, true))

  install(
    handle,
    'advisoryLock',
    async (key: bigint | string, o?: AdvisoryLockOptions): Promise<boolean> => {
      const shared = o?.shared === true
      const tryLock = o?.try === true
      const fn = advisoryFn('xact', tryLock, shared)
      const rows = await runner.use(async (c) =>
        c.execute({
          text: `select ${fn}($1)`,
          params: [advisoryKey(key).toString()],
          paramTypes: [20],
        }),
      )
      if (!tryLock) return true
      const cell = rows.rows[0]?.[0]
      return cell === 't' || cell === 'true'
    },
  )

  install(handle, 'rollback', (): never => {
    throw new TransactionRollback(
      'pg-prime: tx.rollback() — the transaction was aborted deliberately. db.transaction() ' +
        'issues ROLLBACK and rethrows this. Use tx.rollbackWith(value) if you want the ' +
        'transaction to resolve with a value instead (07 §3.7).',
      { context: { handle: 'tx', txId: tx.txId, depth: tx.depth } },
    )
  })

  install(handle, 'rollbackWith', (value: unknown): never => {
    tx.doomed = true
    throw { [DOOMED]: true, value } as Doomed
  })

  install(handle, 'withOptions', (opts: CallOptions) =>
    makeTxHandle(deps, conn, tx, shape, { ...defaults, ...opts }),
  )
  install(handle, 'outsideTransaction', () =>
    makeTxHandle(deps, conn, tx, shape, { ...defaults, outsideTransaction: true }),
  )
  return handle
}

/**
 * `tx.savepoint(fn)` — `07` §3.3.
 *
 * The value of a savepoint, and the thing the docs must say out loud: after **any** statement error
 * PostgreSQL puts the transaction in the aborted state and every subsequent statement fails with
 * `25P02`. A savepoint is the *only* way to attempt something that may fail — a speculative insert,
 * a constraint probe — and carry on. Rolling back to one un-poisons the transaction, which is why
 * `poisonedBy` is cleared here and nowhere else.
 */
async function runSavepoint<T>(
  deps: TxDeps,
  conn: PgConnection,
  parent: TxRuntime,
  shape: TxShape,
  fn: Callback<T>,
  o: SavepointOptions | undefined,
): Promise<T> {
  const depth = parent.depth + 1
  const child: TxRuntime = {
    ...parent,
    depth,
    inFlight: 0,
    warned: parent.warned,
    baselineTimeoutMs: o?.timeoutMs ?? parent.baselineTimeoutMs,
    label: o?.label ?? parent.label,
  }
  await conn.execute({ text: savepointSql(depth), params: [], mode: 'simple' })
  const settings: Record<string, string | number | boolean> = { ...o?.localSettings }
  if (o?.timeoutMs !== undefined) settings['statement_timeout'] = o.timeoutMs
  if (o?.lockTimeoutMs !== undefined) settings['lock_timeout'] = o.lockTimeoutMs
  const names = Object.keys(settings)
  if (names.length > 0) {
    await conn.execute({
      text: setConfigSql(names.length, true),
      params: setConfigParams(settings) as string[],
    })
    if (o?.timeoutMs !== undefined) child.localTimeoutMs = o.timeoutMs
  }
  const handle = makeTxHandle(deps, conn, child, {
    ...shape,
    ...(o?.signal === undefined ? {} : { signal: o.signal }),
    ...(o?.label === undefined ? {} : { label: o.label }),
  })
  try {
    const result = await fn(handle)
    if (child.doomed) {
      await conn.execute({ text: rollbackToSavepointSql(depth), params: [], mode: 'simple' })
      parent.poison.error = undefined
      await conn.execute({ text: releaseSavepointSql(depth), params: [], mode: 'simple' })
      return result as T
    }
    await conn.execute({ text: releaseSavepointSql(depth), params: [], mode: 'simple' })
    return result
  } catch (e) {
    if (isDoomed(e)) {
      await conn.execute({ text: rollbackToSavepointSql(depth), params: [], mode: 'simple' })
      parent.poison.error = undefined
      await conn.execute({ text: releaseSavepointSql(depth), params: [], mode: 'simple' })
      return e.value as T
    }
    await conn
      .execute({ text: rollbackToSavepointSql(depth), params: [], mode: 'simple' })
      .catch(() => {})
    // The rollback un-poisoned the enclosing transaction; a later 25P02 would now be a lie.
    parent.poison.error = undefined
    await conn
      .execute({ text: releaseSavepointSql(depth), params: [], mode: 'simple' })
      .catch(() => {})
    throw e
  } finally {
    child.closed = true
  }
}

/** `setLocal(name, value)` and `setLocal({ … })`, both through `set_config` (§3.5). */
async function setLocalOn(
  runner: AnyRunner,
  a: unknown,
  b: unknown,
  local: boolean,
): Promise<void> {
  const settings: Record<string, string | number | boolean> =
    typeof a === 'string'
      ? { [a]: b as string | number | boolean }
      : (a as Record<string, string | number | boolean>)
  if (typeof a === 'string') assertGucName(a)
  const names = Object.keys(settings)
  if (names.length === 0) return
  await runner.use(async (conn) => {
    await conn.execute({
      text: setConfigSql(names.length, local),
      params: setConfigParams(settings) as string[],
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// REFRESH MATERIALIZED VIEW, installed on every handle (design/01 §3 row 58)
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_OIDS: readonly number[] = Object.freeze([])
const EMPTY_PARAMS: readonly unknown[] = Object.freeze([])

export interface RefreshMaterializedViewOptions {
  /**
   * Override the view's own `.refreshable({ concurrently })` declaration.
   *
   * `true` needs a unique index on the matview; PostgreSQL answers `55000` without one and that
   * error is mapped and rethrown rather than swallowed.
   */
  readonly concurrently?: boolean
}

/**
 * `REFRESH MATERIALIZED VIEW [CONCURRENTLY] "schema"."name"`.
 *
 * Not parameterisable — an object name is an identifier, so it is quoted, never bound — and the
 * identifier comes from the declaration rather than from a caller-supplied string, so there is no
 * splicing surface here at all.
 */
export function refreshSql(
  view: AnyMaterializedView,
  opts?: RefreshMaterializedViewOptions,
): string {
  const info = view.$.view as { kind?: unknown; name?: unknown; schema?: unknown } | undefined
  if (info === undefined || info.kind !== 'materializedView' || typeof info.name !== 'string') {
    throw new UsageError(
      'pg-prime: refreshMaterializedView() takes a pgMaterializedView(...) declaration. A plain ' +
        'view has no stored rows to refresh, and a table is refreshed by writing to it.',
    )
  }
  const concurrently = opts?.concurrently ?? view.$.view.refreshConcurrently === true
  const qualified =
    typeof info.schema === 'string'
      ? `${quoteIdentPart(info.schema)}.${quoteIdentPart(info.name)}`
      : quoteIdentPart(info.name)
  return `refresh materialized view ${concurrently ? 'concurrently ' : ''}${qualified}`
}

// ─────────────────────────────────────────────────────────────────────────────
// COPY, installed on every handle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `copyFrom(table, rows, opts?)`, `copyFrom.raw(sql, bytes)` and `copyTo(sql)` (`07` §6.6).
 *
 * A callable object rather than two methods, because `copyFrom.raw` is `07`'s own spelling and a
 * function carrying a property is the smallest thing that is both.
 */
export interface CopyFromApi {
  (table: TableLike, rows: CopyRows, opts?: CopyOptions): Promise<CopyResult>
  /** The escape hatch: your own `COPY … FROM STDIN`, your own bytes, no encoding by us. */
  raw(
    sql: string | { readonly sql: string },
    bytes: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    opts?: CopyOptions,
  ): Promise<CopyResult>
}

export type CopyRows = AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>

export interface CopyToApi {
  (sql: string | { readonly sql: string }, opts?: CopyOptions): AsyncIterable<Uint8Array>
  /** The same stream split into lines of text — the shape people actually want for CSV. */
  lines(sql: string | { readonly sql: string }, opts?: CopyOptions): AsyncIterable<string>
}

function sqlTextOf(q: string | { readonly sql: string }): string {
  return typeof q === 'string' ? q : q.sql
}

function makeCopyFrom(state: SessionState, runner: AnyRunner): CopyFromApi {
  const api = (async (
    table: TableLike,
    rows: CopyRows,
    opts?: CopyOptions,
  ): Promise<CopyResult> => {
    const meta = metaOf(table, state.env.registry)
    // One list, and the row key rides ON each column: the default is now a SUBSET of the declared
    // columns (GENERATED ALWAYS is not insertable), so a second `opts?.columns ?? meta.keys` array
    // beside this one would be misaligned by exactly the columns that were dropped.
    const columns = copyColumns(meta, opts?.columns)
    const format = opts?.format ?? 'text'
    const text = copyFromSql(meta, columns, format)
    const hwm = opts?.highWaterMark ?? 65_536
    return runner.use(async (conn) => {
      assertCopyIn(conn, state.driver.capabilities.adapter)
      const res = await conn.copyIn(text, encodeCopyRows(rows, columns, format, hwm), {
        ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        ...(opts?.highWaterMark === undefined ? {} : { highWaterMark: opts.highWaterMark }),
      })
      return { rowCount: res.rowCount }
    })
  }) as CopyFromApi

  api.raw = async (q, bytes, opts): Promise<CopyResult> =>
    runner.use(async (conn) => {
      assertCopyIn(conn, state.driver.capabilities.adapter)
      const res = await conn.copyIn(sqlTextOf(q), toAsync(bytes), {
        ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        ...(opts?.highWaterMark === undefined ? {} : { highWaterMark: opts.highWaterMark }),
      })
      return { rowCount: res.rowCount }
    })
  return api
}

function makeCopyTo(state: SessionState, runner: AnyRunner): CopyToApi {
  const bytes = (
    q: string | { readonly sql: string },
    opts?: CopyOptions,
  ): AsyncIterable<Uint8Array> => {
    const text = sqlTextOf(q)
    return runner.scope((conn) => {
      assertCopyOut(conn, state.driver.capabilities.adapter)
      return conn.copyOut(text, {
        ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        ...(opts?.highWaterMark === undefined ? {} : { highWaterMark: opts.highWaterMark }),
      })
    })
  }
  const api = bytes as CopyToApi
  api.lines = (q, opts) => copyLines(bytes(q, opts))
  return api
}

async function* toAsync(
  it: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  for await (const chunk of it as AsyncIterable<Uint8Array>) yield chunk
}

// ─────────────────────────────────────────────────────────────────────────────
// Session (§1.4)
// ─────────────────────────────────────────────────────────────────────────────

export async function runSession<T>(deps: TxDeps, fn: Callback<T>): Promise<T> {
  const state = deps.state
  if (state.profile.sessionHandle === 'unsupported') {
    throw new UnsupportedInPoolerModeError(
      `pg-prime: db.session() cannot work under poolerMode: '${state.poolerMode}'. A transaction ` +
        `pooler reassigns the server connection between transactions, so "the same backend for ` +
        `several statements" is exactly the guarantee it does not make — a session advisory lock ` +
        `would be released under you and a temp table would vanish. Use db.transaction() (which ` +
        `IS one backend, for its duration), or add directConnection and run the session work ` +
        `there (07 §5.2).`,
    )
  }
  const lease = await acquire(state, state.signal)
  const tx: TxRuntime = {
    txId: nextTxId(),
    attempt: 1,
    depth: 0,
    doomed: false,
    closed: false,
    poison: { error: undefined },
    inFlight: 0,
    warned: false,
    localTimeoutMs: undefined,
    baselineTimeoutMs: undefined,
    label: undefined,
  }
  /** Built once, and again for every `withOptions` — a scoped `Session` is still a `Session`. */
  const makeSessionHandle = (extra: CallOptions): object => {
    const scopedRunner = new ConnRunner(state, extra as StatementOptions, lease.conn, tx, 'session')
    attachDeps(scopedRunner, deps)
    const h = makeExecutor({ ...deps.ctxSeed, runner: scopedRunner }, deps.handles)
    installQueryable(h, state, scopedRunner, 'session')
    installGetter(h, 'backendPid', () => lease.conn.backendPid)
    install(h, 'transaction', <T2>(a: Callback<T2> | TxOptions, b?: Callback<T2> | TxOptions) =>
      runNestedOnConnection(deps, lease.conn, tx, a, b),
    )
    // `Session.set()` is `set_config($1,$2,false)` — the session-scoped sibling of `setLocal`.
    install(h, 'set', (a: unknown, b?: unknown) => setLocalOn(scopedRunner, a, b, false))
    install(
      h,
      'advisoryLock',
      async (key: bigint | string, o?: AdvisoryLockOptions): Promise<AdvisoryLock | boolean> =>
        sessionAdvisoryLock(state, scopedRunner, key, o),
    )
    install(h, 'withOptions', (opts: CallOptions) => makeSessionHandle({ ...extra, ...opts }))
    install(h, 'outsideTransaction', () =>
      makeSessionHandle({ ...extra, outsideTransaction: true }),
    )
    return h
  }
  const handle = makeSessionHandle({})
  let dispose = false
  try {
    // A session is NOT a transaction, so the guard must not see a frame — but a `db` statement
    // inside a session callback is legitimate (it is a different connection, and that is fine).
    return await withoutFrames(() => fn(handle))
  } catch (e) {
    dispose = true
    throw mapError(e, {
      context: { handle: 'session' },
      errors: state.errors,
      schema: state.schema,
    })
  } finally {
    tx.closed = true
    const status = lease.conn.transactionStatus
    if (status === 'T' || status === 'E') dispose = true
    if (!lease.conn.usable) dispose = true
    await release(state, lease, dispose)
  }
}

/** A transaction opened on a `Session`'s own connection: `BEGIN` on the pinned backend. */
async function runNestedOnConnection<T>(
  deps: TxDeps,
  conn: PgConnection,
  parent: TxRuntime,
  a: Callback<T> | TxOptions | undefined,
  b: Callback<T> | TxOptions | undefined,
): Promise<T> {
  const { fn, opts } = splitArgs(a, b)
  const isolation = opts.isolation as IsolationLevel | undefined
  const accessMode = opts.accessMode as AccessMode | undefined
  const begin = beginSql({
    ...(isolation === undefined ? {} : { isolation }),
    ...(accessMode === undefined ? {} : { accessMode }),
    ...((opts as { deferrable?: boolean }).deferrable === undefined
      ? {}
      : { deferrable: (opts as { deferrable?: boolean }).deferrable }),
  })
  const tx: TxRuntime = {
    ...parent,
    txId: nextTxId(),
    depth: 0,
    inFlight: 0,
    warned: false,
    doomed: false,
  }
  await conn.execute({ text: begin, params: [], mode: 'simple' })
  const handle = makeTxHandle(deps, conn, tx, {
    ...(isolation === undefined ? {} : { isolation }),
    ...(accessMode === undefined ? {} : { accessMode }),
    ...(opts.label === undefined ? {} : { label: opts.label }),
  })
  try {
    const result = await withFrame(
      { txId: tx.txId, label: opts.label, openedAt: undefined, depth: 0 },
      () => fn(handle),
    )
    if (tx.doomed) {
      await conn.execute({ text: 'rollback', params: [], mode: 'simple' })
      return result
    }
    await conn.execute({ text: 'commit', params: [], mode: 'simple' })
    return result
  } catch (e) {
    if (isDoomed(e)) {
      await conn.execute({ text: 'rollback', params: [], mode: 'simple' }).catch(() => {})
      return e.value as T
    }
    await conn.execute({ text: 'rollback', params: [], mode: 'simple' }).catch(() => {})
    throw e
  } finally {
    tx.closed = true
  }
}

/**
 * A **session**-level advisory lock — the kind a transaction pooler cannot support, which is why
 * it lives here and `tx.advisoryLock` (the `_xact_` family) lives on `Tx`.
 */
async function sessionAdvisoryLock(
  state: SessionState,
  runner: ConnRunner,
  key: bigint | string,
  o: AdvisoryLockOptions | undefined,
): Promise<AdvisoryLock | boolean> {
  if (state.profile.sessionAdvisoryLocks === 'unsupported') {
    throw new UnsupportedInPoolerModeError(
      `pg-prime: a SESSION advisory lock cannot be held under poolerMode: '${state.poolerMode}'. ` +
        `The lock lives on a server connection the pooler will hand to somebody else at the next ` +
        `transaction boundary, and it also pins an RDS Proxy connection. Use ` +
        `tx.advisoryLock(key) — pg_advisory_xact_lock — which is transaction-scoped and works in ` +
        `every profile (07 §5.2).`,
    )
  }
  const shared = o?.shared === true
  const tryLock = o?.try === true
  const k = advisoryKey(key)
  const fn = advisoryFn('session', tryLock, shared)
  const res = await runner.use(async (c) =>
    c.execute({ text: `select ${fn}($1)`, params: [k.toString()], paramTypes: [20] }),
  )
  if (tryLock) {
    const cell = res.rows[0]?.[0]
    const got = cell === 't' || cell === 'true'
    if (!got) return false
  }
  const unlock = async (): Promise<boolean> => {
    const r = await runner.use(async (c) =>
      c.execute({
        text: `select ${advisoryUnlockFn(shared)}($1)`,
        params: [k.toString()],
        paramTypes: [20],
      }),
    )
    const cell = r.rows[0]?.[0]
    return cell === 't' || cell === 'true'
  }
  // The cast is the price of `AsyncDisposeKey` being inferred rather than a `unique symbol` we
  // declare: TypeScript only accepts a computed key from a `const x: unique symbol`, and declaring
  // our own would not be the well-known symbol `await using` looks for. One cast, one place.
  return {
    key: k,
    shared,
    unlock,
    [ASYNC_DISPOSE]: async () => void (await unlock()),
  } as unknown as AdvisoryLock
}

export { attachDeps, install, installGetter, installQueryable, isTransactionPooled }
