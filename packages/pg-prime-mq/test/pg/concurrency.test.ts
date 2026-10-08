import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sql } from 'pg-prime'
import type { Db } from 'pg-prime'
import { requiresConcurrency } from '@pg-prime/testing'
import { defineQueue, pgMq } from '../../src/index.js'
import type { Mq, Worker } from '../../src/index.js'
import { claimGroups } from '../../src/sql/claim.js'
import { reconcileGroups, reconcileQueue } from '../../src/sql/maintain.js'
import { finish } from '../../src/sql/settle.js'
import { tables } from '../../src/sql/tables.js'
import { freshSchema, p95, sleep, until, useServer } from '../_db.js'

const server = useServer()
const test = requiresConcurrency(it)
type P = { n: number; g?: string }

/** `count` mq instances on one schema, each on its own pool. */
function fleet(schema: string, count: number, max: number): { db: Db; mq: Mq<{}> }[] {
  return Array.from({ length: count }, () => {
    const db = server.db(max, { devGuard: false })
    return { db, mq: pgMq({ db, schema }) }
  })
}

const count = async (db: Db, q: string): Promise<number> =>
  ((await db.sql`${sql.unsafeRaw(q)}`.execute())[0]?.['n'] as number | undefined) ?? -1

describe('the §10 tier-2 table', () => {
  test('two consumers never both own a message: 4 instances × 25, 20 000 messages', async () => {
    const schema = freshSchema()
    const def = defineQueue<P>('own', { retry: { maxAttempts: 1 } })
    const admin = server.db(2)
    const setup = pgMq({ db: admin, schema })
    await setup.start()
    const own = sql.ident(schema, 'own')
    await admin.sql`create table ${own} (id bigint primary key)`.execute()
    const q = setup.queue(def)
    for (let i = 0; i < 20; i++) {
      await q.sendMany(Array.from({ length: 1000 }, (_, n) => ({ payload: { n: i * 1000 + n } })))
    }
    let failed = 0
    const workers: Worker[] = fleet(schema, 4, 12).map(({ db, mq }) => {
      mq.observe({ onSettle: (e) => void (e.outcome !== 'completed' && failed++) })
      return mq
        .queue(def)
        .work(async (m) => void (await db.sql`insert into ${own} values (${m.id})`.execute()), {
          concurrency: 25,
          pollMs: 200,
        })
    })
    await until(async () => (await q.counts()).completed === 20_000, 110_000)
    await Promise.all(workers.map((w) => w.close()))
    expect(failed).toBe(0)
    expect(await count(admin, `select count(*)::int as n from ${schema}.own`)).toBe(20_000)
    expect(
      await count(admin, `select count(*)::int as n from ${schema}.messages where claims <> 1`),
    ).toBe(0)
  }, 120_000)

  test('an expired lease is recovered once: SIGKILL a worker, 3 live scanners', async () => {
    const schema = freshSchema()
    const def = defineQueue<P, number>('victim')
    const setup = pgMq({ db: server.db(2), schema })
    const q = setup.queue(def)
    const ref = await q.send({ n: 1 })
    const child = spawn(process.execPath, [await victim(), server.url(), schema], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    try {
      await new Promise<void>((res, rej) => {
        child.stdout.on('data', (d: Buffer) => d.toString().includes('running') && res())
        child.on('exit', (code) => rej(new Error(`victim exited early with ${code}`)))
      })
    } finally {
      child.kill('SIGKILL')
    }
    const expired: bigint[] = []
    const runs: number[] = []
    const workers = fleet(schema, 3, 3).map(({ mq }) => {
      mq.observe({ onLeaseExpired: (e) => void expired.push(...e.ids) })
      return mq.queue(def).work(async (_m, ctx) => (runs.push(ctx.attempt), 1), {
        pollMs: 50,
        expireScanMs: 100,
      })
    })
    await until(async () => (await q.get(ref))?.state === 'completed', 20_000)
    await sleep(300)
    await Promise.all(workers.map((w) => w.close()))
    expect(expired).toStrictEqual([ref.id])
    expect(runs).toStrictEqual([2])
    const m = await q.get(ref)
    expect([m?.attempts, m?.claims]).toStrictEqual([2, 2])
  }, 60_000)

  test('a parent is released once: 100 children, 8 workers', async () => {
    const schema = freshSchema()
    const parentDef = defineQueue<P, number>('parent')
    const childDef = defineQueue<P, number>('child')
    const setup = pgMq({ db: server.db(2), schema })
    const roots = []
    for (let i = 0; i < 3; i++) {
      roots.push(
        await setup.flow({
          queue: parentDef,
          payload: { n: i },
          children: Array.from({ length: 100 }, (_, n) => ({ queue: childDef, payload: { n } })),
        }),
      )
    }
    const parentRuns = new Map<bigint, number>()
    const fl = fleet(schema, 8, 4)
    const workers = fl.flatMap(({ mq }, i) => [
      mq.queue(childDef).work(async (m) => m.payload.n, { concurrency: 8, pollMs: 50 }),
      ...(i < 2
        ? [
            mq.queue(parentDef).work(
              async (m) => {
                parentRuns.set(m.id, (parentRuns.get(m.id) ?? 0) + 1)
                return 0
              },
              { pollMs: 50 },
            ),
          ]
        : []),
    ])
    const parents = setup.queue(parentDef)
    await until(async () => (await parents.counts()).completed === 3, 60_000)
    await Promise.all(workers.map((w) => w.close()))
    expect([...parentRuns.values()]).toStrictEqual([1, 1, 1])
    for (const r of roots) {
      const row = await setup.queue(parentDef).get(r)
      expect([row?.claims, row?.state]).toStrictEqual([1, 'completed'])
    }
    const db = server.db(1)
    expect(
      await count(db, `select count(*)::int as n from ${schema}.messages where pending_deps <> 0`),
    ).toBe(0)
  }, 90_000)

  test('a group concurrency of 1 is never exceeded: 8 workers, 50 groups × 40, FIFO per group', async () => {
    const schema = freshSchema()
    const def = defineQueue<P>('groups')
    const setup = pgMq({ db: server.db(2), schema })
    const q = setup.queue(def)
    const items = []
    for (let n = 0; n < 40; n++)
      for (let g = 0; g < 50; g++)
        items.push({ payload: { n, g: `g${g}` }, opts: { group: `g${g}` } })
    await q.sendMany(items)
    const log = new Map<string, { n: number; start: number; end: number }[]>()
    const workers = fleet(schema, 8, 4).map(({ mq }) =>
      mq.queue(def).work(
        async (m) => {
          const start = performance.now()
          await sleep(Math.random() * 2)
          const g = m.payload.g as string
          log.set(g, [...(log.get(g) ?? []), { n: m.payload.n, start, end: performance.now() }])
        },
        { concurrency: 10, pollMs: 50, group: { concurrency: 1 } },
      ),
    )
    await until(async () => (await q.counts()).completed === 2000, 90_000)
    await Promise.all(workers.map((w) => w.close()))
    for (const [g, runs] of log) {
      expect(
        runs.map((r) => r.n),
        g,
      ).toStrictEqual(Array.from({ length: 40 }, (_, n) => n))
      for (let i = 1; i < runs.length; i++)
        expect(runs[i]!.start, g).toBeGreaterThanOrEqual(runs[i - 1]!.end)
    }
  }, 120_000)

  test('global concurrency holds for grouped and ungrouped messages; active returns to 0', async () => {
    const schema = freshSchema()
    const def = defineQueue<P>('capped', { concurrency: 3 })
    const setup = pgMq({ db: server.db(2), schema })
    const q = setup.queue(def)
    await q.sendMany(
      Array.from({ length: 300 }, (_, n) => ({
        payload: { n },
        opts: n % 2 ? { group: `g${n % 7}` } : {},
      })),
    )
    let running = 0
    let worst = 0
    const workers = fleet(schema, 4, 4).map(({ mq }) =>
      mq.queue(def).work(
        async () => {
          worst = Math.max(worst, ++running)
          await sleep(Math.random() * 3)
          running--
        },
        { concurrency: 5, pollMs: 50 },
      ),
    )
    await until(async () => (await q.counts()).completed === 300, 60_000)
    await Promise.all(workers.map((w) => w.close()))
    expect(worst).toBeLessThanOrEqual(3)
    expect(worst).toBe(3)
    expect(await count(server.db(1), `select active as n from ${schema}.queues`)).toBe(0)
  }, 90_000)

  test('the global rate holds: at most 5 claims per database rate window', async () => {
    const schema = freshSchema()
    const perMs = 1000
    const def = defineQueue<P>('rated', { rate: { max: 5, perMs } })
    const setup = pgMq({ db: server.db(2), schema })
    const q = setup.queue(def)
    await q.sendMany(Array.from({ length: 30 }, (_, n) => ({ payload: { n } })))
    const claimedAt: number[] = []
    const leaseMs = 60_000
    const workers = fleet(schema, 4, 3).map(({ db, mq }) =>
      mq.queue(def).work(
        async (m) => {
          // lease_until − leaseMs is the claiming statement's now(): the rate window's clock.
          const [r] = await db.sql`select (extract(epoch from lease_until) * 1000)::float8 as l
            from ${sql.ident(schema, 'messages')} where id = ${m.id}`.execute()
          claimedAt.push((r?.['l'] as number) - leaseMs)
          await sleep(10 + Math.random() * 300)
        },
        { concurrency: 5, pollMs: 50, leaseMs, heartbeatMs: leaseMs },
      ),
    )
    await until(async () => (await q.counts()).completed === 30, 30_000)
    await Promise.all(workers.map((w) => w.close()))
    // A window opens at the claim that finds the last one spent (rate_window = its now()).
    const sorted = [...claimedAt].sort((a, b) => a - b)
    const windows: number[][] = []
    for (const c of sorted) {
      const w = windows.at(-1)
      if (w !== undefined && c < (w[0] as number) + perMs) w.push(c)
      else windows.push([c])
    }
    expect(windows.length).toBeGreaterThanOrEqual(6)
    for (const w of windows) expect(w.length).toBeLessThanOrEqual(5)
  }, 60_000)

  test('reconcile cannot over-book: lock-then-count looping while 4 workers claim under concurrency 2', async () => {
    const schema = freshSchema()
    const def = defineQueue<P>('recon', { concurrency: 2 })
    const admin = server.db(2)
    const setup = pgMq({ db: admin, schema })
    const q = setup.queue(def)
    await q.sendMany(
      Array.from({ length: 200 }, (_, n) => ({
        payload: { n },
        opts: n % 2 ? { group: 'g' } : {},
      })),
    )
    let running = 0
    let worst = 0
    const t = tables(schema)
    let stop = false
    const loop = (async () => {
      while (!stop) {
        await admin.transaction((tx) => reconcileQueue(tx, t, 'recon'))
        await admin.transaction((tx) => reconcileGroups(tx, t, 'recon'))
      }
    })()
    const workers = fleet(schema, 4, 4).map(({ mq }) =>
      mq.queue(def).work(
        async () => {
          worst = Math.max(worst, ++running)
          await sleep(Math.random() * 2)
          running--
        },
        { concurrency: 4, pollMs: 50, maintenanceMs: 1 },
      ),
    )
    await until(async () => (await q.counts()).completed === 200, 60_000)
    stop = true
    await loop
    await Promise.all(workers.map((w) => w.close()))
    expect(worst).toBe(2)
  }, 90_000)

  test('dedup under 50 concurrent sends, each mode: one message, 49 deduplicated to its id', async () => {
    const schema = freshSchema()
    const def = defineQueue<P>('dedup')
    const fl = fleet(schema, 2, 25)
    await fl[0]?.mq.start()
    const modes = ['until-done', { windowMs: 60_000 }, { windowMs: 60_000, extend: true }] as const
    for (const [i, dedup] of modes.entries()) {
      const refs = await Promise.all(
        Array.from({ length: 50 }, (_, n) =>
          fl[n % 2]!.mq.queue(def).send({ n }, { key: `k${i}`, dedup }),
        ),
      )
      const winners = refs.filter((r) => !r.deduplicated)
      expect(winners).toHaveLength(1)
      expect(new Set(refs.map((r) => r.id))).toStrictEqual(new Set([winners[0]?.id]))
    }
    expect((await fl[0]!.mq.queue(def).counts()).ready).toBe(3)
  }, 60_000)

  test('an active parent racing a failing fail-child always ends failed, never blocked (1 000 runs)', async () => {
    const schema = freshSchema()
    const parentDef = defineQueue<P>('p', { retry: { maxAttempts: 1 } })
    const childDef = defineQueue<P>('c', { retry: { maxAttempts: 1 } })
    const setup = pgMq({ db: server.db(2), schema })
    const parents = setup.queue(parentDef)
    await parents.sendMany(Array.from({ length: 1000 }, (_, n) => ({ payload: { n } })))
    const fl = fleet(schema, 4, 6)
    const workers = fl.flatMap(({ mq }) => [
      mq.queue(parentDef).work(
        async (m, ctx) => {
          if (ctx.attempt > 1 || m.claims > 1) return
          await ctx.spawn(childDef, { n: m.payload.n }, { onFail: 'fail' })
          await sleep(Math.random() * 4)
          return ctx.waitForChildren()
        },
        { concurrency: 10, pollMs: 50 },
      ),
      mq.queue(childDef).work(
        async () => {
          throw new Error('child fails')
        },
        { concurrency: 10, pollMs: 50 },
      ),
    ])
    await until(async () => {
      const c = await parents.counts()
      return c.failed + c.completed === 1000
    }, 90_000)
    await Promise.all(workers.map((w) => w.close()))
    const c = await parents.counts()
    expect([c.failed, c.blocked, c.completed]).toStrictEqual([1000, 0, 0])
  }, 120_000)

  test('a heartbeat is not blocked by a row held in an open transaction', async () => {
    const schema = freshSchema()
    const def = defineQueue<P, number>('held')
    const db = server.db(6)
    const mq = pgMq({ db, schema })
    const q = mq.queue(def)
    await q.sendMany([0, 1, 2].map((n) => ({ payload: { n } })))
    const leaseMs = 600
    const lost: string[] = []
    mq.observe({ onInternal: (e) => void lost.push(e.kind) })
    let holding = false
    const w = q.work(
      async (m, ctx) => {
        if (m.payload.n !== 0) return (await sleep(4 * leaseMs), m.payload.n)
        // The row stays locked while it is still in the heartbeat set, then completes in the same tx.
        return db.transaction(async (tx) => {
          await tx.sql`select 1 from ${sql.ident(schema, 'messages')} where id = ${m.id} for update`.execute()
          holding = true
          await sleep(3 * leaseMs)
          await ctx.complete(0, { tx })
          return 0
        })
      },
      { concurrency: 3, leaseMs, pollMs: 50 },
    )
    await until(async () => holding && (await q.counts()).active === 3)
    // A second worker scans for expired leases; nothing is left for it to claim.
    const scanner = pgMq({ db: server.db(2), schema })
      .queue(def)
      .work(async () => 0, { pollMs: 50, expireScanMs: 50 })
    await sleep(2 * leaseMs)
    const stale = await count(
      server.db(1),
      `select count(*)::int as n from ${schema}.messages where state = 'active' and lease_until < now()
         and payload->>'n' <> '0'`,
    )
    expect(stale).toBe(0)
    await until(async () => (await q.counts()).completed === 3, 20_000)
    await Promise.all([w.close(), scanner.close()])
    expect(lost.filter((k) => k === 'lease-lost')).toStrictEqual([])
    for (const m of await q.list()) expect([m.attempts, m.claims]).toStrictEqual([1, 1])
  }, 30_000)

  test('a heartbeat keeps a 3 × leaseMs handler; a lost lease aborts its handler and the new owner completes it', async () => {
    const schema = freshSchema()
    const def = defineQueue<P, string>('beat')
    const leaseMs = 400
    const [a, b] = fleet(schema, 2, 3)
    const q = a!.mq.queue(def)
    const slow = await q.send({ n: 1 })
    const stolen = await q.send({ n: 2 })
    let abortReason: unknown
    const ran: string[] = []
    const wa = q.work(
      async (m, ctx) => {
        if (m.payload.n === 1) return (await sleep(3 * leaseMs), 'slow')
        await new Promise((r) => ctx.signal.addEventListener('abort', r))
        abortReason = ctx.signal.reason
        ran.push('first')
        return 'first'
      },
      { concurrency: 2, leaseMs, pollMs: 50, expireScanMs: 60_000 },
    )
    await until(async () => (await q.get(stolen))?.state === 'active')
    // Another owner holds the message now; this worker's heartbeat must notice.
    await a!.db
      .sql`update ${sql.ident(schema, 'messages')} set token = 'thief', lease_until = now() - interval '1 s'
      where id = ${stolen.id}`.execute()
    await until(() => abortReason !== undefined, 10_000)
    await wa.close()
    const wb = b!.mq
      .queue(def)
      .work(async () => (ran.push('second'), 'second'), { pollMs: 50, expireScanMs: 50 })
    await until(async () => (await q.counts()).completed === 2, 20_000)
    await wb.close()
    expect((await q.get(slow))?.attempts).toBe(1)
    expect((abortReason as Error).name).toBe('LeaseLostError')
    expect((await q.get(stolen))?.result).toBe('second')
    expect(ran.sort()).toStrictEqual(['first', 'second'])
  }, 30_000)

  test('a transactional send is invisible, and wakes nobody, until it commits', async () => {
    const schema = freshSchema()
    const def = defineQueue<P>('txsend')
    const db = server.db(3, { devGuard: false })
    const mq = pgMq({ db, schema })
    await mq.start()
    const q = mq.queue(def)
    const seen: number[] = []
    const other = pgMq({ db: server.db(3, { devGuard: false }), schema })
    const w = other.queue(def).work(async (m) => void seen.push(m.payload.n), { pollMs: 60_000 })
    await sleep(300)
    let release: (() => void) | undefined
    const held = db.transaction(async (tx) => {
      await q.send({ n: 1 }, { tx })
      await new Promise<void>((r) => (release = r))
    })
    await until(() => release !== undefined)
    await sleep(300)
    expect(seen).toStrictEqual([])
    expect((await other.queue(def).counts()).ready).toBe(0)
    const committed = performance.now()
    release?.()
    await held
    await until(() => seen.length === 1, 5000)
    await w.close()
    expect(performance.now() - committed).toBeLessThan(1000)
  }, 30_000)

  test('a claim on the hot group stays fast beside 10 000 idle groups (p95 < 5 ms)', async () => {
    const schema = freshSchema()
    const def = defineQueue<P>('wide')
    const db = server.db(2, { devGuard: false })
    const mq = pgMq({ db, schema })
    const q = mq.queue(def)
    await q.start()
    const groups = sql.ident(schema, 'groups')
    await db.sql`insert into ${groups} (queue, key) select 'wide', 'idle' || i from generate_series(1, 10000) i`.execute()
    await q.sendMany(
      Array.from({ length: 200 }, (_, n) => ({ payload: { n }, opts: { group: 'hot' } })),
    )
    await db.sql`analyze ${sql.ident(schema, 'messages')}`.execute()
    const t = tables(schema)
    const o = {
      queue: 'wide',
      n: 1,
      leaseMs: 30_000,
      token: null,
      consumer: 'bench',
      limited: false,
    }
    const took: number[] = []
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now()
      const r = await claimGroups(db, t, o, { after: '', scan: 4, concurrency: 1, rate: undefined })
      took.push(performance.now() - t0)
      const m = r.rows[0]
      if (m !== undefined)
        await finish(db, t, {
          id: m.id,
          to: 'completed',
          guard: { kind: 'token', token: m.token as string },
        })
    }
    expect(p95(took)).toBeLessThan(5)
  }, 60_000)
})

// Claims a message, says so, then hangs until killed.
const VICTIM = `
import { defineSchema, pgPrime } from 'pg-prime'
import { defineQueue, pgMq } from '../../src/index.js'
const [url, schema] = process.argv.slice(2)
const db = pgPrime({ connection: url, schema: defineSchema({}) })
pgMq({ db, schema }).queue(defineQueue('victim')).work(
  () => (console.log('running'), new Promise(() => {})),
  { leaseMs: 1000, pollMs: 50 },
)
`

let bundled: Promise<string> | undefined
/** The victim as one ESM file, so a plain `node`/`bun` child can run the sources. */
function victim(): Promise<string> {
  return (bundled ??= (async () => {
    const { build } = await import('esbuild')
    const outfile = join(tmpdir(), `pgprime-mq-victim-${process.pid}.mjs`)
    const src = (pkg: string) => resolve(import.meta.dirname, `../../../${pkg}/src/index.ts`)
    await build({
      stdin: { contents: VICTIM, resolveDir: import.meta.dirname, loader: 'ts' },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      alias: { 'pg-prime': src('pg-prime'), '@pg-prime/events': src('pg-prime-events') },
      external: ['pg-native'],
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      logLevel: 'error',
    })
    return outfile
  })())
}
