import type { AsyncDisposable_, Db, Queryable } from 'pg-prime'
import type { OutboxDef, PayloadOf } from './define.js'

export interface WriteOptions {
  /** The caller's transaction. A `Db` works too: one statement is its own transaction. */
  tx: Queryable<any>
  key?: string
  idempotencyKey?: string
  headers?: Record<string, string>
}

export interface WriteResult {
  id: bigint
  idem: string
  duplicate: boolean
}

export interface OutboxRecord<T> {
  readonly id: bigint
  readonly key: string | null
  readonly idem: string
  readonly payload: T
  readonly headers: Record<string, string> | null
  readonly attempts: number
  readonly createdAt: Date
}

/** `decoded: false` when the codec rejected the stored payload; `payload` is then the raw JSON. */
export type ParkedRecord<T> = Omit<OutboxRecord<T>, 'payload'> & {
  readonly error: string | null
} & (
    | { readonly decoded: true; readonly payload: T }
    | { readonly decoded: false; readonly payload: unknown }
  )

export interface DeliveryContext {
  readonly signal: AbortSignal
  /** Fencing token: grows every time the partition changes hands. */
  readonly epoch: bigint
  readonly partition: number
}

export type DeliveryResult = void | { failed: ReadonlyMap<bigint, unknown> }

export interface OutboxSink<T> {
  /** `wave` never holds two records of one key, so a sink may deliver it in parallel. */
  deliver(wave: readonly OutboxRecord<T>[], ctx: DeliveryContext): Promise<DeliveryResult>
}

export interface RetryOptions {
  /** Default 10. */
  maxAttempts?: number
  /** Default 1 000. */
  baseDelayMs?: number
  /** Default 300 000. */
  maxDelayMs?: number
  /** Default `'full'`. */
  jitter?: 'full' | 'equal' | 'none'
}

export interface RelayOptions {
  /** Records read per partition per round. Default 100. */
  batchSize?: number
  /** Partitions this relay delivers in parallel. Default 4. */
  concurrency?: number
  /** Default 30 000; heartbeats run every `leaseMs / 3`. */
  leaseMs?: number
  /** Fallback poll interval. Default 1 000. */
  pollMs?: number
  retry?: RetryOptions
  /** How long `close()` lets in-flight waves finish before aborting them. Default 10 000. */
  graceMs?: number
  /** Default `${hostname}:${pid}:${random}`. */
  owner?: string
  signal?: AbortSignal
}

export interface Relay extends AsyncDisposable_ {
  readonly partitions: readonly number[]
  close(): Promise<void>
}

export interface PartitionStats {
  readonly partition: number
  readonly pending: number
  readonly oldestAt: Date | null
  readonly owner: string | null
  readonly epoch: bigint
  readonly leaseUntil: Date | null
}

export interface OutboxStats {
  readonly paused: boolean
  readonly pending: number
  readonly parked: number
  readonly blockedKeys: number
  readonly partitions: readonly PartitionStats[]
}

export interface OutboxTopic<T> {
  readonly name: string
  /** Creates this topic's rows; declared topics start with `outbox.start()`. */
  start(): Promise<void>
  /**
   * Writes one record in `tx`. On an `ordered` topic a keyed write locks its key until commit, and
   * keys are sorted only within one call: a transaction writing several keys should use one
   * `writeMany` or a consistent key order, or two such transactions can deadlock (40P01).
   */
  write(payload: T, opts: WriteOptions): Promise<WriteResult>
  /** Writes several records in `tx` in one statement, locking their keys in sorted order. */
  writeMany(
    items: readonly ({ payload: T } & Omit<WriteOptions, 'tx'>)[],
    opts: { tx: Queryable<any> },
  ): Promise<WriteResult[]>
  relay(sink: OutboxSink<T>, opts?: RelayOptions): Relay
  parked(opts?: { limit?: number; after?: bigint }): Promise<ParkedRecord<T>[]>
  replay(ids: readonly bigint[]): Promise<number>
  discard(ids: readonly bigint[]): Promise<number>
  pause(): Promise<void>
  resume(): Promise<void>
  stats(): Promise<OutboxStats>
}

export type InternalKind =
  | 'listen-unavailable'
  | 'heartbeat-failed'
  | 'relay-failed'
  | 'hook-failed'

export interface OutboxHooks {
  onWrite?(e: { topic: string; count: number; duplicates: number }): void
  onDeliver?(e: { topic: string; partition: number; count: number; durationMs: number }): void
  onFail?(e: {
    topic: string
    id: bigint
    key: string | null
    attempt: number
    error: unknown
  }): void
  onPark?(e: { topic: string; id: bigint; key: string | null; error: unknown }): void
  onLease?(e: { topic: string; acquired: readonly number[]; released: readonly number[] }): void
  onInternal?(e: { kind: InternalKind; message: string; cause?: unknown }): void
}

export interface OutboxConfig<D extends Record<string, OutboxDef<any>>> {
  db: Db
  /** Default `'pgprime_outbox'`. */
  schema?: string
  /** Default true; false makes `start()` fail with `SchemaVersionError` on an old schema. */
  autoMigrate?: boolean
  define?: D
  hooks?: OutboxHooks
}

export interface Outbox<D extends Record<string, OutboxDef<any>>> extends AsyncDisposable_ {
  readonly topics: { readonly [K in keyof D]: OutboxTopic<PayloadOf<D[K]>> }
  topic<T>(def: OutboxDef<T>): OutboxTopic<T>
  /** Migrates (or checks) the schema and creates the declared topics. Required before `write`. */
  start(): Promise<void>
  migrate(): Promise<{ from: number; to: number }>
  /** Closes every relay this outbox started. */
  close(): Promise<void>
}
