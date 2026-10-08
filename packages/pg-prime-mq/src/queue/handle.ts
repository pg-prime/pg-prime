import { engineChannel, waker } from '@pg-prime/events'
import { UsageError } from 'pg-prime'
import type { Queryable, Subscription } from 'pg-prime'
import type { QueueDef } from '../define.js'
import { LeaseLostError, MessageFailedError } from '../errors.js'
import type { Core } from '../mq.js'
import { decodePayload } from '../payload.js'
import {
  activeCount,
  deleteMessages,
  dropRows,
  flagCancel,
  lockTree,
  purgeBatch,
  resolveRemoved,
  retry,
  setGroup,
  setPaused,
  withUnresolvedChildren,
} from '../sql/admin.js'
import type { GroupLimits } from '../sql/admin.js'
import { claim, claimGroups, promote } from '../sql/claim.js'
import { counts, get, list } from '../sql/read.js'
import type { MessageState, MsgRow } from '../sql/read.js'
import { dedupOwners, insert } from '../sql/send.js'
import { extend } from '../sql/settle.js'
import { assertTxSettle, message } from './context.js'
import type { Message } from './context.js'
import { newRow } from './flow.js'
import type { MessageRef, SendOptions } from './flow.js'
import { completeMessage, failMessage, finishMessage, recoverExpired } from './settle.js'
import { startWorker } from './worker.js'
import type { Handler, Worker, WorkerOptions } from './worker.js'

export interface QueueHandle<T, R> {
  readonly name: string
  /** Upserts this queue's row; required before `{ tx }` sends on an ad hoc queue. */
  start(): Promise<void>
  send(payload: T, opts?: SendOptions): Promise<MessageRef>
  sendMany(
    items: readonly { payload: T; opts?: Omit<SendOptions, 'tx'> }[],
    opts?: { tx?: Queryable<any> },
  ): Promise<MessageRef[]>
  work(handler: Handler<T, R>, opts?: WorkerOptions): Worker
  /**
   * Manual consumption: settle each with `complete`, `fail` or `extend` before its lease ends.
   * Expired leases are recovered first, at most once per 15 s per queue. Groups are served
   * round-robin, probing at most `4 × limit` per call: an empty result can mean only paused or
   * full groups were probed, and the next call goes on after them.
   */
  claim(opts?: { token?: string; leaseMs?: number; limit?: number }): Promise<Message<T>[]>
  complete(m: Message<T>, result: R, opts?: { tx?: Queryable<any> }): Promise<void>
  fail(m: Message<T>, err: unknown, opts?: { tx?: Queryable<any>; final?: boolean }): Promise<void>
  extend(m: Message<T>, leaseMs: number): Promise<void>
  get(ref: MessageRef | bigint | { key: string }): Promise<Message<T, R> | undefined>
  list(opts?: {
    state?: MessageState | readonly MessageState[]
    limit?: number
    after?: bigint
  }): Promise<Message<T, R>[]>
  counts(): Promise<Record<MessageState, number>>
  /** Resolves with the result; rejects with `MessageFailedError` when it fails or is cancelled. */
  result(
    ref: MessageRef,
    opts?: { timeoutMs?: number; signal?: AbortSignal; pollMs?: number },
  ): Promise<R>
  /** A live, best-effort stream of transitions. */
  watch(
    handler: (e: { id: bigint; state: MessageState }) => void,
    opts?: { signal?: AbortSignal },
  ): Promise<Subscription>
  pause(): Promise<void>
  resume(): Promise<void>
  cancel(ref: MessageRef | bigint, reason?: string): Promise<void>
  retry(
    sel:
      | { ids: readonly bigint[] }
      | { state: 'failed' | 'cancelled' | 'completed'; limit?: number },
  ): Promise<number>
  promote(ref: MessageRef | bigint): Promise<void>
  /** Deletes the message and its descendants; refuses while any of them is active. */
  remove(ref: MessageRef | bigint): Promise<boolean>
  purge(sel: { states: readonly MessageState[]; olderThanMs?: number }): Promise<number>
  /** Deletes the queue; refuses while a message is active unless `force`. */
  drop(opts?: { force?: boolean }): Promise<void>
  pauseGroup(key: string): Promise<void>
  resumeGroup(key: string): Promise<void>
  setGroupLimits(key: string, l: GroupLimits): Promise<void>
}

const idOf = (ref: MessageRef | bigint): bigint => (typeof ref === 'bigint' ? ref : ref.id)

export function queueHandle<T, R>(core: Core, def: QueueDef<T, R>): QueueHandle<T, R> {
  const { t } = core
  const name = def.name
  const toMessage = async (r: MsgRow): Promise<Message<T, R>> =>
    message<T, R>(r, await decodePayload(def.payload, r.payload))
  const lost = (m: { id: bigint }): LeaseLostError =>
    new LeaseLostError(`@pg-prime/mq: message ${name}:${m.id} is no longer held by this consumer.`)
  const token = (m: Message<T>): string => {
    if (m.token === null)
      throw new UsageError('@pg-prime/mq: only a claimed message can be settled.')
    return m.token
  }
  /** The claimed message's full row (parent, retry policy), still held by its token. */
  const held = async (m: Message<T>, q: Queryable<any>): Promise<MsgRow & { token: string }> => {
    const r = await get(q, t, name, { id: m.id })
    if (r?.state !== 'active' || r.token !== token(m)) throw lost(m)
    return { ...r, token: token(m) }
  }
  const ready = (): Promise<void> => core.ready(def)
  // Manual claims' round-robin position over groups, as a worker keeps its own.
  let cursor = ''

  const sendMany: QueueHandle<T, R>['sendMany'] = async (items, opts = {}) => {
    const { tx } = opts
    if (tx === undefined) await ready()
    else core.assertStarted('send')
    if (items.length === 0) return []
    const rows = await Promise.all(items.map((i, n) => newRow(def, i.payload, i.opts, n + 1)))
    // One dedup mode per statement, and a key at most once: ON CONFLICT cannot touch a row twice.
    const firstOf = new Map<string, number>()
    const batches = new Map<boolean, typeof rows>()
    for (const [i, r] of rows.entries()) {
      if (r.dedup !== null) {
        if (firstOf.has(r.dedup)) continue
        firstOf.set(r.dedup, i)
      }
      const dedup = items[i]?.opts?.dedup
      const extend = typeof dedup === 'object' && dedup.extend === true
      batches.set(extend, [...(batches.get(extend) ?? []), r])
    }
    const run = async (q: Queryable<any>): Promise<MessageRef[]> => {
      const ids = new Map<number, { id: bigint; deduplicated: boolean }>()
      for (const [extend, batch] of batches) {
        let pending = batch
        for (let round = 0; pending.length > 0 && round < 3; round++) {
          const out = await insert(q, t, pending, { extend, flow: false })
          const missing = new Map<string, number>()
          for (const o of out) {
            if (o.id !== null) ids.set(o.n, { id: o.id, deduplicated: false })
            else if (o.existing !== null) ids.set(o.n, { id: o.existing, deduplicated: true })
            else missing.set(rows[o.n - 1]?.dedup as string, o.n)
          }
          if (missing.size === 0) break
          const owners = await dedupOwners(q, t, name, [...missing.keys()])
          for (const [key, n] of missing) {
            const id = owners.get(key)
            if (id !== undefined) ids.set(n, { id, deduplicated: true })
          }
          // The winner finished between the two statements: send those again.
          pending = pending.filter((r) => !ids.has(r.n))
        }
      }
      return rows.map((r, i) => {
        const hit = ids.get(r.dedup === null ? r.n : (firstOf.get(r.dedup) as number) + 1)
        if (hit === undefined)
          throw new Error(`@pg-prime/mq: send of ${name} item ${i} did not settle.`)
        const dup = r.dedup !== null && firstOf.get(r.dedup) !== i
        return { queue: name, id: hit.id, deduplicated: hit.deduplicated || dup }
      })
    }
    const refs =
      tx !== undefined || batches.size === 1
        ? await run(tx ?? core.db)
        : await core.db.transaction(run)
    const fresh = refs.filter((r) => !r.deduplicated).map((r) => r.id)
    if (fresh.length > 0)
      core.hooks.emit('onSend', { queue: name, ids: fresh, inTx: tx !== undefined })
    return refs
  }

  const handle: QueueHandle<T, R> = {
    name,
    start: ready,
    async send(payload, opts = {}) {
      const { tx, ...o } = opts
      const [r] = await sendMany([{ payload, opts: o }], tx === undefined ? {} : { tx })
      return r as MessageRef
    },
    sendMany,
    work: (handler, opts) => startWorker(core, def, handler, opts),

    async claim(opts = {}) {
      await ready()
      await recoverExpired(core, core.db, name, 15_000)
      await promote(core.db, t, name)
      const o = {
        queue: name,
        n: opts.limit ?? 1,
        leaseMs: opts.leaseMs ?? 30_000,
        token: opts.token ?? null,
        consumer: 'manual',
        limited: def.rate !== undefined || def.concurrency !== undefined,
      }
      const rows = await claim(core.db, t, o)
      if (rows.length < o.n) {
        const g = { after: cursor, scan: 4 * o.n, concurrency: undefined, rate: undefined }
        const r = await claimGroups(core.db, t, { ...o, n: o.n - rows.length }, g)
        cursor = r.cursor
        rows.push(...r.rows)
      }
      const out: Message<T>[] = []
      for (const r of rows) {
        try {
          out.push(await toMessage(r))
        } catch (err) {
          await failMessage(core, def, { ...r, token: r.token as string }, err, { final: true })
        }
      }
      return out
    },

    async complete(m, result, opts = {}) {
      if (opts.tx !== undefined) assertTxSettle(def)
      const h = {
        id: m.id,
        queue: name,
        parent: null,
        onFail: 'wait' as const,
        attempts: m.attempts,
        retry: def.retry,
      }
      const r = await completeMessage(core, def, { ...h, token: token(m) }, result, opts.tx)
      if (r === undefined) throw lost(m)
    },
    async fail(m, err, opts = {}) {
      if (opts.tx !== undefined) assertTxSettle(def)
      const r = await failMessage(core, def, await held(m, opts.tx ?? core.db), err, {
        ...(opts.final === undefined ? {} : { final: opts.final }),
        ...(opts.tx === undefined ? {} : { tx: opts.tx }),
      })
      if (r === undefined) throw lost(m)
    },
    async extend(m, leaseMs) {
      if (!(await extend(core.db, t, m.id, token(m), leaseMs))) throw lost(m)
    },

    async get(ref) {
      await ready()
      const r = await get(
        core.db,
        t,
        name,
        typeof ref === 'object' && 'key' in ref ? ref : { id: idOf(ref) },
      )
      return r === undefined ? undefined : toMessage(r)
    },
    async list(opts = {}) {
      await ready()
      const s = opts.state
      const states = s === undefined ? null : typeof s === 'string' ? [s] : [...s]
      const rows = await list(core.db, t, name, states, opts.after ?? 0n, opts.limit ?? 100)
      return Promise.all(rows.map(toMessage))
    },
    async counts() {
      await ready()
      return counts(core.db, t, name)
    },

    async result(ref, opts = {}) {
      watched()
      await ready()
      const stop = new AbortController()
      const timer =
        opts.timeoutMs === undefined ? undefined : setTimeout(() => stop.abort(), opts.timeoutMs)
      const onAbort = (): void => stop.abort()
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      if (opts.signal?.aborted === true) stop.abort()
      // Subscribe first, then read: a fast completion cannot slip between the two.
      const w = waker(core.db, engineChannel(t.schema, 'q-watch', name), {
        pollMs: opts.pollMs ?? 5000,
        signal: stop.signal,
        onInternal: (e) => core.hooks.internal('listen-unavailable', e.message, e.cause),
      })
      try {
        do {
          const r = await get(core.db, t, name, { id: ref.id })
          if (r === undefined)
            throw new UsageError(`@pg-prime/mq: message ${name}:${ref.id} does not exist.`)
          if (r.state === 'completed') return r.result as R
          if (r.state === 'failed' || r.state === 'cancelled') {
            throw new MessageFailedError(
              `@pg-prime/mq: message ${name}:${ref.id} ${r.state}: ${r.error ?? 'no error recorded'}`,
              r.state,
            )
          }
        } while ((await w.wait()) !== undefined)
        throw (
          opts.signal?.reason ??
          new UsageError(`@pg-prime/mq: result() of ${name}:${ref.id} timed out.`)
        )
      } finally {
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        await w.close()
      }
    },
    async watch(handler, opts = {}) {
      watched()
      await ready()
      return core.db.listen(
        engineChannel(t.schema, 'q-watch', name),
        (raw) => {
          const e = JSON.parse(raw) as { id: string; s: MessageState }
          handler({ id: BigInt(e.id), state: e.s })
        },
        opts.signal === undefined ? {} : { signal: opts.signal },
      )
    },

    pause: () => ready().then(() => setPaused(core.db, t, name, true)),
    resume: () => ready().then(() => setPaused(core.db, t, name, false)),
    async cancel(ref, reason) {
      await ready()
      const id = idOf(ref)
      const idle = { kind: 'idle', queue: name } as const
      // A message that moves between idle and active meanwhile is caught by the next pass.
      for (;;) {
        const r = await finishMessage(core, { id, queue: name }, 'cancelled', idle, {
          error: reason ?? 'cancelled',
        })
        if (r !== undefined || (await flagCancel(core.db, t, name, id, reason ?? null))) return
        const s = (await get(core.db, t, name, { id }))?.state
        if (s !== 'ready' && s !== 'delayed' && s !== 'blocked' && s !== 'active') return
      }
    },
    async retry(sel) {
      await ready()
      if ('ids' in sel) {
        const refused = await withUnresolvedChildren(core.db, t, name, sel.ids)
        if (refused.length > 0) {
          throw new UsageError(
            `@pg-prime/mq: message(s) ${refused.join(', ')} of ${name} have unresolved children; retry those first.`,
          )
        }
      }
      return retry(core.db, t, name, sel)
    },
    async promote(ref) {
      await ready()
      await promote(core.db, t, name, idOf(ref))
    },
    async remove(ref) {
      await ready()
      const id = idOf(ref)
      return core.db.transaction(async (tx) => {
        const tree = await lockTree(tx, t, name, id)
        if (tree.ids.length === 0) return false
        if (!tree.complete || tree.states.includes('active')) {
          throw new UsageError(
            `@pg-prime/mq: message ${name}:${id} or a descendant is running; cancel it first.`,
          )
        }
        await deleteMessages(tx, t, tree.ids)
        if (tree.parent !== null) await resolveRemoved(tx, t, id, tree.parent)
        return true
      })
    },
    async purge(sel) {
      await ready()
      if (sel.states.includes('active')) {
        throw new UsageError(
          '@pg-prime/mq: purge cannot delete active messages; cancel them first.',
        )
      }
      let n = 0
      for (let k = 1000; k === 1000; n += k) {
        k = await purgeBatch(core.db, t, name, sel.states, sel.olderThanMs ?? null)
      }
      return n
    },
    async drop(opts = {}) {
      await ready()
      await setPaused(core.db, t, name, true)
      if (opts.force !== true && (await activeCount(core.db, t, name)) > 0) {
        await setPaused(core.db, t, name, false)
        throw new UsageError(
          `@pg-prime/mq: queue ${name} has active messages; drop({ force: true }) to drop it anyway.`,
        )
      }
      while ((await purgeBatch(core.db, t, name, null, null)) === 1000);
      await dropRows(core.db, t, name)
      core.forget(def)
    },
    pauseGroup: (key) => ready().then(() => setGroup(core.db, t, name, key, { paused: true })),
    resumeGroup: (key) => ready().then(() => setGroup(core.db, t, name, key, { paused: false })),
    setGroupLimits: (key, l) => ready().then(() => setGroup(core.db, t, name, key, l)),
  }

  function watched(): void {
    if (!def.watch) {
      throw new UsageError(
        `@pg-prime/mq: queue ${name} is not watched; declare it with watch: true.`,
      )
    }
  }
  return handle
}
