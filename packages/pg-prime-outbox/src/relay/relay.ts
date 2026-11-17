import { hostname } from 'node:os'
import { errorText } from '../context.js'
import type { TopicCtx } from '../context.js'
import { OutboxLeaseLostError } from '../errors.js'
import type { OutboxRecord, OutboxSink, Relay, RelayOptions, RetryOptions } from '../types.js'
import {
  readPartition,
  settleDelivered,
  settleFailed,
  settleParked,
  sweep,
  waves,
} from './deliver.js'
import { acquire, fairShare, heartbeat, release } from './lease.js'
import type { Lease } from './lease.js'
import { waker } from './waker.js'
import type { Waker } from './waker.js'

const ASYNC_DISPOSE: symbol =
  (Symbol as { asyncDispose?: symbol }).asyncDispose ?? Symbol.for('Symbol.asyncDispose')
const SWEEP_LIMIT = 5_000

/** `min(maxDelayMs, baseDelayMs * 2^(attempt-1))`, jittered as 15 §0.2 fixes it. */
export function backoffMs(
  { baseDelayMs, maxDelayMs, jitter }: Required<Omit<RetryOptions, 'maxAttempts'>>,
  attempt: number,
  random: () => number = Math.random,
): number {
  // Clamped: `0 * 2 ** 1024` is NaN, and anything past 2 ** 62 is only ever capped by maxDelayMs.
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(62, Math.max(0, attempt - 1)))
  if (jitter === 'none') return ceiling
  if (jitter === 'equal') return ceiling / 2 + random() * (ceiling / 2)
  return random() * ceiling
}

interface Held extends Lease {
  readonly ctrl: AbortController
}

export function startRelay<T>(
  ctx: TopicCtx<T>,
  sink: OutboxSink<T>,
  opts: RelayOptions,
  onClose: (r: Relay) => void,
): Relay {
  const {
    batchSize = 100,
    concurrency = 4,
    leaseMs = 30_000,
    pollMs = 1_000,
    graceMs = 10_000,
  } = opts
  const retry = {
    maxAttempts: 10,
    baseDelayMs: 1_000,
    maxDelayMs: 300_000,
    jitter: 'full' as const,
    ...opts.retry,
  }
  const owner =
    opts.owner ?? `${hostname()}:${process.pid}:${Math.random().toString(16).slice(2, 10)}`
  const { def, hooks } = ctx
  const topic = def.topic
  const held = new Map<number, Held>()
  let live = 1
  let dueAt = Infinity
  let closed = false
  let started = false
  let stopped = false
  let wake: Waker | undefined
  let beating: Promise<void> | undefined
  let sweeping: Promise<void> | undefined

  const lose = (p: number, h: Held): void => {
    if (held.get(p) !== h) return
    held.delete(p)
    h.ctrl.abort(
      new OutboxLeaseLostError(`@pg-prime/outbox: ${topic}: partition ${p} was taken over.`),
    )
    hooks.call('onLease', { topic, acquired: [], released: [p] })
  }

  /** One heartbeat at a time; `close()` waits for the one in flight. */
  const beat = (): Promise<void> | undefined =>
    started && !stopped ? (beating ??= pulse().finally(() => (beating = undefined))) : undefined

  const pulse = async (): Promise<void> => {
    try {
      const sent = [...held.values()]
      const r = await heartbeat(ctx, owner, leaseMs, sent)
      live = r.live
      for (const h of sent) if (!r.kept.has(h.p)) lose(h.p, h)
      if (held.size > fairShare(def.partitions, live)) wake?.kick()
      if (def.keepDeliveredMs > 0 && !closed) {
        sweeping ??= clean().finally(() => (sweeping = undefined))
      }
    } catch (e) {
      hooks.internal('heartbeat-failed', `@pg-prime/outbox: ${topic}: heartbeat failed.`, e)
    }
  }

  const clean = async (): Promise<void> => {
    try {
      let force = false
      while (!closed && (await sweep(ctx, leaseMs, SWEEP_LIMIT, force)) === SWEEP_LIMIT)
        force = true
    } catch (e) {
      hooks.internal('relay-failed', `@pg-prime/outbox: ${topic}: retention sweep failed.`, e)
    }
  }

  /** L1 whenever not above the fair share (L1 computes it fresh), then release any excess. */
  const rebalance = async (): Promise<void> => {
    if (held.size <= fairShare(def.partitions, live)) {
      const got = await acquire(ctx, owner, leaseMs)
      // close() may have released already: give these back, but leave the membership row to it.
      if (closed) return got.leases.length > 0 ? release(ctx, owner, got.leases, false) : undefined
      live = got.live
      for (const l of got.leases) held.set(l.p, { ...l, ctrl: new AbortController() })
      if (got.leases.length > 0) {
        hooks.call('onLease', { topic, acquired: got.leases.map((l) => l.p), released: [] })
      }
    }
    const excess = held.size - fairShare(def.partitions, live)
    if (excess > 0) {
      const extra = [...held.values()].sort((a, b) => b.p - a.p).slice(0, excess)
      for (const h of extra) held.delete(h.p)
      await release(ctx, owner, extra, false)
      hooks.call('onLease', { topic, acquired: [], released: extra.map((h) => h.p) })
    }
  }

  /** One batch of one partition; true when the partition may have more. */
  const serve = async (h: Held): Promise<boolean> => {
    const rows = await readPartition(ctx, h.p, batchSize)
    const failedKeys = new Set<string>()
    for (const wave of waves(rows, failedKeys)) {
      if (closed || held.get(h.p) !== h) return false
      const t0 = performance.now()
      const failed = new Map<bigint, unknown>()
      const ready: OutboxRecord<T>[] = []
      for (const r of wave) {
        if ('error' in r) failed.set(r.id, r.error)
        else ready.push(r)
      }
      if (ready.length > 0) {
        try {
          const res = await sink.deliver(ready, {
            signal: h.ctrl.signal,
            epoch: h.epoch,
            partition: h.p,
          })
          for (const [id, e] of res?.failed ?? []) failed.set(id, e)
        } catch (e) {
          for (const r of ready) failed.set(r.id, e)
        }
      }
      const ok = ready.filter((r) => !failed.has(r.id)).map((r) => r.id)
      if (ok.length > 0) {
        if ((await settleDelivered(ctx, h, ok)) < ok.length) {
          lose(h.p, h)
          return false
        }
        const durationMs = performance.now() - t0
        hooks.call('onDeliver', { topic, partition: h.p, count: ok.length, durationMs })
      }
      for (const r of wave) {
        if (!failed.has(r.id)) continue
        if (r.key !== null) failedKeys.add(r.key)
        if (!(await settleFailure(h, r, failed.get(r.id)))) {
          lose(h.p, h)
          return false
        }
      }
    }
    return rows.length === batchSize
  }

  const settleFailure = async (
    h: Held,
    r: Pick<OutboxRecord<T>, 'id' | 'key' | 'attempts'>,
    error: unknown,
  ): Promise<boolean> => {
    const attempt = r.attempts + 1
    const text = errorText(error)
    if (
      (error as { code?: unknown } | null)?.code === 'OUTBOX_NON_RETRYABLE' ||
      attempt >= retry.maxAttempts
    ) {
      if ((await settleParked(ctx, h, r.id, text)) === 0) return false
      hooks.call('onPark', { topic, id: r.id, key: r.key, error })
      return true
    }
    const delay = backoffMs(retry, attempt)
    if ((await settleFailed(ctx, h, r.id, text, delay)) === 0) return false
    dueAt = Math.min(dueAt, Date.now() + delay)
    hooks.call('onFail', { topic, id: r.id, key: r.key, attempt, error })
    return true
  }

  /** Every held partition gets one batch, `concurrency` at a time. */
  const round = async (): Promise<boolean> => {
    const queue = [...held.values()]
    let more = false
    const worker = async (): Promise<void> => {
      for (let h = queue.shift(); h !== undefined && !closed; h = queue.shift()) {
        if (await serve(h)) more = true
      }
    }
    // A rejected worker must not leave its siblings serving into the next round.
    const done = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, queue.length) }, worker),
    )
    for (const r of done) if (r.status === 'rejected') throw r.reason
    return more
  }

  const heartbeats = setInterval(() => void beat(), leaseMs / 3)
  const loop = async (w: Waker): Promise<void> => {
    try {
      while (!closed) {
        try {
          if (!started) {
            await ctx.start()
            started = true
            await beat()
            continue
          }
          await rebalance()
          if (await round()) continue
          const now = Date.now()
          if (dueAt <= now) dueAt = Infinity
          await w.wait(Math.min(pollMs, dueAt - now))
        } catch (e) {
          if (closed) break
          hooks.internal('relay-failed', `@pg-prime/outbox: ${topic}: relay round failed.`, e)
          await w.wait(pollMs)
        }
      }
    } finally {
      await w.close()
    }
  }

  const running = waker(ctx.db, ctx.chan, hooks)
    .then((w) => {
      wake = w
      if (closed) w.kick()
      return loop(w)
    })
    .catch((e: unknown) => {
      hooks.internal('relay-failed', `@pg-prime/outbox: ${topic}: relay stopped.`, e)
    })

  let closing: Promise<void> | undefined
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      closed = true
      wake?.kick()
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([running, new Promise((r) => (timer = setTimeout(r, graceMs)))])
      clearTimeout(timer)
      stopped = true
      clearInterval(heartbeats)
      // A heartbeat landing after the release below would bring the membership row back.
      await Promise.all([beating, sweeping])
      await wake?.close()
      const leases = [...held.values()]
      held.clear()
      for (const h of leases) h.ctrl.abort()
      try {
        await release(ctx, owner, leases, true)
      } catch (e) {
        hooks.internal('relay-failed', `@pg-prime/outbox: ${topic}: release on close failed.`, e)
      }
      onClose(relay)
    })())

  opts.signal?.addEventListener('abort', () => void close(), { once: true })
  if (opts.signal?.aborted === true) void close()

  const relay = {
    get partitions() {
      return [...held.keys()].sort((a, b) => a - b)
    },
    close,
    [ASYNC_DISPOSE]: close,
  } as unknown as Relay
  return relay
}
