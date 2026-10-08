import { createHash } from 'node:crypto'
import type { AnyFragment, Db } from 'pg-prime'
import type { OutboxDef } from './define.js'
import type { InternalKind, OutboxHooks, OutboxRecord } from './types.js'

export interface Hooks {
  call<K extends Exclude<keyof OutboxHooks, 'onInternal'>>(
    name: K,
    e: Parameters<NonNullable<OutboxHooks[K]>>[0],
  ): void
  internal(kind: InternalKind, message: string, cause?: unknown): void
}

/** What the write path, the admin calls and the relay share for one topic. */
export interface TopicCtx<T> {
  readonly db: Db
  /** The quoted schema. */
  readonly s: AnyFragment
  readonly def: OutboxDef<T>
  /** The wake-up channel; NOTIFY carries nothing. */
  readonly chan: string
  readonly hooks: Hooks
  /** Starts the topic lazily; only for calls that do not run in the caller's transaction. */
  start(): Promise<void>
  decode(row: Record<string, unknown>): OutboxRecord<T>
}

export function hooksOf(hooks: OutboxHooks | undefined): Hooks {
  const internal = (kind: InternalKind, message: string, cause?: unknown): void => {
    try {
      hooks?.onInternal?.({ kind, message, cause })
    } catch {
      // a throwing onInternal has nowhere left to report to
    }
  }
  return {
    internal,
    call(name, e) {
      try {
        ;(hooks?.[name] as ((e: unknown) => void) | undefined)?.(e)
      } catch (err) {
        internal('hook-failed', `@pg-prime/outbox: the ${name} hook threw.`, err)
      }
    },
  }
}

export function channelOf(schema: string, topic: string): string {
  return `ob_${createHash('sha256').update(`${schema}/${topic}`).digest('hex').slice(0, 24)}`
}

export function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 2000)
}
