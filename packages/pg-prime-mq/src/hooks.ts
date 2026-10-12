export type InternalKind =
  | 'listen-unavailable'
  | 'heartbeat-failed'
  | 'maintenance-failed'
  | 'worker-failed'
  | 'lease-lost'
  | 'hook-failed'

export type SettleOutcome = 'completed' | 'retry' | 'failed' | 'cancelled' | 'deferred'

export interface SettleEvent {
  queue: string
  id: bigint
  outcome: SettleOutcome
  durationMs: number
  attempt: number
  error?: unknown
}

export interface MqHooks {
  onSend?(e: { queue: string; ids: readonly bigint[]; inTx: boolean }): void
  onClaim?(e: { queue: string; count: number; waitedMs: number }): void
  onSettle?(e: SettleEvent): void
  onLeaseExpired?(e: { queue: string; ids: readonly bigint[] }): void
  onBind?(e: { subscription: string; queue: string; count: number }): void
  onInternal?(e: { kind: InternalKind; message: string; cause?: unknown }): void
}

/** Fan-out to every observer; a throwing hook is reported as `hook-failed`, never rethrown. */
export interface Hooks {
  emit<K extends keyof MqHooks>(name: K, e: Parameters<NonNullable<MqHooks[K]>>[0]): void
  internal(kind: InternalKind, message: string, cause?: unknown): void
  observe(h: MqHooks): () => void
}

export function createHooks(initial?: MqHooks): Hooks {
  const all = new Set<MqHooks>(initial === undefined ? [] : [initial])
  const hooks: Hooks = {
    emit(name, e) {
      for (const h of all) {
        try {
          ;(h[name] as ((e: unknown) => void) | undefined)?.call(h, e)
        } catch (cause) {
          if (name === 'onInternal') continue
          hooks.internal('hook-failed', `@pg-prime/mq: the ${name} hook threw.`, cause)
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

/** OpenTelemetry messaging attributes for a settle. */
export function spanAttributes(e: SettleEvent): Readonly<Record<string, string | number>> {
  return {
    'messaging.system': 'pg-prime-mq',
    'messaging.destination.name': e.queue,
    'messaging.message.id': String(e.id),
    'messaging.operation.type': 'process',
    'pg_prime_mq.outcome': e.outcome,
    'pg_prime_mq.attempt': e.attempt,
  }
}
