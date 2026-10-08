import type { Queryable, Subscription } from 'pg-prime'
import type { TopicDef } from '../define.js'
import type { Core } from '../events.js'
import { decodePayload, encodePayload } from '../payload.js'
import { ASYNC_DISPOSE, emitAll } from '../util.js'
import { waker } from '../waker.js'
import { advance, advanceTo, decodeCursor, encodeCursor, seed } from './cursor.js'
import type { EntryRow } from './sql.js'

export interface Entry<T> {
  readonly id: bigint
  readonly topic: string
  readonly type: string | null
  readonly key: string | null
  readonly payload: T
  readonly headers: Record<string, string> | null
  readonly at: Date
  /** The opaque cursor state right after this entry: the only valid resume handle. */
  readonly cursor: string
}

export interface PublishOptions {
  tx?: Queryable<any>
  type?: string
  key?: string
  headers?: Record<string, string>
}

export interface TopicHandle<T> {
  publish(payload: T, opts?: PublishOptions): Promise<{ id: bigint }>
  publishMany(
    items: readonly ({ payload: T } & Omit<PublishOptions, 'tx'>)[],
    opts?: { tx?: Queryable<any> },
  ): Promise<{ id: bigint }[]>
  tail(
    handler: (e: Entry<T>) => void,
    opts?: { from?: 'now' | { after: string }; signal?: AbortSignal; pollMs?: number },
  ): Promise<Subscription>
  /** Browse by id for admin tools; not a resume handle. */
  read(opts?: { afterId?: bigint; limit?: number }): Promise<Omit<Entry<T>, 'cursor'>[]>
}

export async function entryOf<T>(def: TopicDef<T>, r: EntryRow): Promise<Omit<Entry<T>, 'cursor'>> {
  return {
    id: r.id,
    topic: def.name,
    type: r.type,
    key: r.key,
    payload: await decodePayload(def.payload, r.payload),
    headers: r.headers,
    at: r.at,
  }
}

const TAIL_BATCH = 500

export function topicHandle<T>(core: Core, def: TopicDef<T>): TopicHandle<T> {
  const channel = core.topicChannel(def.name)
  const handle: TopicHandle<T> = {
    async publish(payload, opts = {}) {
      const { tx, ...item } = opts
      const [r] = await handle.publishMany([{ payload, ...item }], tx === undefined ? {} : { tx })
      return r as { id: bigint }
    },

    async publishMany(items, opts = {}) {
      if (opts.tx === undefined) await core.ready(def)
      else core.assertStarted('publish')
      if (items.length === 0) return []
      const rows = await Promise.all(
        items.map(async (i) => ({
          type: i.type ?? null,
          key: i.key ?? null,
          headers: i.headers ?? null,
          payload: await encodePayload(def.payload, i.payload),
        })),
      )
      const ids = await core.sql.publish(opts.tx ?? core.db, def.name, channel, rows)
      core.hooks.emit('onPublish', {
        topic: def.name,
        count: ids.length,
        inTx: opts.tx !== undefined,
      })
      return ids.map((id) => ({ id }))
    },

    async tail(handler, opts = {}) {
      await core.ready(def)
      const from = opts.from ?? 'now'
      let cursor =
        from === 'now'
          ? await core.sql.seedNow(core.db).then((s) => seed(s.xmax, s.xip))
          : decodeCursor(from.after)
      const errors = new Set<(e: unknown) => void>()
      const fail = (e: unknown): void => emitAll(errors, e)
      const stop = new AbortController()
      opts.signal?.addEventListener('abort', () => stop.abort(), { once: true })
      if (opts.signal?.aborted === true) stop.abort()
      const wake = waker(core.db, channel, {
        pollMs: opts.pollMs ?? 5000,
        signal: stop.signal,
        onInternal: (e) => core.hooks.emit('onInternal', e),
      })
      const loop = (async () => {
        do {
          try {
            while (!stop.signal.aborted) {
              const { view, rows } = await core.sql.read(
                core.db,
                def.name,
                cursor,
                TAIL_BATCH,
                null,
              )
              for (const r of rows) {
                cursor = advance(cursor, view, r)
                try {
                  handler({ ...(await entryOf(def, r)), cursor: encodeCursor(cursor) })
                } catch (e) {
                  fail(e)
                }
              }
              cursor = advanceTo(cursor, view)
              if (view.pos === null && view.late === null) break
            }
          } catch (e) {
            fail(e)
          }
        } while ((await wake.wait()) !== undefined)
      })()
      const close = async (): Promise<void> => {
        stop.abort()
        await loop
        core.running.delete(sub)
      }
      // Tails heal gaps from the log, so only 'error' ever fires.
      const on = (event: string, h: (e: unknown) => void): (() => void) => {
        if (event !== 'error') return () => {}
        errors.add(h)
        return () => void errors.delete(h)
      }
      const sub = { channel, close, [ASYNC_DISPOSE]: close, on } as unknown as Subscription
      core.running.add(sub)
      return sub
    },

    async read(opts = {}) {
      await core.ready(def)
      const rows = await core.sql.browse(core.db, def.name, opts.afterId ?? 0n, opts.limit ?? 100)
      return Promise.all(rows.map((r) => entryOf(def, r)))
    },
  }
  return handle
}
