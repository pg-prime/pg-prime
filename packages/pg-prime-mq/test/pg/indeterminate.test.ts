import { createServer, connect } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { IndeterminateCommitError, sql } from 'pg-prime'
import { requiresConcurrency } from '@pg-prime/testing'
import { defineQueue, pgMq } from '../../src/index.js'
import { freshSchema, until, useServer } from '../_db.js'

const server = useServer()
type Cut = 'before' | 'after'

/** A TCP proxy that, when armed, drops the connection carrying the next `commit` (pg-prime sends it as a simple query): before or after the server sees it. */
async function commitCutter(
  target: URL,
): Promise<{ url: string; arm(c: Cut): void; close(): Promise<void> }> {
  let armed: Cut | undefined
  const sockets = new Set<Socket>()
  const proxy: Server = createServer((client) => {
    const upstream = connect(Number(target.port || 5432), target.hostname)
    sockets.add(client).add(upstream)
    let cutOnReply = false
    const cut = () => {
      client.destroy()
      upstream.destroy()
    }
    client.on('data', (d: Buffer) => {
      if (armed !== undefined && d.includes('commit\0')) {
        const how = armed
        armed = undefined
        if (how === 'before') return cut()
        cutOnReply = true
      }
      upstream.write(d)
    })
    upstream.on('data', (d: Buffer) => (cutOnReply ? cut() : client.write(d)))
    for (const s of [client, upstream]) {
      s.on('error', () => {})
      s.on('close', () => {
        sockets.delete(s)
        cut()
      })
    }
  })
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
  const via = new URL(target)
  via.hostname = '127.0.0.1'
  via.port = String((proxy.address() as AddressInfo).port)
  return {
    url: via.toString(),
    arm: (c) => void (armed = c),
    close: () => {
      for (const s of sockets) s.destroy()
      return new Promise((r) => proxy.close(() => r()))
    },
  }
}

describe('indeterminate in-transaction completion', () => {
  requiresConcurrency(it)(
    'the connection is cut during ctx.transaction’s COMMIT: rolled back re-runs, committed completes once',
    async () => {
      const cutter = await commitCutter(new URL(server.url()))
      const schema = freshSchema()
      const def = defineQueue<{ n: number }, number>('ind', {
        retry: { maxAttempts: 5, baseDelayMs: 1 },
      })
      const admin = server.db(2)
      const setup = pgMq({ db: admin, schema })
      await setup.start()
      const sink = sql.ident(schema, 'sink')
      await admin.sql`create table ${sink} (n int primary key)`.execute()
      const q = setup.queue(def)
      await q.sendMany(Array.from({ length: 20 }, (_, n) => ({ payload: { n } })))

      const db = server.db(3, { connection: cutter.url, devGuard: false })
      const mq = pgMq({ db, schema })
      const errors: unknown[] = []
      mq.observe({ onSettle: (e) => void (e.error !== undefined && errors.push(e.error)) })
      const runs = new Map<number, number>()
      const w = mq.queue(def).work(
        (m, ctx) =>
          ctx.transaction(async (tx) => {
            const n = m.payload.n
            runs.set(n, (runs.get(n) ?? 0) + 1)
            await tx.sql`insert into ${sink} values (${n})`.execute()
            if (runs.get(n) === 1) cutter.arm(n % 2 === 0 ? 'before' : 'after')
            return n
          }),
        { pollMs: 50, maintenanceMs: 600_000, expireScanMs: 600_000 },
      )
      await until(async () => (await q.counts()).completed === 20, 60_000)
      await w.close()
      await cutter.close()

      const rows = await admin.sql`select count(*)::int as n from ${sink}`.execute()
      expect(rows[0]?.['n']).toBe(20)
      expect(errors).toHaveLength(20)
      for (const e of errors) expect(e).toBeInstanceOf(IndeterminateCommitError)
      for (const m of await q.list({ limit: 20 })) {
        const rolledBack = m.payload.n % 2 === 0
        expect([m.payload.n, runs.get(m.payload.n), m.attempts]).toStrictEqual(
          rolledBack ? [m.payload.n, 2, 2] : [m.payload.n, 1, 1],
        )
      }
    },
    90_000,
  )
})
