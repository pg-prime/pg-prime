import { engineChannel, waker } from '@pg-prime/events'
import type { WakeReason } from '@pg-prime/events'
import type { AsyncDisposable_, Db } from 'pg-prime'
import type { QueueDef } from '../define.js'
import { CancelledError, LeaseLostError, NonRetryableError } from '../errors.js'
import type { SettleOutcome } from '../hooks.js'
import type { Core } from '../mq.js'
import { decodePayload } from '../payload.js'
import { claim, claimGroups, promote } from '../sql/claim.js'
import type { ClaimOptions } from '../sql/claim.js'
import { heartbeat } from '../sql/lease.js'
import {
  dedupBatch,
  expireBatch,
  maintenanceGate,
  reconcileGroups,
  reconcileQueue,
  trimBatch,
} from '../sql/maintain.js'
import { holder } from '../sql/read.js'
import type { MsgRow } from '../sql/read.js'
import { ASYNC_DISPOSE, limiter } from '../util.js'
import { isDeferral, message, workContext } from './context.js'
import type { Deferral, Message, Running, WorkContext } from './context.js'
import { completeMessage, failMessage, moveMessage, recoverExpired, settleSafely } from './settle.js'

export type Handler<T, R> = (msg: Message<T>, ctx: WorkContext<T, R>) => Promise<R | Deferral>

export interface WorkerOptions {
  /** Messages run at once; default 1. */
  concurrency?: number
  /** Default 30 000. */
  leaseMs?: number
  /** Default `leaseMs / 3`. */
  heartbeatMs?: number
  /** Longest sleep without a wake-up; default 5 000. */
  pollMs?: number
  /** Default 15 000. */
  expireScanMs?: number
  /** Default 5 000. */
  maintenanceMs?: number
  /** This worker's own claim rate. */
  localRate?: { max: number; perMs: number }
  /** Defaults for groups whose row sets no limits; `scan` caps the groups probed per claim. */
  group?: { concurrency?: number; rate?: { max: number; perMs: number }; scan?: number }
  signal?: AbortSignal
  /** Claims, heartbeats and expiry scans run here: a small second pool, so a saturated `db` cannot starve them. */
  controlDb?: Db
}

export interface Worker extends AsyncDisposable_ {
  /** Messages being handled now. */
  readonly running: number
  /** Stops claiming and waits for running handlers; after `graceMs` their signals abort. */
  close(opts?: { graceMs?: number }): Promise<void>
}

interface Entry extends Running {
  cancelled: boolean
  lost: boolean
  /** Aborted by `close({ graceMs })`: a failure releases the message instead of counting it. */
  shutdown: boolean
}

export function startWorker<T, R>(
  core: Core,
  def: QueueDef<T, R>,
  handler: Handler<T, R>,
  opts: WorkerOptions = {},
): Worker {
  const { t, hooks } = core
  const queue = def.name
  const concurrency = opts.concurrency ?? 1
  const leaseMs = opts.leaseMs ?? 30_000
  const pollMs = opts.pollMs ?? 5000
  const expireScanMs = opts.expireScanMs ?? 15_000
  const maintenanceMs = opts.maintenanceMs ?? 5000
  const ctl = opts.controlDb ?? core.db
  const consumer = Math.random().toString(36).slice(2, 10)
  const local = limiter(opts.localRate)
  const stop = new AbortController()
  const held = new Map<bigint, Entry>()
  const inflight = new Set<Promise<void>>()
  let slot: (() => void) | undefined
  let promoteAt = 0
  let nextExpire = 0
  let nextMaint = 0
  let cursor = ''
  let groupsFirst = false
  // A path that came back empty is skipped until a wake-up, a promotion or `pollMs` passes.
  const dry = { plain: false, grouped: false }
  let wokeAt = 0
  let beating = false

  const onAbort = (): void => void close()
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  const beat = setInterval(
    () => {
      const live = [...held.values()].filter((e) => !e.inTx && !e.lost)
      if (beating || live.length === 0) return
      beating = true
      heartbeat(
        ctl,
        t,
        live.map((e) => ({ id: e.row.id, token: e.token })),
        leaseMs,
      )
        .then(async (got) => {
          for (const e of live) {
            const cancel = got.get(e.row.id)
            if (cancel === true && !e.cancelled) {
              e.cancelled = true
              e.abort.abort(
                new CancelledError(`@pg-prime/mq: message ${queue}:${e.row.id} was cancelled.`),
              )
            }
            if (cancel !== undefined) continue
            // Skipped: locked by a short admin update, or no longer ours.
            const h = await holder(ctl, t, e.row.id)
            if (h?.state === 'active' && h.token === e.token) continue
            e.lost = true
            e.abort.abort(
              new LeaseLostError(`@pg-prime/mq: message ${queue}:${e.row.id} lost its lease.`),
            )
          }
        })
        .catch((e: unknown) =>
          hooks.internal('heartbeat-failed', `@pg-prime/mq: heartbeat on ${queue} failed.`, e),
        )
        .finally(() => (beating = false))
    },
    opts.heartbeatMs ?? leaseMs / 3,
  )

  const settled = (
    e: Entry,
    outcome: SettleOutcome | undefined,
    started: number,
    error?: unknown,
  ): void => {
    if (outcome === undefined) {
      hooks.internal(
        'lease-lost',
        `@pg-prime/mq: message ${queue}:${e.row.id} was settled elsewhere; its result was dropped.`,
      )
      return
    }
    hooks.emit('onSettle', {
      queue,
      id: e.row.id,
      outcome,
      durationMs: Date.now() - started,
      attempt: e.row.attempts + 1,
      ...(error === undefined ? {} : { error }),
    })
  }

  /** After an in-transaction completion: committed ⇒ done; still ours ⇒ it rolled back, so the attempt failed. */
  const afterTx = async (e: Entry, err: unknown): Promise<SettleOutcome | undefined> => {
    const h = await holder(core.db, t, e.row.id)
    if (h === undefined || h.state === 'completed') return 'completed'
    if (h.state !== 'active' || h.token !== e.token) return undefined
    const indeterminate =
      err === undefined || (err as { code?: unknown }).code === 'INDETERMINATE_COMMIT'
    return failMessage(
      core,
      def,
      { ...e.row, token: e.token },
      err ?? new Error('indeterminate-commit'),
      indeterminate ? { error: 'indeterminate-commit' } : {},
    )
  }

  const outcome = (r: SettleOutcome | 'moved' | 'gone' | undefined): SettleOutcome | undefined =>
    r === 'gone' ? undefined : r === 'moved' ? 'deferred' : r

  const runOne = async (e: Entry): Promise<void> => {
    const started = Date.now()
    const { row } = e
    const m = { ...row, token: e.token }
    let payload: T
    try {
      payload = await decodePayload(def.payload, row.payload)
    } catch (err) {
      const r = await settleSafely(core, m, () => failMessage(core, def, m, err, { final: true }))
      return settled(e, outcome(r), started, err)
    }
    try {
      const value = await handler(message<T, never>(row, payload), workContext(core, def, e))
      if (e.inTx) return settled(e, await afterTx(e, undefined), started)
      if (isDeferral(value)) {
        const r = await settleSafely(core, m, () => moveMessage(core, m, value.deferral))
        if (r !== undefined) return settled(e, outcome(r), started)
        // waitForChildren refused: a `fail` child failed (fail now), or nothing is pending (run again).
        const h = value.deferral.kind === 'wait' ? await holder(core.db, t, row.id) : undefined
        if (h?.state === 'active' && h.token === e.token) {
          const r = h.childFailed
            ? await failMessage(core, def, m, new NonRetryableError('a child failed'), {
                final: true,
              })
            : await moveMessage(core, m, { kind: 'release' })
          return settled(e, outcome(r), started)
        }
        return settled(e, undefined, started)
      }
      const r = await settleSafely(core, m, () => completeMessage(core, def, m, value))
      settled(e, r === 'gone' || r === undefined ? undefined : 'completed', started)
    } catch (err) {
      if (e.inTx) return settled(e, await afterTx(e, err), started, err)
      if (e.lost) return settled(e, undefined, started, err)
      const r = await settleSafely(core, m, () =>
        e.shutdown && !e.cancelled
          ? moveMessage(core, m, { kind: 'release' })
          : failMessage(core, def, m, err, { cancelled: e.cancelled }),
      )
      settled(e, outcome(r), started, err)
    }
  }

  const start = (row: MsgRow): void => {
    const e: Entry = {
      row,
      token: row.token as string,
      abort: new AbortController(),
      inTx: false,
      cancelled: false,
      lost: false,
      shutdown: false,
    }
    held.set(row.id, e)
    const p: Promise<void> = runOne(e)
      .catch((err: unknown) =>
        hooks.internal(
          'worker-failed',
          `@pg-prime/mq: settling ${queue}:${row.id} failed; its lease will expire.`,
          err,
        ),
      )
      .finally(() => {
        held.delete(row.id)
        inflight.delete(p)
        slot?.()
      })
    inflight.add(p)
  }

  const claimOptions = (n: number): ClaimOptions => ({
    queue,
    n,
    leaseMs,
    token: null,
    consumer,
    limited: def.rate !== undefined || def.concurrency !== undefined,
  })

  /** One claim round over ungrouped (S3/S4) and grouped (S5) messages, alternating which goes first. */
  const claimRound = async (free: number, woken: boolean): Promise<number> => {
    const before = Date.now()
    let got = 0
    if (woken) dry.plain = dry.grouped = false
    groupsFirst = !groupsFirst
    for (const grouped of groupsFirst ? [true, false] : [false, true]) {
      const n = free - got
      if (n <= 0 || stop.signal.aborted || dry[grouped ? 'grouped' : 'plain']) continue
      let rows: MsgRow[]
      if (grouped) {
        const scan = opts.group?.scan ?? 4 * n
        const g = { scan, concurrency: opts.group?.concurrency, rate: opts.group?.rate }
        const r = await claimGroups(ctl, t, claimOptions(n), { ...g, after: cursor })
        cursor = r.cursor
        rows = r.rows
        dry.grouped = r.scanned === 0
      } else {
        const o = claimOptions(n)
        rows = await claim(ctl, t, o)
        // Under global limits a freed slot of ours may free capacity: keep trying.
        dry.plain = rows.length === 0 && !o.limited
      }
      for (const row of rows) start(row)
      got += rows.length
    }
    if (got > 0) {
      local.take(got)
      hooks.emit('onClaim', { queue, count: got, waitedMs: Date.now() - before })
    }
    return got
  }

  const expireScan = async (): Promise<void> => {
    if ((await recoverExpired(core, ctl, queue, expireScanMs)) > 0) promoteAt = 0
  }

  const maintain = async (): Promise<void> => {
    const db = core.db
    const g = await maintenanceGate(db, t, queue, maintenanceMs)
    if (g === undefined) return
    while ((await expireBatch(db, t)) === 1000);
    if (g.keepCompletedN !== null)
      while ((await trimBatch(db, t, queue, 'completed', g.keepCompletedN)) === 1000);
    if (g.keepFailedN !== null)
      while ((await trimBatch(db, t, queue, 'failed', g.keepFailedN)) === 1000);
    while ((await dedupBatch(db, t)) === 1000);
    await db.transaction((tx) => reconcileGroups(tx, t, queue))
    if (g.counted) await db.transaction((tx) => reconcileQueue(tx, t, queue))
  }

  /** Waits for a freed slot, `ms`, or close, whichever comes first. */
  const slotOrTimeout = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        stop.signal.removeEventListener('abort', done)
        slot = undefined
        resolve()
      }
      const timer = setTimeout(done, Math.max(1, ms))
      stop.signal.addEventListener('abort', done, { once: true })
      slot = done
    })

  const loop = (async () => {
    const wake = waker(ctl, engineChannel(t.schema, 'q', queue), {
      pollMs,
      signal: stop.signal,
      onInternal: (e) => hooks.internal('listen-unavailable', e.message, e.cause),
    })
    let reason: WakeReason | 'slot' = 'gap'
    while (!stop.signal.aborted) {
      try {
        await core.ready(def)
        const now = Date.now()
        // A busy worker never waits on the waker, so `pollMs` stands in for its wake-ups.
        let woken = reason !== 'slot' || now - wokeAt >= pollMs
        if (woken) wokeAt = now
        if (woken || now >= promoteAt) {
          const p = await promote(ctl, t, queue)
          promoteAt = p.promoted === 1000 ? now : now + (p.nextInMs ?? Infinity)
          woken ||= p.promoted > 0
        }
        if (now >= nextExpire) {
          nextExpire = now + expireScanMs
          await expireScan().catch((e: unknown) =>
            hooks.internal(
              'maintenance-failed',
              `@pg-prime/mq: lease-expiry scan of ${queue} failed.`,
              e,
            ),
          )
        }
        if (now >= nextMaint) {
          nextMaint = now + maintenanceMs
          await maintain().catch((e: unknown) =>
            hooks.internal(
              'maintenance-failed',
              `@pg-prime/mq: maintenance of ${queue} failed.`,
              e,
            ),
          )
        }
        const free = Math.min(concurrency - held.size, local.free())
        const got: number = free > 0 ? await claimRound(free, woken) : 0
        const until = Math.min(promoteAt, nextExpire, nextMaint) - Date.now()
        if (held.size >= concurrency) {
          await slotOrTimeout(until)
          reason = 'slot'
        } else if (got > 0 && got >= free) {
          reason = 'slot'
        } else {
          const rate =
            got === 0
              ? Math.min(def.rate?.perMs ?? pollMs, opts.group?.rate?.perMs ?? pollMs)
              : pollMs
          const limit = local.waitMs() || rate
          reason = (await wake.wait(Math.max(1, Math.min(pollMs, until, limit)))) ?? 'poll'
        }
      } catch (e) {
        hooks.internal(
          'worker-failed',
          `@pg-prime/mq: the ${queue} worker loop failed; retrying.`,
          e,
        )
        await wake.wait(pollMs)
        reason = 'poll'
      }
    }
    await wake.close()
  })()

  let closing: Promise<void> | undefined
  const close = (o: { graceMs?: number } = {}): Promise<void> =>
    (closing ??= (async () => {
      stop.abort()
      await loop
      const all = (): Promise<unknown> => Promise.all(inflight)
      if (o.graceMs === undefined) await all()
      else {
        await Promise.race([all(), new Promise((r) => setTimeout(r, o.graceMs))])
        for (const e of held.values()) {
          e.shutdown = true
          e.abort.abort(new CancelledError(`@pg-prime/mq: the ${queue} worker is closing.`))
        }
        await Promise.race([all(), new Promise((r) => setTimeout(r, o.graceMs))])
      }
      clearInterval(beat)
      opts.signal?.removeEventListener('abort', onAbort)
      core.running.delete(worker)
    })())

  const worker = {
    get running() {
      return held.size
    },
    close,
    [ASYNC_DISPOSE]: () => close(),
  } as unknown as Worker
  core.running.add(worker)
  return worker
}
