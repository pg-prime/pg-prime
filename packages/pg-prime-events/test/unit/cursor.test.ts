import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  BEGINNING,
  advance,
  advanceTo,
  decodeCursor,
  encodeCursor,
  seed,
} from '../../src/log/cursor.js'
import type { Cursor, ReadView } from '../../src/log/cursor.js'

/**
 * A model of what R1 sees: PostgreSQL's snapshot rules for xids assigned at first write, entry ids
 * from one sequence (so ids follow neither xid nor commit order), `xmax = latestCompletedXid + 1`.
 */
interface Tx {
  xid: bigint | undefined
  state: 'running' | 'committed' | 'aborted'
  entries: { id: bigint; type: string }[]
}
interface Row {
  id: bigint
  xid: bigint
  type: string
}

class Model {
  nextXid = 10n
  nextId = 1n
  latestCompleted = 9n
  txs: Tx[] = []

  running(): Tx[] {
    return this.txs.filter((t) => t.state === 'running')
  }
  assignXid(t: Tx): void {
    t.xid ??= this.nextXid++
  }
  insert(t: Tx, type: string): void {
    this.assignXid(t)
    t.entries.push({ id: this.nextId++, type })
  }
  finish(t: Tx, state: 'committed' | 'aborted'): void {
    t.state = state
    if (t.xid !== undefined && t.xid > this.latestCompleted) this.latestCompleted = t.xid
  }
  snapshot(): { xmax: bigint; xip: bigint[] } {
    const xmax = this.latestCompleted + 1n
    const xip = this.running()
      .map((t) => t.xid)
      .filter((x): x is bigint => x !== undefined && x < xmax)
    return { xmax, xip }
  }
  visible(): Row[] {
    return this.txs
      .filter((t) => t.state === 'committed')
      .flatMap((t) => t.entries.map((e) => ({ id: e.id, xid: t.xid as bigint, type: e.type })))
  }
  /** R1, statement for statement. */
  read(c: Cursor, n: number, types: readonly string[] | null): { view: ReadView; rows: Row[] } {
    const all = this.visible()
    const late = all
      .filter((e) => c.pending.has(e.xid) && e.id > (c.pending.get(e.xid) as bigint))
      .sort(byPos)
      .slice(0, n)
    const next = all
      .filter((e) => e.xid > c.xid || (e.xid === c.xid && e.id > c.id))
      .sort(byPos)
      .slice(0, n - late.length)
    const last = next.at(-1)
    const cut = late.length === n ? late.at(-1) : undefined
    const rows = [...late, ...next]
      .filter((e) => types === null || types.includes(e.type))
      .sort(byPos)
    return {
      view: {
        pos: last === undefined ? null : { xid: last.xid, id: last.id },
        late: cut === undefined ? null : { xid: cut.xid, id: cut.id },
        running: this.snapshot().xip,
      },
      rows,
    }
  }
}

/** The §3.3 invariant: every transaction still running below the position is pending. */
function covers(m: Model, c: Cursor): void {
  for (const t of m.running()) {
    if (t.xid !== undefined && t.xid < c.xid && !c.pending.has(t.xid)) {
      throw new Error(`cursor ${encodeCursor(c)} stepped over running xid ${t.xid}`)
    }
  }
}

const byPos = (a: Row, b: Row): number =>
  a.xid !== b.xid ? (a.xid < b.xid ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

/** A reader as the subscription runs one: per-entry cursors, commits, crashes, resumes. */
class SimReader {
  cursor: Cursor
  persisted: Cursor
  /** What the persisted cursor stands for: every entry acknowledged, in order. */
  acked: { id: bigint; cursor: string }[] = []
  committedLen = 0
  constructor(
    start: Cursor,
    readonly types: readonly string[] | null,
  ) {
    this.cursor = start
    this.persisted = start
  }
  commit(c: Cursor, m?: Model): void {
    if (m !== undefined) covers(m, c)
    this.cursor = c
    this.persisted = c
    this.committedLen = this.acked.length
  }
  crash(): void {
    this.acked.length = this.committedLen
    this.cursor = this.persisted
  }
  /** Resume from the `Entry.cursor` of the k-th acknowledged entry, as a user who stored it. */
  resume(k: number, m: Model): void {
    if (this.acked.length === 0) return
    const i = k % this.acked.length
    this.acked.length = i + 1
    this.commit(decodeCursor((this.acked[i] as { cursor: string }).cursor), m)
  }
  step(m: Model, op: ReadOp): void {
    const { view, rows } = m.read(this.cursor, op.n, this.types)
    if (rows.length === 0) return this.commit(advanceTo(this.cursor, view), m)
    // `isolate`: deliver the first entry alone, as after a batch failure; otherwise a prefix
    // of `take` entries succeeds (a throw at the next one), or the whole read.
    const take = op.isolate ? 1 : op.take === 0 ? rows.length : Math.min(op.take, rows.length)
    const whole = take === rows.length
    let c = this.cursor
    for (const [i, r] of rows.slice(0, take).entries()) {
      c = advance(c, view, r)
      if (whole && i === take - 1) c = advanceTo(c, view)
      covers(m, c)
      this.acked.push({ id: r.id, cursor: encodeCursor(c) })
      if (op.commitEach) this.commit(c, m)
      if (op.crashAt === i) return this.crash()
    }
    this.commit(c, m)
  }
  drain(m: Model): void {
    for (let i = 0; i < 10_000; i++) {
      const before = encodeCursor(this.cursor)
      const { rows } = m.read(this.cursor, 3, this.types)
      this.step(m, { n: 3, take: 0, isolate: false, commitEach: false, crashAt: -1 })
      if (rows.length === 0 && encodeCursor(this.cursor) === before) return
    }
    throw new Error('the reader did not converge')
  }
}

interface ReadOp {
  n: number
  take: number
  isolate: boolean
  commitEach: boolean
  crashAt: number
}

const TYPES = ['a', 'b', 'c']
const op = fc.oneof(
  { weight: 3, arbitrary: fc.record({ k: fc.constant('begin' as const) }) },
  {
    weight: 6,
    arbitrary: fc.record({
      k: fc.constant('insert' as const),
      t: fc.nat(),
      type: fc.constantFrom(...TYPES),
    }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('xid' as const), t: fc.nat() }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant('commit' as const), t: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('abort' as const), t: fc.nat() }) },
  {
    weight: 6,
    arbitrary: fc.record({
      k: fc.constant('read' as const),
      r: fc.nat(1),
      n: fc.integer({ min: 1, max: 4 }),
      take: fc.nat(4),
      isolate: fc.boolean(),
      commitEach: fc.boolean(),
      crashAt: fc.integer({ min: -3, max: 3 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ k: fc.constant('resume' as const), r: fc.nat(1), i: fc.nat() }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('seed' as const) }) },
)
const typesArb = fc.option(fc.subarray(TYPES, { minLength: 1 }), { nil: null })

describe('the exact cursor (plan 15 §3.3)', () => {
  it('delivers every committed matching entry exactly once, aborted never, through crashes, resumes and fresh cursors', () => {
    fc.assert(
      fc.property(
        fc.array(op, { maxLength: 150, size: 'max' }),
        typesArb,
        typesArb,
        (ops, t0, t1) => {
          const m = new Model()
          const r0 = new SimReader(BEGINNING, t0)
          let r1: SimReader | undefined
          let committedAtSeed = new Set<Tx>()
          const pick = (i: number): Tx | undefined => {
            const run = m.running()
            return run[i % Math.max(1, run.length)]
          }
          for (const o of ops) {
            switch (o.k) {
              case 'begin':
                m.txs.push({ xid: undefined, state: 'running', entries: [] })
                break
              case 'insert': {
                const t = pick(o.t)
                if (t !== undefined) m.insert(t, o.type)
                break
              }
              case 'xid': {
                const t = pick(o.t)
                if (t !== undefined) m.assignXid(t)
                break
              }
              case 'commit':
              case 'abort': {
                const t = pick(o.t)
                if (t !== undefined) m.finish(t, o.k === 'commit' ? 'committed' : 'aborted')
                break
              }
              case 'read':
                ;(o.r === 0 ? r0 : r1)?.step(m, o)
                break
              case 'resume':
                ;(o.r === 0 ? r0 : r1)?.resume(o.i, m)
                break
              case 'seed':
                if (r1 === undefined) {
                  const s = m.snapshot()
                  r1 = new SimReader(seed(s.xmax, s.xip), t1)
                  covers(m, r1.cursor)
                  committedAtSeed = new Set(m.txs.filter((t) => t.state === 'committed'))
                }
                break
            }
          }
          for (const t of m.running()) m.finish(t, 'committed')
          const expected = (r: SimReader, skip: Set<Tx>): bigint[] =>
            m.txs
              .filter((t) => t.state === 'committed' && !skip.has(t))
              .flatMap((t) => t.entries)
              .filter((e) => r.types === null || r.types.includes(e.type))
              .map((e) => e.id)
              .sort(cmp)
          for (const [r, skip] of [
            [r0, new Set<Tx>()],
            [r1, committedAtSeed],
          ] as const) {
            if (r === undefined) continue
            r.drain(m)
            const got = r.acked.map((a) => a.id)
            expect(new Set(got).size).toBe(got.length)
            expect([...got].sort(cmp)).toStrictEqual(expected(r, skip))
            expect(r.cursor.pending.size).toBe(0)
            // A transaction's entries arrive in insertion order (a read limit may split them).
            for (const t of m.txs) {
              const at = t.entries.map((e) => got.indexOf(e.id)).filter((i) => i >= 0)
              expect(at).toStrictEqual([...at].sort((a, b) => a - b))
            }
          }
        },
      ),
      { numRuns: 3000 },
    )
  }, 60_000)

  it('a read limit can split a transaction, and a late one may arrive between its parts', () => {
    const m = new Model()
    const late: Tx = { xid: undefined, state: 'running', entries: [] }
    const big: Tx = { xid: undefined, state: 'running', entries: [] }
    m.txs.push(late, big)
    m.insert(late, 'a')
    m.insert(big, 'a')
    m.insert(big, 'a')
    m.finish(big, 'committed')
    const r = new SimReader(BEGINNING, null)
    r.step(m, { n: 1, take: 0, isolate: false, commitEach: false, crashAt: -1 })
    m.finish(late, 'committed')
    r.drain(m)
    expect(r.acked.map((a) => a.id)).toStrictEqual([2n, 1n, 3n])
  })
})

describe('named interleavings', () => {
  it('a next entry committed while a lower xid is open: the lower one arrives after it commits', () => {
    const m = new Model()
    const low: Tx = { xid: undefined, state: 'running', entries: [] }
    const high: Tx = { xid: undefined, state: 'running', entries: [] }
    m.txs.push(low, high)
    m.insert(low, 'a')
    m.insert(high, 'a')
    m.finish(high, 'committed')
    const r = new SimReader(BEGINNING, null)
    r.step(m, { n: 10, take: 0, isolate: false, commitEach: false, crashAt: -1 })
    expect(r.acked.map((a) => a.id)).toStrictEqual([2n])
    expect([...r.cursor.pending.keys()]).toStrictEqual([low.xid])
    r.crash()
    m.finish(low, 'committed')
    r.drain(m)
    expect(r.acked.map((a) => a.id)).toStrictEqual([2n, 1n])
  })

  it('a per-entry commit past an open lower xid remembers it across a crash', () => {
    const m = new Model()
    const low: Tx = { xid: undefined, state: 'running', entries: [] }
    const high: Tx = { xid: undefined, state: 'running', entries: [] }
    m.txs.push(low, high)
    m.insert(low, 'a')
    m.insert(high, 'a')
    m.insert(high, 'a')
    m.finish(high, 'committed')
    const r = new SimReader(BEGINNING, null)
    r.step(m, { n: 10, take: 0, isolate: false, commitEach: true, crashAt: 0 })
    expect(r.acked.map((a) => a.id)).toStrictEqual([2n])
    m.finish(low, 'committed')
    r.drain(m)
    expect(r.acked.map((a) => a.id)).toStrictEqual([2n, 1n, 3n])
  })

  it('a fully filtered read still advances, and a later lower-xid match is delivered', () => {
    const m = new Model()
    const open: Tx = { xid: undefined, state: 'running', entries: [] }
    const other: Tx = { xid: undefined, state: 'running', entries: [] }
    m.txs.push(open, other)
    m.insert(open, 'paid')
    m.insert(other, 'created')
    m.finish(other, 'committed')
    const r = new SimReader(BEGINNING, ['paid'])
    r.step(m, { n: 10, take: 0, isolate: false, commitEach: false, crashAt: -1 })
    expect(r.acked).toStrictEqual([])
    expect(r.persisted.xid).toBe(other.xid)
    m.finish(open, 'committed')
    r.drain(m)
    expect(r.acked.map((a) => a.id)).toStrictEqual([1n])
  })

  it('acknowledging inside a late transaction resumes after the acknowledged entry', () => {
    const m = new Model()
    const late: Tx = { xid: undefined, state: 'running', entries: [] }
    const early: Tx = { xid: undefined, state: 'running', entries: [] }
    m.txs.push(late, early)
    m.assignXid(late)
    m.insert(early, 'a')
    m.finish(early, 'committed')
    const r = new SimReader(BEGINNING, null)
    r.drain(m)
    for (let i = 0; i < 3; i++) m.insert(late, 'a')
    m.finish(late, 'committed')
    r.step(m, { n: 10, take: 2, isolate: false, commitEach: true, crashAt: 1 })
    expect(r.persisted.pending.get(late.xid as bigint)).toBe(late.entries[1]?.id)
    r.drain(m)
    expect(r.acked.map((a) => a.id)).toStrictEqual([1n, 2n, 3n, 4n])
  })

  it('a late transaction larger than the read limit is read n entries at a time', () => {
    const m = new Model()
    const late: Tx = { xid: undefined, state: 'running', entries: [] }
    const early: Tx = { xid: undefined, state: 'running', entries: [] }
    m.txs.push(late, early)
    m.insert(late, 'a')
    m.insert(early, 'a')
    m.finish(early, 'committed')
    const r = new SimReader(BEGINNING, null)
    r.drain(m)
    for (let i = 0; i < 4; i++) m.insert(late, 'a')
    m.finish(late, 'committed')
    expect(m.read(r.cursor, 2, null).rows.map((e) => e.id)).toStrictEqual([1n, 3n])
    r.step(m, { n: 2, take: 0, isolate: false, commitEach: false, crashAt: -1 })
    expect(r.persisted.pending.get(late.xid as bigint)).toBe(3n)
    r.drain(m)
    expect(r.acked.map((a) => a.id)).toStrictEqual([2n, 1n, 3n, 4n, 5n, 6n])
    expect(r.cursor.pending.size).toBe(0)
  })

  it("from: 'now' delivers transactions open at seeding time, not committed ones", () => {
    const m = new Model()
    const before: Tx = { xid: undefined, state: 'running', entries: [] }
    const open: Tx = { xid: undefined, state: 'running', entries: [] }
    m.txs.push(before, open)
    m.insert(open, 'a')
    m.insert(before, 'a')
    m.finish(before, 'committed')
    const s = m.snapshot()
    const r = new SimReader(seed(s.xmax, s.xip), null)
    m.finish(open, 'committed')
    r.drain(m)
    expect(r.acked.map((a) => a.id)).toStrictEqual([1n])
  })
})

describe('cursor encoding', () => {
  it('round-trips', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 2n ** 63n }),
        fc.bigInt({ min: 0n, max: 2n ** 63n }),
        fc.array(
          fc.tuple(fc.bigInt({ min: 0n, max: 2n ** 63n }), fc.bigInt({ min: 0n, max: 2n ** 63n })),
        ),
        (xid, id, p) => {
          const c: Cursor = { xid, id, pending: new Map(p) }
          expect(decodeCursor(encodeCursor(c))).toStrictEqual(c)
        },
      ),
    )
  })

  it('refuses what is not a cursor', () => {
    for (const s of ['', 'x', '1', '1.2.', '1.2.3', '-1.2']) {
      expect(() => decodeCursor(s)).toThrow(/not an Entry.cursor/)
    }
  })
})

const cmp = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0)
