export type InternalKind =
  | 'listen-unavailable'
  | 'heartbeat-failed'
  | 'subscription-behind-retention'
  | 'reader-failed'
  | 'hook-failed'

export interface EventsHooks {
  onPublish?(e: { topic: string; count: number; inTx: boolean }): void
  onDeliver?(e: { topic: string; subscription: string; count: number; durationMs: number }): void
  onRetry?(e: {
    topic: string
    subscription: string
    entry: bigint
    attempt: number
    error: unknown
  }): void
  onPark?(e: { topic: string; subscription: string; entry: bigint; error: unknown }): void
  onInternal?(e: { kind: InternalKind; message: string; cause?: unknown }): void
}

/** Fan-out to every observer; a throwing hook is reported as `hook-failed`, never rethrown. */
export interface Hooks {
  emit<K extends keyof EventsHooks>(name: K, e: Parameters<NonNullable<EventsHooks[K]>>[0]): void
  internal(kind: InternalKind, message: string, cause?: unknown): void
  observe(h: EventsHooks): () => void
}

export function createHooks(initial?: EventsHooks): Hooks {
  const all = new Set<EventsHooks>(initial === undefined ? [] : [initial])
  const hooks: Hooks = {
    emit(name, e) {
      for (const h of all) {
        try {
          ;(h[name] as ((e: unknown) => void) | undefined)?.call(h, e)
        } catch (cause) {
          if (name === 'onInternal') continue
          hooks.internal('hook-failed', `@pg-prime/events: the ${name} hook threw.`, cause)
        }
      }
    },
    internal(kind, message, cause) {
      hooks.emit('onInternal', cause === undefined ? { kind, message } : { kind, message, cause })
    },
    observe(h) {
      all.add(h)
      return () => void all.delete(h)
    },
  }
  return hooks
}
