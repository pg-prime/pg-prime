/**
 * Where a statement meets a connection, once the session layer exists (design/07 §1, §4, §6, §7).
 *
 * `src/query/run.ts` used to hold two eight-line runners whose only job was connection lifetime.
 * They are still the only two shapes — one checks a connection out per operation, one reuses the
 * connection `transaction()` holds — but every cross-cutting concern in `07` lands on exactly this
 * seam, and putting them anywhere else would mean putting them in five places:
 *
 *  - **error mapping** (§4): once, at the executor boundary, from `PgDriverErrorData` to a class;
 *  - **hooks** (§7.1): start/end/error with the `serverMs` / `decodeMs` / `waitedForConnectionMs`
 *    split nobody else reports;
 *  - **the slow-query log** (§7.3) and **call-site capture** (§7.4);
 *  - **session GUCs** (§3.6): once per *physical* connection, and not at all under a transaction
 *    profile;
 *  - **cancellation and per-statement timeouts** (§6.1–6.2), including destroying a connection
 *    after a cancel;
 *  - **the dev guard** (§1.5) and the concurrent-statements warning (§3.2).
 *
 * The `Runner` interface itself is unchanged (`src/query/builder-state.ts`), so every terminal in
 * the builder keeps working with no knowledge that any of this exists.
 */

import type { Compiled } from '../compile/contract.js'
import { paramTypesOf } from '../compile/contract.js'
import type { PgConnection, PgDriver, PgNoticeData } from '../driver/types.js'
import { PgPrimeError as PgPrimeErrorClass } from '../errors/index.js'
import type { PgPrimeError } from '../errors/index.js'
import {
  DbClosedError,
  QueryTimeoutError,
  TransactionAbandonedError,
  TransactionClosedError,
  captureCallSite,
  mapError,
  sqlStateOfError,
} from '../errors/index.js'
import type { PoolStats, ResolvedErrorOptions } from '../errors/index.js'
import type { HookBus, QueryOperation, ResolvedLogOptions, SpanContext } from '../observe/index.js'
import { nextQueryId, queryErrorRecord, shouldLog, slowQueryRecord } from '../observe/index.js'
import type { QueryStartEvent } from '../observe/index.js'
import type { PoolerMode, PoolerProfile } from '../pooler/profiles.js'
import type { Runner } from '../query/builder-state.js'
import type { ExecEnv, RunOptions, RunTiming } from '../query/executor.js'
import { runOn } from '../query/executor.js'
import type { AnySchema } from '../schema/index.js'
import { assertNotInsideTransaction, concurrentStatementsWarning } from './guard.js'
import type { CallOptions, SessionDefaults, TransactionDefaults } from './types.js'

/** Everything one `pgPrime(...)` shares, mutable where the runtime learns something. */
export interface SessionState {
  readonly driver: PgDriver
  readonly schema: AnySchema
  readonly env: ExecEnv
  readonly hooks: HookBus
  readonly errors: ResolvedErrorOptions
  readonly log: ResolvedLogOptions
  readonly poolerMode: PoolerMode
  readonly profile: PoolerProfile
  readonly devGuard: boolean
  readonly session: SessionDefaults | undefined
  /** The `set_config` batch to run once per physical connection, or `[]` when there is nothing to do. */
  readonly connectSettings: readonly (readonly [string, string])[]
  readonly transaction: TransactionDefaults | undefined
  readonly signal: AbortSignal | undefined
  readonly spanContext: SpanContext
  readonly poolStats: () => PoolStats | undefined
  /** Physical connections that have already had their session GUCs applied (§3.6). */
  readonly configured: WeakSet<object>
  ended: boolean
  /** Set once by `pgPrime` after the handle exists, so `diagnose()` can reach it. */
  warn(message: string): void
}

/** Per-statement options a runner threads down from the handle and from the call. */
export interface StatementOptions extends CallOptions {
  readonly params?: Readonly<Record<string, unknown>> | undefined
}

/**
 * What {@link execute} needs to know about a statement, whichever surface produced it.
 *
 * Two things produce one: a compiled builder query, and `` db.sql`…` `` — and until this existed
 * the second got no hooks, no slow-query log, no per-statement timeout and no error mapping,
 * because it reached the connection through `Runner.use` instead. A raw statement is still a
 * query; `07` §7.1 does not have an exception for it.
 */
export interface StatementDescriptor<Row> {
  readonly sql: string
  readonly paramCount: number
  /** `07` §4.3: "always present, always safe" — an OID names no user value. */
  readonly paramTypes: readonly number[]
  readonly operation: QueryOperation
  readonly tables: readonly string[] | undefined
  /** Runs it. `timing` is filled when somebody is listening. */
  perform(conn: PgConnection, env: ExecEnv, opts: RunOptions): Promise<{ rows: Row[]; rowCount: number }>
}

/** A compiled builder query as a descriptor. */
export function compiledStatement<Row>(compiled: Compiled<Row>): StatementDescriptor<Row> {
  const c = compiled as unknown as Compiled<unknown>
  return {
    sql: compiled.sql,
    paramCount: compiled.binds.length,
    paramTypes: paramTypesOf(compiled.binds),
    operation: operationOf(c),
    tables: tablesOf(c),
    async perform(conn, env, opts) {
      const rows = await runOn(conn, compiled, env, opts)
      return { rows, rowCount: rows.length }
    },
  }
}

/** What the two runners share. Not exported: `Runner` is the seam, this is the implementation. */
abstract class BaseRunner implements Runner {
  readonly state: SessionState
  readonly defaults: StatementOptions
  abstract readonly inTransaction: boolean

  constructor(state: SessionState, defaults: StatementOptions) {
    this.state = state
    this.defaults = defaults
  }

  get env(): ExecEnv {
    return this.state.env
  }

  /** The handle kind this runner speaks for. Drives the dev guard and every event's `handle`. */
  abstract get handle(): 'db' | 'tx' | 'session'

  abstract use<T>(f: (conn: PgConnection) => Promise<T>): Promise<T>
  abstract scope<T>(f: (conn: PgConnection) => AsyncIterable<T>): AsyncIterable<T>
  abstract run<Row>(compiled: Compiled<Row>, opts?: RunOptions): Promise<Row[]>
  abstract runChunked<Row>(all: readonly Compiled<Row>[]): Promise<Row[]>

  protected merged(opts: RunOptions | undefined): StatementOptions {
    const o = opts as (RunOptions & CallOptions) | undefined
    if (o === undefined) return this.defaults
    return {
      ...this.defaults,
      ...(o.params === undefined ? {} : { params: o.params }),
      ...(o.statement === undefined ? {} : { statement: o.statement }),
      ...(o.signal === undefined ? {} : { signal: o.signal }),
      ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
      ...(o.timeoutStrategy === undefined ? {} : { timeoutStrategy: o.timeoutStrategy }),
      ...(o.label === undefined ? {} : { label: o.label }),
      ...(o.outsideTransaction === undefined ? {} : { outsideTransaction: o.outsideTransaction }),
    }
  }

  /** `07` §6.1 — the caller's signal composed with the db-wide lifecycle one. */
  protected signalFor(opts: StatementOptions): AbortSignal | undefined {
    const own = opts.signal
    const global = this.state.signal
    if (global === undefined) return own
    if (own === undefined) return global
    return anySignal([own, global])
  }

  protected assertOpen(): void {
    if (this.state.ended) {
      throw new DbClosedError(
        'pg-prime: this statement was issued after db.end(). The pool is drained and the handle is ' +
          'closed; build a new one with pgPrime(config) if the process is still alive.',
        { context: { handle: this.handle } },
      )
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The pooled runner — one statement, one checkout
// ─────────────────────────────────────────────────────────────────────────────

export class PoolRunner extends BaseRunner {
  readonly inTransaction = false
  readonly #handle: 'db' | 'session'

  constructor(state: SessionState, defaults: StatementOptions, handle: 'db' | 'session' = 'db') {
    super(state, defaults)
    this.#handle = handle
  }

  get handle(): 'db' | 'session' {
    return this.#handle
  }

  /** A sibling runner with different per-statement defaults. `db.withOptions({ signal })`. */
  with(extra: StatementOptions): PoolRunner {
    return new PoolRunner(this.state, { ...this.defaults, ...extra }, this.#handle)
  }

  async use<T>(f: (conn: PgConnection) => Promise<T>): Promise<T> {
    this.assertOpen()
    this.guard()
    const lease = await acquire(this.state, this.signalFor(this.defaults))
    let dispose = false
    try {
      return await f(lease.conn)
    } catch (e) {
      dispose = poisons(e)
      throw this.mapped(e, undefined)
    } finally {
      await release(this.state, lease, dispose)
    }
  }

  /**
   * A stream at the root owns a connection **and** a transaction for the whole iteration (§6.3),
   * and gives both back on *every* exit: completion, `break` (which calls the iterator's
   * `return()` and therefore runs this `finally`), `throw`, and abort.
   *
   * `commit` only on the completed path. A consumer that broke out has read part of a snapshot and
   * asked for no more; `rollback` says exactly that and costs the same.
   */
  async *scope<T>(f: (conn: PgConnection) => AsyncIterable<T>): AsyncIterable<T> {
    this.assertOpen()
    this.guard()
    const lease = await acquire(this.state, this.signalFor(this.defaults))
    let done = false
    let dispose = false
    try {
      await lease.conn.execute({ text: 'begin', params: [], mode: 'simple' })
      await applyStreamTimeout(lease.conn, this.defaults)
      yield* f(lease.conn)
      done = true
    } catch (e) {
      dispose = poisons(e)
      throw this.mapped(e, undefined)
    } finally {
      if (!dispose) {
        await lease.conn
          .execute({ text: done ? 'commit' : 'rollback', params: [], mode: 'simple' })
          .catch(() => {})
      }
      await release(this.state, lease, dispose)
    }
  }

  async run<Row>(compiled: Compiled<Row>, opts?: RunOptions): Promise<Row[]> {
    this.assertOpen()
    const o = this.merged(opts)
    this.guard(o)
    // `07` §6.2's opt-in: a hard server-side guarantee for an autocommit statement, at +2 RTT.
    if (o.timeoutMs !== undefined && o.timeoutStrategy === 'transaction') {
      return this.#timedInTransaction(compiled, o)
    }
    const lease = await acquire(this.state, this.signalFor(o))
    let dispose = false
    try {
      return await execute(this.state, lease, compiledStatement(compiled), o, this.handle, 0, undefined)
    } catch (e) {
      dispose = poisons(e)
      throw e
    } finally {
      await release(this.state, lease, dispose)
    }
  }

  async #timedInTransaction<Row>(compiled: Compiled<Row>, o: StatementOptions): Promise<Row[]> {
    const lease = await acquire(this.state, this.signalFor(o))
    let dispose = false
    let opened = false
    try {
      await lease.conn.execute({ text: 'begin', params: [], mode: 'simple' })
      opened = true
      await lease.conn.execute({
        text: 'select set_config($1,$2,true)',
        params: ['statement_timeout', String(o.timeoutMs)],
      })
      const rows = await execute(
        this.state,
        lease,
        compiledStatement(compiled),
        { ...o, timeoutMs: undefined },
        this.handle,
        0,
        undefined,
      )
      await lease.conn.execute({ text: 'commit', params: [], mode: 'simple' })
      opened = false
      return rows
    } catch (e) {
      dispose = poisons(e)
      if (opened && !dispose) {
        await lease.conn.execute({ text: 'rollback', params: [], mode: 'simple' }).catch(() => {})
      }
      throw e
    } finally {
      await release(this.state, lease, dispose)
    }
  }

  /**
   * Chunks of one logical batch, on ONE connection, inside ONE transaction.
   *
   * A half-applied bulk insert is the failure mode that makes chunking untrustworthy, and it is
   * invisible: the caller sees a rejected promise and 40 000 of 50 000 rows committed.
   */
  async runChunked<Row>(all: readonly Compiled<Row>[]): Promise<Row[]> {
    this.assertOpen()
    const o = this.defaults
    this.guard(o)
    const lease = await acquire(this.state, this.signalFor(o))
    let dispose = false
    try {
      await lease.conn.execute({ text: 'begin', params: [], mode: 'simple' })
      const out: Row[] = []
      try {
        for (const c of all) {
          out.push(...(await execute(this.state, lease, compiledStatement(c), o, this.handle, 0, undefined)))
        }
      } catch (e) {
        dispose = poisons(e)
        if (!dispose) {
          await lease.conn.execute({ text: 'rollback', params: [], mode: 'simple' }).catch(() => {})
        }
        throw e
      }
      await lease.conn.execute({ text: 'commit', params: [], mode: 'simple' })
      return out
    } finally {
      await release(this.state, lease, dispose)
    }
  }

  /**
   * `` db.sql`…` `` — the same hooks, the same mapping, the same log, the same timeout.
   *
   * It is a separate entry point only because a raw statement has no `Compiled` and therefore no
   * decode plan; everything else about it is a query.
   */
  async runRaw<Row>(desc: StatementDescriptor<Row>, opts?: RunOptions): Promise<Row[]> {
    this.assertOpen()
    const o = this.merged(opts)
    this.guard(o)
    const lease = await acquire(this.state, this.signalFor(o))
    let dispose = false
    try {
      return await execute(this.state, lease, desc, o, this.handle, 0, undefined)
    } catch (e) {
      dispose = poisons(e)
      throw e
    } finally {
      await release(this.state, lease, dispose)
    }
  }

  /** The root handle is the only one the guard applies to (§1.5 layer 3). */
  private guard(o: StatementOptions = this.defaults): void {
    if (!this.state.devGuard) return
    if (this.#handle !== 'db') return
    if (o.outsideTransaction === true) return
    assertNotInsideTransaction(this.state.errors.captureCallSite ? captureCallSite(this.guard) : undefined)
  }

  private mapped(e: unknown, sql: string | undefined): unknown {
    return mapError(e, {
      context: { handle: this.handle, ...(this.defaults.label === undefined ? {} : { label: this.defaults.label }) },
      errors: this.state.errors,
      sql,
      schema: this.state.schema,
      poolStats: this.state.poolStats(),
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The connection-bound runner — every statement on the transaction's own connection
// ─────────────────────────────────────────────────────────────────────────────

/** What a `Tx` needs from its runner beyond `Runner`, and what `./handles.ts` mutates. */
export interface TxRuntime {
  readonly txId: string
  attempt: number
  depth: number
  /** `rollbackWith()` sets this; every later statement then throws `TransactionAbandonedError`. */
  doomed: boolean
  closed: boolean
  /** The error that put the transaction into the aborted state, retained for `25P02` (§3.3). */
  poisonedBy: PgPrimeError | undefined
  /** In-flight statements, for §3.2's warning. */
  inFlight: number
  warned: boolean
  /** The current transaction-local `statement_timeout`, so a repeat costs no round trip. */
  localTimeoutMs: number | undefined
  readonly label: string | undefined
}

export class ConnRunner extends BaseRunner {
  readonly inTransaction = true
  readonly conn: PgConnection
  readonly tx: TxRuntime
  readonly #handle: 'tx' | 'session'

  constructor(
    state: SessionState,
    defaults: StatementOptions,
    conn: PgConnection,
    tx: TxRuntime,
    handle: 'tx' | 'session' = 'tx',
  ) {
    super(state, defaults)
    this.conn = conn
    this.tx = tx
    this.#handle = handle
  }

  get handle(): 'tx' | 'session' {
    return this.#handle
  }

  with(extra: StatementOptions): ConnRunner {
    return new ConnRunner(this.state, { ...this.defaults, ...extra }, this.conn, this.tx, this.#handle)
  }

  #assertUsable(): void {
    this.assertOpen()
    if (this.tx.closed) {
      throw new TransactionClosedError(
        `pg-prime: this ${this.#handle} handle was used after its callback returned. The ` +
          `connection has gone back to the pool and the transaction is over; a handle cannot ` +
          `outlive its scope (07 §1.5, NoHandleEscape).`,
        { context: { handle: this.#handle } },
      )
    }
    if (this.tx.doomed) {
      throw new TransactionAbandonedError(
        'pg-prime: this transaction was abandoned by rollbackWith(...). It will ROLLBACK when the ' +
          'callback returns, so any further statement would be discarded — which is why it throws ' +
          'instead (07 §3.7).',
        { context: { handle: this.#handle } },
      )
    }
  }

  async use<T>(f: (conn: PgConnection) => Promise<T>): Promise<T> {
    this.#assertUsable()
    try {
      return await f(this.conn)
    } catch (e) {
      const mapped = this.#mapped(e, undefined)
      if (mapped instanceof PgPrimeErrorClass && isPoisoning(mapped)) this.tx.poisonedBy ??= mapped
      throw mapped
    }
  }

  /** Joins the caller's transaction; the adapter sees `transactionStatus === 'T'` and does too. */
  scope<T>(f: (conn: PgConnection) => AsyncIterable<T>): AsyncIterable<T> {
    this.#assertUsable()
    return f(this.conn)
  }

  async run<Row>(compiled: Compiled<Row>, opts?: RunOptions): Promise<Row[]> {
    return this.runRaw(compiledStatement(compiled), opts)
  }

  /** See `PoolRunner.runRaw`. Same statement path, the transaction's own connection. */
  async runRaw<Row>(desc: StatementDescriptor<Row>, opts?: RunOptions): Promise<Row[]> {
    this.#assertUsable()
    const o = this.merged(opts)
    await this.#applyLocalTimeout(o)
    this.#enter()
    try {
      return await execute(
        this.state,
        { conn: this.conn, waitedMs: 0 },
        desc,
        o,
        this.#handle,
        this.tx.depth,
        this.tx,
      )
    } finally {
      this.tx.inFlight -= 1
    }
  }

  /** Already atomic — opening a nested `BEGIN` would emit a 25001 warning and commit nothing. */
  async runChunked<Row>(all: readonly Compiled<Row>[]): Promise<Row[]> {
    this.#assertUsable()
    const out: Row[] = []
    for (const c of all) out.push(...(await this.run(c)))
    return out
  }

  /**
   * §3.2's warning, once per transaction. `Promise.all` inside a transaction is serial and we
   * cannot change that; we can stop it being invisible.
   */
  #enter(): void {
    this.tx.inFlight += 1
    if (this.tx.inFlight > 1 && !this.tx.warned && this.state.devGuard) {
      this.tx.warned = true
      const message = concurrentStatementsWarning(this.tx.inFlight)
      this.state.warn(message)
      this.state.hooks.internal({ kind: 'concurrent-statements', message })
    }
  }

  /**
   * `.timeout(ms)` inside a transaction is `SET LOCAL statement_timeout` — correct in every pooler
   * profile, +1 RTT (§6.2).
   *
   * The transaction remembers the value it currently has, so a loop of statements sharing one
   * timeout pays for one `set_config` and not N. Restoring is likewise lazy: the next statement
   * that wants a different value (including "none") emits the change.
   */
  async #applyLocalTimeout(o: StatementOptions): Promise<void> {
    const want = o.timeoutMs
    if (want === this.tx.localTimeoutMs) return
    await this.conn.execute({
      text: 'select set_config($1,$2,true)',
      params: ['statement_timeout', want === undefined ? '0' : String(want)],
    })
    this.tx.localTimeoutMs = want
  }

  #mapped(e: unknown, sql: string | undefined): unknown {
    return mapError(e, {
      context: {
        handle: this.#handle,
        attempt: this.tx.attempt,
        depth: this.tx.depth,
        txId: this.tx.txId,
        ...(this.tx.label === undefined ? {} : { label: this.tx.label }),
      },
      errors: this.state.errors,
      sql,
      schema: this.state.schema,
      poisonedBy: this.tx.poisonedBy,
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Acquire / release, with the §3.6 connection setup and the §7.1 pool events
// ─────────────────────────────────────────────────────────────────────────────

export interface Lease {
  readonly conn: PgConnection
  /** `07` §7.1's `waitedForConnectionMs`: "slow query" and "pool exhausted" must not look alike. */
  readonly waitedMs: number
}

export async function acquire(
  state: SessionState,
  signal: AbortSignal | undefined,
  route?: 'default' | 'direct',
): Promise<Lease> {
  const started = performance.now()
  let conn: PgConnection
  try {
    conn = await state.driver.acquire({
      ...(signal === undefined ? {} : { signal }),
      ...(route === undefined ? {} : { route }),
    })
  } catch (e) {
    state.hooks.pool({ kind: 'timeout', waitedMs: performance.now() - started })
    throw mapError(e, {
      context: { handle: 'db' },
      errors: state.errors,
      schema: state.schema,
      poolStats: state.poolStats(),
    })
  }
  const waitedMs = performance.now() - started
  state.hooks.pool({ kind: 'acquire', waitedMs })
  await applyConnectSettings(state, conn)
  return { conn, waitedMs }
}

export async function release(state: SessionState, lease: Lease, dispose: boolean): Promise<void> {
  state.hooks.pool({ kind: 'release' })
  await state.driver.release(lease.conn, dispose ? { dispose: true } : undefined)
}

/**
 * `07` §3.6 — session GUCs, applied **once per physical connection**, and not at all under a
 * transaction profile.
 *
 * The identity of a physical connection is `conn.serverParameters`, not the `PgConnection`: the pg
 * adapter builds a fresh `PgConnectionImpl` on every `acquire()` and caches the parameters object
 * per underlying client, which is the same reasoning (and the same measured bug) behind the
 * named-statement cache's key in `src/query/executor.ts`.
 *
 * Under `pgbouncer-transaction` / `transaction` this is a no-op by construction: `connectSettings`
 * is empty, because `pgPrime` refused to build it and logged the `ALTER ROLE` fix once at startup.
 */
async function applyConnectSettings(state: SessionState, conn: PgConnection): Promise<void> {
  if (state.connectSettings.length === 0) return
  const key = conn.serverParameters as object
  if (state.configured.has(key)) return
  state.configured.add(key)
  const params: string[] = []
  for (const [name, value] of state.connectSettings) params.push(name, value)
  try {
    await conn.execute({
      text: setConfigText(state.connectSettings.length, false),
      params,
    })
  } catch (e) {
    // Never fail a query because a GUC could not be set: a restricted role that cannot change
    // `statement_timeout` is a real deployment, and refusing to run at all would be worse than
    // running without our default.
    state.configured.delete(key)
    state.hooks.internal({
      kind: 'session-guc-skipped',
      message: `pg-prime: could not apply session defaults on this connection (${state.connectSettings
        .map(([n]) => n)
        .join(', ')}).`,
      cause: e,
    })
  }
}

function setConfigText(count: number, local: boolean): string {
  const calls: string[] = []
  for (let i = 0; i < count; i++) calls.push(`set_config($${i * 2 + 1},$${i * 2 + 2},${local})`)
  return `select ${calls.join(', ')}`
}

/**
 * `07` §3.6 — "streaming and COPY default to `null` for their duration".
 *
 * Emitted only when the caller asked for a specific value **or** when we applied a session
 * `statement_timeout` that a long stream would otherwise trip. Emitting it unconditionally would
 * put an extra round trip on every stream to change nothing, which the AS BUILT note records.
 */
async function applyStreamTimeout(conn: PgConnection, o: StatementOptions): Promise<void> {
  const want = (o as { statementTimeoutMs?: number | null }).statementTimeoutMs
  if (want === undefined) return
  await conn.execute({
    text: 'select set_config($1,$2,true)',
    params: ['statement_timeout', want === null ? '0' : String(want)],
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// One statement: timing, hooks, the timeout timer, error mapping
// ─────────────────────────────────────────────────────────────────────────────

function operationOf(compiled: Compiled<unknown>): QueryOperation {
  const k = compiled.meta.kind
  return k === 'setop' ? 'select' : k
}

function tablesOf(compiled: Compiled<unknown>): readonly string[] | undefined {
  const meta = compiled.meta
  const names = [...meta.writes, ...meta.reads].map((q) => q.name)
  return names.length === 0 ? undefined : names
}

/**
 * The one place a statement is executed with everything `07` asks for around it.
 *
 * The `decodeMs` / `serverMs` split is honest about what it can see: `serverMs` is the awaited
 * `conn.execute`, which is round trip + server work, and `decodeMs` is `decoderFor(...)`'s output
 * applied to the rows. `runOn` does both, so the split is measured by timing the boundary the
 * executor exposes — `07` §7.1 asks for "driver time vs our decode time", which is what this is.
 */
export async function execute<Row>(
  state: SessionState,
  lease: Lease,
  desc: StatementDescriptor<Row>,
  o: StatementOptions,
  handle: 'db' | 'tx' | 'session',
  depth: number,
  tx: TxRuntime | undefined,
): Promise<Row[]> {
  const hooks = state.hooks
  const wantEvents = hooks.enabled || state.log.logAllQueries || state.log.slowQueryMs !== null
  const callSite = state.errors.captureCallSite ? captureCallSite(execute) : undefined
  const started = performance.now()
  const queryId = wantEvents ? nextQueryId() : ''
  const paramCount = desc.paramCount

  const start: QueryStartEvent | undefined = wantEvents
    ? {
        queryId,
        sql: desc.sql,
        paramCount,
        execMode: o.statement ?? state.env.statement,
        handle,
        depth,
        attempt: tx?.attempt ?? 1,
        startedAt: started,
        operation: desc.operation,
        tables: desc.tables,
        label: o.label,
        txId: tx?.txId,
      }
    : undefined
  if (start !== undefined) hooks.queryStart(start)

  const noticeSink =
    hooks.enabled && lease.conn.on !== undefined
      ? lease.conn.on('notice', ((n: PgNoticeData) => hooks.notice({ notice: n, queryId })) as never)
      : undefined

  const timing: RunTiming | undefined = wantEvents ? { serverMs: 0, decodeMs: 0 } : undefined
  const timer = startClientTimeout(lease.conn, o, handle)
  const runOpts: RunOptions = {
    ...(o.params === undefined ? {} : { params: o.params }),
    ...(o.statement === undefined ? {} : { statement: o.statement }),
    ...(timer.signal === undefined ? {} : { signal: timer.signal }),
  }

  try {
    const out = await desc.perform(
      lease.conn,
      state.env,
      timing === undefined ? runOpts : { ...runOpts, timing },
    )
    const durationMs = performance.now() - started
    if (start !== undefined) {
      const serverMs = timing?.serverMs ?? durationMs
      const decodeMs = timing?.decodeMs ?? 0
      hooks.queryEnd({
        ...start,
        durationMs,
        rowCount: out.rowCount,
        command: desc.operation.toUpperCase(),
        serverMs,
        decodeMs,
        waitedForConnectionMs: lease.waitedMs,
      })
      logQuery(state, start, durationMs, out.rowCount, serverMs, decodeMs, lease.waitedMs, callSite)
    }
    return out.rows
  } catch (raw) {
    const durationMs = performance.now() - started
    const error = mapStatementError(state, raw, desc, o, handle, tx, callSite, timer.fired())
    if (tx !== undefined && isPoisoning(error)) tx.poisonedBy ??= error
    if (start !== undefined) {
      hooks.queryError({
        ...start,
        durationMs,
        error,
        waitedForConnectionMs: lease.waitedMs,
      })
      if (shouldLog(state.log, 'error')) {
        state.log.sink(queryErrorRecord({ ...start, durationMs, error, waitedForConnectionMs: lease.waitedMs }))
      }
    }
    throw error
  } finally {
    timer.clear()
    noticeSink?.()
  }
}

function logQuery(
  state: SessionState,
  start: QueryStartEvent,
  durationMs: number,
  rowCount: number,
  serverMs: number,
  decodeMs: number,
  waitedMs: number,
  callSite: string | undefined,
): void {
  const slow = state.log.slowQueryMs
  const isSlow = slow !== null && durationMs >= slow
  if (!isSlow && !state.log.logAllQueries) return
  if (!shouldLog(state.log, isSlow ? 'warn' : 'debug')) return
  state.log.sink(
    slowQueryRecord(
      {
        ...start,
        durationMs,
        rowCount,
        command: '',
        serverMs,
        decodeMs,
        waitedForConnectionMs: waitedMs,
      },
      callSite,
      isSlow ? 'slow-query' : 'query',
    ),
  )
}

/**
 * `07` §6.2 — a client-side timer outside a transaction: fire, `CancelRequest`, and surface
 * `QueryTimeoutError` rather than `QueryCanceledError`, because *we* gave up and the server may
 * still be working.
 */
function startClientTimeout(
  conn: PgConnection,
  o: StatementOptions,
  handle: 'db' | 'tx' | 'session',
): { signal: AbortSignal | undefined; fired: () => boolean; clear: () => void } {
  const base = o.signal
  const useTimer =
    o.timeoutMs !== undefined && handle !== 'tx' && o.timeoutStrategy !== 'transaction'
  if (!useTimer) return { signal: base, fired: () => false, clear: () => {} }
  const ac = new AbortController()
  let fired = false
  const t = setTimeout(() => {
    fired = true
    ac.abort(new Error(`pg-prime: statement timeout after ${String(o.timeoutMs)} ms`))
  }, o.timeoutMs)
  ;(t as unknown as { unref?: () => void }).unref?.()
  const onOuter = (): void => ac.abort(base?.reason)
  base?.addEventListener('abort', onOuter, { once: true })
  void conn
  return {
    signal: ac.signal,
    fired: () => fired,
    clear: () => {
      clearTimeout(t)
      base?.removeEventListener('abort', onOuter)
    },
  }
}

function mapStatementError<Row>(
  state: SessionState,
  raw: unknown,
  desc: StatementDescriptor<Row>,
  o: StatementOptions,
  handle: 'db' | 'tx' | 'session',
  tx: TxRuntime | undefined,
  callSite: string | undefined,
  timedOut: boolean,
): PgPrimeError {
  const mapped = mapError(raw, {
    context: {
      handle,
      ...(tx === undefined ? {} : { attempt: tx.attempt, depth: tx.depth, txId: tx.txId }),
      ...(o.label === undefined ? {} : { label: o.label }),
    },
    errors: state.errors,
    sql: desc.sql,
    params: undefined,
    paramTypes: desc.paramTypes,
    ...(callSite === undefined ? {} : { callSite }),
    schema: state.schema,
    ...(tx?.poisonedBy === undefined ? {} : { poisonedBy: tx.poisonedBy }),
  }) as PgPrimeError
  if (!timedOut) return mapped
  // Our own timer fired. Whatever the server said afterwards, the caller's question is "did *we*
  // give up?", and the answer changes what they should do next (§6.2).
  return new QueryTimeoutError(
    `pg-prime: statement timed out after ${String(o.timeoutMs)} ms (client-side timer). A ` +
      `CancelRequest was sent, but it is best-effort — the server may still be running the ` +
      `statement. Use { timeoutStrategy: 'transaction' } for a server-enforced statement_timeout.`,
    {
      cause: mapped,
      context: { handle, reason: 'cancel' },
      ...(callSite === undefined ? {} : { callSite }),
    },
  )
}

/** Anything that leaves the transaction in the aborted state, i.e. anything the server rejected. */
function isPoisoning(e: PgPrimeError): boolean {
  return e.code.length === 5 && e.code !== '25P02'
}

/** After a cancel, a protocol error or a dead socket, the connection must not go back to the pool. */
function poisons(e: unknown): boolean {
  const data = (e as { pgPrime?: { connectionUnusable?: boolean } } | null | undefined)?.pgPrime
  if (data?.connectionUnusable === true) return true
  const state = sqlStateOfError(e)
  return state !== undefined && (state.startsWith('08') || state === '57P01' || state === 'XX000')
}

/**
 * `AbortSignal.any` is Node 20+/ES2024 and not on every runtime we target, so the two-signal case
 * is written out. Composition is `07` §6.1's "composes downward".
 */
function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  const any = (AbortSignal as unknown as { any?: (s: readonly AbortSignal[]) => AbortSignal }).any
  if (any !== undefined) return any.call(AbortSignal, signals)
  const ac = new AbortController()
  for (const s of signals) {
    if (s.aborted) {
      ac.abort(s.reason)
      return ac.signal
    }
    s.addEventListener('abort', () => ac.abort(s.reason), { once: true })
  }
  return ac.signal
}
