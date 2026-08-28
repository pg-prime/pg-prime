/**
 * The hook bus (design/07 §7.1): static `pgPrime({ hooks })` plus dynamic `db.observe(hooks)`,
 * every invocation wrapped.
 *
 * ## Observability must not be able to take down the application
 *
 * That is the whole design. A hook that throws is called **once**; the failure is reported through
 * `onInternal` (itself wrapped, so a throwing `onInternal` cannot recurse) and that specific
 * callback is disabled for the life of the bus, with a loud `console.error`. Not the whole hook
 * object — the one member that misbehaved — because a broken `onQueryEnd` should not cost you
 * your `onQueryError`.
 *
 * ## Why `dispatch` reads like it does
 *
 * The hot path is `bus.enabled === false` → return. One boolean, no allocation, no array walk,
 * for the overwhelming majority of processes that register nothing. Everything else in this file
 * is behind that check.
 */

import type {
  InternalEvent,
  NoticeEvent,
  PoolEvent,
  QueryEndEvent,
  QueryErrorEvent,
  QueryHooks,
  QueryStartEvent,
  RetryEvent,
  TxEndEvent,
  TxStartEvent,
} from './events.js'

type HookName = keyof QueryHooks

interface Registration {
  readonly hooks: QueryHooks
  /** Members that threw and are therefore off. Per registration, not per bus. */
  readonly disabled: Set<HookName>
}

export class HookBus {
  #regs: Registration[] = []
  /**
   * `true` iff at least one registration exists. Read on every statement, so it is a field and not
   * a `length > 0` on a possibly-empty array.
   */
  enabled = false

  add(hooks: QueryHooks | undefined): () => void {
    if (hooks === undefined) return noop
    const reg: Registration = { hooks, disabled: new Set() }
    this.#regs = [...this.#regs, reg]
    this.enabled = true
    return () => {
      this.#regs = this.#regs.filter((r) => r !== reg)
      this.enabled = this.#regs.length > 0
    }
  }

  /** The one call site for every event. Generic over the member so the payload stays typed. */
  #emit<K extends HookName>(name: K, payload: Parameters<NonNullable<QueryHooks[K]>>[0]): void {
    if (!this.enabled) return
    for (const reg of this.#regs) {
      const fn = reg.hooks[name]
      if (fn === undefined || reg.disabled.has(name)) continue
      try {
        ;(fn as (e: unknown) => void).call(reg.hooks, payload)
      } catch (cause) {
        reg.disabled.add(name)
        this.#reportHookFailure(reg, name, cause)
      }
    }
  }

  /**
   * Report through every *other* registration's `onInternal`, then shout.
   *
   * The failing registration's own `onInternal` is skipped: if `onQueryEnd` and `onInternal` come
   * from the same broken integration, calling the second to report the first is how a crash loop
   * starts.
   */
  #reportHookFailure(failed: Registration, name: HookName, cause: unknown): void {
    const message =
      `pg-prime: the ${name} hook threw and has been disabled for this process. ` +
      `Observability must never break a query (07 §7.1).`
    for (const reg of this.#regs) {
      if (reg === failed) continue
      const fn = reg.hooks.onInternal
      if (fn === undefined || reg.disabled.has('onInternal')) continue
      try {
        fn.call(reg.hooks, { kind: 'hook-failed', message, cause, hook: name })
      } catch {
        reg.disabled.add('onInternal')
      }
    }
    console.error(message, cause)
  }

  queryStart(e: QueryStartEvent): void {
    this.#emit('onQueryStart', e)
  }
  queryEnd(e: QueryEndEvent): void {
    this.#emit('onQueryEnd', e)
  }
  queryError(e: QueryErrorEvent): void {
    this.#emit('onQueryError', e)
  }
  transactionStart(e: TxStartEvent): void {
    this.#emit('onTransactionStart', e)
  }
  transactionEnd(e: TxEndEvent): void {
    this.#emit('onTransactionEnd', e)
  }
  retry(e: RetryEvent): void {
    this.#emit('onRetry', e)
  }
  pool(e: PoolEvent): void {
    this.#emit('onPool', e)
  }
  notice(e: NoticeEvent): void {
    this.#emit('onNotice', e)
  }
  internal(e: InternalEvent): void {
    this.#emit('onInternal', e)
  }
}

function noop(): void {}
