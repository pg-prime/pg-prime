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
  toPgField,
} from './submittable.js'
import { PgDriverError, normaliseError, toServerErrorData } from './errors.js'
import type {
  PgDriverConfig,
  PgLikeClient,
  PgLikeConnection,
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

const identity = (v: string): string => v

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

/** Server parameters are captured once per physical connection and reused. */
const serverParamCache = new WeakMap<object, Record<string, string>>()
const paramStatusSubscribed = new WeakSet<object>()

const SERVER_PARAMS_SQL = `select name, setting from pg_catalog.pg_settings where name in
  ('DateStyle','IntervalStyle','TimeZone','standard_conforming_strings','client_encoding',
   'integer_datetimes','server_version','server_version_num','search_path','application_name')`

/** §4.7 — GUCs the codecs depend on. Asserted, never `SET` by us (`SET` is pooler-hostile). */
export function assertSessionGucs(params: Readonly<Record<string, string>>): void {
  const fail = (guc: string, want: string, got: string | undefined): never => {
    throw new PgDriverError({
      kind: 'adapter',
      message: `pgorm requires ${guc} ${want}, but this session has ${JSON.stringify(got)}. pgorm never SETs session GUCs (forbidden under transaction pooling); configure it on your own Pool.`,
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

  constructor(client: PgLikePoolClient, driver: PgDriverImpl) {
    this.#client = client
    this.#driver = driver
  }

  /** @internal */
  get rawClient(): PgLikePoolClient {
    return this.#client
  }

  get backendPid(): number | undefined {
    return this.#client.processID
  }

  get serverParameters(): Readonly<Record<string, string>> {
    return this.#serverParameters
  }

  get transactionStatus(): 'I' | 'T' | 'E' | undefined {
    return this.#client.getTransactionStatus?.()
  }

  get usable(): boolean {
    return this.#usable
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

  // ── notices ────────────────────────────────────────────────────────────────

  #collectNotices(sink: PgNoticeData[]): () => void {
    const onNotice = (n: unknown): void => {
      if (n && typeof n === 'object') sink.push(toServerErrorData(n as Record<string, unknown>))
    }
    this.#client.on('notice', onNotice as (a: never) => void)
    return () => {
      this.#client.removeListener?.('notice', onNotice as (a: never) => void)
    }
  }

  // ── execute ────────────────────────────────────────────────────────────────

  async execute(query: PgQuery): Promise<PgResult> {
    const mode = query.mode ?? 'unnamed'
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
    if (query.resultFormat === 'binary') {
      throw new PgDriverError({
        kind: 'adapter',
        message: `resultFormat 'binary' is not supported by the '${ADAPTER}' adapter: pg-protocol UTF-8-decodes every DataRow field, which corrupts any byte >= 0x80 (design/02 §4.4). capabilities.binaryResults is false.`,
        connectionUnusable: false,
        adapter: ADAPTER,
        sql: query.text,
      })
    }

    // `maxRows` cannot be expressed through pg's `rows` option: pg PAGES with it
    // (`handlePortalSuspended` → `_getRows` again) rather than truncating, so every row still
    // crosses the wire. A real cap needs a cursor.
    if (query.maxRows !== undefined && mode !== 'simple') {
      return this.#executeCapped(query, query.maxRows)
    }

    const notices: PgNoticeData[] = []
    const stopNotices = this.#collectNotices(notices)
    const detachAbort = this.#attachAbort(query.signal)

    try {
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
      if (query.timeoutMs !== undefined) config.query_timeout = query.timeoutMs

      const raw = await this.#client.query(config)
      // The simple protocol returns an ARRAY of results for a multi-statement string.
      const results = Array.isArray(raw) ? raw : [raw]
      const last = results[results.length - 1]
      if (!last) {
        return { rows: [], fields: [], rowCount: null, command: '', notices }
      }
      return {
        rows: last.rows as readonly (readonly PgRawValue[])[],
        fields: last.fields.map(toPgField),
        rowCount: last.rowCount,
        command: last.command,
        notices,
      }
    } catch (e) {
      throw new PgDriverError(
        normaliseError(e, {
          adapter: ADAPTER,
          sql: query.text,
          aborted: query.signal?.aborted === true,
          timedOut: query.timeoutMs !== undefined,
        }),
      )
    } finally {
      detachAbort()
      stopNotices()
    }
  }

  #attachAbort(signal: AbortSignal | undefined): () => void {
    if (!signal) return () => {}
    const onAbort = (): void => {
      // A real CancelRequest, not merely dropping the promise (§2.3).
      void this.cancel().catch(() => {})
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
    const n = Math.max(1, Math.floor(chunkSize))
    if (!Number.isSafeInteger(n)) {
      throw new PgDriverError({
        kind: 'adapter',
        message: `chunkSize must be a safe integer, got ${String(chunkSize)}`,
        connectionUnusable: false,
        adapter: ADAPTER,
      })
    }
    const cursor = `pgorm_c_${(cursorSeq = (cursorSeq + 1) % 0xffffffff).toString(36)}`
    const joined = this.transactionStatus === 'T'
    if (!joined) await this.#raw('begin')

    let declared = false
    try {
      await this.execute({
        text: `declare ${cursor} no scroll cursor for ${query.text}`,
        params: query.params,
        ...(query.paramTypes ? { paramTypes: query.paramTypes } : {}),
        mode: 'unnamed',
      })
      declared = true

      let fields: readonly PgField[] = []
      for (;;) {
        const chunk = await this.execute({
          text: `fetch forward ${n} from ${cursor}`,
          params: [],
          mode: 'unnamed',
        })
        if (chunk.fields.length > 0) fields = chunk.fields
        const done = chunk.rows.length < n
        yield { rows: chunk.rows, fields, done }
        if (done) return
      }
    } finally {
      // Closing the iterator (break/return/throw) MUST close the portal — §2.2.
      if (declared && this.#usable) await this.#raw(`close ${cursor}`).catch(() => {})
      if (!joined && this.#usable) await this.#raw('commit').catch(() => {})
    }
  }

  async #executeCapped(query: PgQuery, maxRows: number): Promise<PgResult> {
    const rows: (readonly PgRawValue[])[] = []
    let fields: readonly PgField[] = []
    if (maxRows <= 0) return { rows, fields, rowCount: 0, command: 'SELECT', notices: [] }
    for await (const chunk of this.stream(query, maxRows)) {
      fields = chunk.fields
      for (const r of chunk.rows) {
        if (rows.length >= maxRows) break
        rows.push(r)
      }
      break
    }
    return { rows, fields, rowCount: rows.length, command: 'SELECT', notices: [] }
  }

  async #raw(sql: string): Promise<void> {
    await this.#client.query({ text: sql, rowMode: 'array', queryMode: 'extended', types: typeSource([]) })
  }

  // ── optional capabilities ──────────────────────────────────────────────────

  async describe(sql: string): Promise<PgDescribeResult> {
    try {
      return await describeViaSubmittable(this.#client, sql)
    } catch (e) {
      throw new PgDriverError(normaliseError(e, { adapter: ADAPTER, sql }))
    }
  }

  async closeStatement(name: string): Promise<void> {
    try {
      await closeStatementViaSubmittable(this.#client, name)
    } catch (e) {
      throw new PgDriverError(normaliseError(e, { adapter: ADAPTER }))
    }
  }

  /**
   * `pg_cancel_backend` from a SECOND pooled connection. Resolves once the request has been sent;
   * the in-flight query rejects separately with 57014.
   *
   * (The protocol path — an UNCONNECTED `new Client(cfg)` then `.cancel(target, activeQuery)` —
   * needs `createCancelClient` in config and is left for the runtime layer to opt into. Note that
   * pg's `query_timeout` is NOT a cancellation path: it gives up client-side while the query keeps
   * burning CPU on the server.)
   */
  async cancel(): Promise<void> {
    const pid = this.backendPid
    if (pid === undefined) return
    await this.#driver.cancelBackend(pid)
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
          : ((e: unknown) => {
              this.#usable = false
              ;(listener as unknown as (x: unknown) => void)(
                normaliseError(e, { adapter: ADAPTER }),
              )
            })
    this.#client.on(event, wrapped as (a: never) => void)
    return () => {
      this.#client.removeListener?.(event, wrapped as (a: never) => void)
    }
  }

  /** @internal */
  markUnusable(): void {
    this.#usable = false
  }
}

let cursorSeq = 0

// ─────────────────────────────────────────────────────────────────────────────

class PgDriverImpl implements PgDriver {
  readonly #config: PgDriverConfig
  #initialised = false
  #destroyed = false
  #capabilities: PgCapabilities
  readonly #live = new Map<PgConnection, PgLikePoolClient>()

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
      copyIn: false,
      copyOut: false,
      listenNotify: true,
      // Honest, not aspirational: `cancel()` below is implemented with `pg_cancel_backend` from
      // a second pooled connection. The protocol path (§5.4) needs an UNCONNECTED second client
      // plus the target's `_activeQuery`; `createCancelClient` is carried in the config for it
      // but the runtime layer (agent 07) owns opting into it, so we do not claim it here.
      cancel: 'pg_cancel_backend',
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
      client = await withSignal(pool.connect(), options?.signal)
    } catch (e) {
      throw new PgDriverError(
        normaliseError(e, { adapter: ADAPTER, aborted: options?.signal?.aborted === true }),
      )
    }
    const conn = new PgConnectionImpl(client, this)
    await conn.loadServerParameters()
    this.#live.set(conn, client)
    return conn
  }

  async release(connection: PgConnection, options?: { dispose?: boolean }): Promise<void> {
    const client = this.#live.get(connection)
    if (!client) return
    this.#live.delete(connection)
    const dispose = options?.dispose === true || connection.usable === false
    client.release(dispose ? true : undefined)
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return
    this.#destroyed = true
    for (const [conn, client] of this.#live) {
      this.#live.delete(conn)
      try {
        client.release(true)
      } catch {
        /* already gone */
      }
    }
    await this.#config.pool.end()
    if (this.#config.directPool && this.#config.directPool !== this.#config.pool) {
      await this.#config.directPool.end()
    }
  }

  /** @internal — used by `PgConnection.cancel()`. */
  async cancelBackend(pid: number): Promise<void> {
    const pool = this.#config.directPool ?? this.#config.pool
    const client = await pool.connect()
    try {
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

function numOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function withSignal<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** The one public constructor. `pgDriver({ pool: new Pool({ connectionString }) })`. */
export function pgDriver(config: PgDriverConfig): PgDriver {
  return new PgDriverImpl(config)
}

export type { PgLikeClient, PgLikeConnection, PgLikePool, PgLikePoolClient }
