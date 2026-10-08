import { ConfigError, UsageError } from 'pg-prime'
import type { PayloadOptions } from './payload.js'
import type { Jitter } from './util.js'

export interface RetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  jitter?: Jitter
  /** Return false to fail the message now; asked with the attempt that just failed. */
  shouldRetry?: (err: unknown, attempt: number) => boolean
}

/** The stored part of a retry policy (a function cannot be stored). */
export type RetryPolicy = Required<Omit<RetryOptions, 'shouldRetry'>>

/** `false`: not kept (a completed message is deleted by its completion). */
export type Keep = false | { ageMs?: number; count?: number }
export interface KeepOptions {
  completed?: Keep
  /** Also applies to `cancelled` messages. */
  failed?: Keep
}

export interface QueueOptions<T> extends PayloadOptions<T> {
  retry?: RetryOptions
  keep?: KeepOptions
  /** Global: at most `max` claims per `perMs` window. */
  rate?: { max: number; perMs: number }
  /** Global: at most this many active messages. */
  concurrency?: number
  /** Enables `watch()` and `result()`: one NOTIFY per transition. */
  watch?: boolean
}

export interface QueueDef<T, R = void> {
  readonly kind: 'queue'
  readonly name: string
  readonly payload: PayloadOptions<T>
  readonly retry: RetryPolicy
  readonly shouldRetry: ((err: unknown, attempt: number) => boolean) | undefined
  readonly keep: { readonly completed: Keep; readonly failed: Keep }
  readonly rate: { readonly max: number; readonly perMs: number } | undefined
  readonly concurrency: number | undefined
  readonly watch: boolean
  /** Phantom: the result type. */
  readonly __result?: R
}

export type PayloadOf<D> = D extends QueueDef<infer T, any> ? T : never
export type ResultOf<D> = D extends QueueDef<any, infer R> ? R : never

const DAY = 86_400_000
const defs = new WeakSet<object>()

export const isQueueDef = (d: object): boolean => defs.has(d)

/** Declares a queue: its payload type, retry policy, retention, global limits and watching. */
export function defineQueue<T, R = void>(name: string, opts: QueueOptions<T> = {}): QueueDef<T, R> {
  if (typeof name !== 'string' || name.length === 0) {
    throw new UsageError('@pg-prime/mq: a queue needs a non-empty name.')
  }
  const { retry = {}, keep = {}, rate, concurrency, watch = false, schema, codec } = opts
  const { shouldRetry, ...policy } = retry
  const def = {
    kind: 'queue' as const,
    name,
    payload: {
      ...(schema === undefined ? {} : { schema }),
      ...(codec === undefined ? {} : { codec }),
    },
    retry: {
      maxAttempts: 3,
      baseDelayMs: 1000,
      maxDelayMs: 60_000,
      jitter: 'full' as const,
      ...policy,
    },
    shouldRetry,
    keep: {
      completed: keep.completed ?? { ageMs: DAY },
      failed: keep.failed ?? { ageMs: 7 * DAY },
    },
    rate,
    concurrency,
    watch,
  }
  checkRetry(def.retry, `queue ${name}`)
  if (watch && def.keep.completed === false) {
    throw new ConfigError(
      `@pg-prime/mq: queue ${name} has watch: true and keep.completed: false; result() needs the ` +
        `completed row. Keep completed messages for a while instead.`,
    )
  }
  if (rate !== undefined && !(rate.max >= 1 && rate.perMs >= 1)) {
    throw new ConfigError(`@pg-prime/mq: queue ${name}: rate needs max ≥ 1 and perMs ≥ 1.`)
  }
  if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency >= 1)) {
    throw new ConfigError(`@pg-prime/mq: queue ${name}: concurrency must be an integer ≥ 1.`)
  }
  defs.add(Object.freeze(def))
  return def as QueueDef<T, R>
}

export function checkRetry(p: RetryPolicy, where: string): void {
  if (!(Number.isInteger(p.maxAttempts) && p.maxAttempts >= 1) || p.baseDelayMs < 0) {
    throw new ConfigError(
      `@pg-prime/mq: ${where}: retry needs maxAttempts ≥ 1 and baseDelayMs ≥ 0.`,
    )
  }
}
