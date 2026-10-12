import { compileOnly, defineSchema } from 'pg-prime'
import type { Db, Queryable, RawRow, Subscription } from 'pg-prime'

type Handler = (payload: string) => void

/** A `Db` with just `notify` and `listen`, whose notifications and gaps the test raises. */
export function fakeDb(listen?: () => Promise<void>) {
  const subs: { channel: string; handler: Handler; on: Map<string, Set<(x: unknown) => void>> }[] =
    []
  const notified: [string, string][] = []
  let closed = 0
  const db = {
    notify: async (channel: string, payload: string) => void notified.push([channel, payload]),
    listen: async (channel: string, handler: Handler) => {
      await listen?.()
      const s = { channel, handler, on: new Map<string, Set<(x: unknown) => void>>() }
      subs.push(s)
      return {
        channel,
        close: async () => {
          closed++
          subs.splice(subs.indexOf(s), 1)
        },
        on: (event: string, h: (x: unknown) => void) => {
          const set = s.on.get(event) ?? new Set()
          set.add(h)
          s.on.set(event, set)
          return () => set.delete(h)
        },
      } as unknown as Subscription
    },
  } as unknown as Db
  const fire = (channel: string, event: string, info: unknown): void => {
    for (const s of subs.filter((x) => x.channel === channel)) {
      for (const h of s.on.get(event) ?? []) h(info)
    }
  }
  return {
    db,
    notified,
    closed: () => closed,
    listening: () => subs.length,
    deliver: (channel: string, payload: string) => {
      for (const s of subs.filter((x) => x.channel === channel)) s.handler(payload)
    },
    gap: (channel: string) => fire(channel, 'gap', { downMs: 5 }),
    error: (channel: string, e: unknown) => fire(channel, 'error', e),
  }
}

/** A `Queryable` that compiles each statement, records it, and answers from `answers`. */
export function recorder(answers: RawRow[][] = []) {
  const base = compileOnly(defineSchema({}))
  const seen: { label: string; sql: string; params: readonly unknown[] }[] = []
  const q = {
    withOptions: ({ label }: { label: string }) => ({
      sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
        const snap = base.sql(strings, ...values).toSQL()
        return {
          execute: async () => {
            seen.push({ label, sql: snap.sql, params: snap.params })
            return answers.shift() ?? []
          },
        }
      },
    }),
  } as unknown as Queryable<any>
  return { q, seen }
}
