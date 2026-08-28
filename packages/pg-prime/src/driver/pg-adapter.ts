/**
 * The node-postgres adapter — design/02-driver.md §5.
 *
 * Implemented over a USER-SUPPLIED pool-like object (Kysely's model). We never parse a connection
 * string and never own a credential: TLS, SCRAM, `.pgpass`, unix sockets, `keepAlive` and every
 * other connection concern is configured on the user's own `Pool` and passes through untouched.
 *
 * Nothing in this file imports `pg`. Everything is structural (`./pg-like.ts`).
 */

import {
  closeStatementViaSubmittable,
  describeViaSubmittable,
  executeCappedViaSubmittable,
  toPgField,
} from './submittable.js'
import { copyInViaSubmittable, copyOutViaSubmittable } from './copy.js'
import { PgDriverError, normaliseError, toServerErrorData, isServerErrorShape } from './errors.js'
import type { NormaliseOptions } from './errors.js'
import type {
  PgDriverConfig,
  PgLikeCancelClient,
  PgLikeClient,
  PgLikeConnection,
  PgLikeDedicatedClient,
  PgLikePool,
  PgLikePoolClient,
  PgLikeQueryConfig,
  PgLikeResult,
  PgLikeTypeSource,
} from './pg-like.js'
import type {
  PgAcquireOptions,
  PgCapabilities,
  PgConnection,
  PgCopyOptions,
  PgCopyResult,
  PgDescribeResult,
  PgDriver,
  PgField,
  PgNoticeData,
  PgQuery,
  PgRawValue,
  PgResult,
  PgResultChunk,
} from './types.js'

const ADAPTER = 'pg'

/**
 * How long we wait for a SPARE pooled connection to send `pg_cancel_backend` from. Unbounded was a
 * bug: on an exhausted pool the wait outlived the statement it was cancelling, and the cancel then
 * landed on whatever the recycled backend was running for SOMEBODY ELSE.
 */
const CANCEL_CONNECT_TIMEOUT_MS = 2_000

/**
 * Prepared-statement names reach the wire as a protocol C-string. An embedded NUL truncates it —
 * `'a\0b'` becomes statement `'a'` — so a name that round-trips is not the name that was closed.
 * PostgreSQL identifiers are ≤ 63 bytes (NAMEDATALEN - 1).
 */
const STATEMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/

const identity = (v: string): string => v

function adapterError(message: string, sql?: string): PgDriverError {
  const data: Record<string, unknown> = {
    kind: 'adapter',
    message,
    connectionUnusable: false,
    adapter: ADAPTER,
  }
  if (sql !== undefined) data['sql'] = sql
  return new PgDriverError(data as never)
}

/** pg's `query_timeout` give-up, verbatim (`pg/lib/client.js`). */
function isQueryReadTimeout(e: unknown): boolean {
  return e instanceof Error && e.message === 'Query read timeout'
}

/**
 * One in-flight statement. The FIFO of these IS the connection's execution order — pg runs the
 * queries it is handed strictly in order — which is what lets notices and cancellations be
 * attributed to the RIGHT statement instead of to whichever one happened to be awaiting.
 */
interface Pending {
  readonly token: number
  readonly notices: PgNoticeData[]
  /** Rejects the awaiting `execute()` when the cancel request itself failed (nothing else will). */
  readonly failed: Promise<never>
  readonly fail: (e: unknown) => void
  cancelError?: string
}

function newPending(token: number): Pending {
  let fail!: (e: unknown) => void
  // `#run` always feeds this to `Promise.race`, so a rejection is never unhandled.
  const failed = new Promise<never>((_resolve, reject) => {
    fail = reject
  })
  return { token, notices: [], failed, fail }
}

/**
 * §5.1 — THE TRICK. `pg` reads `query.types` twice with two different meanings:
 *   - `pg/lib/query.js` Parse path: as an ARRAY of parameter type OIDs
 *   - `pg/lib/query.js` Result path: as an OBJECT with `getTypeParser`
 *
 * We satisfy BOTH with one value: an array of param OIDs carrying a `getTypeParser`
 * own-property that returns the identity function for every OID and every format.
 *
 * Consequences, both load-bearing:
 *   1. ALL of pg's result parsing is neutralised — raw wire text reaches our codecs (D7).
 *   2. Parameter type OIDs ARE sent in Parse, so a bare `$1` does not raise
 *      `42P18 could not determine data type of parameter $1`, and we never have to pollute the
 *      generated SQL with `::type` casts (D10).
 *
 * And critically: this needs NO cooperation from how the user constructed their Pool. A pool
 * built with no `types` option at all still yields raw text, because we override per query.
 * (`pg.types.setTypeParser` — the global — is process-wide mutation and would corrupt every other
 * library in the user's app. Per-query is strictly better.)
 */
export function typeSource(paramOids: readonly number[]): PgLikeTypeSource {
  const a = paramOids.slice() as number[] & { getTypeParser?: unknown }
  a.getTypeParser = () => identity
  return a as unknown as PgLikeTypeSource
}

/** Cursor names only need to be unique per connection; a module counter is plenty. */
let cursorSeq = 0

/** Server parameters are captured once per physical connection and reused. */
const serverParamCache = new WeakMap<object, Record<string, string>>()
const paramStatusSubscribed = new WeakSet<object>()

const SERVER_PARAMS_SQL = `select name, setting from pg_catalog.pg_settings where name in
  ('DateStyle','IntervalStyle','TimeZone','standard_conforming_strings','client_encoding',
   'integer_datetimes','server_version','server_version_num','search_path','application_name')`

/**
 * §4.7 — GUCs the codecs depend on. Asserted, never `SET` by us (`SET` is pooler-hostile).
 *
 * Called from `init()` only, i.e. once per driver against ONE connection. That is deliberate: the
 * values come from the server's configuration, not from the session, and a per-acquire assertion
 * would cost a comparison on the hot path to catch a case that cannot arise without someone
 * issuing `SET` behind our back. `serverParameters` stays live for anyone who wants to re-check.
 */
export function assertSessionGucs(params: Readonly<Record<string, string>>): void {
  const fail = (guc: string, want: string, got: string | undefined): never => {
    throw new PgDriverError({
      kind: 'adapter',
      message: `pg-prime requires ${guc} ${want}, but this session has ${JSON.stringify(got)}. pg-prime never SETs session GUCs (forbidden under transaction pooling); configure it on your own Pool.`,
      connectionUnusable: false,
      adapter: ADAPTER,
    })
  }
  const ds = params['DateStyle']
  if (ds !== undefined && !ds.startsWith('ISO')) fail('DateStyle', 'to start with "ISO"', ds)
  const is = params['IntervalStyle']
  if (is !== undefined && is !== 'postgres' && is !== 'iso_8601')
    fail('IntervalStyle', '= postgres | iso_8601', is)
  const ce = params['client_encoding']
  if (ce !== undefined && ce !== 'UTF8') fail('client_encoding', '= UTF8', ce)
  const scs = params['standard_conforming_strings']
  if (scs !== undefined && scs !== 'on') fail('standard_conforming_strings', '= on', scs)
  const idt = params['integer_datetimes']
  if (idt !== undefined && idt !== 'on') fail('integer_datetimes', '= on', idt)
  // TimeZone: no requirement — every temporal codec is offset-driven.
}

// ─────────────────────────────────────────────────────────────────────────────

class PgConnectionImpl implements PgConnection {
  readonly #client: PgLikePoolClient
  readonly #driver: PgDriverImpl
  #serverParameters: Record<string, string> = {}
  #usable = true
  /** Whatever made this connection unusable, kept so later calls reject with the REAL cause. */
  #failure: unknown
  #seq = 0
  /** In-flight statements, oldest first. `#pending[0]` is the one actually on the wire. */
  readonly #pending: Pending[] = []
  #streaming = false
  #listening = false

  /**
   * pg-pool takes ITS `error` listener off the client at checkout (`pg-pool/index.js`: the idle
   * listener is removed on acquire and re-added on release) and pg emits `error` unconditionally
   * on a dead socket (`client.js` `_handleErrorEvent`). With nothing listening in between, a
   * server restart / `pg_terminate_backend` / `idle_session_timeout` during a checkout is an
   * UNHANDLED 'error' event — i.e. the host process exits. So the adapter owns a listener for the
   * whole checkout, and it is also the ONLY thing that flips `usable` for a socket death.
   */
  readonly #onClientError = (e: unknown): void => {
    this.#usable = false
    if (this.#failure === undefined) this.#failure = e
  }

  /**
   * Notices are attributed to the statement they belong to. The sink used to be attached for the
   * whole `client.query()` await, so a second `execute()` queued behind the first collected the
   * FIRST statement's notices as well.
   */
  readonly #onNotice = (n: unknown): void => {
    const current = this.#pending[0]
    if (!current || n === null || typeof n !== 'object') return
    current.notices.push(toServerErrorData(n as Record<string, unknown>))
  }

  constructor(client: PgLikePoolClient, driver: PgDriverImpl) {
    this.#client = client
    this.#driver = driver
  }

  /** @internal — attached for exactly as long as this connection is checked out. */
  attachClientListeners(): void {
    if (this.#listening) return
    this.#listening = true
    this.#client.on('error', this.#onClientError as (a: never) => void)
    this.#client.on('notice', this.#onNotice as (a: never) => void)
  }

  /** @internal — detached on release/destroy so pg-pool's own idle listener takes over again. */
  detachClientListeners(): void {
    if (!this.#listening) return
    this.#listening = false
    this.#client.removeListener('error', this.#onClientError as (a: never) => void)
    this.#client.removeListener('notice', this.#onNotice as (a: never) => void)
  }

  /** @internal */
  get rawClient(): PgLikePoolClient {
    return this.#client
  }

  get backendPid(): number | undefined {
    // pg's `processID` is `null` until BackendKeyData arrives, and a `null` here would go out as
    // `pg_cancel_backend('null')`. "Unknown" is the seam's word for that.
    const pid = this.#client.processID
    return typeof pid === 'number' && pid > 0 ? pid : undefined
  }

  get serverParameters(): Readonly<Record<string, string>> {
    return this.#serverParameters
  }

  get transactionStatus(): 'I' | 'T' | 'E' | undefined {
    const s = this.#client.getTransactionStatus?.()
    // pg reports `null` until the first ReadyForQuery. `undefined` ("cannot tell") is the seam's
    // word for that; returning `null` through a `'I' | 'T' | 'E' | undefined` getter is a lie.
    return s === 'I' || s === 'T' || s === 'E' ? s : undefined
  }

  get usable(): boolean {
    return this.#usable
  }

  /** Every entry point starts here: a dead connection must not put anything on the wire. */
  #assertUsable(sql?: string): void {
    if (this.#usable) return
    const cause = this.#failure ?? new Error('this connection is no longer usable')
    const opts: NormaliseOptions = { adapter: ADAPTER, connectionUnusable: true }
    throw new PgDriverError(
      normaliseError(cause, sql === undefined ? opts : { ...opts, sql }),
    )
  }

  /**
   * ⚠️ DEVIATION from 02 §4.7, forced by the user-supplied-pool model. 02 says ParameterStatus is
   * captured at startup. pg emits `parameterStatus` on the Connection but never stores it, and by
   * the time a user hands us an already-constructed Pool the startup messages are long gone. So:
   * one `pg_settings` query per PHYSICAL connection (cached in a WeakMap keyed by the pg client),
   * plus a live `parameterStatus` subscription for anything that changes afterwards. Cost is one
   * round trip per physical connection lifetime, not per acquire.
   */
  async loadServerParameters(): Promise<void> {
    const cached = serverParamCache.get(this.#client)
    if (cached) {
      this.#serverParameters = cached
      return
    }
    const res = (await this.#client.query({
      text: SERVER_PARAMS_SQL,
      rowMode: 'array',
      queryMode: 'extended',
      types: typeSource([]),
    })) as PgLikeResult
    // §4.4 / D6 — a Pool constructed with `binary: true` makes pg force `query.binary = true` on
    // EVERY query it did not already mark (`client.js`), and pg-protocol then UTF-8-decodes the
    // binary DataRow bytes, silently corrupting every codec. Nothing else detects it, so the very
    // first query on a physical connection is the assertion.
    if (res.fields.some((f) => f.format === 'binary')) {
      throw adapterError(
        `this pool forces BINARY result format (Pool option 'binary: true'), which pg-protocol ` +
          `UTF-8-decodes and corrupts for any byte >= 0x80 (design/02 §4.4). Remove 'binary' from ` +
          `the Pool options; the '${ADAPTER}' adapter needs text results.`,
      )
    }
    const out: Record<string, string> = {}
    for (const row of res.rows as unknown as [string, string][]) out[row[0]] = row[1]
    serverParamCache.set(this.#client, out)
    this.#serverParameters = out

    const conn = this.#client.connection
    if (conn && !paramStatusSubscribed.has(this.#client)) {
      paramStatusSubscribed.add(this.#client)
      conn.on('parameterStatus', ((msg: { parameterName?: string; parameterValue?: string }) => {
        if (msg?.parameterName) out[msg.parameterName] = msg.parameterValue ?? ''
      }) as (m: never) => void)
    }
  }

  // ── execute ────────────────────────────────────────────────────────────────

  async execute(query: PgQuery): Promise<PgResult> {
    const mode = query.mode ?? 'unnamed'
    this.#assertUsable(query.text)
    if (query.signal?.aborted) {
      throw new PgDriverError(
        normaliseError(query.signal.reason ?? new Error('aborted'), {
          adapter: ADAPTER,
          sql: query.text,
          aborted: true,
        }),
      )
    }
    if (mode === 'simple' && query.params.length > 0) {
      throw new PgDriverError({
        kind: 'adapter',
        message: `mode 'simple' cannot carry parameters (${query.params.length} given); the simple query protocol has no Bind message.`,
        connectionUnusable: false,
        adapter: ADAPTER,
        sql: query.text,
      })
    }
    if (mode === 'named' && !query.statementName) {
      throw new PgDriverError({
        kind: 'adapter',
        message: `mode 'named' requires a statementName.`,
        connectionUnusable: false,
        adapter: ADAPTER,
        sql: query.text,
      })
    }
    if (query.statementName !== undefined) assertStatementName(query.statementName)
    if (
      query.paramTypes !== undefined &&
      query.paramTypes.length !== 0 &&
      query.paramTypes.length !== query.params.length
    ) {
      // §2.3: "length must equal params.length or be 0". pg pads/truncates silently otherwise,
      // and the backend then infers the missing OIDs — which is exactly the 42P18 we send OIDs
      // to avoid, only now with a wrong-arity Parse nobody can see.
      throw adapterError(
        `paramTypes has ${query.paramTypes.length} entries but params has ${query.params.length}; ` +
          `they must match, or paramTypes must be empty (design/02 §2.3).`,
        query.text,
      )
    }
    if (query.resultFormat === 'binary') {
      throw new PgDriverError({
        kind: 'adapter',
        message: `resultFormat 'binary' is not supported by the '${ADAPTER}' adapter: pg-protocol UTF-8-decodes every DataRow field, which corrupts any byte >= 0x80 (design/02 §4.4). capabilities.binaryResults is false.`,
        connectionUnusable: false,
        adapter: ADAPTER,
        sql: query.text,
      })
    }

    if (query.maxRows !== undefined && mode !== 'simple') {
      return this.#executeCapped(query, query.maxRows)
    }

    return this.#run(query, async (entry) => {
      const config: PgLikeQueryConfig =
        mode === 'simple'
          ? // D5/§5.3: the ONLY path that does not force the extended protocol. Multi-statement
            // bodies and `CREATE INDEX CONCURRENTLY` scripts need it.
            { text: query.text, rowMode: 'array', types: typeSource([]) }
          : {
              text: query.text,
              values: query.params as unknown[],
              rowMode: 'array',
              // D4/§5.3: ALWAYS extended, even with 0 params. Without this pg silently falls back
              // to the SIMPLE protocol, which happily runs `select 1; drop table users` as two
              // statements. Forcing extended turns that into a server-side 42601.
              queryMode: 'extended',
              types: typeSource(query.paramTypes ?? []),
            }
      if (mode === 'named' && query.statementName !== undefined) config.name = query.statementName
      // `timeoutMs: 0` is passed through as-is and pg reads it as falsy, i.e. "use the Pool's
      // query_timeout". There is no per-query way to say "no deadline" to pg, so the seam
      // documents 0 as "inherit" rather than pretending otherwise (PgQuery.timeoutMs).
      if (query.timeoutMs !== undefined) config.query_timeout = query.timeoutMs

      // `entry.failed` only ever rejects when a cancel request we issued for THIS statement could
      // not be delivered: pg would otherwise keep awaiting a query nobody can stop.
      const raw = await Promise.race([this.#client.query(config), entry.failed])
      // The simple protocol returns an ARRAY of results for a multi-statement string.
      const results = Array.isArray(raw) ? raw : [raw]
      const last = results[results.length - 1]
      if (!last) {
        return { rows: [], fields: [], rowCount: null, command: '', notices: entry.notices }
      }
      return {
        rows: last.rows as readonly (readonly PgRawValue[])[],
        fields: last.fields.map(toPgField),
        rowCount: last.rowCount,
        // EmptyQueryResponse leaves pg's `command` unset; the seam promises a string.
        command: last.command ?? '',
        notices: entry.notices,
      }
    })
  }

  /**
   * The plumbing every statement shares: an in-flight token (so a cancel can be aimed at THIS
   * statement and at nothing else), its own notice sink, and one place that turns a rejection
   * into seam data.
   */
  async #run<T>(query: PgQuery, body: (entry: Pending) => Promise<T>): Promise<T> {
    // An already-aborted signal must not put anything on the wire, whichever entry point we came
    // through — `execute()` checks this too, but `describe()` and `stream()` come through here.
    if (query.signal?.aborted) {
      throw new PgDriverError(
        normaliseError(query.signal.reason ?? new Error('aborted'), {
          adapter: ADAPTER,
          sql: query.text,
          aborted: true,
        }),
      )
    }
    const entry = newPending((this.#seq += 1))
    this.#pending.push(entry)
    const detachAbort = this.#attachAbort(query.signal, entry.token)
    try {
      return await body(entry)
    } catch (e) {
      if (e instanceof PgDriverError) throw e // already seam data (a failed cancel, a nested call)
      if (isQueryReadTimeout(e)) {
        // §5.4 + the release trap: pg gave up client-side, but the statement is STILL RUNNING on
        // this socket. Handing the client back to the pool means the next borrower's first query
        // waits behind it (and its DataRows arrive with our no-op callback). The connection is
        // done; `release()` disposes it.
        this.#usable = false
        if (this.#failure === undefined) this.#failure = e
      }
      if (isServerErrorShape(e) && this.#usable) await this.#afterReadyForQuery()
      const opts: NormaliseOptions = {
        adapter: ADAPTER,
        sql: query.text,
        aborted: query.signal?.aborted === true,
        ...(this.#usable ? {} : { connectionUnusable: true }),
        ...(entry.cancelError === undefined ? {} : { cancelError: entry.cancelError }),
      }
      throw new PgDriverError(normaliseError(e, opts))
    } finally {
      detachAbort()
      const i = this.#pending.indexOf(entry)
      if (i >= 0) this.#pending.splice(i, 1)
    }
  }

  /**
   * Hold a server-error rejection until the backend's ReadyForQuery has been handled.
   *
   * pg settles a query at ErrorResponse and records the transaction status at the ReadyForQuery
   * that follows it (`Client#_handleErrorMessage` vs `_handleReadyForQuery`). When both messages
   * arrive in one TCP read the parser handles both before the rejection's microtask runs, and
   * `transactionStatus` reads `'E'` after `await execute()` rejects; when the socket delivers
   * them in two reads it still reads the pre-statement `'T'`. The seam promises the
   * *post-statement* status after an awaited call (`PgConnection.transactionStatus`), and a
   * caller that checks it before `rollback` — or `stream()`'s own `'E'` guard — must not depend
   * on packet boundaries. CI flipped on exactly this (run 33059095233, `cursor.test.ts` "refuses
   * to stream inside a FAILED transaction"): a test that had been green for five runs read `'T'`.
   *
   * Only a server error is held. After an ErrorResponse the backend always sends ReadyForQuery
   * (it discards until Sync, then reports), so the wait is bounded by the round trip already in
   * flight. A socket error, a client-side read deadline or a failed cancel has no ReadyForQuery
   * coming — those paths retire the connection and are not held — and `end`/`error` on the client
   * release the wait for the case where the socket dies in between. A drop-in client without
   * `readyForQuery` / `connection` is not held either, which is the documented cost of lacking
   * them.
   */
  #afterReadyForQuery(): Promise<void> {
    const client = this.#client
    const con = client.connection
    if (client.readyForQuery !== false || con === undefined) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = (): void => {
        con.removeListener('readyForQuery', done as (msg: never) => void)
        client.removeListener('end', done as (arg: never) => void)
        client.removeListener('error', done as (arg: never) => void)
        resolve()
      }
      con.on('readyForQuery', done as (msg: never) => void)
      client.on('end', done as (arg: never) => void)
      client.on('error', done as (arg: never) => void)
    })
  }

  #attachAbort(signal: AbortSignal | undefined, token: number): () => void {
    if (!signal) return () => {}
    const onAbort = (): void => {
      // A real CancelRequest, not merely dropping the promise (§2.3) — and aimed at the statement
      // this signal belongs to, never at whatever the backend is running by the time it lands.
      void this.#cancelStatement(token)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    return () => signal.removeEventListener('abort', onAbort)
  }

  // ── cursors: stream() and maxRows ──────────────────────────────────────────

  /**
   * `DECLARE … CURSOR FOR <query>` + `FETCH FORWARD n` — the ZERO-DEPENDENCY cursor path.
   *
   * 07 §6.3 left open whether PostgreSQL accepts bind parameters in `DECLARE … CURSOR` over the
   * extended query protocol (psycopg2 interpolating client-side was weak evidence against).
   * MEASURED ON PG 17.11: **it does.** See test/driver/cursor.test.ts. So `.stream()` needs
   * neither `pg-cursor` nor an optional peer dependency.
   *
   * Two constraints the tests pinned down and this code obeys:
   *   1. `DECLARE` is only legal inside a transaction block unless `WITH HOLD` is used
   *      (`25P01`). We join an open transaction, or open our own and close it on exit.
   *   2. The FETCH COUNT may NOT be a bind parameter (`FETCH FORWARD $1` → `42601 syntax error`).
   *      It is inlined as a validated integer literal — which is safe because the ORM, never the
   *      user, supplies it.
   */
  async *stream(query: PgQuery, chunkSize: number): AsyncIterable<PgResultChunk> {
    this.#assertUsable(query.text)
    const n = Math.max(1, Math.floor(chunkSize))
    if (!Number.isSafeInteger(n)) {
      throw adapterError(`chunkSize must be a safe integer, got ${String(chunkSize)}`, query.text)
    }
    // One cursor per connection at a time. Two overlapping non-joined streams would interleave
    // their BEGIN/COMMIT on the SAME session, so the first one to finish commits the other's
    // transaction out from under it. Sequential streams are fine; concurrent ones need a second
    // connection, and saying so beats silently corrupting transaction scope.
    if (this.#streaming) {
      throw adapterError(
        `this connection already has an open stream(); two overlapping streams on one connection ` +
          `share its transaction and are not supported — acquire a second connection.`,
        query.text,
      )
    }
    const status = this.transactionStatus
    if (status === undefined) {
      // We would have to BEGIN/COMMIT blindly, and a blind COMMIT ends a transaction the CALLER
      // opened. Refuse instead: this adapter cannot auto-manage what it cannot observe.
      throw adapterError(
        `stream() needs to know whether this session is already in a transaction and this ` +
          `pg-like client does not expose getTransactionStatus(); open a transaction yourself ` +
          `before calling stream(), or use an adapter that reports it.`,
        query.text,
      )
    }
    if (status === 'E') {
      throw adapterError(
        `stream() cannot run inside a FAILED transaction (transactionStatus 'E'): DECLARE would ` +
          `raise 25P02. Roll back (or roll back to a savepoint) first.`,
        query.text,
      )
    }

    const cursor = `pgprime_c_${(cursorSeq = (cursorSeq + 1) % 0xffffffff).toString(36)}`
    const joined = status === 'T'
    const inner = {
      ...(query.signal ? { signal: query.signal } : {}),
      ...(query.timeoutMs !== undefined ? { timeoutMs: query.timeoutMs } : {}),
    }
    this.#streaming = true
    if (!joined) await this.#raw('begin', query.signal)

    let declared = false
    try {
      await this.execute({
        text: `declare ${cursor} no scroll cursor for ${query.text}`,
        params: query.params,
        ...(query.paramTypes ? { paramTypes: query.paramTypes } : {}),
        mode: 'unnamed',
        ...inner,
      })
      declared = true

      let fields: readonly PgField[] = []
      for (;;) {
        const chunk = await this.execute({
          text: `fetch forward ${n} from ${cursor}`,
          params: [],
          mode: 'unnamed',
          ...inner,
        })
        if (chunk.fields.length > 0) fields = chunk.fields
        const done = chunk.rows.length < n
        yield { rows: chunk.rows, fields, done }
        if (done) return
      }
    } finally {
      this.#streaming = false
      // Closing the iterator (break/return/throw) MUST close the portal — §2.2. Best effort: the
      // failure that got us here is the one the caller should see.
      if (declared && this.#usable) await this.#raw(`close ${cursor}`).catch(() => {})
      if (!joined && this.#usable) await this.#raw('commit').catch(() => {})
    }
  }

  /**
   * `maxRows` — Parse + Bind + Describe(P) + **Execute with `rows = n`** + Close(P) + Sync,
   * in ONE round trip.
   *
   * ⚠️ REVISES design/02 amendment ③. That amendment ruled out pg's own `rows` option (correctly:
   * pg PAGES with it, so every row still crosses the wire) and implemented the cap over
   * `DECLARE`/`FETCH` — five round trips, `command`/`notices` invented rather than reported, and
   * `INSERT … RETURNING` impossible, because DECLARE cannot wrap DML. Driving the portal
   * ourselves keeps the real CommandComplete and works inside or outside a transaction.
   */
  async #executeCapped(query: PgQuery, maxRows: number): Promise<PgResult> {
    if (!Number.isSafeInteger(maxRows) || maxRows < 0) {
      throw adapterError(`maxRows must be a non-negative safe integer, got ${String(maxRows)}`, query.text)
    }
    return this.#run(query, async (entry) => {
      // `Execute(rows = 0)` means UNLIMITED on the wire, so a literal `maxRows: 0` asks for one
      // row and throws it away: the statement still executes (side effects, notices, tag), which
      // is what "run it, give me no rows" has to mean.
      const capped = await Promise.race([
        executeCappedViaSubmittable(this.#client, {
          text: query.text,
          values: query.params as readonly (string | Uint8Array | null)[],
          paramTypes: query.paramTypes ?? [],
          rows: maxRows === 0 ? 1 : maxRows,
        }),
        entry.failed,
      ])
      return {
        rows: maxRows === 0 ? [] : capped.rows,
        fields: capped.fields,
        rowCount: maxRows === 0 ? 0 : capped.rowCount,
        command: capped.command,
        notices: entry.notices,
      }
    })
  }

  async #raw(sql: string, signal?: AbortSignal): Promise<void> {
    await this.#run({ text: sql, params: [], ...(signal ? { signal } : {}) }, async (entry) =>
      Promise.race([
        this.#client.query({
          text: sql,
          rowMode: 'array',
          queryMode: 'extended',
          types: typeSource([]),
        }),
        entry.failed,
      ]),
    )
  }

  // ── optional capabilities ──────────────────────────────────────────────────

  async describe(sql: string, options?: { readonly signal?: AbortSignal }): Promise<PgDescribeResult> {
    this.#assertUsable(sql)
    return this.#run(
      { text: sql, params: [], ...(options?.signal ? { signal: options.signal } : {}) },
      async (entry) => Promise.race([describeViaSubmittable(this.#client, sql), entry.failed]),
    )
  }

  async closeStatement(name: string): Promise<void> {
    this.#assertUsable()
    assertStatementName(name)
    try {
      await closeStatementViaSubmittable(this.#client, name)
    } catch (e) {
      throw new PgDriverError(
        normaliseError(e, {
          adapter: ADAPTER,
          ...(this.#usable ? {} : { connectionUnusable: true }),
        }),
      )
    }
  }

  /**
   * `COPY … FROM STDIN` (design/07 §6.6, decision 9 of design/12 §1).
   *
   * The statement goes out over the simple query protocol — COPY carries no bind parameters, so
   * there is nothing the extended protocol could add — and the payload rides pg's own
   * `sendCopyFromChunk` / `endCopyFrom`. That is the API `pg-copy-streams` itself uses, which is why
   * `07` §6.6's optional peer dependency is not needed.
   */
  async copyIn(
    sql: string,
    source: AsyncIterable<Uint8Array>,
    options?: PgCopyOptions,
  ): Promise<PgCopyResult> {
    this.#assertUsable(sql)
    return this.#run({ text: sql, params: [], ...(options?.signal ? { signal: options.signal } : {}) }, async (entry) =>
      Promise.race([
        copyInViaSubmittable(this.#client, sql, source, options?.signal, entry.notices),
        entry.failed,
      ]),
    )
  }

  /** `COPY … TO STDOUT`. Raw `CopyData` payloads; the caller owns framing (text/csv/binary). */
  copyOut(sql: string, options?: PgCopyOptions): AsyncIterable<Uint8Array> {
    this.#assertUsable(sql)
    return copyOutViaSubmittable(this.#client, sql, options?.signal)
  }

  /**
   * Cancel whatever is currently on this connection's wire. No-op when nothing is running (§2.2).
   *
   * Two paths: a protocol CancelRequest on its own socket when the caller supplied
   * `createCancelClient`, otherwise `pg_cancel_backend(pid)` from a SECOND pooled connection.
   * (pg's `query_timeout` is NOT a cancellation path: it gives up client-side while the query
   * keeps burning CPU on the server.)
   */
  async cancel(): Promise<void> {
    const current = this.#pending[0]
    if (!current) return
    await this.#cancelStatement(current.token)
  }

  /**
   * The token is what makes this safe. Waiting for a spare connection can easily outlive the
   * statement, and by then this backend has been released and is running SOMEBODY ELSE's SQL —
   * cancelling it would be a random query failure with no explanation anywhere.
   */
  async #cancelStatement(token: number): Promise<void> {
    const current = this.#pending[0]
    if (!current || current.token !== token) return
    const isCurrent = (): boolean => this.#pending[0]?.token === token
    try {
      await this.#driver.cancelBackend(this.#client, this.backendPid, isCurrent)
    } catch (e) {
      if (!isCurrent()) return // it finished on its own while we were failing to cancel it
      const message = e instanceof Error ? e.message : String(e)
      current.cancelError = message
      // We could not stop the statement and nothing else will: the caller asked to abort, so fail
      // their promise rather than hang, and retire the connection — the statement is still running
      // on it, so it must never go back to the pool.
      this.#usable = false
      if (this.#failure === undefined) this.#failure = e
      current.fail(
        new PgDriverError(
          normaliseError(e, {
            adapter: ADAPTER,
            aborted: true,
            connectionUnusable: true,
            cancelError: message,
          }),
        ),
      )
    }
  }

  on(event: 'notice' | 'notification' | 'error', listener: (arg: never) => void): () => void {
    const wrapped =
      event === 'notification'
        ? ((n: { channel?: string; payload?: string; processId?: number }) =>
            (listener as unknown as (x: unknown) => void)({
              channel: n?.channel ?? '',
              payload: n?.payload ?? '',
              processId: n?.processId ?? 0,
            }))
        : event === 'notice'
          ? ((n: unknown) =>
              (listener as unknown as (x: unknown) => void)(
                toServerErrorData((n ?? {}) as Record<string, unknown>),
              ))
          : // `usable` is NOT flipped here: `#onClientError` is attached for the whole checkout
            // and already did it, whether or not anybody subscribed.
            ((e: unknown) =>
              (listener as unknown as (x: unknown) => void)(
                normaliseError(e, { adapter: ADAPTER, connectionUnusable: true }),
              ))
    this.#client.on(event, wrapped as (a: never) => void)
    return () => {
      this.#client.removeListener(event, wrapped as (a: never) => void)
    }
  }
}

/** §2.3 / §5.2 — a statement name reaches the wire as a C-string; validate before it does. */
function assertStatementName(name: string): void {
  if (!STATEMENT_NAME.test(name)) {
    throw adapterError(
      `invalid statementName ${JSON.stringify(name)}: prepared-statement names must match ` +
        `${String(STATEMENT_NAME)} (≤ 63 bytes, no NUL — an embedded NUL silently TRUNCATES the ` +
        `protocol C-string, so the statement parsed is not the statement closed).`,
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────

class PgDriverImpl implements PgDriver {
  readonly #config: PgDriverConfig
  #initialised = false
  #destroyed = false
  #capabilities: PgCapabilities
  readonly #live = new Map<PgConnection, PgLikePoolClient>()
  /** Connections handed out by `connect()`: not the pool's, so `release` ends them instead. */
  readonly #dedicated = new WeakSet<PgConnection>()

  constructor(config: PgDriverConfig) {
    this.#config = config
    this.#capabilities = {
      adapter: ADAPTER,
      execModes: ['unnamed', 'named', 'simple'],
      // §4.4: pg-protocol UTF-8-decodes every DataRow field. Binary results are byte-corrupting.
      binaryResults: false,
      paramTypeOids: true,
      describe: true,
      richFieldMetadata: true,
      cursors: true,
      // Real since design/12 §3 S: `./copy.ts` drives pg's connection-level COPY messages, so
      // there is no optional peer and no capability to apologise for.
      copyIn: true,
      copyOut: true,
      listenNotify: true,
      // Honest, not aspirational: without `createCancelClient` the only cancel we can perform is
      // `pg_cancel_backend` from a second POOLED connection (§5.4). Supply `createCancelClient`
      // and the adapter sends a real protocol CancelRequest on its own socket instead — which is
      // the only path that also works when the pool is exhausted.
      cancel: config.createCancelClient ? 'protocol' : 'pg_cancel_backend',
      multipleStatementsPerSession: true,
      maxConnections: undefined,
      maxParams: 65535,
      serverVersionNum: undefined,
    }
  }

  get capabilities(): PgCapabilities {
    return this.#capabilities
  }

  async init(): Promise<void> {
    if (this.#initialised) return
    const conn = await this.acquire()
    try {
      assertSessionGucs(conn.serverParameters)
      const svn = conn.serverParameters['server_version_num']
      this.#capabilities = {
        ...this.#capabilities,
        serverVersionNum: svn ? Number(svn) : undefined,
        maxConnections: numOrUndefined(this.#config.pool.options?.['max']),
      }
      this.#initialised = true
    } finally {
      await this.release(conn)
    }
  }

  async acquire(options?: PgAcquireOptions): Promise<PgConnection> {
    if (this.#destroyed) {
      throw new PgDriverError({
        kind: 'adapter',
        message: 'driver has been destroyed',
        connectionUnusable: true,
        adapter: ADAPTER,
      })
    }
    if (options?.signal?.aborted) {
      throw new PgDriverError(
        normaliseError(options.signal.reason ?? new Error('aborted'), {
          adapter: ADAPTER,
          aborted: true,
        }),
      )
    }
    const pool =
      options?.route === 'direct' ? (this.#config.directPool ?? this.#config.pool) : this.#config.pool
    let client: PgLikePoolClient
    try {
      // The abort path MUST still release the slot: `pool.connect()` keeps running, and a client
      // that arrives after we rejected is a leaked pool slot — one per aborted acquire, until the
      // pool is permanently exhausted.
      client = await withSignal(pool.connect(), options?.signal, (c) => c.release(true))
    } catch (e) {
      throw new PgDriverError(
        normaliseError(e, { adapter: ADAPTER, aborted: options?.signal?.aborted === true }),
      )
    }
    const conn = new PgConnectionImpl(client, this)
    conn.attachClientListeners()
    try {
      await conn.loadServerParameters()
    } catch (e) {
      // Same leak, other end: a failing first query (a `binary: true` pool, a dead socket, a
      // revoked `pg_settings` grant) escaped un-normalised AND kept the connection checked out.
      conn.detachClientListeners()
      client.release(true)
      if (e instanceof PgDriverError) throw e
      throw new PgDriverError(normaliseError(e, { adapter: ADAPTER, sql: SERVER_PARAMS_SQL }))
    }
    this.#live.set(conn, client)
    return conn
  }

  /**
   * A connection the pool does not own — `07` §6.5's requirement for `LISTEN`.
   *
   * Two paths, and the second is a deliberate, documented compromise.
   *
   *  1. **`createDedicatedClient`** (what `pgPrime({ connection })` always supplies, derived from
   *     the same config the pool was built from): a fresh client, connected here, closed on
   *     `release(conn, { dispose: true })`. This is the design.
   *  2. **No factory** — a bring-your-own `pool:` we cannot construct a sibling client for. Rather
   *     than refuse `db.listen()` outright for every such user, we check a connection out of the
   *     pool and never give it back for the subscription's lifetime, which costs exactly one pool
   *     slot. The runtime warns, once, and names `createDedicatedClient` as the fix. `07` §6.5's
   *     objection to a pool client is that it *silently* shrinks `max`; saying so out loud is the
   *     difference.
   */
  async connect(options?: PgAcquireOptions): Promise<PgConnection> {
    const make = this.#config.createDedicatedClient
    if (make === undefined) return this.acquire(options)
    const client = make()
    await client.connect()
    const wrapped = asPoolClient(client)
    const conn = new PgConnectionImpl(wrapped, this)
    conn.attachClientListeners()
    try {
      await conn.loadServerParameters()
    } catch (e) {
      conn.detachClientListeners()
      await client.end().catch(() => {})
      if (e instanceof PgDriverError) throw e
      throw new PgDriverError(normaliseError(e, { adapter: ADAPTER, sql: SERVER_PARAMS_SQL }))
    }
    this.#live.set(conn, wrapped)
    this.#dedicated.add(conn)
    return conn
  }

  async release(connection: PgConnection, options?: { dispose?: boolean }): Promise<void> {
    const client = this.#live.get(connection)
    if (!client) return
    this.#live.delete(connection)
    // Read the status BEFORE handing the client back: an open ('T') or failed ('E') transaction
    // returned to the pool becomes the next borrower's transaction — their first statement joins
    // it, and an eventual ROLLBACK throws away work they never saw. `undefined` means the client
    // cannot tell us, and disposing on "don't know" would recycle every connection.
    const status = connection.transactionStatus
    const dispose =
      options?.dispose === true ||
      connection.usable === false ||
      status === 'T' ||
      status === 'E'
    if (connection instanceof PgConnectionImpl) connection.detachClientListeners()
    client.release(dispose ? true : undefined)
  }

  /** @internal — `connect()`'s connections are ended, not returned. */
  isDedicated(connection: PgConnection): boolean {
    return this.#dedicated.has(connection)
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return
    this.#destroyed = true
    for (const [conn, client] of this.#live) {
      this.#live.delete(conn)
      if (conn instanceof PgConnectionImpl) conn.detachClientListeners()
      try {
        client.release(true)
      } catch {
        /* already gone */
      }
    }
    // §2.1 says destroy() is idempotent and safe. `pool.end()` on a pool the user already ended
    // throws, and that must not turn a teardown into a failure.
    await this.#config.pool.end().catch(() => {})
    if (this.#config.directPool && this.#config.directPool !== this.#config.pool) {
      await this.#config.directPool.end().catch(() => {})
    }
  }

  /**
   * @internal — used by `PgConnection.cancel()`.
   *
   * `isCurrent()` is re-checked immediately before the cancel goes out, because everything up to
   * that point can take arbitrarily long (the pool may be empty) and the statement we are
   * cancelling may have finished — at which point the backend is running someone else's SQL.
   */
  async cancelBackend(
    target: PgLikeClient,
    pid: number | undefined,
    isCurrent: () => boolean,
  ): Promise<void> {
    const makeCancelClient = this.#config.createCancelClient
    if (makeCancelClient) {
      const canceller = makeCancelClient()
      if (!isCurrent()) return
      // A protocol CancelRequest on its own socket: no pooled connection to borrow, so it works
      // even when the pool is exhausted — which is exactly when a cancel matters most.
      canceller.cancel(target, target.activeQuery)
      return
    }
    if (pid === undefined) {
      throw adapterError(
        `cannot cancel: this client does not expose a backend PID and no createCancelClient was ` +
          `configured (design/02 §5.4).`,
      )
    }
    const pool = this.#config.directPool ?? this.#config.pool
    const client = await withDeadline(
      pool.connect(),
      CANCEL_CONNECT_TIMEOUT_MS,
      () =>
        adapterError(
          `could not obtain a spare connection to send pg_cancel_backend(${pid}) within ` +
            `${CANCEL_CONNECT_TIMEOUT_MS} ms; the pool is exhausted. Configure ` +
            `createCancelClient for a protocol CancelRequest that needs no pooled connection.`,
        ),
      (c) => c.release(true),
    )
    try {
      if (!isCurrent()) return
      await client.query({
        text: 'select pg_catalog.pg_cancel_backend($1)',
        values: [String(pid)],
        rowMode: 'array',
        queryMode: 'extended',
        types: typeSource([23]),
      })
    } finally {
      client.release()
    }
  }
}

/**
 * A dedicated client, wearing a `PgLikePoolClient`'s `release`.
 *
 * `PgConnectionImpl` is written against a pool client, and the *only* member a dedicated one lacks
 * is `release`. Giving it one that ends the socket is four lines and keeps a single connection
 * implementation, which matters because everything subtle in this file — the error listener that
 * stops an unhandled `'error'` from exiting the process, the ReadyForQuery hold, the notice
 * attribution — would otherwise have to exist twice.
 */
function asPoolClient(client: PgLikeDedicatedClient): PgLikePoolClient {
  const wrapped = client as PgLikeDedicatedClient & { release?: (err?: Error | boolean) => void }
  if (typeof wrapped.release !== 'function') {
    wrapped.release = () => {
      void client.end().catch(() => {})
    }
  }
  return wrapped as PgLikePoolClient
}

function numOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * Reject on abort, and hand the late arrival to `dispose` — the underlying promise is NOT
 * cancellable, so whatever it eventually produces is ours to clean up or leak.
 */
function withSignal<T>(
  p: Promise<T>,
  signal: AbortSignal | undefined,
  dispose: (value: T) => void,
): Promise<T> {
  if (!signal) return p
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      settled = true
      reject(signal.reason ?? new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        if (settled) dispose(v)
        else resolve(v)
      },
      (e: unknown) => {
        if (!settled) reject(e)
      },
    ).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** Same contract as `withSignal`, with a timer instead of a signal. */
function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  onTimeout: () => Error,
  dispose: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      reject(onTimeout())
    }, ms)
    // Never keep the event loop alive for a cancel that nobody is waiting on.
    ;(timer as unknown as { unref?: () => void }).unref?.()
    p.then(
      (v) => {
        clearTimeout(timer)
        if (settled) dispose(v)
        else resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        if (!settled) reject(e)
      },
    )
  })
}

/** The one public constructor. `pgDriver({ pool: new Pool({ connectionString }) })`. */
export function pgDriver(config: PgDriverConfig): PgDriver {
  return new PgDriverImpl(config)
}

export type { PgLikeCancelClient, PgLikeClient, PgLikeConnection, PgLikePool, PgLikePoolClient }
