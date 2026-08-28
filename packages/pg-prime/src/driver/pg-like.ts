/**
 * Structural re-declaration of the subset of `pg` we touch — design/02-driver.md §3.
 *
 * We deliberately do NOT `import type { Pool } from 'pg'`. That would force `@types/pg` on every
 * consumer AND would break duck-typed drop-ins: `@neondatabase/serverless@1.1.0` inlined its own
 * declarations and switched `Buffer` → `Uint8Array`, so *nominal* identity with `@types/pg` is
 * already gone. Structural typing is the only approach robust to that.
 *
 * Verified against `pg@8.23.0` / `@types/pg@8.21.0` and `@neondatabase/serverless@1.1.0`.
 */

/** Subset of `pg.Pool` / Neon's `Pool` / a Hyperdrive-fed `pg.Pool` that we need. */
export interface PgLikePool {
  connect(): Promise<PgLikePoolClient>
  end(): Promise<void>
  /**
   * pg-pool exposes the resolved config here. We read exactly ONE key — `max`, for
   * `capabilities.maxConnections`. (An earlier draft claimed host/port/user were read from here
   * to build a cancel connection; they never were. Opening our own socket would mean owning a
   * credential, which design/02 §3 forbids — the protocol cancel path goes through
   * `PgDriverConfig.createCancelClient` instead.)
   */
  readonly options?: Record<string, unknown>
  readonly totalCount?: number
  readonly idleCount?: number
  readonly waitingCount?: number
}

export interface PgLikePoolClient extends PgLikeClient {
  release(err?: Error | boolean): void
}

export interface PgLikeClient {
  /** Config-object overload — the only one we call. */
  query(config: PgLikeQueryConfig): Promise<PgLikeResult | PgLikeResult[]>
  /** Submittable overload. This is pg's real extension seam (§5.2); Neon re-exports it verbatim. */
  query<T extends PgLikeSubmittable>(submittable: T): T
  on(event: 'notice' | 'notification' | 'error' | 'end', listener: (arg: never) => void): unknown
  /**
   * REQUIRED. The adapter keeps an `error` listener on every checked-out client (pg-pool removes
   * its own idle listener at checkout, and pg emits `error` unconditionally — an unhandled one is
   * a process exit), so it MUST be able to take it off again at release.
   */
  removeListener(event: string, listener: (arg: never) => void): unknown
  /** Present on pg >= 8.21. Optional so a minimal duck-type still satisfies us. */
  getTransactionStatus?(): 'I' | 'T' | 'E'
  readonly processID?: number
  /** The in-flight query object, if the driver exposes one. Only used to aim a protocol cancel. */
  readonly activeQuery?: unknown
  /** Private-ish, but stable since pg 6 and required for describe/copy/close (§5.2). */
  readonly connection?: PgLikeConnection
  /**
   * pg's `Client#readyForQuery`: `false` from the moment a query is dispatched until its
   * ReadyForQuery has been handled, `true` otherwise. Read for exactly one purpose —
   * `PgConnectionImpl.#afterReadyForQuery`, which holds a server-error rejection until the
   * transaction status pg reports on that message is in place. Optional: a drop-in without it
   * loses the post-statement `transactionStatus` guarantee `types.ts` documents, and nothing else.
   */
  readonly readyForQuery?: boolean
}

/**
 * What `PgDriverConfig.createCancelClient` must return: an UNCONNECTED client that knows how to
 * open its own socket and send a protocol CancelRequest for another client's backend. `pg.Client`
 * satisfies this structurally (`Client.prototype.cancel(target, activeQuery)`), which is the whole
 * point — the caller hands us `() => new Client(sameConfig)` and never a credential of ours.
 */
export interface PgLikeCancelClient {
  cancel(client: PgLikeClient, query?: unknown): void
  end?(): Promise<void> | void
}

export interface PgLikeQueryConfig {
  text: string
  values?: readonly unknown[]
  name?: string
  rowMode?: 'array'
  /** pg >= 8.12. Forces the extended protocol even with zero parameters. See D4. */
  queryMode?: 'extended'
  binary?: boolean
  /** Per-portal row cap. NOTE: pg *pages* with this, it does not truncate. See pg-adapter.ts. */
  rows?: number
  query_timeout?: number
  /**
   * OVERLOADED IN pg — see §5.1. Read as an array it supplies Parse parameter OIDs; read as an
   * object it supplies the result-parser table. We pass a value that satisfies both.
   */
  types?: PgLikeTypeSource
}

/** Array of param OIDs that ALSO carries `getTypeParser`. Verified to satisfy both consumers. */
export interface PgLikeTypeSource extends ReadonlyArray<number> {
  getTypeParser(oid: number, format?: 'text' | 'binary'): (raw: string) => unknown
}

export interface PgLikeResult {
  rows: unknown[]
  fields: readonly PgLikeField[]
  rowCount: number | null
  /** `null` for an EmptyQueryResponse — pg never sets it, so the seam must not claim `string`. */
  command: string | null
}

export interface PgLikeField {
  name: string
  tableID: number
  columnID: number
  dataTypeID: number
  dataTypeSize: number
  dataTypeModifier: number
  format: 'text' | 'binary'
}

/** pg dispatches backend messages to whatever object has a `submit` method. */
export interface PgLikeSubmittable {
  submit(connection: PgLikeConnection): Error | null | undefined | void
  handleRowDescription(msg: { fields: readonly PgLikeField[] }): void
  handleDataRow(msg: { fields: readonly (string | null)[] }): void
  handleCommandComplete(msg: { text?: string; command?: string }, connection: PgLikeConnection): void
  handleEmptyQuery(connection: PgLikeConnection): void
  handlePortalSuspended(connection: PgLikeConnection): void
  handleCopyInResponse(connection: PgLikeConnection): void
  handleCopyData(msg: { chunk: Uint8Array }, connection: PgLikeConnection): void
  handleError(err: unknown, connection: PgLikeConnection): void
  handleReadyForQuery(connection: PgLikeConnection): void
  callback?: (err: unknown, result?: unknown) => void
  name?: string | undefined
  text?: string | undefined
}

/** The low-level protocol writer. Present on pg, Neon (with an extra `more` arg) and pg-cloudflare. */
export interface PgLikeConnection {
  parse(q: { name: string; text: string; types?: readonly number[] }, more?: boolean): void
  bind(
    c: {
      portal?: string
      statement?: string
      values?: readonly unknown[]
      binary?: boolean
      valueMapper?: unknown
    },
    more?: boolean,
  ): void
  describe(m: { type: 'S' | 'P'; name?: string }, more?: boolean): void
  execute(c: { portal?: string; rows?: number }, more?: boolean): void
  close(m: { type: 'S' | 'P'; name?: string }, more?: boolean): void
  sync(): void
  flush(): void
  /**
   * COPY IN, in pg's own spelling — **not** `sendCopyData`/`sendCopyDone`, which is what the
   * protocol messages are called and what an earlier draft of this declaration guessed. Measured
   * against `pg@8.23.0`'s `lib/connection.js`: the methods are `sendCopyFromChunk(chunk)` and
   * `endCopyFrom()`, and they are the pair `pg-copy-streams` drives.
   */
  sendCopyFromChunk(chunk: Uint8Array): void
  endCopyFrom(): void
  sendCopyFail(msg: string): void
  /** Simple query. The path COPY takes — it carries no bind parameters, so there is nothing else. */
  query?(text: string): void
  on(event: string, listener: (msg: never) => void): unknown
  removeListener(event: string, listener: (msg: never) => void): unknown
  readonly parsedStatements: Record<string, string>
  readonly stream: {
    cork?(): void
    uncork?(): void
    destroy(): void
    /** Node's socket backpressure signal, read by the COPY IN pump. */
    readonly writableNeedDrain?: boolean
    once?(event: string, listener: () => void): unknown
  }
}

/**
 * An UNCONNECTED client we may connect ourselves and own for its whole life — what
 * `PgDriver.connect()` hands out for `LISTEN` (design/07 §6.5). `pg.Client` satisfies it.
 */
export interface PgLikeDedicatedClient extends PgLikeClient {
  connect(): Promise<void>
  end(): Promise<void>
}

/** Public constructor surface — design/02 §3. */
export interface PgDriverConfig {
  /** Anything that duck-types as a pg Pool: pg.Pool, Neon's Pool, a Hyperdrive-fed pg.Pool. */
  pool: PgLikePool
  /** Optional second pool that bypasses a transaction pooler. Used for `route: 'direct'`. */
  directPool?: PgLikePool
  /**
   * Only needed to enable protocol-level `cancel()`, which requires opening a *second* socket.
   * When present, `capabilities.cancel` is `'protocol'` and an aborted statement is cancelled
   * without borrowing a pooled connection. If omitted we fall back to `pg_cancel_backend(pid)`
   * over a pooled connection.
   */
  createCancelClient?: () => PgLikeCancelClient
  /**
   * Opens a connection the pool does not own, for `PgDriver.connect()` (design/07 §6.5). Supplied
   * automatically when `pgPrime({ connection })` builds the pool; supply it yourself with `pool:`
   * if you want `db.listen()` on a connection that is not one of your pool's.
   */
  createDedicatedClient?: () => PgLikeDedicatedClient
}
