// A diagnostic, not a gate: where the bytes and the microseconds of one `.compile()` go.
//
//   pnpm bench:profile                                           → the staged allocation/time table
//   node --expose-gc bench/runtime/profile.mjs                    → the same, run directly
//   node --expose-gc --cpu-prof bench/runtime/profile.mjs --cpu   → the same, plus a .cpuprofile
//                                                                   in the cwd (gitignored)
//
// `run.mjs` measures the whole builder chain as one number, which is the right thing for a budget
// and useless for deciding what to change. This walks the chain one method at a time and reports
// the marginal bytes and marginal microseconds of each step, so an optimisation can be aimed.
//
// It gates nothing and is never run in CI. Every row of design/09 §3.7's follow-up change table
// was aimed with it.

import { bytesPerOp, sample } from './sampler.mjs'
import { BENCH_NS, loadPackage } from './cases.mjs'

const argv = process.argv.slice(2)
const CPU = argv.includes('--cpu')
const REBUILD = argv.includes('--rebuild')

const { api, compiler, fixture } = await loadPackage({ rebuild: REBUILD })
const fx = fixture.makeFixture(BENCH_NS)
const h = fx.schema.h
const db = api.compileOnly(fx.schema)
const ops = api

/** The heavy case of `cases.mjs`, one step at a time. Each entry is a *complete* thunk. */
const heavySteps = [
  ['from', () => db.from(h.posts)],
  ['+ innerJoin', () => db.from(h.posts).innerJoin(h.users, 'author', ({ posts: p, author: a }) => ops.eq(p.authorId, a.id))],
  [
    '+ leftJoin',
    () =>
      db
        .from(h.posts)
        .innerJoin(h.users, 'author', ({ posts: p, author: a }) => ops.eq(p.authorId, a.id))
        .leftJoin(h.comments, 'c', ({ posts: p, c }) => ops.eq(c.postId, p.id)),
  ],
  [
    '+ where',
    () =>
      db
        .from(h.posts)
        .innerJoin(h.users, 'author', ({ posts: p, author: a }) => ops.eq(p.authorId, a.id))
        .leftJoin(h.comments, 'c', ({ posts: p, c }) => ops.eq(c.postId, p.id))
        .where(({ posts: p, author: a }) => ops.and(ops.isTrue(p.published), ops.isNull(a.deletedAt))),
  ],
  [
    '+ orderBy + limit',
    () =>
      db
        .from(h.posts)
        .innerJoin(h.users, 'author', ({ posts: p, author: a }) => ops.eq(p.authorId, a.id))
        .leftJoin(h.comments, 'c', ({ posts: p, c }) => ops.eq(c.postId, p.id))
        .where(({ posts: p, author: a }) => ops.and(ops.isTrue(p.published), ops.isNull(a.deletedAt)))
        .orderBy(({ posts: p }) => [ops.desc(p.createdAt), ops.asc(p.id)])
        .limit(50),
  ],
  [
    '+ select (12 cols + 1 relation)',
    () =>
      db
        .from(h.posts)
        .innerJoin(h.users, 'author', ({ posts: p, author: a }) => ops.eq(p.authorId, a.id))
        .leftJoin(h.comments, 'c', ({ posts: p, c }) => ops.eq(c.postId, p.id))
        .where(({ posts: p, author: a }) => ops.and(ops.isTrue(p.published), ops.isNull(a.deletedAt)))
        .orderBy(({ posts: p }) => [ops.desc(p.createdAt), ops.asc(p.id)])
        .limit(50)
        .select(({ posts: p, author: a, c }) => ({
          id: p.id,
          title: p.title,
          body: p.body,
          amount: p.amount,
          published: p.published,
          createdAt: p.createdAt,
          authorId: p.authorId,
          authorEmail: a.email,
          authorName: a.name,
          authorRole: a.role,
          commentId: c.id,
          commentBody: c.body,
          recent: a.posts.many((s) => s.select((q) => ({ id: q.id, title: q.title })).limit(3)),
        })),
  ],
]

const full = heavySteps[heavySteps.length - 1][1]
heavySteps.push(['+ toAst()', () => full().toAst()])
heavySteps.push(['+ compile()', () => full().compile()])

// The simple case (design/08 §5's 200 000/s line), same treatment.
const simpleSteps = [
  ['from', () => db.from(h.users)],
  [
    '+ select (4 cols)',
    () => db.from(h.users).select(({ users: u }) => ({ id: u.id, email: u.email, name: u.name, role: u.role })),
  ],
  [
    '+ where + limit',
    () =>
      db
        .from(h.users)
        .select(({ users: u }) => ({ id: u.id, email: u.email, name: u.name, role: u.role }))
        .where(({ users: u }) => ops.eq(u.email, 'ada@example.com'))
        .limit(1),
  ],
]
const simpleFull = simpleSteps[simpleSteps.length - 1][1]
simpleSteps.push(['+ compile()', () => simpleFull().compile()])

const S = { iters: 2000, samples: 25, warmup: 5000 }

/**
 * A sink the optimiser cannot see through.
 *
 * `bytesPerOp(() => db.from(x))` reads *less* than nothing without one: the result is unused, so
 * escape analysis sinks the allocation and the stage appears to cost 550 B when the previous stage
 * cost 870. Every measurement below therefore stores its result.
 */
let SINK = null
const keep = (fn) => () => {
  SINK = fn()
}

function table(title, steps) {
  console.log(`\n── ${title} ──────────────────────────────────────────────`)
  console.log(`  ${'stage'.padEnd(34)} ${'B/op'.padStart(8)} ${'ΔB'.padStart(8)} ${'µs'.padStart(9)} ${'Δµs'.padStart(9)}`)
  let prevB = 0
  let prevUs = 0
  const rows = []
  for (const [name, fn] of steps) {
    globalThis.gc?.()
    const a = bytesPerOp(keep(fn), { warmup: 20000 })
    const b = a.median
    const t = sample(keep(fn), S).p50
    rows.push({ name, bytes: b, deltaBytes: b - prevB, us: t, deltaUs: t - prevUs })
    console.log(
      `  ${name.padEnd(34)} ${String(b).padStart(8)} ${String(b - prevB).padStart(8)} ` +
        `${t.toFixed(3).padStart(9)} ${(t - prevUs).toFixed(3).padStart(9)}   ${a.stable ? '' : 'UNSTABLE'}`,
    )
    prevB = b
    prevUs = t
  }
  return rows
}

// The emitter alone, for the split between "the builder built an AST" and "the emitter walked it".
const asts = Array.from({ length: 256 }, () => full().toAst())
let cur = 0
const emitOnce = () => compiler.compile(asts[cur++ & 255])

const heavy = table('heavy: 12 cols + 2 joins + 1 relation', heavySteps)
const simple = table('simple: 4 cols, one where', simpleSteps)

globalThis.gc?.()
const emitB = bytesPerOp(keep(emitOnce), { warmup: 20000 }).median
const emitUs = sample(keep(emitOnce), S).p50
console.log(`\n  ${'emitter alone (pre-built AST)'.padEnd(34)} ${String(emitB).padStart(8)} ${''.padStart(8)} ${emitUs.toFixed(3).padStart(9)}`)

if (CPU) {
  // Enough iterations that the sampler has something to say; the profile is written on exit.
  const t0 = performance.now()
  let n = 0
  while (performance.now() - t0 < 6000) {
    SINK = full().compile()
    n++
  }
  console.log(`\n  cpu-prof: ${n} compiles in 6 s → .cpuprofile in the cwd`)
}

console.log('')
