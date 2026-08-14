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
   * pg-pool exposes the resolved config here; we read host/port/user/database to build a
   * cancel connection. Verified present on both pg and Neon (`Pool_2.options`).
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
  removeListener?(event: string, listener: (arg: never) => void): unknown
  /** Present on pg >= 8.21. Optional so a minimal duck-type still satisfies us. */
  getTransactionStatus?(): 'I' | 'T' | 'E'
  readonly processID?: number
  /** Private-ish, but stable since pg 6 and required for describe/copy/close (§5.2). */
  readonly connection?: PgLikeConnection
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
  command: string
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
  sendCopyData(chunk: Uint8Array): void
  sendCopyDone(): void
  sendCopyFail(msg: string): void
  on(event: string, listener: (msg: never) => void): unknown
  removeListener(event: string, listener: (msg: never) => void): unknown
  readonly parsedStatements: Record<string, string>
  readonly stream: { cork?(): void; uncork?(): void; destroy(): void }
}

/** Public constructor surface — design/02 §3. */
export interface PgDriverConfig {
  /** Anything that duck-types as a pg Pool: pg.Pool, Neon's Pool, a Hyperdrive-fed pg.Pool. */
  pool: PgLikePool
  /** Optional second pool that bypasses a transaction pooler. Used for `route: 'direct'`. */
  directPool?: PgLikePool
  /**
   * Only needed to enable protocol-level `cancel()`, which requires opening a *second* socket.
   * If omitted we fall back to `pg_cancel_backend(pid)` over a pooled connection, and if
   * `directPool` is also absent, `capabilities.cancel` is `false`.
   */
  createCancelClient?: () => PgLikeClient
}
