import { describe, expect, it } from 'vitest'
import { requiresConcurrency } from '@pg-prime/testing'
import { defineChannel, pgEvents, waker } from '../../src/index.js'
import { until, useServer } from '../_db.js'

const server = useServer()

describe('channels across sessions', () => {
  requiresConcurrency(it)(
    'two listeners and two wakers on one channel all see gap when the LISTEN backend dies',
    async () => {
      const name = `ev_gap_${process.pid}`
      const ping = defineChannel<{ n: number }>(name)
      const db = server.db(2)
      const events = pgEvents({ db, define: { channels: { ping } } })
      const sender = pgEvents({ db: server.db(1), define: { channels: { ping } } })
      const got = { a: [] as number[], b: [] as number[] }
      const gaps: string[] = []
      const a = await events.channels.ping.listen((p) => void got.a.push(p.n), {
        onGap: () => void gaps.push('a'),
      })
      const b = await events.channels.ping.listen((p) => void got.b.push(p.n), {
        onGap: () => void gaps.push('b'),
      })
      const wakes = [waker(db, name, { pollMs: 60_000 }), waker(db, name, { pollMs: 60_000 })]
      for (const w of wakes) expect(await w.wait()).toBe('gap')

      await sender.channels.ping.notify({ n: 1 })
      await until(() => got.a.length === 1 && got.b.length === 1)
      for (const w of wakes) expect(await w.wait()).toBe('notify')

      const killed = await server.db(1).sql`select pg_terminate_backend(pid) as ok
        from pg_stat_activity where datname = current_database() and query = ${`listen "${name}"`}`.execute()
      expect(killed).toStrictEqual([{ ok: true }])
      await until(() => gaps.length === 2, 20_000)
      expect(gaps.sort()).toStrictEqual(['a', 'b'])
      for (const w of wakes) expect(await w.wait()).toBe('gap')

      await sender.channels.ping.notify({ n: 2 })
      await until(() => got.a.length === 2 && got.b.length === 2)
      expect(got).toStrictEqual({ a: [1, 2], b: [1, 2] })
      await Promise.all([a.close(), b.close(), ...wakes.map((w) => w.close())])
    },
    60_000,
  )
})
