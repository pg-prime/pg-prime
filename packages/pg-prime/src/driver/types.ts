/**
 * The adapter seam — structural interfaces only.
 *
 * Per design/02-driver.md §2. NOTHING in this file (or anywhere under src/) may
 * `import … from 'pg'`. Structural typing is what buys us zero deps AND zero peer deps,
 * and what lets @neondatabase/serverless (which inlined its own, nominally-incompatible
 * declarations) duck-type in for free.
 *
 * Authored for `erasableSyntaxOnly`: no enum, no namespace, no parameter properties.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Wire-level value shapes. These three are the ENTIRE vocabulary of the seam.
// ─────────────────────────────────────────────────────────────────────────────

/** What a codec hands to an adapter. `string` → text format, `Uint8Array` → binary, `null` → SQL NULL. */
export type PgParam = string | Uint8Array | null

/** What an adapter hands back. Adapters never interpret; decoding is the codec registry's job. */
export type PgRawValue = string | Uint8Array | null

export type PgExecMode = 'unnamed' | 'named' | 'simple'

// ─────────────────────────────────────────────────────────────────────────────
// §2.1 Driver — 4 methods
// ─────────────────────────────────────────────────────────────────────────────

/** A driver owns a pool of physical connections. One per configured database URL. */
export interface PgDriver {
  /** Idempotent. Resolve config, validate capabilities, warm the pool. Never opens a connection eagerly. */
  init(): Promise<void>

  /**
   * Check out a physical connection. The returned object is owned by the caller until `release`.
   * `signal` aborts the *acquisition* (pool queue wait), not any query on it.
   */
  acquire(options?: PgAcquireOptions): Promise<PgConnection>

  /**
   * Return a connection to the pool. `dispose: true` destroys it instead of reusing it — the runtime
   * layer sets this after a protocol-level failure, an unfinished COPY, or an aborted transaction it
   * could not roll back.
   */
  release(connection: PgConnection, options?: { dispose?: boolean }): Promise<void>

  /**
   * OPTIONAL. Open a connection the pool does **not** own, for the one feature that needs to pin a
   * backend for its whole lifetime: `LISTEN` (design/07 §6.5).
   *
   * Taking that connection from the pool silently shrinks `max` and eventually starves the app —
   * with the serverless preset's `max: 1` the first subscription deadlocks the process — so the
   * runtime asks for one outside it. The returned connection is released the same way as any
   * other, with `release(conn, { dispose: true })`, which for a dedicated connection means "close
   * the socket".
   *
   * An adapter that cannot do this omits the method; `db.listen()` then says so, naming what to
   * configure instead. Optional so every adapter written before `07` existed still satisfies
   * `PgDriver`.
   */
  connect?(options?: PgAcquireOptions): Promise<PgConnection>

  /** Drain and close everything. Idempotent. Safe to call while queries are in flight (they reject). */
  destroy(): Promise<void>

  /** Static description of what this adapter can do. Read after `init()`. */
  readonly capabilities: PgCapabilities
}

export interface PgAcquireOptions {
  readonly signal?: AbortSignal
  /**
   * Routing hint, not a guarantee. `'direct'` asks for a connection that bypasses any transaction
   * pooler — required for LISTEN, session advisory locks, WITH HOLD cursors, replication and
   * migrations. Adapters without a second URL ignore it.
   */
  readonly route?: 'default' | 'direct'
}

// ─────────────────────────────────────────────────────────────────────────────
// §2.2 Connection — 2 required, 6 optional
// ─────────────────────────────────────────────────────────────────────────────

export interface PgConnection {
  /** REQUIRED. Extended-protocol execution. The single hot path. */
  execute(query: PgQuery): Promise<PgResult>

  /**
   * REQUIRED. Server-side cursor. Yields fixed-size chunks; `fields` is repeated on every chunk so a
   * consumer that only sees one chunk can still decode. Closing the iterator (break/return/throw)
   * MUST close the portal.
   */
  stream(query: PgQuery, chunkSize: number): AsyncIterable<PgResultChunk>

  // ── optional capabilities; presence must match `PgDriver.capabilities` ─────

  /** Parse + Describe('S') + Sync, with NO Execute. Powers typed raw SQL, codegen and migration checks. */
  describe?(sql: string, options?: { readonly signal?: AbortSignal }): Promise<PgDescribeResult>

  /** Protocol-level `Close('S', name)`. NEVER SQL `DEALLOCATE` (breaks PgBouncer). */
  closeStatement?(name: string): Promise<void>

  /** COPY … FROM STDIN. Resolves with the row count from the CommandComplete tag. */
  copyIn?(
    sql: string,
    source: AsyncIterable<Uint8Array>,
    options?: PgCopyOptions,
  ): Promise<PgCopyResult>

  /** COPY … TO STDOUT. Yields raw CopyData payloads; the caller owns framing (text/csv/binary). */
  copyOut?(sql: string, options?: PgCopyOptions): AsyncIterable<Uint8Array>

  /**
   * Best-effort cancellation of whatever is currently executing on this connection.
   * Resolves once the cancel request has been *sent*; the in-flight query rejects separately
   * with SQLSTATE 57014. Safe to call when nothing is running (no-op).
   */
  cancel?(): Promise<void>

  /** Subscribe to async backend messages. Returns an unsubscribe function. */
  on?(event: 'notice', listener: (n: PgNoticeData) => void): () => void
  on?(event: 'notification', listener: (n: PgNotification) => void): () => void
  on?(event: 'error', listener: (e: PgDriverErrorData) => void): () => void

  // ── introspectable state ──────────────────────────────────────────────────

  /** Server backend PID, if the adapter knows it. Needed for `pg_cancel_backend` and diagnostics. */
  readonly backendPid: number | undefined

  /** ParameterStatus values captured at startup + any that changed. §4.7 — we assert on these. */
  readonly serverParameters: Readonly<Record<string, string>>

  /**
   * 'I' idle · 'T' in transaction · 'E' failed transaction · undefined if the adapter can't tell.
   *
   * Post-statement after an awaited `execute()` — including a rejected one. pg reports the status
   * on ReadyForQuery, which follows the ErrorResponse that rejects the promise; the adapter holds
   * the rejection until then, so `await execute(…).catch(…)` followed by a read of this getter
   * sees `'E'`, never the `'T'` the session was in when the statement was sent.
   */
  readonly transactionStatus: 'I' | 'T' | 'E' | undefined

  /** False after a protocol error. The runtime layer must `release(conn, { dispose: true })`. */
  readonly usable: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// §2.3 The query shape
// ─────────────────────────────────────────────────────────────────────────────

export interface PgQuery {
  /** SQL with `$1`-style placeholders. Never interpolated values. */
  readonly text: string

  /**
   * Parameters, ALREADY ENCODED by the codec registry. Adapters MUST NOT apply any further
   * conversion — passing only `string | Uint8Array | null` makes pg's `prepareValue` an identity.
   */
  readonly params: readonly PgParam[]

  /**
   * Parameter type OIDs, one per param, sent in the `Parse` message. Length must equal
   * `params.length` or be 0. Supplying these is how we avoid `42P18` on a bare `$n` without
   * emitting `::type` casts into the SQL text.
   */
  readonly paramTypes?: readonly number[]

  /**
   *  - 'unnamed' (default) — extended protocol, unnamed statement. 1 RTT, zero server session
   *                          state, safe on every pooler.
   *  - 'named'             — extended protocol with `statementName`. Server-side plan cache.
   *  - 'simple'            — simple query protocol. `params` MUST be empty. For DDL scripts,
   *                          `SET`, multi-statement migration bodies, and dumb proxies.
   */
  readonly mode?: PgExecMode

  /**
   * Required iff `mode === 'named'`. Must be a plain identifier, ≤ 63 bytes (PG's NAMEDATALEN - 1)
   * and free of NUL: the name reaches the wire as a protocol C-string, so an embedded NUL would
   * silently truncate it and the statement parsed would not be the statement closed.
   */
  readonly statementName?: string

  /** `'text'` is the only value an adapter is REQUIRED to support and the only one v1 emits (§4.4). */
  readonly resultFormat?: 'text' | 'binary'

  /**
   * Cap on rows fetched via the portal in one Execute. `undefined` = all rows.
   *
   * ⚠️ **CORRECTED, measured on PG 17.11** (design/09 §3.6, R10 M5; pinned by
   * `test/driver/cursor.test.ts`). This docblock previously said that closing the portal at the
   * cap *stops* a row-returning DML statement. It does not: `insert … select generate_series(1,5)
   * … returning id` with `maxRows: 1` inserts **all five rows**, returns one, and reports
   * `rowCount: 1`. So the hazard is not data loss, it is a **wrong count** — the value a caller
   * would log, trust as "rows affected", or feed to an idempotency check.
   *
   * `maxRows: 0` still runs the statement (side effects, notices and the command tag are real)
   * and returns no rows.
   */
  readonly maxRows?: number

  /** Aborts the query. Adapters that can MUST issue a real CancelRequest, not just drop the promise. */
  readonly signal?: AbortSignal

  /**
   * Milliseconds. Adapter-enforced client-side deadline. Distinct from server `statement_timeout`:
   * it gives up on READING, it does not stop the statement — the pg adapter therefore retires the
   * connection when it fires (§5.4). Use `signal` when the SERVER should stop working.
   *
   * `0` is NOT "no deadline": pg reads `query_timeout` as falsy and falls back to whatever the
   * Pool was constructed with. Omit the field for "no deadline".
   */
  readonly timeoutMs?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// §2.4 Results and metadata
// ─────────────────────────────────────────────────────────────────────────────

export interface PgResult {
  /** ALWAYS array-of-arrays, positionally aligned with `fields`. Values are RAW. */
  readonly rows: readonly (readonly PgRawValue[])[]

  /** REQUIRED whenever the statement produced a RowDescription. Buys us OID-driven decoding. */
  readonly fields: readonly PgField[]

  /** From CommandComplete: rows returned/affected. `null` when the tag carries no count. */
  readonly rowCount: number | null

  /** From CommandComplete: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'CREATE' | 'COPY' | … */
  readonly command: string

  /** NoticeResponses collected during this statement. Migrations surface `RAISE NOTICE` from these. */
  readonly notices: readonly PgNoticeData[]
}

/** `stream()` chunk. `fields` is repeated on every chunk. `done` marks the final chunk. */
export interface PgResultChunk {
  readonly rows: readonly (readonly PgRawValue[])[]
  readonly fields: readonly PgField[]
  readonly done: boolean
}

export interface PgField {
  readonly name: string
  /** OID → codec registry lookup. */
  readonly dataTypeID: number
  /** typmod. `varchar(30)` → 34 (= n + 4); `numeric(10,2)` → 655366 (= ((p<<16)|s) + 4); -1 = none. */
  readonly dataTypeModifier: number
  /** Source table OID, or 0 for computed columns. Join to `pg_attribute` for `attnotnull`. */
  readonly tableID: number
  /** Source column attnum, or 0. Together with `tableID` this disambiguates duplicate JOIN names. */
  readonly columnID: number
  /** Wire size: fixed-width types give a positive byte count, variable-width give -1. */
  readonly dataTypeSize: number
  readonly format: 'text' | 'binary'
}

export interface PgDescribeResult {
  /** Server-inferred parameter OIDs, in `$1..$n` order. */
  readonly paramTypes: readonly number[]
  /** Empty array when the statement returns no rows (protocol `NoData`). */
  readonly fields: readonly PgField[]
}

// ─────────────────────────────────────────────────────────────────────────────
// §2.5 COPY, LISTEN/NOTIFY, notices
// ─────────────────────────────────────────────────────────────────────────────

export interface PgCopyOptions {
  readonly signal?: AbortSignal
  /** Bytes buffered before backpressure is applied to the source. Default 64 KiB. */
  readonly highWaterMark?: number
}

export interface PgCopyResult {
  readonly rowCount: number
  readonly notices: readonly PgNoticeData[]
}

export interface PgNotification {
  readonly channel: string
  readonly payload: string
  /** PID of the notifying backend. Compare with `connection.backendPid` to ignore self-notifies. */
  readonly processId: number
}

// ─────────────────────────────────────────────────────────────────────────────
// §2.6 Capabilities
// ─────────────────────────────────────────────────────────────────────────────

export interface PgCapabilities {
  /** Human-readable adapter id for error messages and telemetry. e.g. 'pg', 'neon-ws', 'pglite'. */
  readonly adapter: string

  /** Which exec modes `execute()` honours. 'unnamed' is mandatory for every adapter. */
  readonly execModes: readonly PgExecMode[]

  /** False ⇒ the ORM must never emit `resultFormat: 'binary'`. False for every v1 adapter (§4.4). */
  readonly binaryResults: boolean

  /** False ⇒ the ORM must emit `::type` casts instead of relying on `PgQuery.paramTypes`. */
  readonly paramTypeOids: boolean

  /** False ⇒ typed-raw-SQL and `migrate verify` degrade to executing against a shadow schema. */
  readonly describe: boolean

  /** False ⇒ `fields[].dataTypeModifier / tableID / columnID` are 0/-1. PGlite is false here. */
  readonly richFieldMetadata: boolean

  readonly cursors: boolean
  readonly copyIn: boolean
  readonly copyOut: boolean
  readonly listenNotify: boolean

  /** How `cancel()` is implemented, or `false` if it cannot be. */
  readonly cancel: 'protocol' | 'pg_cancel_backend' | false

  /** False ⇒ interactive transactions are impossible (HTTP one-shot adapters). */
  readonly multipleStatementsPerSession: boolean

  /** PGlite: 1. Drives whether the concurrency test suite runs against this adapter. */
  readonly maxConnections: number | undefined

  /** PG's own wire limit is 65535; poolers/edge backends may be lower. */
  readonly maxParams: number

  /** Populated after `init()` from ParameterStatus. `undefined` before first connect. */
  readonly serverVersionNum: number | undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 What crosses the seam on failure — plain DATA, never classes.
// ─────────────────────────────────────────────────────────────────────────────

export type PgErrorKind =
  | 'server' // ErrorResponse from the backend. `sqlstate` is present.
  | 'connection' // socket/TLS/auth failure, pool exhaustion, connection closed mid-query
  | 'protocol' // desync / unexpected message. Connection is NOT reusable.
  | 'timeout' // client-side deadline (PgQuery.timeoutMs) elapsed
  | 'cancelled' // AbortSignal fired, or SQLSTATE 57014 came back
  | 'adapter' // the adapter itself misbehaved / unsupported capability requested

export interface PgDriverErrorData {
  readonly kind: PgErrorKind
  readonly message: string
  /** True ⇒ the runtime MUST `release(conn, { dispose: true })`. Always true for 'protocol'. */
  readonly connectionUnusable: boolean
  /** Present iff kind === 'server'. */
  readonly server?: PgServerErrorData
  /** The SQL we sent, for the error's `position` to point into. Redacted params never included. */
  readonly sql?: string
  readonly adapter: string
  readonly cause?: unknown
  /**
   * Present when this statement was aborted and the CANCEL REQUEST ITSELF failed (no spare
   * connection inside the deadline, `pg_cancel_backend` refused, …). Without it a failed cancel
   * is indistinguishable from a successful one that the backend ignored.
   */
  readonly cancelError?: string
}

/** Every field of the protocol's ErrorResponse, normalised. Field letters in comments. */
export interface PgServerErrorData {
  readonly severity: string //          S / V
  readonly sqlstate: string //          C   5 chars, e.g. '23505'. THE routing key.
  readonly message: string //           M
  readonly detail?: string //           D
  readonly hint?: string //             H
  readonly position?: number //         P   1-based char offset into the SQL WE sent
  readonly internalPosition?: number // p
  readonly internalQuery?: string //    q
  readonly where?: string //            W
  readonly schema?: string //           s
  readonly table?: string //            t
  readonly column?: string //           c
  readonly dataType?: string //         d
  readonly constraint?: string //       n
  readonly file?: string //             F
  readonly line?: number //             L
  readonly routine?: string //          R
}

export type PgNoticeData = PgServerErrorData

// ─────────────────────────────────────────────────────────────────────────────
// §2.7 The escape hatch
// ─────────────────────────────────────────────────────────────────────────────

export type PgRemoteCallback = (
  sql: string,
  params: readonly PgParam[],
  meta: { readonly mode: PgExecMode; readonly paramTypes: readonly number[] },
) => Promise<{
  rows: readonly (readonly PgRawValue[])[]
  fields: readonly PgField[]
  rowCount?: number | null
  command?: string
}>
