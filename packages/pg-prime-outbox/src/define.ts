import { UsageError } from 'pg-prime'

/** The Standard Schema v1 interface (standardschema.dev), copied so the package has no dependency. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>
    readonly types?: { readonly input: Input; readonly output: Output } | undefined
  }
}

type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | {
      readonly issues: readonly {
        readonly message: string
        readonly path?: readonly unknown[] | undefined
      }[]
    }

export interface OutboxCodec<T> {
  encode(v: T): unknown
  decode(v: unknown): T
}

export interface OutboxDefOptions<T> {
  /** Default 16; immutable once the topic exists. */
  partitions?: number
  /** Default true: same-key writers serialize until commit, so id order is commit order. */
  ordered?: boolean
  /** Default 86 400 000. 0 deletes on delivery and gives up write-side dedup afterwards. */
  keepDeliveredMs?: number
  schema?: StandardSchemaV1<unknown, T>
  codec?: OutboxCodec<T>
}

export interface OutboxDef<T> {
  readonly topic: string
  readonly partitions: number
  readonly ordered: boolean
  readonly keepDeliveredMs: number
  readonly schema: StandardSchemaV1<unknown, T> | undefined
  readonly codec: OutboxCodec<T> | undefined
  /** Phantom: carries the payload type. */
  readonly '~payload'?: T
}

export type PayloadOf<D> = D extends OutboxDef<infer T> ? T : never

export function defineOutbox<T>(topic: string, opts: OutboxDefOptions<T> = {}): OutboxDef<T> {
  const { partitions = 16, ordered = true, keepDeliveredMs = 86_400_000 } = opts
  if (typeof topic !== 'string' || topic === '') {
    throw new UsageError('@pg-prime/outbox: defineOutbox(topic) needs a non-empty topic name.')
  }
  if (!Number.isInteger(partitions) || partitions < 1 || partitions > 1024) {
    throw new UsageError(
      `@pg-prime/outbox: topic ${topic}: partitions must be an integer in 1..1024; got ${partitions}.`,
    )
  }
  if (!Number.isSafeInteger(keepDeliveredMs) || keepDeliveredMs < 0) {
    throw new UsageError(
      `@pg-prime/outbox: topic ${topic}: keepDeliveredMs must be a non-negative integer.`,
    )
  }
  return Object.freeze({
    topic,
    partitions,
    ordered,
    keepDeliveredMs,
    schema: opts.schema,
    codec: opts.codec,
  })
}
