import { describe, expect, it } from 'vitest'
import { UsageError, sql } from 'pg-prime'
import { defineQueue, pgMq } from '../../src/index.js'
import type { Message, OnFail, WorkContext, Worker } from '../../src/index.js'
import { freshSchema, until, useServer } from '../_db.js'

const server = useServer()
type P = { name: string; fail?: boolean }
const fast = { pollMs: 20, expireScanMs: 20, maintenanceMs: 20, concurrency: 4 }
const once = { retry: { maxAttempts: 1 } }

function setup() {
  const db = server.db()
  const schema = freshSchema()
  const mq = pgMq({ db, schema })
  const a = mq.queue(defineQueue<P, string>('a', once))
  const b = mq.queue(defineQueue<P, string>('b', { ...once, keep: { completed: false } }))
  const results = new Map<string, Record<string, unknown>>()
  const handler = async (m: Message<P>, ctx: WorkContext<P, string>) => {
    if (m.payload.fail === true) throw new Error(`${m.payload.name} failed`)
    results.set(m.payload.name, await ctx.childResults())
    return m.payload.name
  }
  const workers: Worker[] = [a.work(handler, fast), b.work(handler, fast)]
  const stop = () => Promise.all(workers.map((w) => w.close()))
  return { db, schema, mq, a, b, results, stop }
}

describe('flows (F1)', () => {
  it('three levels across queues: each parent runs once its children are done', async () => {
    const { mq, a, b, results, stop } = setup()
    const defA = defineQueue<P, string>('a', once)
    const defB = defineQueue<P, string>('b', once)
    const root = await mq.flow({
      queue: defA,
      payload: { name: 'root' },
      children: [
        {
          queue: defB,
          payload: { name: 'mid' },
          children: [{ queue: defA, payload: { name: 'leaf' } }],
        },
        { queue: defB, payload: { name: 'grouped' }, opts: { group: 'g1' } },
      ],
    })
    expect(root.children.map((c) => c.queue)).toStrictEqual(['b', 'b'])
    await until(async () => (await a.get(root))?.state === 'completed')
    await stop()
    const [mid, grouped] = root.children
    expect(results.get('root')).toStrictEqual({
      [`b:${mid?.id}`]: { status: 'completed', value: 'mid' },
      [`b:${grouped?.id}`]: { status: 'completed', value: 'grouped' },
    })
    expect(results.get('mid')).toStrictEqual({
      [`a:${mid?.children[0]?.id}`]: { status: 'completed', value: 'leaf' },
    })
    // b keeps no completed messages: the parent's results survived their deletion.
    expect(await b.get(mid as never)).toBeUndefined()
  })

  async function failingChild(onFail: OnFail) {
    const s = setup()
    const defA = defineQueue<P, string>('a', once)
    const root = await s.mq.flow({
      queue: defA,
      payload: { name: 'root' },
      children: [
        { queue: defA, payload: { name: 'bad', fail: true }, opts: { onFail } },
        { queue: defA, payload: { name: 'good' } },
      ],
    })
    await until(
      async () => (await s.a.counts()).failed === 1 && (await s.a.counts()).completed >= 1,
    )
    return { ...s, root }
  }

  it("onFail 'wait': the parent stays blocked and sees the failure", async () => {
    const { a, root, stop } = await failingChild('wait')
    await new Promise((r) => setTimeout(r, 100))
    expect((await a.get(root))?.state).toBe('blocked')
    await a.cancel(root)
    await stop()
    // A finished parent whose child failed is refused: retry the child first.
    await expect(a.retry({ ids: [root.id] })).rejects.toBeInstanceOf(UsageError)
    expect(await a.retry({ state: 'cancelled' })).toBe(0)
  })

  it("onFail 'ignore': the parent is released", async () => {
    const { a, root, stop, results } = await failingChild('ignore')
    await until(async () => (await a.get(root))?.state === 'completed')
    await stop()
    const bad = root.children[0]?.id
    expect(results.get('root')?.[`a:${bad}`]).toStrictEqual({ status: 'ignored' })
  })

  it("onFail 'fail': the parent fails, and the failure climbs while the policy is 'fail'", async () => {
    const s = setup()
    const defA = defineQueue<P, string>('a', once)
    const root = await s.mq.flow({
      queue: defA,
      payload: { name: 'root' },
      opts: { key: 'r', dedup: 'until-done' },
      children: [
        {
          queue: defA,
          payload: { name: 'mid' },
          opts: { onFail: 'fail' },
          children: [
            { queue: defA, payload: { name: 'bad', fail: true }, opts: { onFail: 'fail' } },
          ],
        },
      ],
    })
    await until(async () => (await s.a.get(root))?.state === 'failed')
    await s.stop()
    const mid = root.children[0] as (typeof root.children)[number]
    expect((await s.a.get(mid))?.error).toBe(`child a:${mid.children[0]?.id} failed`)
    expect((await s.a.get(root))?.error).toBe(`child a:${mid.id} failed`)
    // The cascade-failed root released its dedup key.
    const again = await s.mq.flow({
      queue: defA,
      payload: { name: 'again' },
      opts: { key: 'r', dedup: 'until-done' },
    })
    expect(again.deduplicated).toBe(false)
  })

  it('retry of a failed wait child releases its parent once', async () => {
    const s = setup()
    const defA = defineQueue<P, string>('a', once)
    let runs = 0
    const flakyDef = defineQueue<{ n: number }, string>('flaky', once)
    const flaky = s.mq.queue(flakyDef)
    const w = flaky.work(async () => {
      if (++runs === 1) throw new Error('first time')
      return 'ok'
    }, fast)
    const root = await s.mq.flow({
      queue: defA,
      payload: { name: 'root' },
      children: [{ queue: flakyDef, payload: { n: 1 } }],
    })
    await until(async () => (await flaky.counts()).failed === 1)
    expect((await s.a.get(root))?.state).toBe('blocked')
    expect(await flaky.retry({ state: 'failed' })).toBe(1)
    await until(async () => (await s.a.get(root))?.state === 'completed')
    await w.close()
    await s.stop()
    expect(s.results.get('root')).toStrictEqual({
      [`flaky:${root.children[0]?.id}`]: { status: 'completed', value: 'ok' },
    })
    expect((await s.a.get(root))?.claims).toBe(1)
  })

  it('a deduplicated root inserts nothing; dedup on a child or in spawn is refused', async () => {
    const { db, schema, mq, stop } = setup()
    await stop()
    const defA = defineQueue<P, string>('a', once)
    const tree = {
      queue: defA,
      payload: { name: 'r' },
      opts: { key: 'k', dedup: 'until-done' as const },
      children: [{ queue: defA, payload: { name: 'c' } }],
    }
    const first = await mq.flow(tree)
    const second = await mq.flow(tree)
    expect(second).toStrictEqual({ queue: 'a', id: first.id, deduplicated: true, children: [] })
    const [c] =
      await db.sql`select count(*)::int as n from ${sql.ident(schema, 'messages')}`.execute()
    expect(c?.['n']).toBe(2)
    await expect(
      mq.flow({
        queue: defA,
        payload: { name: 'r' },
        children: [{ queue: defA, payload: { name: 'c' }, opts: { key: 'x' } as never }],
      }),
    ).rejects.toBeInstanceOf(UsageError)
  })

  it('a dedup winner that finishes between the two statements: the flow is sent again', async () => {
    const db = server.db()
    const schema = freshSchema()
    const defA = defineQueue<P, string>('a', once)
    const plain = pgMq({ db, schema }).queue(defA)
    let raced = false
    // After the flow's insert, the key's holder completes before its owner is read.
    const racing = new Proxy(db, {
      get(o, k) {
        if (k !== 'withOptions') {
          const v = Reflect.get(o, k)
          return typeof v === 'function' ? v.bind(o) : v
        }
        return (opts: { label: string }) => {
          const q = o.withOptions(opts)
          if (opts.label !== 'mq.flow' || raced) return q
          raced = true
          return {
            sql: (s: TemplateStringsArray, ...v: unknown[]) => ({
              execute: async () => {
                const rows = await q.sql(s, ...v).execute()
                const [m] = (await plain.claim()) as [Message<P>]
                await plain.complete(m, 'done')
                return rows
              },
            }),
          }
        }
      },
    })
    const opts = { key: 'k', dedup: 'until-done' as const }
    const first = await plain.send({ name: 'first' }, opts)
    const ref = await pgMq({ db: racing, schema }).flow({ queue: defA, payload: { name: 'x' }, opts })
    expect(raced).toBe(true)
    expect(ref.deduplicated).toBe(false)
    expect((await plain.get(ref))?.payload).toStrictEqual({ name: 'x' })
    expect(ref.id).not.toBe(first.id)
  })
})

describe('spawn and waitForChildren', () => {
  it('a parent spawns children, waits, then runs again with their results', async () => {
    const db = server.db()
    const mq = pgMq({ db, schema: freshSchema() })
    const parentDef = defineQueue<{ n: number }, number>('parent')
    const childDef = defineQueue<{ n: number }, number>('child')
    const parent = mq.queue(parentDef)
    const child = mq.queue(childDef)
    let runs = 0
    let refused: unknown
    const wp = parent.work(
      async (m, ctx) => {
        runs++
        const done = await ctx.childResults()
        if (Object.keys(done).length === 0) {
          for (let i = 1; i <= 3; i++) await ctx.spawn(childDef, { n: i })
          await ctx
            .spawn(childDef, { n: 0 }, { key: 'no' } as never)
            .catch((e: unknown) => (refused = e))
          return ctx.waitForChildren()
        }
        return Object.values(done).reduce((s, d) => s + (d.value as number), 0)
      },
      { pollMs: 20 },
    )
    const wc = child.work(async (m) => m.payload.n * 10, { pollMs: 20, concurrency: 3 })
    const ref = await parent.send({ n: 0 })
    await until(async () => (await parent.get(ref))?.state === 'completed')
    await Promise.all([wp.close(), wc.close()])
    expect([(await parent.get(ref))?.result, runs]).toStrictEqual([60, 2])
    expect(refused).toBeInstanceOf(UsageError)
  })

  it('waitForChildren with nothing pending runs the handler again', async () => {
    const db = server.db()
    const q = pgMq({ db, schema: freshSchema() }).queue(defineQueue<{ n: number }, number>('p'))
    let runs = 0
    const w = q.work(async (_m, ctx) => (++runs === 1 ? ctx.waitForChildren() : runs), {
      pollMs: 20,
    })
    const ref = await q.send({ n: 1 })
    await until(async () => (await q.get(ref))?.state === 'completed')
    await w.close()
    expect([runs, (await q.get(ref))?.attempts]).toStrictEqual([2, 1])
  })
})
