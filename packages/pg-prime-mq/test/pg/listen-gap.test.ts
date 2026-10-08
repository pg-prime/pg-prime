import { describe, expect, it } from 'vitest'
import { engineChannel } from '@pg-prime/events'
import { requiresConcurrency } from '@pg-prime/testing'
import { defineQueue, pgMq } from '../../src/index.js'
import { freshSchema, p95, sleep, until, useServer } from '../_db.js'

const server = useServer()
const test = requiresConcurrency(it)
// No dev-mode startup pooler probe: it holds the pool for a few hundred ms and skews latencies.
const quiet = { devGuard: false }
type P = { n: number; at: number }

describe('wake-ups', () => {
  test('a NOTIFY wakes an idle worker: p95 < 100 ms with pollMs: 5000', async () => {
    const schema = freshSchema()
    const def = defineQueue<P>('wake')
    const worker = pgMq({ db: server.db(3, quiet), schema })
    const producer = pgMq({ db: server.db(1, quiet), schema }).queue(def)
    const latency: number[] = []
    const w = worker.queue(def).work(async (m) => void latency.push(Date.now() - m.payload.at), {
      pollMs: 5000,
    })
    await producer.start()
    await sleep(500)
    for (let n = 0; n < 50; n++) {
      await producer.send({ n, at: Date.now() })
      await sleep(40)
    }
    await until(() => latency.length === 50)
    await w.close()
    expect(p95(latency)).toBeLessThan(100)
  }, 60_000)

  test('a LISTEN gap triggers a claim long before pollMs', async () => {
    const schema = freshSchema()
    const def = defineQueue<P>('gap')
    const db = server.db(3, quiet)
    const seen: number[] = []
    const w = pgMq({ db, schema })
      .queue(def)
      .work(async (m) => void seen.push(m.payload.n), { pollMs: 60_000 })
    const admin = server.db(1, quiet)
    const listen = `listen "${engineChannel(schema, 'q', 'gap')}"`
    const kill = () =>
      admin.sql`select pg_terminate_backend(pid) as ok from pg_stat_activity
        where datname = current_database() and query = ${listen}`.execute()
    await until(async () => (await kill()).length === 1)
    const at = Date.now()
    await pgMq({ db: admin, schema }).queue(def).send({ n: 1, at })
    await until(() => seen.length === 1, 30_000)
    await w.close()
    expect(Date.now() - at).toBeLessThan(30_000)
  }, 60_000)
})

describe('result() across processes', () => {
  const def = defineQueue<P, number>('watched', { watch: true })

  test('resolves within 100 ms of the completion, and by polling when NOTIFY is unavailable', async () => {
    const schema = freshSchema()
    const a = pgMq({ db: server.db(3, quiet), schema }).queue(def)
    const polling = pgMq({
      db: server.db(2, { ...quiet, poolerMode: 'transaction' }),
      schema,
    }).queue(def)
    let doneAt = 0
    const b = pgMq({ db: server.db(3, quiet), schema })
      .queue(def)
      .work(
        async (m) => {
          await sleep(200)
          doneAt = Date.now()
          return m.payload.n * 2
        },
        { pollMs: 50 },
      )
    const ref = await a.send({ n: 21, at: 0 })
    expect(await a.result(ref)).toBe(42)
    expect(Date.now() - doneAt).toBeLessThan(100)

    const second = await a.send({ n: 1, at: 0 })
    const t0 = Date.now()
    expect(await polling.result(second, { pollMs: 300 })).toBe(2)
    expect(Date.now() - t0).toBeLessThan(200 + 300 + 500)
    await b.close()
  }, 30_000)

  test('watch() streams transitions from every process', async () => {
    const schema = freshSchema()
    const watcher = pgMq({ db: server.db(2, quiet), schema }).queue(def)
    const seen: string[] = []
    const sub = await watcher.watch((e) => void seen.push(e.state))
    const b = pgMq({ db: server.db(3, quiet), schema }).queue(def)
    const w = b.work(async () => 1, { pollMs: 50 })
    await b.send({ n: 1, at: 0 })
    await until(() => seen.includes('completed'))
    await Promise.all([w.close(), sub.close()])
    expect(seen).toStrictEqual(['ready', 'active', 'completed'])
  }, 30_000)
})
