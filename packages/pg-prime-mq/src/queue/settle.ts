import type { Queryable } from 'pg-prime'
import type { QueueDef } from '../define.js'
import { NonRetryableError } from '../errors.js'
import type { Core } from '../mq.js'
import { MAX_PAYLOAD, toJson } from '../payload.js'
import { expire, expiryGate } from '../sql/lease.js'
import { holder } from '../sql/read.js'
import type { MsgRow } from '../sql/read.js'
import { finish, lockAncestors, move } from '../sql/settle.js'
import type { Guard, Settled } from '../sql/settle.js'
import { backoffMs, sleep } from '../util.js'

type Held = Pick<MsgRow, 'id' | 'queue' | 'parent' | 'onFail' | 'attempts' | 'retry'> & {
  readonly token: string
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * `completed` / `failed` / `cancelled` through the one `finish` builder. A failure that may
 * cascade (a `fail` child, or a row we have not read) is one short transaction: lock the
 * ancestors, finish the message, then each `blocked` parent the cascade reaches.
 */
export async function finishMessage(
  core: Core,
  m:
    | Pick<MsgRow, 'id' | 'queue' | 'parent' | 'onFail'>
    | { readonly id: bigint; readonly queue: string },
  to: 'completed' | 'failed' | 'cancelled',
  guard: Guard,
  o: {
    result?: string
    error?: string
    stack?: string | null
    del?: boolean
    tx?: Queryable<any>
  } = {},
): Promise<Settled | undefined> {
  const { t } = core
  const args = {
    id: m.id,
    to,
    guard,
    result: o.result ?? null,
    error: o.error ?? null,
    stack: o.stack ?? null,
    del: o.del ?? false,
  }
  const cascades =
    to !== 'completed' && (!('parent' in m) || (m.parent !== null && m.onFail === 'fail'))
  if (!cascades) return finish(o.tx ?? core.db, t, args)
  const body = async (q: Queryable<any>): Promise<Settled | undefined> => {
    await lockAncestors(q, t, m.id)
    const first = await finish(q, t, args)
    let child = { id: m.id, queue: m.queue }
    let r = first
    while (r?.cascadeTo != null) {
      const parent: bigint = r.cascadeTo
      r = await finish(q, t, {
        id: parent,
        to: 'failed',
        guard: { kind: 'blocked' },
        error: `child ${child.queue}:${child.id} failed`,
      })
      child = { id: parent, queue: r?.queue ?? '' }
    }
    return first
  }
  return o.tx === undefined ? core.db.transaction(body) : body(o.tx)
}

export function completeMessage(
  core: Core,
  def: QueueDef<any, any>,
  m: Held,
  result: unknown,
  tx?: Queryable<any>,
): Promise<Settled | undefined> {
  return finishMessage(
    core,
    m,
    'completed',
    { kind: 'token', token: m.token },
    {
      result: toJson(result ?? null, MAX_PAYLOAD, 'result'),
      del: def.keep.completed === false,
      ...(tx === undefined ? {} : { tx }),
    },
  )
}

/** A failed attempt: retried with backoff while attempts remain, else `failed` (or `cancelled`). */
export async function failMessage(
  core: Core,
  def: QueueDef<any, any>,
  m: Held,
  err: unknown,
  o: { final?: boolean; cancelled?: boolean; error?: string; tx?: Queryable<any> } = {},
): Promise<'retry' | 'failed' | 'cancelled' | undefined> {
  const attempt = m.attempts + 1
  const error = o.error ?? errorText(err)
  const stack = err instanceof Error ? (err.stack ?? null) : null
  const tx = o.tx === undefined ? {} : { tx: o.tx }
  if (o.cancelled === true) {
    const r = await finishMessage(
      core,
      m,
      'cancelled',
      { kind: 'token', token: m.token },
      { error, stack, ...tx },
    )
    return r && 'cancelled'
  }
  let final = o.final === true || err instanceof NonRetryableError || attempt >= m.retry.maxAttempts
  if (!final && def.shouldRetry !== undefined) {
    try {
      final = !def.shouldRetry(err, attempt)
    } catch {
      final = true
    }
  }
  if (final) {
    const r = await finishMessage(
      core,
      m,
      'failed',
      { kind: 'token', token: m.token },
      { error, stack, ...tx },
    )
    return r && 'failed'
  }
  const ok = await move(o.tx ?? core.db, core.t, m.id, m.token, {
    kind: 'retry',
    delayMs: backoffMs(m.retry, attempt),
    error,
    stack,
  })
  return ok ? 'retry' : undefined
}

/** S9 at most once per queue per `everyMs`: re-queues or fails expired leases; returns how many. */
export async function recoverExpired(
  core: Core,
  q: Queryable<any>,
  queue: string,
  everyMs: number,
): Promise<number> {
  if (!(await expiryGate(q, core.t, queue, everyMs))) return 0
  const r = await expire(q, core.t, queue)
  for (const id of r.exhausted)
    await finishMessage(core, { id, queue }, 'failed', { kind: 'expired' }, { error: 'lease-expired' })
  const ids = [...r.requeued, ...r.exhausted]
  if (ids.length > 0) core.hooks.emit('onLeaseExpired', { queue, ids })
  return ids.length
}

/**
 * Runs a standalone settle; when it errors (a lost connection may have applied it), re-reads the
 * row: still ours and active ⇒ issue it again, otherwise it is settled or the lease is gone.
 */
export async function settleSafely<V>(
  core: Core,
  m: { readonly id: bigint; readonly token: string },
  fn: () => Promise<V>,
): Promise<V | 'gone'> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i === 2) throw e
      await sleep(100 * (i + 1))
      const h = await holder(core.db, core.t, m.id).catch(() => 'unknown' as const)
      if (h !== 'unknown' && (h?.state !== 'active' || h.token !== m.token)) return 'gone'
    }
  }
}
