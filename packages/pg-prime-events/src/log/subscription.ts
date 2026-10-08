import type { AsyncDisposable_, Queryable } from 'pg-prime'
import type { SubscriptionDef } from '../define.js'
import { EventsLeaseLostError } from '../errors.js'
import type { Core } from '../events.js'
import { ASYNC_DISPOSE, backoffMs, sleep } from '../util.js'
import { waker } from '../waker.js'
import type { Waker } from '../waker.js'
import { BEGINNING, advance, advanceTo, decodeCursor, encodeCursor, seed } from './cursor.js'
import type { Cursor, ReadView } from './cursor.js'
import type { EntryRow, LeaseRow } from './sql.js'
import { entryOf } from './topic.js'
import type { Entry } from './topic.js'

export interface ReadContext {
  readonly signal: AbortSignal
  /** 1-based count of attempts at this entry; a multi-entry batch reports 1. */
  readonly attempt: number
  /** Commits the offset inside your transaction: exactly-once effects for same-database sinks. */
  commit(opts: { tx: Queryable<any> }): Promise<void>
}
export type EntryHandler<T> = (e: Entry<T>, ctx: ReadContext) => Promise<void>
export type BatchHandler<T> = {
  batch: (es: readonly Entry<T>[], ctx: ReadContext) => Promise<void>
}
export interface Reader extends AsyncDisposable_ {
  /** True while this reader holds the subscription's lease. */
  readonly active: boolean
  close(): Promise<void>
}
export interface RunOptions {
  batchSize?: number
  leaseMs?: number
  pollMs?: number
  signal?: AbortSignal
}

export interface SubscriptionHandle<T> {
  run(handler: EntryHandler<T> | BatchHandler<T>, opts?: RunOptions): Reader
  /** Moves the cursor and drops the current lease; `after` takes an `Entry.cursor`. */
  reset(to: 'beginning' | 'now' | { after: string }): Promise<void>
  lag(): Promise<{ entries: number; oldestAt: Date | null }>
  parked(opts?: {
    limit?: number
  }): Promise<{ entry: Omit<Entry<T>, 'cursor'>; attempts: number; error: string | null }[]>
  discard(entryIds: readonly bigint[]): Promise<number>
  remove(): Promise<void>
}

const MAINTENANCE_MS = 60_000

export function subscriptionHandle<T>(core: Core, def: SubscriptionDef<T>): SubscriptionHandle<T> {
  const t = def.topic.name
  const s = def.name
  return {
    run: (handler, opts = {}) => startReader(core, def, handler, opts),
    async reset(to) {
      await core.ready(def)
      const c =
        to === 'beginning'
          ? BEGINNING
          : to === 'now'
            ? await core.sql.seedNow(core.db).then((x) => seed(x.xmax, x.xip))
            : decodeCursor(to.after)
      await core.sql.reset(core.db, t, s, c)
    },
    async lag() {
      await core.ready(def)
      return core.sql.lag(core.db, t, s)
    },
    async parked(opts = {}) {
      await core.ready(def)
      const rows = await core.sql.parked(core.db, t, s, opts.limit ?? 100)
      return Promise.all(
        rows.map(async (r) => ({
          entry: await entryOf(def.topic, r),
          attempts: r.attempts,
          error: r.error,
        })),
      )
    },
    async discard(ids) {
      await core.ready(def)
      return ids.length === 0 ? 0 : core.sql.discard(core.db, t, s, ids)
    },
    async remove() {
      await core.ready(def)
      await core.sql.remove(core.db, t, s)
      core.forget(def)
    },
  }
}

function startReader<T>(
  core: Core,
  def: SubscriptionDef<T>,
  handler: EntryHandler<T> | BatchHandler<T>,
  opts: RunOptions,
): Reader {
  const { db, sql, hooks } = core
  const t = def.topic.name
  const s = def.name
  const batchSize = opts.batchSize ?? 100
  const leaseMs = opts.leaseMs ?? 30_000
  const pollMs = opts.pollMs ?? 5000
  const stop = new AbortController()
  opts.signal?.addEventListener('abort', () => stop.abort(), { once: true })
  if (opts.signal?.aborted === true) stop.abort()
  let active = false
  let lastError: { id: bigint; error: string } | undefined
  let nextMaintenance = 0

  const lostError = (): EventsLeaseLostError =>
    new EventsLeaseLostError(
      `@pg-prime/events: subscription ${t}/${s} lost its lease to another reader.`,
    )

  async function serve(lease: LeaseRow, wake: Waker): Promise<void> {
    const token = lease.token
    let cursor = lease.cursor
    // A multi-entry attempt still marked at takeover crashed: find its poison entry one by one.
    let isolate = lease.headId !== null && lease.headSize > 1 ? lease.headSize : 0
    const held = { lost: false }
    const handlerStop = new AbortController()
    const onStop = (): void => handlerStop.abort()
    stop.signal.addEventListener('abort', onStop, { once: true })
    let beating = false
    const heartbeat = setInterval(() => {
      if (beating) return
      beating = true
      sql
        .heartbeat(db, t, s, token, leaseMs)
        .then((ok) => {
          if (ok) return
          held.lost = true
          handlerStop.abort()
        })
        .catch((e: unknown) =>
          hooks.internal('heartbeat-failed', `@pg-prime/events: heartbeat of ${t}/${s} failed.`, e),
        )
        .finally(() => (beating = false))
    }, leaseMs / 3)

    const commit = async (c: Cursor): Promise<void> => {
      if (!(await sql.commit(db, t, s, token, c))) throw lostError()
      cursor = c
    }

    /** Runs one attempt over `rows`, the first `rows.length` matching entries of `view`. */
    const attempt = async (rows: EntryRow[], view: ReadView, whole: boolean): Promise<void> => {
      const first = rows[0] as EntryRow
      const attempts = await sql.mark(db, t, s, token, first.id, rows.length)
      if (attempts === undefined) throw lostError()
      const cursors: Cursor[] = []
      for (const r of rows) cursors.push(advance(cursors.at(-1) ?? cursor, view, r))
      if (whole) cursors.push(advanceTo(cursors.pop() as Cursor, view))

      if (rows.length === 1 && attempts > def.retry.maxAttempts) {
        const error = lastError?.id === first.id ? lastError.error : null
        const c = cursors[0] as Cursor
        if (!(await sql.park(db, t, s, token, c, first.id, attempts - 1, error))) throw lostError()
        cursor = c
        isolate = Math.max(0, isolate - 1)
        hooks.emit('onPark', { topic: t, subscription: s, entry: first.id, error })
        return
      }

      let committed: string | undefined
      const ctx = (c: Cursor): ReadContext => ({
        signal: handlerStop.signal,
        attempt: Math.max(1, attempts),
        async commit({ tx }) {
          if (!(await sql.commit(tx, t, s, token, c))) throw lostError()
          committed = encodeCursor(c)
        },
      })
      const started = Date.now()
      let done = 0
      let failure: { error: unknown } | undefined
      try {
        const es = await Promise.all(
          rows.map(async (r, i) => ({
            ...(await entryOf(def.topic, r)),
            cursor: encodeCursor(cursors[i] as Cursor),
          })),
        )
        if (typeof handler === 'function') {
          for (const [i, e] of es.entries()) {
            await handler(e, ctx(cursors[i] as Cursor))
            done = i + 1
          }
        } else {
          await handler.batch(es, ctx(cursors.at(-1) as Cursor))
          done = es.length
        }
      } catch (error) {
        failure = { error }
      }
      if (done > 0) {
        const c = cursors[done - 1] as Cursor
        if (encodeCursor(c) === committed) cursor = c
        else await commit(c)
        hooks.emit('onDeliver', {
          topic: t,
          subscription: s,
          count: done,
          durationMs: Date.now() - started,
        })
      }
      if (failure === undefined) {
        isolate = Math.max(0, isolate - done)
        return
      }
      if (rows.length > 1) {
        // A batch failure is never charged: retry the rest one entry at a time.
        isolate = rows.length - done
        return
      }
      if (held.lost) throw lostError()
      lastError = { id: first.id, error: String(failure.error) }
      const delay = backoffMs(def.retry, attempts)
      if (!(await sql.nack(db, t, s, token, delay))) throw lostError()
      hooks.emit('onRetry', {
        topic: t,
        subscription: s,
        entry: first.id,
        attempt: attempts,
        error: failure.error,
      })
      await sleep(delay, stop.signal)
    }

    try {
      active = true
      if (lease.retryInMs > 0) await sleep(lease.retryInMs, stop.signal)
      while (!stop.signal.aborted) {
        if (held.lost) throw lostError()
        if (Date.now() >= nextMaintenance) {
          nextMaintenance = Date.now() + MAINTENANCE_MS
          const m = await sql.maintain(db, t, MAINTENANCE_MS)
          if (m.behind) {
            hooks.internal(
              'subscription-behind-retention',
              `@pg-prime/events: retention on ${t} removed entries a subscription had not read; ` +
                `it continues from the oldest surviving entry. Use keepUntilConsumed to prevent this.`,
            )
          }
        }
        const { view, rows } = await sql.read(db, t, cursor, isolate > 0 ? 1 : batchSize, def.types)
        if (rows.length === 0) {
          const c = advanceTo(cursor, view)
          if (encodeCursor(c) !== encodeCursor(cursor)) await commit(c)
          else await wake.wait()
          continue
        }
        const batch = isolate > 0 ? rows.slice(0, 1) : rows
        await attempt(batch, view, batch.length === rows.length)
      }
    } finally {
      active = false
      clearInterval(heartbeat)
      stop.signal.removeEventListener('abort', onStop)
      if (!held.lost) await sql.release(db, t, s, token).catch(() => {})
    }
  }

  const loop = (async () => {
    const wake = waker(db, core.topicChannel(t), {
      pollMs,
      signal: stop.signal,
      onInternal: (e) => hooks.emit('onInternal', e),
    })
    while (!stop.signal.aborted) {
      try {
        await core.ready(def)
        const lease = await sql.lease(db, t, s, leaseMs)
        if (lease === undefined) await sleep(leaseMs / 2, stop.signal)
        else await serve(lease, wake)
      } catch (e) {
        if (e instanceof EventsLeaseLostError) continue
        hooks.internal('reader-failed', `@pg-prime/events: reader ${t}/${s} failed; retrying.`, e)
        await sleep(pollMs, stop.signal)
      }
    }
    await wake.close()
  })()

  const close = async (): Promise<void> => {
    stop.abort()
    await loop
    core.running.delete(reader)
  }
  const reader = {
    get active() {
      return active
    },
    close,
    [ASYNC_DISPOSE]: close,
  } as unknown as Reader
  core.running.add(reader)
  return reader
}
