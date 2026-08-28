/**
 * A seeded generator of random **builder chains** — the public API, not the AST (design/09 WS7).
 *
 * `compiler-fuzz.test.ts` builds `SelectNode`s with the constructors in `compile/nodes.ts`. That
 * covers the emitter and nothing above it: the scope machinery, the join widening, the relation
 * resolver, the projection compiler, `nest`, the CTE plumbing and the set-operation branch are all
 * layers a user types through and that fuzzer never touches. This one starts at `db.from(...)` and
 * only ever calls exported methods (R11), with no casts anywhere (R12).
 *
 * ## How randomness stays typed
 *
 * A random chain has a type that depends on runtime choices, which no type system can express. The
 * way out is that **the chain's SHAPE is one of a small number of statically written templates and
 * only the CHOICES inside it are random**:
 *
 *   · The only methods that change `Query<S, O, N>` before the projection are `innerJoin` /
 *     `leftJoin`, so the four join combinations are four hand-written functions, each with its own
 *     fully inferred scope type.
 *   · Everything else before the projection — `where`, `orderBy`, `limit`, `offset`, `distinct`,
 *     `distinctOn` — returns the same type it was given, so those steps are `(q: Q) => Q` arrays
 *     that the generator composes at random. TypeScript checks every one of them.
 *   · The projection is a `Record<string, Projectable>`, which is exactly `Projection`, so a
 *     randomly assembled object literal is a legal argument with no assertion.
 *
 * The result is a generator with no `as`, no `any`, and no `@ts-expect-error`, which is the point:
 * if generating a random chain had needed a cast, the cast would have been evidence about the
 * builder's types (R12) rather than a convenience.
 *
 * ## What it generates
 *
 * Six top-level shapes, chosen by weight: plain select, grouped select (`groupBy`/`having`),
 * `distinct on`, windowed projection, CTE (`with` + `fromCte`), and a set operation. Inside them:
 * ~30 operators through the `ops` surface, `nest({...})` groups, all seven relation accessors, m2m
 * `through`, the composite-key relation, and per-parent `limit`/`orderBy` on `many`.
 *
 * ## Determinism
 *
 * Every chain is a pure function of a 32-bit seed via the same mulberry32 the ident fuzzer uses
 * (`generator.ts`), so a failure is replayable from the number printed with it, and pinnable in
 * `corpus/builder.json` without storing the chain.
 */

import type { Bind } from '../../src/compile/contract.js'
import { nest } from '../../src/query/projection.js'
import { BuilderError } from '../../src/sql/errors.js'
import * as q from '../../src/query/types.js'
import type { Db, Projection } from '../../src/query/types.js'
import type { Projectable } from '../../src/schema/index.js'
import type { Fixture } from '../live/fixture.js'
import { rng } from './generator.js'

type Sc = Fixture['schema']
type Handles = Db<Sc>['h']

/** The deterministic stream. One per case, seeded from the case's own seed. */
export type Rng = () => number

const pick = <T>(r: Rng, xs: readonly T[]): T => {
  const v = xs[Math.floor(r() * xs.length)]
  if (v === undefined) throw new Error('empty choice list')
  return v
}
const int = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1))
const chance = (r: Rng, p: number): boolean => r() < p

/**
 * A bind value with a marker no emitter could produce by accident.
 *
 * Invariant (b) — "no bind value appears in the SQL text" — is only as strong as the values are
 * distinctive, and the payloads are the ones that break naive quoting: a statement terminator, a
 * comment opener, a `$1` lookalike, a backslash run, a quote.
 */
export function mintFor(r: Rng): () => string {
  let n = 0
  return () =>
    `«bf${n++}»${pick(r, [
      "'; drop table users; --",
      '"x"',
      '\\\\',
      '$1',
      ';',
      '/*',
      "''",
      '%',
      '_',
      '🙂𝄞',
    ])}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Leaf predicates, one per table, written against the refs the scope hands out
// ─────────────────────────────────────────────────────────────────────────────
//
// These take the refs object rather than the scope, so the same twelve shapes are reachable from
// every join combination without being written four times. Each shape is one PostgreSQL will
// resolve with the parameter types the codecs declare — invariant (e) executes them for real, and
// a shape the type-class gate makes unrepresentable is not a shape a user could write either.

/**
 * The refs a *scope* hands out, not `RefsAt<H>`: relation accessors live on the scope
 * (`ScopeOf` merges `RefsAt` with `RelPickers`), so a helper typed on `RefsAt` alone cannot reach
 * `u.posts.many(...)`. Spelling them this way is how the leaf and projection helpers stay callable
 * from every join combination without being written out four times.
 */
type UserRefs = q.ScopeOf<{ users: Handles['users'] }>['users']
type PostRefs = q.ScopeOf<{ posts: Handles['posts'] }>['posts']
type CommentRefs = q.ScopeOf<{ comments: Handles['comments'] }>['comments']
/** The same, left-joined: every column reads `T | null` (03 §2.2). */
type NullCommentRefs = q.ScopeOf<{ comments: Handles['comments'] }, 'comments'>['comments']

export function userLeaf(r: Rng, u: UserRefs, mint: () => string): q.Expr<boolean> {
  switch (int(r, 0, 13)) {
    case 0:
      return q.ilike(u.email, `%${mint()}%`)
    case 1:
      return q.startsWith(u.name, mint())
    case 2:
      return q.isNull(u.deletedAt)
    case 3:
      return q.isNotNull(u.email)
    case 4:
      return q.inList(u.role, ['admin', 'owner'])
    case 5:
      return q.hasKey(u.meta, mint())
    case 6:
      return q.eq(q.jsonPathText(u.meta, ['billing', mint()]), mint())
    case 7:
      return q.between(u.createdAt, new Date(0), new Date('2100-01-01T00:00:00Z'))
    case 8:
      return q.isDistinctFrom(u.deletedAt, null)
    case 9:
      return q.arrayContains(u.tags, [mint()])
    case 10:
      return q.gt(u.balance, '0.00')
    case 11:
      return q.notILike(u.name, `%${mint()}%`)
    case 12:
      return q.regex(u.email, `^${mint().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    default:
      return q.inList(
        u.id,
        Array.from({ length: int(r, 0, 3) }, () => BigInt(int(r, 1, 9))),
      )
  }
}

export function postLeaf(r: Rng, p: PostRefs, mint: () => string): q.Expr<boolean> {
  switch (int(r, 0, 8)) {
    case 0:
      return q.isTrue(p.published)
    case 1:
      return q.isNotTrue(p.published)
    case 2:
      return q.ilike(p.title, `%${mint()}%`)
    case 3:
      return q.gte(p.amount, '0.00')
    case 4:
      return q.isNull(p.k1)
    case 5:
      return q.gte(q.arrayLength(p.tagIds), 0)
    case 6:
      return q.lt(p.createdAt, new Date('2100-01-01T00:00:00Z'))
    case 7:
      return q.notLike(p.body, `%${mint()}%`)
    default:
      return q.isNotDistinctFrom(p.k2, null)
  }
}

export function commentLeaf(
  r: Rng,
  c: CommentRefs | NullCommentRefs,
  mint: () => string,
): q.Expr<boolean> {
  switch (int(r, 0, 3)) {
    case 0:
      return q.ilike(c.body, `%${mint()}%`)
    case 1:
      return q.isNotNull(c.body)
    case 2:
      return q.gt(c.createdAt, new Date(0))
    default:
      return q.neq(c.body, mint())
  }
}

/** `and` / `or` / `not` over the leaves, bounded depth — the same shape as the AST fuzzer's. */
export function combine(
  r: Rng,
  depth: number,
  leaf: () => q.Expr<boolean>,
): q.Expr<boolean> {
  if (depth <= 0) return leaf()
  switch (int(r, 0, 3)) {
    case 0:
      return q.and(...Array.from({ length: int(r, 1, 3) }, () => combine(r, depth - 1, leaf)))
    case 1:
      return q.or(...Array.from({ length: int(r, 1, 3) }, () => combine(r, depth - 1, leaf)))
    case 2:
      return q.not(combine(r, depth - 1, leaf))
    default:
      return leaf()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Projections
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scalar projection items off `users`, including the seven relation accessors and a `nest` group.
 *
 * `Projection` is `Record<string, Projectable>`, so an assembled object is a legal argument — the
 * randomness is in which keys exist, not in bending a type.
 *
 * **A relation accessor that projects a json column is generated freely again**, `.distinct()`
 * included. It was suppressed for the length of one day: seeds 2802423309 and 3300751089 found
 * that `select distinct` needs an equality operator for every output column and PostgreSQL's
 * `json` has none (`42883 could not identify an equality operator for type json`). The builder now
 * emits the **jsonb** variant of a relation projection whenever the statement compares rows
 * (`compile/hoist.ts`'s `jsonVariant`), so the combination is legal — and generating it is what
 * keeps that fix honest.
 */
export function userProjection(r: Rng, u: UserRefs, mint: () => string): Projection {
  // One draw in six is the whole-alias spread (`12` B). It is generated next to the hand-picked
  // keys rather than instead of them, because the interesting case is a `$all` that shares a
  // projection with a relation column, a `nest` group and an aggregate — which is where a spread
  // that leaked an accessor, or a key that collided with one, would show up.
  const out: Record<string, Projectable> = chance(r, 1 / 6)
    ? { ...(chance(r, 0.5) ? u.$all : q.omit(u.$all, 'meta', 'deletedAt')) }
    : { id: u.id }
  if (chance(r, 0.7)) out['email'] = u.email
  if (chance(r, 0.4)) out['role'] = u.role
  if (chance(r, 0.3)) out['balance'] = u.balance
  if (chance(r, 0.3)) out['tag'] = q.jsonGetText(u.meta, mint())
  if (chance(r, 0.25)) {
    out['grp'] = nest({ name: u.name, joined: u.createdAt })
  }
  if (chance(r, 0.45)) {
    // `many` (0), `all` (4) and the two nested shapes (5, 6) project a json column; `count` (1),
    // `sum` (2), `exists` (3) and `12` B's `avg`/`min`/`max` (7-9) project a scalar. All ten are
    // drawn under every chain shape — `all()` is spelled out because the first, partial fix listed
    // the other three and the fuzzer came back with it 5 000 live cases later, at seed 3300751089.
    switch (int(r, 0, 9)) {
      case 0:
        out['posts'] = u.posts.many((s) =>
          s
            .select((p) => ({ id: p.id, title: p.title }))
            .orderBy((p) => q.asc(p.id))
            .limit(int(r, 1, 5)),
        )
        break
      case 1:
        out['n'] = u.posts.count()
        break
      case 2:
        out['revenue'] = u.posts.sum((p) => p.amount)
        break
      case 3:
        out['any'] = u.posts.exists()
        break
      case 7:
        // `12` B's three new aggregates. Unlike `sum` they are NOT coalesced, so the empty
        // relation comes back NULL — the live oracle is what checks that, and generating them
        // here is what puts them under `distinct`, a set operation and a window.
        out['avgAmount'] = u.posts.avg((p) => p.amount)
        break
      case 8:
        out['minTitle'] = u.posts.min((p) => p.title)
        break
      case 9:
        out['newest'] = u.posts.max((p) => p.createdAt)
        break
      case 4:
        out['all'] = u.posts.all()
        break
      case 5:
        out['deep'] = u.posts.many((s) =>
          s
            .select((p) => ({
              id: p.id,
              comments: p.comments.many((s2) =>
                s2.select((c) => ({ id: c.id, body: c.body })).limit(int(r, 1, 3)),
              ),
            }))
            .limit(int(r, 1, 3)),
        )
        break
      default:
        out['tags'] = u.posts.many((s) =>
          s
            .select((p) => ({
              id: p.id,
              tags: p.tags.many((s2) => s2.select((t) => ({ name: t.name }))),
              kv: p.kv.one((s2) => s2.select((k) => ({ v: k.v }))),
              author: p.author.one((s2) => s2.select((a) => ({ email: a.email }))),
            }))
            .limit(int(r, 1, 3)),
        )
    }
  }
  return out
}

export function postProjection(r: Rng, p: PostRefs, mint: () => string): Projection {
  const out: Record<string, Projectable> = { pid: p.id }
  if (chance(r, 0.6)) out['title'] = p.title
  if (chance(r, 0.4)) out['amount'] = p.amount
  if (chance(r, 0.3)) out['label'] = q.concat(p.title, mint())
  if (chance(r, 0.3)) out['pgrp'] = nest({ body: p.body, at: p.createdAt })
  return out
}

export function commentProjection(r: Rng, c: CommentRefs | NullCommentRefs): Projection {
  const out: Record<string, Projectable> = { cid: c.id }
  if (chance(r, 0.6)) out['cbody'] = c.body
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// The chain templates
// ─────────────────────────────────────────────────────────────────────────────
//
// `Step<Q>` is the type-preserving half of the builder: everything that returns what it was given.
// The four join combinations below each get their own list, written out rather than generated,
// because writing them out is what makes TypeScript check every call.

/**
 * The two fields every invariant here reads off a compiled statement.
 *
 * `Compiled<Row>` is deliberately **invariant** in `Row` (it carries a `(r: Row) => Row` phantom),
 * so `Compiled<{a: bigint}>` is not a `Compiled<unknown>` and a heterogeneous list of chains cannot
 * be typed as one. Narrowing to the two fields the fuzzer actually asserts on is how a list of
 * differently-shaped chains is held without a single cast — R12 again, and the variance is a
 * feature (design/04 §3.3) rather than something to route around with `as`.
 */
export interface CompiledFacts {
  readonly sql: string
  readonly binds: readonly Bind[]
  /**
   * The sentence, when the builder **refused to compile the chain** — the third outcome, and a
   * first-class one since the distinct follow-up of 2026-08-27.
   *
   * `.distinct()` with an `ORDER BY` on an expression the projection does not carry is `42P10` at
   * the server, and there is no repair that is not a different query (widening the projection
   * changes the row shape *and* which rows a DISTINCT returns), so `compile()` throws a
   * `BuilderError` naming the expression. A generator that only ever produced compilable chains
   * would be a generator that had been narrowed away from a real API surface, so the refusal is
   * recorded instead: (e′) determinism and (f) immutability are asserted over the sentence exactly
   * as they are over SQL, and (a)-(c) and the live oracle skip it because there is no statement.
   */
  readonly refused?: string | undefined
}

/**
 * Narrow any builder stage's `.compile()` to {@link CompiledFacts}. Structural, no assertion.
 *
 * A `BuilderError` becomes a `refused` fact; every other throw propagates, because "the builder
 * crashed" and "the builder said no" are not the same result and only one of them is a finding.
 */
const factsOf = (x: { compile: () => CompiledFacts }): CompiledFacts => {
  try {
    const c = x.compile()
    return { sql: c.sql, binds: c.binds }
  } catch (e) {
    if (e instanceof BuilderError) return { sql: '', binds: [], refused: e.message }
    throw e
  }
}

export interface Step<Q> {
  readonly label: string
  readonly apply: (query: Q, r: Rng, mint: () => string) => Q
}

/**
 * A captured intermediate builder, and the lens invariant (f) observes it through.
 *
 * A prefix cannot simply be compiled: `.select()` is mandatory (there is no implicit `SELECT *`),
 * so `db.from(users).where(…).compile()` throws a `BuilderError` and comparing two identical
 * exceptions would prove nothing. `probe()` therefore continues the prefix with a **fixed**
 * projection and compiles that, which observes everything the prefix carries — from, joins, where,
 * order, limit, offset, distinct — through a lens that does not vary with the chain.
 *
 * `eager` is filled only when the chain was generated in eager mode; see {@link makeChain}.
 */
export interface Prefix {
  readonly label: string
  readonly probe: () => CompiledFacts
  eager?: CompiledFacts
}

export interface Chain {
  readonly seed: number
  readonly shape: string
  readonly labels: readonly string[]
  readonly prefixes: readonly Prefix[]
  readonly compile: () => CompiledFacts
}

type AnyDb = Db<Sc>

function stepsFor<Q>(list: readonly Step<Q>[], r: Rng, howMany: number): Step<Q>[] {
  return Array.from({ length: howMany }, () => pick(r, list))
}

/** Records a prefix, and in eager mode compiles it **now** — before the chain continues. */
function recorder(
  sink: Prefix[],
  labels: string[],
  eager: boolean,
): <T extends { compile: () => CompiledFacts }>(
  label: string,
  value: T,
  probe: (v: T) => CompiledFacts,
) => T {
  return (label, value, probe) => {
    labels.push(label)
    const entry: Prefix = { label, probe: () => probe(value) }
    if (eager) entry.eager = probe(value)
    sink.push(entry)
    return value
  }
}

/**
 * Shape 1 — a plain select, with 0-2 joins.
 *
 * The four join combinations are four blocks. They look repetitive on purpose: each block's scope
 * type is different, so each callback destructures a different object, and only writing them out
 * gets that checked.
 */
function plainSelect(
  db: AnyDb,
  h: Handles,
  r: Rng,
  mint: () => string,
  sink: Prefix[],
  labels: string[],
  eager: boolean,
): () => CompiledFacts {
  const record = recorder(sink, labels, eager)
  const combo = int(r, 0, 3)

  if (combo === 0) {
    const base = db.from(h.users)
    type Q0 = typeof base
    const probe = (x: Q0): CompiledFacts => factsOf(x.select(({ users: u }) => ({ probe: u.id })))
    /**
     * `distinct` and `orderBy` are drawn independently again.
     *
     * PostgreSQL requires every `ORDER BY` expression of a `SELECT DISTINCT` to appear in the
     * select list (`42P10`) and this projection is random, so for one day the ordering narrowed to
     * `id` whenever `distinct` was in the chain (seed 2310382765). The builder now **refuses** the
     * pair at compile time with a sentence naming the expression, so the pair is generated again
     * and {@link factsOf}'s caller records the `BuilderError` as the answer rather than as a
     * failure — see `expectedRefusal` in `builder-fuzz.test.ts`.
     */
    const steps: readonly Step<Q0>[] = [
      { label: 'where(users)', apply: (x, rr, m) => x.where(({ users: u }) => combine(rr, int(rr, 0, 2), () => userLeaf(rr, u, m))) },
      {
        label: 'orderBy(users)',
        apply: (x, rr) =>
          x.orderBy(({ users: u }) =>
            chance(rr, 0.5) ? [q.desc(u.createdAt), q.asc(u.id)] : q.asc(u.email),
          ),
      },
      { label: 'limit', apply: (x, rr) => x.limit(int(rr, 1, 50)) },
      { label: 'offset', apply: (x, rr) => x.offset(int(rr, 0, 10)) },
      { label: 'distinct', apply: (x) => x.distinct() },
      { label: 'where(relation)', apply: (x, rr) => x.where(({ users: u }) => (chance(rr, 0.5) ? u.posts.some((p) => q.isTrue(p.published)) : u.posts.none((p) => q.isTrue(p.published)))) },
    ]
    let cur: Q0 = base
    for (const st of stepsFor(steps, r, int(r, 0, 4))) cur = record(st.label, st.apply(cur, r, mint), probe)
    // After `.select(...)` the stage is `Query<S, Project<P>, N>`, and `Query` is INVARIANT in its
    // row type (`[INV]`, design/04 §3.3 — it is what turns `let q = …; if (f) q = q.select(x)` into
    // a compile error). So the pre-select `probe` does not typecheck against it, and each
    // post-select stage gets its own inline lens rather than a cast.
    const selProbe = (x: { select: (f: (t: { users: UserRefs }) => Projection) => { compile: () => CompiledFacts } }): CompiledFacts =>
      factsOf(x.select(({ users: u }) => ({ probe: u.id })))
    const sel = record(
      'select(users)',
      cur.select(({ users: u }) => userProjection(r, u, mint)),
      selProbe,
    )
    const tail = chance(r, 0.3) ? record('limit(after select)', sel.limit(int(r, 1, 20)), selProbe) : sel
    return () => factsOf(tail)
  }

  if (combo === 1) {
    const base = db
      .from(h.users)
      .innerJoin(h.posts, 'p', ({ users: u, p }) => q.eq(p.authorId, u.id))
    type Q1 = typeof base
    const probe = (x: Q1): CompiledFacts =>
      factsOf(x.select(({ users: u, p }) => ({ probe: u.id, probe2: p.id })))
    const steps: readonly Step<Q1>[] = [
      { label: 'where(users)', apply: (x, rr, m) => x.where(({ users: u }) => combine(rr, int(rr, 0, 2), () => userLeaf(rr, u, m))) },
      { label: 'where(posts)', apply: (x, rr, m) => x.where(({ p }) => combine(rr, int(rr, 0, 2), () => postLeaf(rr, p, m))) },
      { label: 'orderBy(join)', apply: (x, rr) => x.orderBy(({ users: u, p }) => (chance(rr, 0.5) ? [q.desc(p.createdAt), q.asc(u.id)] : q.asc(p.id))) },
      { label: 'limit', apply: (x, rr) => x.limit(int(rr, 1, 50)) },
      { label: 'offset', apply: (x, rr) => x.offset(int(rr, 0, 10)) },
    ]
    let cur: Q1 = base
    for (const st of stepsFor(steps, r, int(r, 0, 4))) cur = record(st.label, st.apply(cur, r, mint), probe)
    const sel = record(
      'select(join)',
      cur.select(({ users: u, p }) => ({ ...userProjection(r, u, mint), ...postProjection(r, p, mint) })),
      (x: { select: (f: (t: { users: UserRefs; p: PostRefs }) => Projection) => { compile: () => CompiledFacts } }) =>
        factsOf(x.select(({ users: u, p }) => ({ probe: u.id, probe2: p.id }))),
    )
    return () => factsOf(sel)
  }

  if (combo === 2) {
    const base = db
      .from(h.posts)
      .leftJoin(h.comments, 'c', ({ posts: p, c }) => q.eq(c.postId, p.id))
    type Q2 = typeof base
    const probe = (x: Q2): CompiledFacts =>
      factsOf(x.select(({ posts: p, c }) => ({ probe: p.id, probe2: c.id })))
    const steps: readonly Step<Q2>[] = [
      { label: 'where(posts)', apply: (x, rr, m) => x.where(({ posts: p }) => combine(rr, int(rr, 0, 2), () => postLeaf(rr, p, m))) },
      { label: 'where(leftJoined)', apply: (x, rr, m) => x.where(({ c }) => combine(rr, int(rr, 0, 1), () => commentLeaf(rr, c, m))) },
      { label: 'orderBy(posts)', apply: (x, rr) => x.orderBy(({ posts: p }) => (chance(rr, 0.5) ? [q.asc(p.id)] : q.desc(p.createdAt))) },
      { label: 'limit', apply: (x, rr) => x.limit(int(rr, 1, 50)) },
      {
        label: 'distinctOn',
        apply: (x) =>
          x
            .distinctOn(({ posts: p }) => p.authorId)
            .orderBy(({ posts: p }) => [q.asc(p.authorId), q.desc(p.createdAt)]),
      },
    ]
    let cur: Q2 = base
    /**
     * `distinctOn` wherever it was drawn — **after** a plain `orderBy` included.
     *
     * `.orderBy()` APPENDS (`src/query/select.ts`) and PostgreSQL requires a `DISTINCT ON` list to
     * match the *initial* `ORDER BY` expressions, so a plain `orderBy` step drawn before the
     * `distinctOn` step was `42P10 SELECT DISTINCT ON expressions must match initial ORDER BY
     * expressions` — found by this fuzzer on its first 5 000-case live run (design/09 §3.7). The
     * step list was reordered to hide it; the compiler now makes the emitted `ORDER BY` lead with
     * the `DISTINCT ON` expressions (`compile/hoist.ts`'s `alignDistinctOn`), so the draw stands.
     */
    for (const st of stepsFor(steps, r, int(r, 0, 3))) cur = record(st.label, st.apply(cur, r, mint), probe)
    const sel = record(
      'select(leftJoin)',
      cur.select(({ posts: p, c }) => ({ ...postProjection(r, p, mint), ...commentProjection(r, c) })),
      (x: { select: (f: (t: { posts: PostRefs; c: NullCommentRefs }) => Projection) => { compile: () => CompiledFacts } }) =>
        factsOf(x.select(({ posts: p, c }) => ({ probe: p.id, probe2: c.id }))),
    )
    return () => factsOf(sel)
  }

  const base = db
    .from(h.users)
    .innerJoin(h.posts, 'p', ({ users: u, p }) => q.eq(p.authorId, u.id))
    .leftJoin(h.comments, 'c', ({ p, c }) => q.eq(c.postId, p.id))
  type Q3 = typeof base
  const probe = (x: Q3): CompiledFacts =>
    factsOf(x.select(({ users: u, p, c }) => ({ probe: u.id, probe2: p.id, probe3: c.id })))
  const steps: readonly Step<Q3>[] = [
    { label: 'where(users)', apply: (x, rr, m) => x.where(({ users: u }) => combine(rr, int(rr, 0, 2), () => userLeaf(rr, u, m))) },
    { label: 'where(posts)', apply: (x, rr, m) => x.where(({ p }) => combine(rr, int(rr, 0, 1), () => postLeaf(rr, p, m))) },
    { label: 'orderBy(3-way)', apply: (x) => x.orderBy(({ users: u, p }) => [q.asc(u.id), q.desc(p.createdAt)]) },
    { label: 'limit', apply: (x, rr) => x.limit(int(rr, 1, 25)) },
  ]
  let cur: Q3 = base
  for (const st of stepsFor(steps, r, int(r, 0, 4))) cur = record(st.label, st.apply(cur, r, mint), probe)
  const sel = record(
    'select(3-way)',
    cur.select(({ users: u, p, c }) => ({
      ...userProjection(r, u, mint),
      ...postProjection(r, p, mint),
      ...commentProjection(r, c),
    })),
    (x: {
      select: (
        f: (t: { users: UserRefs; p: PostRefs; c: NullCommentRefs }) => Projection,
      ) => { compile: () => CompiledFacts }
    }) => factsOf(x.select(({ users: u, p, c }) => ({ probe: u.id, probe2: p.id, probe3: c.id }))),
  )
  return () => factsOf(sel)
}

/** Shape 2 — `groupBy` + `having` + aggregates, the stage with the relation guard on its scope. */
function groupedSelect(
  db: AnyDb,
  h: Handles,
  r: Rng,
  mint: () => string,
  sink: Prefix[],
  labels: string[],
  eager: boolean,
): () => CompiledFacts {
  const record = recorder(sink, labels, eager)
  const grouped = db
    .from(h.posts)
    .where(({ posts: p }) => combine(r, int(r, 0, 1), () => postLeaf(r, p, mint)))
    .groupBy(({ posts: p }) => (chance(r, 0.5) ? p.authorId : [p.authorId, p.published]))
  type G = typeof grouped
  const probe = (x: G): CompiledFacts => factsOf(x.select(({ posts: p }) => ({ probe: p.authorId })))
  const withHaving = chance(r, 0.6)
    ? record('having', grouped.having(({ posts: p }) => q.gt(q.fn.count(p.id), 0n)), probe)
    : record('groupBy', grouped, probe)
  const projected = withHaving.select(({ posts: p }) => ({
    author: p.authorId,
    n: q.fn.count(p.id),
    total: q.fn.sum(p.amount),
  }))
  const ordered = chance(r, 0.5) ? projected.orderBy(({ posts: p }) => q.asc(p.authorId)) : projected
  return () => factsOf(ordered)
}

/** Shape 3 — a windowed projection, named window or inline spec. */
function windowedSelect(db: AnyDb, h: Handles, r: Rng, mint: () => string): () => CompiledFacts {
  const base = db.from(h.posts).where(({ posts: p }) => combine(r, int(r, 0, 1), () => postLeaf(r, p, mint)))
  if (chance(r, 0.5)) {
    const named = base
      .window('w', ({ posts: p }) => ({ partitionBy: [p.authorId], orderBy: [q.desc(p.createdAt), q.asc(p.id)] }))
      .select(({ posts: p }) => ({
        id: p.id,
        rank: q.over(q.fn.rank(), 'w'),
        dense: q.over(q.fn.denseRank(), 'w'),
      }))
    return () => factsOf(named)
  }
  const inline = base.select(({ posts: p }) => ({
    id: p.id,
    n: q.over(q.fn.rowNumber(), (w) => w.partitionBy(p.authorId).orderBy([q.desc(p.createdAt), q.asc(p.id)])),
    run: q.over(q.fn.sum(p.amount), (w) => w.partitionBy(p.authorId).orderBy(q.asc(p.id))),
  }))
  return () => factsOf(inline)
}

/** Shape 4 — a CTE, read back through `fromCte`, optionally chained. */
function cteSelect(db: AnyDb, h: Handles, r: Rng, mint: () => string): () => CompiledFacts {
  const withOne = db.with('recent', (d) =>
    d
      .from(h.posts)
      .where(({ posts: p }) => combine(r, int(r, 0, 1), () => postLeaf(r, p, mint)))
      .orderBy(({ posts: p }) => q.desc(p.createdAt))
      .limit(int(r, 1, 20))
      .select(({ posts: p }) => ({ id: p.id, author: p.authorId, title: p.title })),
  )
  if (chance(r, 0.5)) {
    const read = withOne.fromCte('recent').select(({ recent }) => ({ id: recent.id, title: recent.title }))
    return () => factsOf(read)
  }
  const chained = withOne
    .with('counted', (d) => d.fromCte('recent').select(({ recent }) => ({ author: recent.author })))
    .fromCte('counted')
    .select(({ counted }) => ({ author: counted.author }))
  return () => factsOf(chained)
}

/**
 * Shape 5 — a set operation between two chains that project the same shape.
 *
 * **One arm in four carries a relation projection**, which is the set-operation half of the json
 * finding: `union` / `intersect` / `except` deduplicate, deduplicating compares whole rows, and
 * PostgreSQL cannot compare `json`. The branches are planned with `rowEquality` and come out as
 * `jsonb_agg` (`compile/compiler.ts`'s `isDistinctOp`, `compile/hoist.ts`'s `jsonVariant`); the
 * `… all` spellings are drawn from the same list, so the pair that must *not* switch is generated
 * too. Both branches project `{ v: text, rel: { id: bigint }[] }` — union-compatible by
 * construction, which is what lets a random arm typecheck at all.
 */
function setOpSelect(db: AnyDb, h: Handles, r: Rng, mint: () => string): () => CompiledFacts {
  const withRelation = chance(r, 0.25)
  const op = pick(r, ['union', 'unionAll', 'intersect', 'except'] as const)
  // Drawn before the branch so the two arms consume the same stream in the same order and a seed
  // means the same *chain*, not merely the same shape.
  const relLimit = int(r, 1, 3)
  const wantOrder = chance(r, 0.6)
  const wantLimit = chance(r, 0.5)
  const limitN = int(r, 1, 20)

  // The two arms are written out rather than selected with a ternary, exactly as the four join
  // combinations above are: `union` type-checks that branch 2 projects branch 1's columns, so a
  // ternary would hand it a union of two projections and the check would resolve against the wrong
  // one (`OrmTypeError<'union branch 2 has no column "rel"'>`). Two blocks, two inferred pairs.
  if (withRelation) {
    const left = db
      .from(h.users)
      .where(({ users: u }) => combine(r, int(r, 0, 1), () => userLeaf(r, u, mint)))
      .select(({ users: u }) => ({
        v: u.email,
        rel: u.posts.many((sq) => sq.select((p) => ({ id: p.id })).limit(relLimit)),
      }))
    const right = db
      .from(h.posts)
      .where(({ posts: p }) => combine(r, int(r, 0, 1), () => postLeaf(r, p, mint)))
      .select(({ posts: p }) => ({
        v: p.title,
        rel: p.comments.many((sq) => sq.select((c) => ({ id: c.id })).limit(relLimit)),
      }))
    const joined =
      op === 'union'
        ? left.union(right)
        : op === 'unionAll'
          ? left.unionAll(right)
          : op === 'intersect'
            ? left.intersect(right)
            : left.except(right)
    const ordered = wantOrder ? joined.orderBy((row) => q.asc(row.v)) : joined
    const limited = wantLimit ? ordered.limit(limitN) : ordered
    return () => factsOf(limited)
  }

  const left = db
    .from(h.users)
    .where(({ users: u }) => combine(r, int(r, 0, 1), () => userLeaf(r, u, mint)))
    .select(({ users: u }) => ({ v: u.email }))
  const right = db
    .from(h.posts)
    .where(({ posts: p }) => combine(r, int(r, 0, 1), () => postLeaf(r, p, mint)))
    .select(({ posts: p }) => ({ v: p.title }))
  const joined =
    op === 'union'
      ? left.union(right)
      : op === 'unionAll'
        ? left.unionAll(right)
        : op === 'intersect'
          ? left.intersect(right)
          : left.except(right)
  const ordered = wantOrder ? joined.orderBy((row) => q.asc(row.v)) : joined
  const limited = wantLimit ? ordered.limit(limitN) : ordered
  return () => factsOf(limited)
}

/**
 * Shape 6 — the joins `12` B added: right, full, cross, and the two laterals.
 *
 * Written out as five blocks for the same reason the four `plain` combinations are: each block's
 * scope type is different (a RIGHT join nulls the aliases bound before it, a FULL join both sides,
 * a lateral binds a derived row shape), and only writing them out gets the callbacks checked.
 *
 * Every block ends in a projection drawn from the same helpers as every other shape, so the new
 * joins meet relation projections, `nest` groups and `$all` spreads without a second generator.
 */
function outerJoinSelect(db: AnyDb, h: Handles, r: Rng, mint: () => string): () => CompiledFacts {
  switch (int(r, 0, 4)) {
    case 0: {
      // RIGHT: `users` survives, `posts` may be missing — the mirror of the left-join block.
      const built = db
        .from(h.posts)
        .rightJoin(h.users, 'u', ({ posts: p, u }) => q.eq(p.authorId, u.id))
        .where(({ u }) => combine(r, int(r, 0, 1), () => userLeaf(r, u, mint)))
        .select(({ posts: p, u }) => ({
          ...userProjection(r, u, mint),
          title: p.title,
          grp: chance(r, 0.5) ? nest({ t: p.title }) : q.nestNullable({ t: p.title, at: p.createdAt }),
        }))
      return () => factsOf(built)
    }
    case 1: {
      const built = db
        .from(h.posts)
        .fullJoin(h.users, 'u', ({ posts: p, u }) => q.eq(p.authorId, u.id))
        .select(({ posts: p, u }) => ({
          uid: u.id,
          pid: p.id,
          grp: q.nestNullable({ email: u.email, title: p.title }),
        }))
      return () => factsOf(built)
    }
    case 2: {
      const built = db
        .from(h.tags)
        .crossJoin(h.kv, 'k')
        .where(({ k }) => q.isNotNull(k.v))
        .select(({ tags: t, k }) => ({ name: t.name, v: k.v, grp: nest({ id: t.id }) }))
      return () => factsOf(built)
    }
    case 3: {
      // An inner lateral correlated on the outer alias — the shape a per-parent top-N wants.
      const built = db
        .from(h.users)
        .innerJoinLateral(
          (t) =>
            db
              .from(h.posts)
              .where(({ posts: p }) => q.eq(p.authorId, t.users.id))
              .orderBy(({ posts: p }) => [q.desc(p.createdAt), q.asc(p.id)])
              .limit(int(r, 1, 4))
              .select(({ posts: p }) => ({ id: p.id, title: p.title })),
          'recent',
          chance(r, 0.4) ? ({ recent }) => q.isNotNull(recent.title) : undefined,
        )
        .select(({ users: u, recent }) => ({
          ...userProjection(r, u, mint),
          rid: recent.id,
          rtitle: recent.title,
        }))
      return () => factsOf(built)
    }
    default: {
      const built = db
        .from(h.users)
        .leftJoinLateral(
          (t) =>
            db
              .from(h.comments)
              .innerJoin(h.posts, 'p', ({ comments: c, p }) => q.eq(c.postId, p.id))
              .where(({ p }) => q.eq(p.authorId, t.users.id))
              .limit(int(r, 1, 3))
              .select(({ comments: c }) => ({ id: c.id, body: c.body })),
          'cs',
        )
        .select(({ users: u, cs }) => ({
          email: u.email,
          cid: cs.id,
          grp: q.nestNullable({ body: cs.body }),
        }))
      return () => factsOf(built)
    }
  }
}

/**
 * Weighted shape choice. Plain select dominates because it is the shape with the most degrees of
 * freedom — the others are narrower templates whose value is that they exist at all.
 */
const SHAPES = [
  'plain',
  'plain',
  'plain',
  'plain',
  'grouped',
  'windowed',
  'cte',
  'setop',
  'outerjoin',
] as const

export interface ChainOptions {
  /**
   * Compile every intermediate builder **at the moment it is created**, before the chain
   * continues. Invariant (f) generates each case twice — once eager, once not — and compares; see
   * `builder-fuzz.test.ts`.
   */
  readonly eager?: boolean
}

/**
 * One deterministic chain from one seed.
 *
 * Prefixes are captured for the `plain` and `grouped` shapes, which is where the type-preserving
 * steps live and therefore where in-place mutation could hide. `windowed`, `cte` and `setop` are
 * single fixed templates with no random step list, so they contribute a final statement to (a)-(e′)
 * and nothing to (f) — stated here rather than left to be discovered.
 */
export function makeChain(db: AnyDb, h: Handles, seed: number, opts: ChainOptions = {}): Chain {
  const r = rng(seed)
  const mint = mintFor(r)
  const shape = pick(r, SHAPES)
  const prefixes: Prefix[] = []
  const labels: string[] = []
  const eager = opts.eager === true

  const compile =
    shape === 'plain'
      ? plainSelect(db, h, r, mint, prefixes, labels, eager)
      : shape === 'grouped'
        ? groupedSelect(db, h, r, mint, prefixes, labels, eager)
        : shape === 'windowed'
          ? windowedSelect(db, h, r, mint)
          : shape === 'cte'
            ? cteSelect(db, h, r, mint)
            : shape === 'outerjoin'
              ? outerJoinSelect(db, h, r, mint)
              : setOpSelect(db, h, r, mint)

  if (labels.length === 0) labels.push(shape)
  return { seed, shape, labels, prefixes, compile }
}

/** The seed stream, the same arithmetic `generator.ts`'s `cases()` uses, so the two never collide. */
export function* seeds(count: number, baseSeed: number): Generator<number> {
  for (let i = 0; i < count; i++) yield (baseSeed + i * 0x9e3779b1) >>> 0
}
