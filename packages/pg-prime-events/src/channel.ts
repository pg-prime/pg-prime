import { createHash } from 'node:crypto'
import { sql } from 'pg-prime'
import type { Db, Fragment, Queryable, Subscription } from 'pg-prime'
import type { ChannelDef } from './define.js'
import { decodePayload, encodePayload } from './payload.js'
import { ASYNC_DISPOSE, emitAll } from './util.js'

/** `ev_` + 24 hex chars of `sha256(schema/kind/name)`: fixed length, unique per schema. */
export function engineChannel(schema: string, kind: string, name: string): string {
  return `ev_${createHash('sha256').update(`${schema}/${kind}/${name}`).digest('hex').slice(0, 24)}`
}

/** {@link engineChannel} computed in SQL, for a name only the statement knows. */
export function engineChannelSql(
  schema: string,
  kind: string,
  name: Fragment<unknown>,
): Fragment<unknown> {
  const prefix = `${schema}/${kind}/`
  return sql`('ev_' || left(encode(sha256(convert_to(${prefix}::text || (${name})::text, 'UTF8')), 'hex'), 24))`
}

export interface ChannelHandle<T> {
  notify(payload: T, opts?: { tx?: Queryable<any> }): Promise<void>
  listen(
    handler: (payload: T) => void,
    opts?: { signal?: AbortSignal; onGap?: (e: { downMs: number }) => void },
  ): Promise<Subscription>
}

export function channelHandle<T>(db: Db, def: ChannelDef<T>): ChannelHandle<T> {
  return {
    async notify(payload, opts) {
      // db.notify enforces PostgreSQL's 8000-byte limit itself.
      await (opts?.tx ?? db).notify(def.name, await encodePayload(def.payload, payload, Infinity))
    },
    async listen(handler, opts) {
      const errors = new Set<(e: unknown) => void>()
      const fail = (e: unknown): void => emitAll(errors, e)
      const inner = await db.listen(
        def.name,
        (raw) => {
          let wire: unknown
          try {
            wire = JSON.parse(raw)
          } catch (e) {
            return fail(e)
          }
          decodePayload(def.payload, wire).then(handler).catch(fail)
        },
        opts?.signal === undefined ? {} : { signal: opts.signal },
      )
      inner.on('error', fail)
      if (opts?.onGap !== undefined) inner.on('gap', opts.onGap)
      const on = (event: string, h: (info: any) => void): (() => void) => {
        if (event !== 'error') return inner.on(event as 'gap', h)
        errors.add(h)
        return () => void errors.delete(h)
      }
      return {
        channel: inner.channel,
        close: () => inner.close(),
        [ASYNC_DISPOSE]: () => inner.close(),
        on,
      } as unknown as Subscription
    },
  }
}
