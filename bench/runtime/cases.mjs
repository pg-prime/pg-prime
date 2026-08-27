// The workloads the runtime bench measures (design/09 WS7), and the one place that knows how to
// get at a *built* `pg-prime`.
//
// ─── Why this builds the package instead of importing `src` ─────────────────
//
// The bench is `.mjs`, like `bench/types`, and Node cannot load `packages/pg-prime/src/**/*.ts`
// directly: every import in the package carries the `.js` suffix ESM requires, and type-stripping
// does not remap extensions. So the bench compiles the package once with the consumer-floor
// compiler (TypeScript 5.9.3, the same binary `bench/types` uses) into `.gen/dist` and imports the
// JavaScript a user would actually run — which is a better measurement than instrumenting the
// TypeScript would have been.
//
// ─── Why the fixture is the LIVE fixture ────────────────────────────────────
//
// `test/live/fixture.ts` comes along in the same emit. It is the only table set in the repo whose
// `pgTable(…)` declarations are checked against `information_schema` (R5, `fixture.drift.test.ts`),
// so the bench measures shapes that are known to match a real database. A bench-private fixture
// would be a second thing that can drift, and its DDL would be checked by nothing.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const OUT = join(HERE, '.gen', 'dist')
const TSC = join(ROOT, 'node_modules', 'typescript59', 'bin', 'tsc')

/** The bench's own schema namespace, so it cannot collide with a test file's (R6). */
export const BENCH_NS = 'pgprime_bench'

/**
 * Build `packages/pg-prime` (plus the live fixture) to `.gen/dist` and import it.
 *
 * Rebuilds when any input is newer than the emitted barrel, so a local `--quick` loop does not pay
 * ~6 s of `tsc` per run; `--rebuild` forces it. CI always starts from a clean checkout, so CI
 * always builds.
 */
export async function loadPackage({ rebuild = false } = {}) {
  const barrel = join(OUT, 'src', 'index.js')
  if (rebuild || !existsSync(barrel) || stale(barrel)) {
    rmSync(join(HERE, '.gen'), { recursive: true, force: true })
    execFileSync(process.execPath, [TSC, '-p', join(HERE, 'tsconfig.json'), '--pretty', 'false'], {
      encoding: 'utf8',
      stdio: ['ignore', 'inherit', 'inherit'],
    })
  }
  const api = await import(pathToUrl(barrel))
  const compiler = await import(pathToUrl(join(OUT, 'src', 'compile', 'compiler.js')))
  const decode = await import(pathToUrl(join(OUT, 'src', 'compile', 'decode.js')))
  const fixture = await import(pathToUrl(join(OUT, 'test', 'live', 'fixture.js')))
  return { api, compiler, decode, fixture }
}

const pathToUrl = (p) => new URL(`file://${p.replace(/\\/g, '/')}`).href

function stale(barrel) {
  const built = statSync(barrel).mtimeMs
  const src = join(ROOT, 'packages', 'pg-prime')
  let newest = 0
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue
        walk(join(dir, e.name))
      } else if (e.name.endsWith('.ts')) {
        newest = Math.max(newest, statSync(join(dir, e.name)).mtimeMs)
      }
    }
  }
  walk(join(src, 'src'))
  newest = Math.max(newest, statSync(join(src, 'test', 'live', 'fixture.ts')).mtimeMs)
  return newest > built
}

// ─────────────────────────── the compile cases ───────────────────────────

/**
 * design/03 §1.1's case, spelled through the public API: **a 12-column select with two joins and
 * one nested relation projection**.
 *
 * Twelve scalar columns (seven off `posts`, three off the inner-joined `users`, two off the
 * left-joined `comments`) plus one `many` relation, which is what puts the LATERAL + `json_agg`
 * hoist on the measured path. `where` / `orderBy` / `limit` are there because §1.1's claim is about
 * a real query and a real query has them.
 *
 * It returns a THUNK, and the bench calls the thunk every iteration: `.compile()` is memoised on
 * the instance (03 §1.4a), so timing a reused builder would time a `??=`. What a request pays is
 * the chain plus the compile, and that is what is measured.
 */
export function heavyQuery(db, h, ops) {
  return () =>
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
      }))
}

/**
 * design/08 §5's PR-gate case: "≥ 200 000 simple selects/sec". Four columns, one `where`, no join.
 * Same thunk discipline as above.
 */
export function simpleQuery(db, h, ops) {
  return () =>
    db
      .from(h.users)
      .select(({ users: u }) => ({ id: u.id, email: u.email, name: u.name, role: u.role }))
      .where(({ users: u }) => ops.eq(u.email, 'ada@example.com'))
      .limit(1)
}

// ─────────────────────────── the decode case ───────────────────────────
//
// The twelve columns, the row fixture and the hand mapper all live in `hand-mapper.mjs`: they are
// one contract, and `test/compile/decode-oracle.test.ts` imports them from there so tier 0 checks
// the same oracle the bench times.

export function decodeQuery(db, h, ops) {
  return db
    .from(h.posts)
    .innerJoin(h.users, 'author', ({ posts: p, author: a }) => ops.eq(p.authorId, a.id))
    .leftJoin(h.comments, 'c', ({ posts: p, c }) => ops.eq(c.postId, p.id))
    .select(({ posts: p, author: a, c }) => ({
      id: p.id,
      authorId: p.authorId,
      title: p.title,
      body: p.body,
      amount: p.amount,
      published: p.published,
      createdAt: p.createdAt,
      authorEmail: a.email,
      authorName: a.name,
      authorBalance: a.balance,
      commentId: c.id,
      commentBody: c.body,
    }))
}
