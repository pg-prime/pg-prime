import { UsageError } from 'pg-prime'
import type { PayloadOptions } from './payload.js'

export interface ChannelDef<T> {
  readonly kind: 'channel'
  readonly name: string
  readonly payload: PayloadOptions<T>
}

export interface TopicDef<T> {
  readonly kind: 'topic'
  readonly name: string
  readonly payload: PayloadOptions<T>
  /** `null`: kept forever. */
  readonly keepMs: number | null
  readonly keepUntilConsumed: boolean
}

export interface RetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  jitter?: 'full' | 'equal' | 'none'
}

export interface SubscriptionDef<T> {
  readonly kind: 'subscription'
  readonly topic: TopicDef<T>
  readonly name: string
  readonly types: readonly string[] | null
  readonly from: 'beginning' | 'now'
  readonly retry: Required<RetryOptions>
}

export interface EventsDefinitions {
  readonly channels?: Readonly<Record<string, ChannelDef<any>>>
  readonly topics?: Readonly<Record<string, TopicDef<any>>>
  readonly subscriptions?: Readonly<Record<string, SubscriptionDef<any>>>
}

/** The payload type a declaration carries. */
export type PayloadOf<D> =
  D extends ChannelDef<infer T>
    ? T
    : D extends TopicDef<infer T>
      ? T
      : D extends SubscriptionDef<infer T>
        ? T
        : never

/** A typed LISTEN/NOTIFY channel; `name` is the literal channel name. */
export function defineChannel<T>(name: string, opts: PayloadOptions<T> = {}): ChannelDef<T> {
  if (name.length === 0 || new TextEncoder().encode(name).length > 63 || name.includes('\0')) {
    throw new UsageError(
      `@pg-prime/events: channel name ${JSON.stringify(name)} must be 1–63 UTF-8 bytes without NUL.`,
    )
  }
  return Object.freeze({ kind: 'channel', name, payload: opts })
}

/** A durable topic: an append-only log of entries. */
export function defineTopic<T>(
  name: string,
  opts: PayloadOptions<T> & { keepMs?: number | null; keepUntilConsumed?: boolean } = {},
): TopicDef<T> {
  nonEmpty('topic', name)
  const { keepMs = null, keepUntilConsumed = false, ...payload } = opts
  return Object.freeze({ kind: 'topic', name, payload, keepMs, keepUntilConsumed })
}

/** A named, durable cursor over a topic with one active reader at a time. */
export function defineSubscription<T>(
  topic: TopicDef<T>,
  name: string,
  opts: { types?: readonly string[]; from?: 'beginning' | 'now'; retry?: RetryOptions } = {},
): SubscriptionDef<T> {
  nonEmpty('subscription', name)
  const retry = {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 60_000,
    jitter: 'full' as const,
    ...opts.retry,
  }
  return Object.freeze({
    kind: 'subscription',
    topic,
    name,
    types: opts.types === undefined ? null : Object.freeze([...opts.types]),
    from: opts.from ?? 'now',
    retry,
  })
}

function nonEmpty(what: string, name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new UsageError(`@pg-prime/events: a ${what} needs a non-empty name.`)
  }
}
