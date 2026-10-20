/**
 * Where a statement meets a connection (design/07 §1, §4, §6, §7): `PoolRunner` checks one out per
 * operation, `ConnRunner` reuses the one `transaction()` holds. `execute()` is the one statement
 * path, so error mapping, hooks, the slow-query log, call-site capture, timeouts and the
 * `.ifVersion()` check live there once; session GUCs, cancellation and the dev guard sit around it.
 * Builder terminals reach all of it through the `Runner` interface (`src/query/builder-state.ts`).
 */

import type { Compiled, CompiledMeta } from '../compile/contract.js'
import { paramTypesOf } from '../compile/contract.js'
import type { PgConnection, PgDriver, PgNoticeData, PgResult } from '../driver/types.js'
import { PgPrimeError as PgPrimeErrorClass } from '../errors/index.js'
import type { PgPrimeError } from '../errors/index.js'
import {
  DbClosedError,
  QueryTimeoutError,
  TransactionAbandonedError,
  TransactionClosedError,
  UsageError,
  VersionConflictError,
  captureCallSite,
  mapError,
  sqlStateOfError,
} from '../errors/index.js'
import type { ErrorContext, PoolStats, ResolvedErrorOptions } from '../errors/index.js'
import type { HookBus, QueryOperation, ResolvedLogOptions, SpanContext } from '../observe/index.js'
import { nextQueryId, queryErrorRecord, shouldLog, slowQueryRecord } from '../observe/index.js'
import type { QueryStartEvent } from '../observe/index.js'
import type { PoolerMode, PoolerProfile } from '../pooler/profiles.js'
import type { Runner } from '../query/builder-state.js'
import type { ExecEnv, RunOptions, RunTiming } from '../query/executor.js'
import { bindsToParams, runOn } from '../query/executor.js'
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
  /**
   * The `statement_timeout` **we** install per physical connection, or `undefined` when we install
   * none. Read by `ConnRunner.#restoreValue`, which explains why it has to exist.
   */
  readonly sessionStatementTimeout: string | undefined
  readonly transaction: TransactionDefaults | undefined
  readonly signal: AbortSignal | undefined
  readonly spanContext: SpanContext
  readonly poolStats: () => PoolStats | undefined
  /** Physical connections that have already had their session GUCs applied (§3.6). */
  readonly configured: WeakSet<object>
  ended: boolean
  warn(message: string): void
  /**
   * `07` §5.4's dev-mode startup check, run **once, asynchronously, after the first connection**.
   *
   * Not at construction: `pgPrime` opens no socket (§1.1) and §8 rejection 25 refuses to spend
   * startup latency on a heuristic. Not blocking the first query either — this is scheduled on a
   * macrotask *after* an acquire has already succeeded, so the probe rides a warm pool and its
   * cost lands on nobody's critical path.
   */
  startupProbe: (() => void) | undefined
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
  /**
   * The bind values that were sent — the failure path's only source for both `paramCount` and,
   * under `errors.includeParams`, `params` (`07` §4.3).
   *
   * A method, not a field: the values are the PII, so they are built where an error is already
   * being constructed and never on the success path. Whether they are *published* is
   * `mapDriverError`'s decision and only its decision — R10 M9 is the mutation that pins that,
   * and R10 M8 is why the count is not computed separately here.
   */
  paramValues(opts: StatementOptions): readonly unknown[] | undefined
  /** Runs it. `timing` is filled when somebody is listening. */
  perform(conn: PgConnection, env: ExecEnv, opts: RunOptions): Promise<StatementResult<Row>>
  /** After `perform`: the `.ifVersion()` check the statement failed, if any. */
  conflict?(): CompiledMeta['versionCheck']
}

/** What {@link StatementDescriptor.perform} resolves with. */
export interface StatementResult<Row> {
  readonly rows: Row[]
  readonly rowCount: number
}

/** `rows` → `{ rows, rowCount }`, hoisted so `perform` allocates no closure per statement. */
function asStatementResult<Row>(rows: Row[]): StatementResult<Row> {
  return { rows, rowCount: rows.length }
}

/**
 * A compiled builder query as a descriptor.
 *
 * **Everything but the SQL is lazy, and that is measured.** `paramTypes` is read by the error
 * mapper and `tables` by the `07` §7.1 events; a statement that neither fails nor is observed paid
 * for both anyway, and `paramTypes` was then built a *second* time inside `runOn` — two
 * 3 000-element arrays per statement on a 1 000-row batch insert (design/12 §4 P). A class rather
 * than an object literal so `perform` is a shared method, not a per-statement closure.
 */
class CompiledStatement<Row> implements StatementDescriptor<Row> {
  readonly compiled: Compiled<Row>
  #paramTypes: readonly number[] | undefined
  #tables: readonly string[] | undefined
  #tablesDone = false

  constructor(compiled: Compiled<Row>) {
    this.compiled = compiled
  }

  get sql(): string {
    return this.compiled.sql
  }

  get paramCount(): number {
    return this.compiled.binds.length
  }

  get paramTypes(): readonly number[] {
    return (this.#paramTypes ??= paramTypesOf(this.compiled.binds))
  }

  get operation(): QueryOperation {
    return operationOf(this.compiled as unknown as Compiled<unknown>)
  }

  get tables(): readonly string[] | undefined {
    if (!this.#tablesDone) {
      this.#tables = tablesOf(this.compiled as unknown as Compiled<unknown>)
      this.#tablesDone = true
    }
    return this.#tables
  }

  /** Exactly what `runOn` put in the `Bind` message, rebuilt on the failure path only. */
  paramValues(opts: StatementOptions): readonly unknown[] {
    return bindsToParams(this.compiled.binds, opts.params)
  }

  perform(conn: PgConnection, env: ExecEnv, opts: RunOptions): Promise<StatementResult<Row>> {
    // `paramTypes` forced rather than lazy: `runOn` needs it for `Parse` anyway, so this is ONE
    // `paramTypesOf` per statement that the error mapper reuses, instead of the two it was. Not
    // `async`: a `.then` is one promise, an `async` frame is a promise plus two closures.
    return runOn(conn, this.compiled, env, opts, this.paramTypes).then(asStatementResult)
  }
}

/** A compiled builder query as a descriptor. */
export function compiledStatement<Row>(compiled: Compiled<Row>): StatementDescriptor<Row> {
  return new CompiledStatement(compiled)
}

/** Also records the command tag's count; events still report `rows.length`. */
class CountedStatement<Row> extends CompiledStatement<Row> {
  readonly count = { rowCount: 0 }

  conflict(): CompiledMeta['versionCheck'] {
    return this.count.rowCount === 0 ? this.compiled.meta.versionCheck : undefined
  }

  override perform(
    conn: PgConnection,
    env: ExecEnv,
    opts: RunOptions,
  ): Promise<StatementResult<Row>> {
    return runOn(conn, this.compiled, env, opts, this.paramTypes, this.count).then(
      asStatementResult,
    )
  }
}

/** What the two runners share. Not exported: `Runner` is the seam, this is the implementation. */
abstract class BaseRunner implements Runner {
  readonly state: SessionState
  readonly defaults: StatementOptions
  abstract readonly inTransaction: boolean

  constructor(state: SessionState, defaults: StatementOptions) {
    if (defaults.timeoutMs !== undefined) assertTimeoutMs(defaults.timeoutMs)
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
  abstract runRaw<Row>(desc: StatementDescriptor<Row>, opts?: RunOptions): Promise<Row[]>
  abstract runChunked<Row>(all: readonly Compiled<Row>[], opts?: RunOptions): Promise<Row[]>

  async run<Row>(compiled: Compiled<Row>, opts?: RunOptions): Promise<Row[]> {
    if (compiled.meta.versionCheck === undefined) {
      return this.runRaw(compiledStatement(compiled), opts)
    }
    return (await this.runCounted(compiled, opts)).rows
  }

  async runCounted<Row>(
    compiled: Compiled<Row>,
    opts?: RunOptions,
  ): Promise<{ rows: Row[]; rowCount: number }> {
    const desc = new CountedStatement(compiled)
    const rows = await this.runRaw(desc, opts)
    return { rows, rowCount: desc.count.rowCount }
  }

  protected merged(opts: RunOptions | undefined): StatementOptions {
    const o = opts as (RunOptions & CallOptions) | undefined
    const d = this.defaults
    if (o === undefined) return d
    if (o.timeoutMs !== undefined) assertTimeoutMs(o.timeoutMs)
    return {
      ...d,
      params: o.params ?? d.params,
      statement: o.statement ?? d.statement,
      signal: o.signal ?? d.signal,
      timeoutMs: o.timeoutMs ?? d.timeoutMs,
      timeoutStrategy: o.timeoutStrategy ?? d.timeoutStrategy,
      label: o.label ?? d.label,
      outsideTransaction: o.outsideTransaction ?? d.outsideTransaction,
    }
  }

  /** `07` §6.1 — the caller's signal composed with the db-wide lifecycle one. */
  protected signalFor(opts: StatementOptions): AbortSignal | undefined {
    return composeSignal(opts.signal, this.state.signal)
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

  use<T>(f: (conn: PgConnection) => Promise<T>): Promise<T> {
    this.assertOpen()
    this.guard()
    return this.#onLease(this.defaults, (lease) => f(lease.conn))
  }

  /** `f` exempt from the session `statement_timeout` like a stream — in a transaction, if needed. */
  useExempt<T>(f: (conn: PgConnection) => Promise<T>): Promise<T> {
    this.assertOpen()
    this.guard()
    return this.#onLease(this.defaults, ({ conn }) => {
      const timeout = streamTimeout(this.state, conn, this.defaults)
      return timeout === undefined ? f(conn) : inTransaction(conn, timeout, () => f(conn))
    })
  }

  async #onLease<T>(o: StatementOptions, f: (lease: Lease) => Promise<T>): Promise<T> {
    const lease = await acquire(this.state, this.signalFor(o))
    let dispose = false
    try {
      return await f(lease)
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
    let dispose = false
    try {
      const timeout = streamTimeout(this.state, lease.conn, this.defaults)
      yield* transactional(lease.conn, timeout, () => f(lease.conn))
    } catch (e) {
      dispose = poisons(e)
      throw this.mapped(e, undefined)
    } finally {
      await release(this.state, lease, dispose)
    }
  }

  protected context(): ErrorContext {
    const label = this.defaults.label
    return label === undefined ? { handle: this.handle } : { handle: this.handle, label }
  }

  /**
   * Chunks of one logical batch, on ONE connection, inside ONE transaction.
   *
   * A half-applied bulk insert is the failure mode that makes chunking untrustworthy, and it is
   * invisible: the caller sees a rejected promise and 40 000 of 50 000 rows committed.
   */
  runChunked<Row>(all: readonly Compiled<Row>[], opts?: RunOptions): Promise<Row[]> {
    this.assertOpen()
    const o = this.merged(opts)
    this.guard(o)
    return this.#onLease(o, (lease) =>
      inTransaction(
        lease.conn,
        serverTimeout(o),
        (inner) =>
          chunked(all, (desc) =>
            execute(this.state, lease, desc, inner, this.handle, 0, undefined),
          ),
        o,
      ),
    )
  }

  /**
   * `` db.sql`…` `` — the same hooks, the same mapping, the same log, the same timeout.
   *
   * It is a separate entry point only because a raw statement has no `Compiled` and therefore no
   * decode plan; everything else about it is a query.
   */
  runRaw<Row>(desc: StatementDescriptor<Row>, opts?: RunOptions): Promise<Row[]> {
    this.assertOpen()
    const o = this.merged(opts)
    this.guard(o)
    const timeout = serverTimeout(o)
    return this.#onLease(o, (lease) =>
      // `07` §6.2's opt-in: a hard server-side guarantee for an autocommit statement, at +2 RTT.
      timeout === undefined
        ? execute(this.state, lease, desc, o, this.handle, 0, undefined)
        : inTransaction(
            lease.conn,
            timeout,
            (inner) => execute(this.state, lease, desc, inner, this.handle, 0, undefined),
            o,
          ),
    )
  }

  /** The root handle is the only one the guard applies to (§1.5 layer 3). */
  private guard(o: StatementOptions = this.defaults): void {
    if (!this.state.devGuard) return
    if (this.#handle !== 'db') return
    if (o.outsideTransaction === true) return
    // A boolean, not a captured stack: `assertNotInsideTransaction` captures only on the path
    // that throws, which is approximately never. See its docblock.
    assertNotInsideTransaction(this.state.errors.captureCallSite)
  }

  private mapped(e: unknown, sql: string | undefined): unknown {
    return mapError(e, {
      context: this.context(),
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
  /**
   * The error that put the transaction into the aborted state, retained for `25P02` (§3.3).
   *
   * A **shared box**, not a field, because a savepoint's `TxRuntime` is a copy of its parent's: a
   * failure inside the savepoint has to be visible to the enclosing transaction (it is the same
   * PostgreSQL transaction), and `ROLLBACK TO SAVEPOINT` has to be able to clear it for everyone.
   * With a plain field the child recorded the poison and the parent never saw it, so the clear was
   * a no-op and the `25P02` message blamed nothing — caught by R10 mutation M4.
   */
  readonly poison: { error: PgPrimeError | undefined }
  /** In-flight statements, for §3.2's warning. */
  inFlight: number
  warned: boolean
  /** The current transaction-local `statement_timeout`, so a repeat costs no round trip. */
  localTimeoutMs: number | undefined
  /**
   * What a statement with no opinion of its own should get: the transaction's own `timeoutMs`, or
   * nothing. Without it, one `.withOptions({ timeoutMs })` statement would silently *clear* the
   * timeout the caller set on the whole transaction.
   */
  baselineTimeoutMs: number | undefined
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
    return new ConnRunner(
      this.state,
      { ...this.defaults, ...extra },
      this.conn,
      this.tx,
      this.#handle,
    )
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
      throw this.#mapped(e, undefined)
    }
  }

  /** See `PoolRunner.useExempt`. A session has no transaction to SET LOCAL in, so it opens one. */
  async useExempt<T>(f: (conn: PgConnection) => Promise<T>): Promise<T> {
    this.#assertUsable()
    if (this.#handle === 'tx') {
      await this.#setLocalTimeout(this.#streamTimeout())
      return this.use(f)
    }
    const timeout = streamTimeout(this.state, this.conn, this.defaults)
    return this.use((conn) =>
      timeout === undefined ? f(conn) : inTransaction(conn, timeout, () => f(conn)),
    )
  }

  /** `SAVEPOINT`, `set_config`, … — mapped like a query, and recorded as poison. */
  async control(text: string, params: readonly (string | null)[] = []): Promise<PgResult> {
    try {
      return await this.conn.execute(
        params.length === 0 ? { text, params, mode: 'simple' } : { text, params },
      )
    } catch (e) {
      throw this.#mapped(e, text)
    }
  }

  /** A `Tx` joins its own transaction; a `Session` opens one for the stream unless one is open. */
  async *scope<T>(f: (conn: PgConnection) => AsyncIterable<T>): AsyncIterable<T> {
    this.#assertUsable()
    if (this.#handle === 'tx') {
      await this.#setLocalTimeout(this.#streamTimeout())
      yield* f(this.conn)
      return
    }
    try {
      const timeout = streamTimeout(this.state, this.conn, this.defaults)
      yield* transactional(this.conn, timeout, () => f(this.conn))
    } catch (e) {
      throw this.#mapped(e, undefined)
    }
  }

  /** See `PoolRunner.runRaw`. Same statement path, the transaction's own connection. */
  async runRaw<Row>(desc: StatementDescriptor<Row>, opts?: RunOptions): Promise<Row[]> {
    this.#assertUsable()
    const o = this.merged(opts)
    if (this.#handle === 'session') {
      // Outside a transaction a SET LOCAL dies with its statement, so the client timer bounds
      // the statement — or the +2 RTT opt-in does.
      const timeout = serverTimeout(o)
      if (timeout === undefined) return this.#execute(desc, o)
      return this.use((conn) =>
        inTransaction(conn, timeout, (inner) => this.#execute(desc, inner), o),
      )
    }
    await this.#setLocalTimeout(o.timeoutMs ?? this.tx.baselineTimeoutMs)
    return this.#execute(desc, o)
  }

  async #execute<Row>(desc: StatementDescriptor<Row>, o: StatementOptions): Promise<Row[]> {
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

  /** A `Tx` is already atomic; a `Session` gets one transaction for the batch, like the pool. */
  runChunked<Row>(all: readonly Compiled<Row>[], opts?: RunOptions): Promise<Row[]> {
    this.#assertUsable()
    if (this.#handle === 'tx') return chunked(all, (desc) => this.runRaw(desc, opts))
    const o = this.merged(opts)
    return this.use((conn) =>
      inTransaction(
        conn,
        serverTimeout(o),
        (inner) => chunked(all, (desc) => this.#execute(desc, inner)),
        o,
      ),
    )
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
   * profile, +1 RTT (§6.2). `0` is what a stream or COPY wants: no timeout for its duration.
   *
   * The transaction remembers the value it currently has, so a loop of statements sharing one
   * timeout pays for one `set_config` and not N. Restoring is likewise lazy: the next statement
   * that wants a different value (including "none") emits the change.
   */
  async #setLocalTimeout(want: number | undefined): Promise<void> {
    if (want === this.tx.localTimeoutMs) return
    await this.control(SET_LOCAL_TIMEOUT, [
      'statement_timeout',
      want === undefined ? this.#restoreValue() : String(want),
    ])
    this.tx.localTimeoutMs = want
  }

  /** An explicit `statementTimeoutMs`, else the transaction's own, else §3.6's exemption. */
  #streamTimeout(): number | undefined {
    const want = (this.defaults as { statementTimeoutMs?: number | null }).statementTimeoutMs
    if (want !== undefined) return want ?? 0
    if (this.tx.baselineTimeoutMs !== undefined) return this.tx.baselineTimeoutMs
    return exemption(this.state, this.conn) === undefined ? undefined : 0
  }

  /**
   * What "the statement's timeout is over" restores to, and why it is not always `NULL`.
   *
   * `set_config(name, NULL, true)` restores the GUC's **reset** value — right when the value we
   * displaced came from `postgresql.conf` or `ALTER ROLE`, wrong when it came from *us*, because a
   * session-level `SET` does not become the reset value. There `NULL` lands on the server's
   * default (`0`: no timeout) for the rest of the transaction, which is the per-transaction
   * exemption the `'0'` spelling was rejected for. Measured on PG 15/17/18 (design/12 §4 D, b).
   *
   * So: the value **we** installed on **this physical connection** (keyed on `serverParameters`,
   * as `applyConnectSettings` keys it), and `NULL` only when we installed nothing — the
   * transaction-pooler case, and `pool:`/`driver:` with no `session:`.
   */
  #restoreValue(): string | null {
    return installedTimeout(this.state, this.conn) ?? null
  }

  protected context(): ErrorContext {
    const { attempt, depth, txId, label } = this.tx
    const base = { handle: this.#handle, attempt, depth, txId }
    return label === undefined ? base : { ...base, label }
  }

  #mapped(e: unknown, sql: string | undefined): unknown {
    const mapped = mapError(e, {
      context: this.context(),
      errors: this.state.errors,
      sql,
      schema: this.state.schema,
      poisonedBy: this.tx.poison.error,
    })
    if (mapped instanceof PgPrimeErrorClass && isPoisoning(mapped)) this.tx.poison.error ??= mapped
    return mapped
  }
}

/** The `statement_timeout` we installed on this physical connection, or nothing. */
function installedTimeout(state: SessionState, conn: PgConnection): string | undefined {
  const value = state.sessionStatementTimeout
  if (value === undefined) return undefined
  return state.configured.has(conn.serverParameters as object) ? value : undefined
}

/** `07` §3.6: a stream or COPY is exempt from the session `statement_timeout`, if we installed one. */
function exemption(state: SessionState, conn: PgConnection): '0' | undefined {
  return installedTimeout(state, conn) === undefined ? undefined : '0'
}

/** The caller's `statementTimeoutMs` (`null` = none), else the exemption. */
function streamTimeout(
  state: SessionState,
  conn: PgConnection,
  o: StatementOptions,
): string | undefined {
  const want = (o as { statementTimeoutMs?: number | null }).statementTimeoutMs
  if (want === undefined) return exemption(state, conn)
  return want === null ? '0' : String(want)
}

/** `07` §6.2's opt-in: the value to `SET LOCAL` around an autocommit statement, if asked for. */
function serverTimeout(o: StatementOptions): string | undefined {
  return o.timeoutMs !== undefined && o.timeoutStrategy === 'transaction'
    ? String(o.timeoutMs)
    : undefined
}

const BEGIN = Object.freeze({ text: 'begin', params: [], mode: 'simple' as const })
const COMMIT = Object.freeze({ text: 'commit', params: [], mode: 'simple' as const })
const ROLLBACK = Object.freeze({ text: 'rollback', params: [], mode: 'simple' as const })

const SET_LOCAL_TIMEOUT = 'select set_config($1,$2,true)'

function setTimeoutQuery(value: string): { text: string; params: string[] } {
  return { text: SET_LOCAL_TIMEOUT, params: ['statement_timeout', value] }
}

async function currentTimeout(conn: PgConnection): Promise<string> {
  const r = await conn.execute({ text: "select current_setting('statement_timeout')", params: [] })
  return String(r.rows[0]?.[0] ?? '0')
}

/**
 * `begin; set_config(statement_timeout); …; commit` around `f`, `rollback` on any other exit. A
 * transaction the caller opened by hand is joined, and the timeout it had is put back afterwards.
 * An adapter that cannot report the status gets no transaction management at all.
 */
async function* transactional<T>(
  conn: PgConnection,
  timeout: string | undefined,
  f: () => AsyncIterable<T>,
): AsyncIterable<T> {
  const status = conn.transactionStatus
  if (status === undefined) {
    yield* f()
    return
  }
  const own = status === 'I'
  const restore = own || timeout === undefined ? undefined : await currentTimeout(conn)
  if (own) await conn.execute(BEGIN)
  let done = false
  let dead = false
  try {
    if (timeout !== undefined) await conn.execute(setTimeoutQuery(timeout))
    yield* f()
    done = true
  } catch (e) {
    dead = poisons(e)
    throw e
  } finally {
    if (!dead) {
      if (own && done) await conn.execute(COMMIT)
      else if (own) await conn.execute(ROLLBACK).catch(() => {})
      if (restore !== undefined) await conn.execute(setTimeoutQuery(restore)).catch(() => {})
    }
  }
}

/** {@link transactional} around one statement or COPY; `body` gets `timeoutMs` cleared when the server enforces it. */
async function inTransaction<T>(
  conn: PgConnection,
  timeout: string | undefined,
  body: (o: StatementOptions) => Promise<T>,
  o: StatementOptions = {},
): Promise<T> {
  if (conn.transactionStatus === undefined) {
    // Nothing to manage, so the client timer bounds the body instead of the server.
    return body(o.timeoutStrategy === 'transaction' ? { ...o, timeoutStrategy: 'client' } : o)
  }
  const inner = timeout === undefined ? o : { ...o, timeoutMs: undefined }
  const run = transactional(conn, timeout, async function* () {
    yield await body(inner)
  })[Symbol.asyncIterator]()
  const { value } = await run.next()
  await run.next()
  return value as T
}

async function chunked<Row>(
  all: readonly Compiled<Row>[],
  run: (desc: StatementDescriptor<Row>) => Promise<Row[]>,
): Promise<Row[]> {
  const out: Row[] = []
  for (const c of all) out.push(...(await run(compiledStatement(c))))
  return out
}

/** `0` would mean "fire now" to a timer and "no timeout" to the server; neither is a timeout. */
export function assertTimeoutMs(ms: number, name = 'timeoutMs', min = 1): void {
  if (Number.isSafeInteger(ms) && ms >= min) return
  throw new UsageError(
    `pg-prime: ${name} must be an integer number of milliseconds` +
      `${min > 0 ? ' greater than 0' : ''}; got ${String(ms)}.`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Acquire / release, with the §3.6 connection setup and the §7.1 pool events
// ─────────────────────────────────────────────────────────────────────────────

export interface Lease {
  readonly conn: PgConnection
  /** `07` §7.1's `waitedForConnectionMs`: "slow query" and "pool exhausted" must not look alike. */
  readonly waitedMs: number
}

/**
 * Is anybody going to read what this statement reports? One predicate for `acquire` and `execute`
 * both, because `waitedForConnectionMs` must be *measured* whenever the end event or the
 * slow-query record will carry it (`07` §7.1 separates "pool exhausted" from "slow query", and a
 * zero there merges them again) and must cost nothing when neither will.
 */
function observed(state: SessionState): boolean {
  const log = state.log
  return state.hooks.enabled || log.logAllQueries || log.slowQueryMs !== null
}

/** `{ kind: 'release' }` has no fields; one frozen object serves every release. */
const RELEASE_EVENT = Object.freeze({ kind: 'release' as const })

export async function acquire(
  state: SessionState,
  signal: AbortSignal | undefined,
  route?: 'default' | 'direct',
): Promise<Lease> {
  const hooks = state.hooks
  // With no observer, `waitedMs` is 0 and no event object is built: two `performance.now()` calls
  // and two allocations per statement that used to be paid whether or not anything read them.
  const timed = observed(state)
  const started = timed ? performance.now() : 0
  let conn: PgConnection
  try {
    conn = await state.driver.acquire(acquireOptions(signal, route))
  } catch (e) {
    if (timed) hooks.pool({ kind: 'timeout', waitedMs: performance.now() - started })
    throw mapError(e, {
      context: { handle: 'db' },
      errors: state.errors,
      schema: state.schema,
      poolStats: state.poolStats(),
    })
  }
  const waitedMs = timed ? performance.now() - started : 0
  if (timed) hooks.pool({ kind: 'acquire', waitedMs })
  // The `length` test is at the call site, because `await`ing an `async` function that returns
  // immediately is not free: a promise, two reaction closures and an await context. The three such
  // frames this file added per statement — this one, `release`, `perform` — measured ~1.6 kB.
  if (state.connectSettings.length !== 0) await applyConnectSettings(state, conn)
  const probe = state.startupProbe
  if (probe !== undefined) {
    // Arm, do not run: the probe owns its own scheduling, because it may only open a connection
    // when the pool is at rest and this is the moment it demonstrably is not (see
    // `maybeWarnAtStartup`).
    state.startupProbe = undefined
    probe()
  }
  return { conn, waitedMs }
}

/** Not `async`: it has nothing to do after the driver's promise, so it hands that promise back. */
export function release(state: SessionState, lease: Lease, dispose: boolean): Promise<void> {
  if (state.hooks.enabled) state.hooks.pool(RELEASE_EVENT)
  return state.driver.release(lease.conn, dispose ? DISPOSE : undefined)
}

const DISPOSE = Object.freeze({ dispose: true as const })

/**
 * The driver's acquire options, or `undefined` — the seam's parameter is optional precisely so the
 * common case can skip it, where the two-spread literal allocated an object to say nothing.
 */
function acquireOptions(
  signal: AbortSignal | undefined,
  route: 'default' | 'direct' | undefined,
): { signal?: AbortSignal; route?: 'default' | 'direct' } | undefined {
  if (signal === undefined) return route === undefined ? undefined : { route }
  return route === undefined ? { signal } : { signal, route }
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
  const wantEvents = observed(state)
  const callSite = state.errors.captureCallSite ? captureCallSite(execute) : undefined
  // No observer, no clock: `started` only ever reaches an event or a log record.
  const started = wantEvents ? performance.now() : 0

  const start: QueryStartEvent | undefined = wantEvents
    ? {
        queryId: nextQueryId(),
        sql: desc.sql,
        paramCount: desc.paramCount,
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
      ? lease.conn.on('notice', ((n: PgNoticeData) =>
          hooks.notice({ notice: n, queryId: start?.queryId ?? '' })) as never)
      : undefined

  const timing: RunTiming | undefined = wantEvents ? { serverMs: 0, decodeMs: 0 } : undefined
  const timer = startClientTimeout(lease.conn, o, handle)
  const runOpts = runOptionsFor(o, timer.signal, timing)

  try {
    const out = await desc.perform(lease.conn, state.env, runOpts)
    const check = desc.conflict?.()
    if (check !== undefined) {
      throw new VersionConflictError(
        `pg-prime: version conflict on "${check.table}": no row matched .ifVersion().`,
        {
          context: contextOf(handle, tx, o),
          table: check.table,
          ...(state.errors.includeParams ? { expected: check.expected } : {}),
          ...(callSite === undefined ? {} : { callSite }),
        },
      )
    }
    if (start !== undefined) {
      const durationMs = performance.now() - started
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
    const error =
      raw instanceof VersionConflictError
        ? raw
        : mapStatementError(state, raw, desc, o, handle, tx, callSite, timer.fired())
    if (tx !== undefined && isPoisoning(error)) tx.poison.error ??= error
    if (start !== undefined) {
      const durationMs = performance.now() - started
      hooks.queryError({
        ...start,
        durationMs,
        error,
        waitedForConnectionMs: lease.waitedMs,
      })
      if (shouldLog(state.log, 'error')) {
        state.log.sink(
          queryErrorRecord({ ...start, durationMs, error, waitedForConnectionMs: lease.waitedMs }),
        )
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
/**
 * The options `runOn` gets, built without spreads. The literal this replaces made an object out of
 * three conditional spreads and then *copied* it to add `timing`: four shapes and two allocations
 * per statement, where the common case is all four undefined and now allocates nothing.
 */
const NO_RUN_OPTIONS: RunOptions = Object.freeze({})

function runOptionsFor(
  o: StatementOptions,
  signal: AbortSignal | undefined,
  timing: RunTiming | undefined,
): RunOptions {
  if (
    o.params === undefined &&
    o.statement === undefined &&
    signal === undefined &&
    timing === undefined
  ) {
    return NO_RUN_OPTIONS
  }
  const out: {
    params?: Readonly<Record<string, unknown>>
    statement?: StatementOptions['statement']
    signal?: AbortSignal
    timing?: RunTiming
  } = {}
  if (o.params !== undefined) out.params = o.params
  if (o.statement !== undefined) out.statement = o.statement
  if (signal !== undefined) out.signal = signal
  if (timing !== undefined) out.timing = timing
  return out as RunOptions
}

const NEVER_FIRED = (): boolean => false
const NO_CLEAR = (): void => {}
/** No timer and no caller signal — the common case, so it allocates nothing. */
const NO_TIMER = Object.freeze({
  signal: undefined,
  fired: NEVER_FIRED,
  clear: NO_CLEAR,
})

function startClientTimeout(
  conn: PgConnection,
  o: StatementOptions,
  handle: 'db' | 'tx' | 'session',
): { signal: AbortSignal | undefined; fired: () => boolean; clear: () => void } {
  const base = o.signal
  const useTimer =
    o.timeoutMs !== undefined && handle !== 'tx' && o.timeoutStrategy !== 'transaction'
  if (!useTimer) {
    return base === undefined ? NO_TIMER : { signal: base, fired: NEVER_FIRED, clear: NO_CLEAR }
  }
  const ac = new AbortController()
  let fired = false
  const t = setTimeout(() => {
    fired = true
    ac.abort(new Error(`pg-prime: statement timeout after ${String(o.timeoutMs)} ms`))
  }, o.timeoutMs)
  ;(t as unknown as { unref?: () => void }).unref?.()
  const onOuter = (): void => ac.abort(base?.reason)
  if (base?.aborted) onOuter()
  else base?.addEventListener('abort', onOuter, { once: true })
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

function contextOf(
  handle: 'db' | 'tx' | 'session',
  tx: TxRuntime | undefined,
  o: StatementOptions,
): ErrorContext {
  return {
    handle,
    ...(tx === undefined ? {} : { attempt: tx.attempt, depth: tx.depth, txId: tx.txId }),
    ...(o.label === undefined ? {} : { label: o.label }),
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
    context: contextOf(handle, tx, o),
    errors: state.errors,
    sql: desc.sql,
    // `07` §4.3's `paramCount` and `params` come from ONE place. The values are the PII and
    // `mapDriverError` alone decides whether to publish them; the count is safe and always
    // published, and deriving it from the same array is what stops the two disagreeing. This is
    // the failure path, once, next to constructing an Error with a stack — the success path never
    // reaches it, which was the whole reason the previous code passed `undefined` here and made
    // `paramCount` read 0 for every statement in the default configuration.
    params: paramValuesOf(desc, o),
    paramTypes: desc.paramTypes,
    ...(callSite === undefined ? {} : { callSite }),
    schema: state.schema,
    ...(tx?.poison.error === undefined ? {} : { poisonedBy: tx.poison.error }),
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

/**
 * The descriptor's bind values, or nothing.
 *
 * `paramValues` can itself throw — a prepared statement missing a placeholder raises a
 * `BuilderError` — and an error mapper that throws while mapping an error replaces the real
 * failure with its own.
 */
function paramValuesOf<Row>(
  desc: StatementDescriptor<Row>,
  o: StatementOptions,
): readonly unknown[] | undefined {
  try {
    return desc.paramValues(o)
  } catch {
    return undefined
  }
}

/** Anything that leaves the transaction in the aborted state, i.e. anything the server rejected. */
function isPoisoning(e: PgPrimeError): boolean {
  return e.code.length === 5 && e.code !== '25P02'
}

/** After a cancel, a protocol error or a dead socket, the connection must not go back to the pool. */
export function poisons(e: unknown): boolean {
  const data = (e as { pgPrime?: { connectionUnusable?: boolean } } | null | undefined)?.pgPrime
  if (data?.connectionUnusable === true) return true
  const state = sqlStateOfError(e)
  return state !== undefined && (state.startsWith('08') || state === '57P01' || state === 'XX000')
}

/** `07` §6.1 — a handle's or transaction's signal composed with the db-wide lifecycle one. */
export function composeSignal(
  own: AbortSignal | undefined,
  global: AbortSignal | undefined,
): AbortSignal | undefined {
  if (own === undefined || global === undefined) return own ?? global
  return anySignal([own, global])
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
