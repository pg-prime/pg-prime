/**
 * The SELECT builder and the set-operation stage (design/09 WS4; `03` §2.1–2.3, 2.8).
 *
 * ## One class, three type-level stages
 *
 * `Query`, `GroupedQuery` and `SetQuery` are separate *interfaces* — that is `04` §4's "a named
 * interface per builder stage", and it is what keeps the `GROUP BY` guard's conditionals off every
 * ungrouped query in the program. At runtime they are one shape: {@link SelectBuilder} carries
 * every method and the type system decides which are reachable. Nothing branches on a stage tag,
 * because there isn't one.
 *
 * ## Immutability, and what it actually costs
 *
 * Every method returns a **new builder over a new frozen state record**. That copies about a dozen
 * pointers. It never walks the AST and never clones a node, because nodes are frozen at
 * construction (`mkNode`) and can therefore be shared by reference between a query and its
 * derivatives. `.compile()` memoises on the *instance*; deriving produces a different instance, so
 * the memo cannot go stale.
 *
 * ## Repeated clauses
 *
 * `.where()` twice ANDs; `.orderBy()` twice appends. Both are the reading a caller expects from
 * `q.$if(admin, q => q.where(...))`, and both are total — there is no clause a second call can
 * silently discard. `.select()`, `.limit()` and `.offset()` replace, because there is only one of
 * each in the grammar.
 */

import type { CodecRegistry } from '../codec/index.js'
import { int4Codec } from '../codec/index.js'
import type {
  CteNode,
  Expr as Node,
  JoinNode,
  NamedWindow,
  OrderItem,
  ProjectionItem,
  SelectNode,
  SetOpNode,
} from '../compile/ast.js'
import type { Compiled } from '../compile/contract.js'
import { codecOf } from '../compile/hoist.js'
import { compile as compileAst } from '../compile/compiler.js'
import { and as andNode, join as joinNode, param, scalarSubquery, select, setop } from '../compile/nodes.js'
import { NAME } from '../schema/index.js'
import type { TableRuntime } from '../schema/index.js'
import { BuilderError } from '../sql/errors.js'
import type { BuilderCtx, SelectState, SetOpState } from './builder-state.js'
import { queryAstOf } from './nominal.js'
import { registerBuilder } from './nominal.js'
import type { RefScope } from './ref.js'
import {
  allOf,
  compileProjection,
  fieldsOfQuery,
  NO_LEFT_JOINS,
  outputColumn,
  registerDerived,
  scopeFor,
  sourceOf,
  toExprList,
  toExprNode,
  toOrderItems,
} from './scope.js'
import type { ExplainOptions, ExplainResult, StreamOptions } from './executor.js'
import type { PrepareOptions, PreparedQueryImpl } from './prepared.js'
import { prepareFrom } from './prepared.js'
import type { SqlSnapshot } from './terminals.js'
import { explainWith, runnerOf, streamWith, takeFirst, toSQLOf } from './terminals.js'
import { oneOf, toWindowDef } from './window.js'
import type { WindowFn, WindowLiteral, WindowSpec } from './window.js'

type Scope = Readonly<Record<string, RefScope>>
type Sources = Readonly<Record<string, object>>
type Lambda<R> = (t: never) => R

/**
 * Every alias's scope, derived against the full alias set of the statement.
 *
 * Exported because `update`'s `fromValues` and `delete`'s `using` widen a statement exactly the
 * same way, and the avoid-list has to be the same list in all three.
 */
export function rebuildScope(sources: Sources, ctx: BuilderCtx): Scope {
  const aliases = Object.keys(sources)
  const out: Record<string, RefScope> = {}
  for (const alias of aliases) {
    out[alias] = scopeFor(sources[alias] as object, alias, ctx, aliases)
  }
  return Object.freeze(out)
}

/** Drop keys whose value is `undefined` so a builder's AST is `toStrictEqual` to a hand-built one. */
function compact<T extends Record<string, unknown>>(o: T): T {
  // A copy, not `delete`. Deleting a property moves the object into V8's dictionary mode, and the
  // node constructor then spreads that dictionary into the frozen node. Measured in situ by
  // reverting all six copies of this function to `delete` and re-running `bench:compile`
  // (design/09 §3.7 follow-up): the four-column simple select allocates **8 387 B against
  // 6 932 B** — 21 % of the whole compile — and design/08 §5's throughput line reads 184 791/s
  // against ~245 000/s; design/03 §1.1's query allocates 33 435 B against 31 099 B. It is the
  // largest single allocation win of that pass. Every caller hands in a fresh object literal, so
  // returning a different object is invisible.
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(o)) {
    const v = o[k]
    if (v !== undefined) out[k] = v
  }
  return out as T
}

function call<R>(f: Lambda<R>, scope: Scope): R {
  // Scope lambdas run HERE — at the call site, exactly once (09 WS4's contract). Never at
  // `.compile()` time, so a `Date.now()` inside a callback happens where the reader sees it and
  // two `.compile()` calls cannot produce two different queries.
  return (f as unknown as (t: Scope) => R)(scope)
}

/** A synthetic `TableRuntime` for a derived table — enough to be a handle, claiming nothing. */
export function derivedRuntime(name: string): TableRuntime {
  return { name, schema: undefined, columns: [], extras: [], column: () => undefined }
}

/**
 * ## A branch keeps its own `WITH`
 *
 * A set operation has no `WITH` slot in our AST, and hoisting both branches' CTE lists onto the
 * left-most select would be wrong rather than tidy: the emitter parenthesises a branch that opens
 * with `WITH` (it must — `… union with "c" as (…) select …` is 42601), and a name declared inside
 * `( … )` is not visible to the other branch. So each branch carries the CTEs it references, which
 * is self-contained and correct at the cost of repeating a shared declaration's text.
 */

// ─────────────────────────────────────────────────────────────────────────────
// SELECT
// ─────────────────────────────────────────────────────────────────────────────

export class SelectBuilder {
  readonly s: SelectState
  #ast: SelectNode | undefined
  #compiled: Compiled<unknown> | undefined

  constructor(s: SelectState) {
    this.s = Object.freeze(s)
    registerBuilder(this)
  }

  #next(patch: Partial<SelectState>): SelectBuilder {
    return new SelectBuilder({ ...this.s, ...patch })
  }

  get #registry(): CodecRegistry {
    return this.s.ctx.registry
  }

  // ── projection ────────────────────────────────────────────────────────────

  /**
   * The aliases this statement brought in with a LEFT JOIN — what decides whether a
   * `nestNullable({...})` in the projection can be null, and which of its members say so.
   * See `groupWitnesses` in `./projection.ts`.
   */
  get #leftJoined(): ReadonlySet<string> {
    let out: Set<string> | undefined
    for (const j of this.s.joins) {
      if (j.type !== 'left') continue
      out ??= new Set<string>()
      out.add(j.item.alias)
    }
    return out ?? NO_LEFT_JOINS
  }

  select(f: Lambda<Record<string, unknown>>): SelectBuilder {
    return this.#next({ projection: compileProjection(call(f, this.s.scope), this.#leftJoined) })
  }

  selectAll(alias: string): SelectBuilder {
    const scope = this.s.scope[alias]
    if (scope === undefined) throw unknownAlias(alias, this.s.scope)
    // `allOf` is refs only — no group can appear — so the join set is immaterial here.
    return this.#next({ projection: compileProjection(allOf(scope), NO_LEFT_JOINS) })
  }

  /**
   * `select distinct` — every output column compared, which has two consequences the compiler
   * handles rather than leaving to the server (`03` §2.8 / §2.3 AS BUILT 2026-08-27): an
   * `.orderBy()` on an expression the projection does not carry is a `BuilderError` at
   * `.compile()` (PostgreSQL's `42P10`, and no repair for it is the same query), and a relation
   * projection is built as `jsonb` rather than `json`, because `json` has no equality operator.
   */
  distinct(): SelectBuilder {
    return this.#next({ distinct: {} })
  }

  /**
   * `distinct on (…)` — PG-only, and the reason "latest row per group" needs no window (03 §2.8).
   *
   * **The emitted `ORDER BY` always leads with these expressions**, in this order, followed by
   * whatever `.orderBy()` added — because PostgreSQL requires the `DISTINCT ON` list to match the
   * *initial* `ORDER BY` expressions (`42P10`) and `.orderBy()` appends, so writing
   * `.distinctOn(a).orderBy(desc(b))` and meaning "the greatest `b` for each `a`" is the ordinary
   * case rather than a mistake. A list that already leads with them keeps its own direction and
   * `nulls` placement untouched. See `03` §2.8's AS BUILT note of 2026-08-27 and `alignDistinctOn`
   * in `src/compile/hoist.ts`.
   */
  distinctOn(f: Lambda<unknown>): SelectBuilder {
    return this.#next({ distinct: { on: toExprList(call(f, this.s.scope), 'distinctOn()') } })
  }

  // ── predicates and clauses ────────────────────────────────────────────────

  where(f: Lambda<unknown>): SelectBuilder {
    return this.#next({ where: conjoin(this.s.where, toExprNode(call(f, this.s.scope), 'where()')) })
  }

  having(f: Lambda<unknown>): SelectBuilder {
    return this.#next({
      having: conjoin(this.s.having, toExprNode(call(f, this.s.scope), 'having()')),
    })
  }

  groupBy(f: Lambda<unknown>): SelectBuilder {
    return this.#next({ groupBy: toExprList(call(f, this.s.scope), 'groupBy()') })
  }

  orderBy(f: Lambda<unknown>): SelectBuilder {
    return this.#next({ orderBy: [...this.s.orderBy, ...toOrderItems(call(f, this.s.scope))] })
  }

  /** The bind is `int4`, not text: `limit '20'` plans differently and casts on every row. */
  limit(n: number): SelectBuilder {
    return this.#next({ limit: param(n, int4Codec) })
  }

  offset(n: number): SelectBuilder {
    return this.#next({ offset: param(n, int4Codec) })
  }

  /**
   * A named window (03 §2.8). The callback may return either spelling the module documents:
   * `t => ({ partitionBy: [...] })` or `t => w => w.partitionBy(...)`.
   */
  window(name: string, f: Lambda<WindowSpec | WindowLiteral | WindowFn>): SelectBuilder {
    if (this.s.windows.some((w) => w.name === name)) {
      throw new BuilderError(
        `pg-prime: a window named "${name}" is already declared on this query. Rename one.`,
      )
    }
    const entry: NamedWindow = { name, def: toWindowDef(call(f, this.s.scope)) }
    return this.#next({ windows: [...this.s.windows, entry] })
  }

  /**
   * Row locking. `skip locked` is what makes a queue workload possible (03 §2.8).
   *
   * `strength` and `wait` are spliced into the SQL text as keywords, so they are checked against
   * their closed sets **here**, at the boundary. The TS union alone is not a guard: a value that
   * arrives from untyped JavaScript — a request body, a config file — is a string like any other,
   * and `{ wait: 'nowait; drop table users --' }` would otherwise be emitted verbatim.
   */
  forUpdate(opts: LockOpts = {}): SelectBuilder {
    return this.#next({
      locking: compact({
        strength: oneOf(opts.strength ?? 'update', LOCK_STRENGTHS, 'forUpdate({ strength })'),
        of: opts.of,
        wait: oneOf(opts.wait ?? 'block', LOCK_WAITS, 'forUpdate({ wait })'),
      }) as SelectNode['locking'],
    })
  }

  // ── joins ─────────────────────────────────────────────────────────────────

  innerJoin(h: object, a: string | Lambda<unknown>, on?: Lambda<unknown>): SelectBuilder {
    return this.#join('inner', h, a, on)
  }

  leftJoin(h: object, a: string | Lambda<unknown>, on?: Lambda<unknown>): SelectBuilder {
    return this.#join('left', h, a, on)
  }

  /**
   * `.innerJoin(users, on)` and `.innerJoin(users, 'u', on)` are the same call: the alias defaults
   * to the source's own key, and naming it is how a self-join gets two scopes (03 §2.1).
   */
  #join(
    type: JoinNode['type'],
    h: object,
    a: string | Lambda<unknown>,
    on: Lambda<unknown> | undefined,
  ): SelectBuilder {
    const source = sourceOf(h)
    const alias = typeof a === 'string' ? a : source.name
    const onFn = typeof a === 'string' ? on : a
    if (onFn === undefined) {
      throw new BuilderError(`pg-prime: ${type} join on "${alias}" needs an ON predicate.`)
    }
    const widened = this.#widen(h, alias)
    const item = source.fromItem(alias, false)
    const node = joinNode(
      type,
      item,
      toExprNode(call(onFn, widened.scope), `${type} join on "${alias}"`),
    )
    return this.#next({ joins: [...this.s.joins, node], ...widened })
  }

  /**
   * Bind one more alias, and **rebuild every scope** against the new alias set.
   *
   * The rebuild is not bookkeeping. A relation accessor picks its child's alias when the scope is
   * built, avoiding the names already visible; joining `posts` afterwards makes `"posts"` mean two
   * different things, and `u.posts.many(sq => sq.where(c => gt(c.id, p.id)))` then compiles to
   * `"posts"."id" > "posts"."id"` — well-formed SQL, no error, empty result for every row. So the
   * avoid-list is every alias bound in the statement, and every scope is re-derived whenever it
   * grows.
   */
  #widen(h: object, alias: string): { scope: Scope; sources: Sources } {
    if (this.s.scope[alias] !== undefined) throw aliasTaken(alias)
    checkAlias(alias)
    const sources = Object.freeze({ ...this.s.sources, [alias]: h })
    return { scope: rebuildScope(sources, this.s.ctx), sources }
  }

  // ── composition (03 §1.5, kysely.md B.1) ──────────────────────────────────

  $call(f: (q: SelectBuilder) => SelectBuilder): SelectBuilder {
    return f(this)
  }

  $if(cond: boolean, f: (q: SelectBuilder) => SelectBuilder): SelectBuilder {
    return cond ? f(this) : this
  }

  // ── set operations (03 §2.8) ──────────────────────────────────────────────

  union(q: unknown): SetOpBuilder {
    return this.#setop('union', q)
  }
  unionAll(q: unknown): SetOpBuilder {
    return this.#setop('union all', q)
  }
  intersect(q: unknown): SetOpBuilder {
    return this.#setop('intersect', q)
  }
  intersectAll(q: unknown): SetOpBuilder {
    return this.#setop('intersect all', q)
  }
  except(q: unknown): SetOpBuilder {
    return this.#setop('except', q)
  }
  exceptAll(q: unknown): SetOpBuilder {
    return this.#setop('except all', q)
  }

  #setop(op: SetOpNode['op'], q: unknown): SetOpBuilder {
    const left = this.toAst()
    return makeSetOp(this.s.ctx, setop({ op, left, right: queryAstOf(q, `.${opMethod(op)}()`) }), left)
  }

  // ── terminals ─────────────────────────────────────────────────────────────

  /**
   * The query as a scalar expression (`03` §2.8): `(select max(...) from ... where ...)`.
   * Its result codec is the projection's single column, so the value decodes exactly.
   */
  asScalar(): unknown {
    const items = this.s.projection
    if (items === undefined || items.length !== 1) {
      throw new BuilderError(
        `pg-prime: asScalar() needs a projection with exactly one column (got ${items?.length ?? 0}).`,
      )
    }
    const only = items[0] as ProjectionItem
    // A `nest({...})` group and a relation projection are several columns wearing one key, so
    // there is no single value for the subquery to be. Their placeholder `expr` is a NULL
    // literal, which would otherwise decode every row as `null` under `unknown`.
    if (only.group !== undefined || only.nested !== undefined) {
      throw new BuilderError(
        `pg-prime: asScalar() needs one *column*; "${only.key}" is a ` +
          `${only.group !== undefined ? 'nest({...}) group' : 'relation projection'}, which is ` +
          `several columns. Project the one value you want.`,
      )
    }
    return scalarSubquery(this.toAst(), codecOf(only.expr))
  }

  /** The query as a derived table: `.from(db.from(posts).select(…).as('recent'))` (03 §2.8). */
  as(name: string): object {
    const node = this.toAst()
    const handle = { [NAME]: name, $: derivedRuntime(name) }
    registerDerived(handle, name, node, fieldsOfQuery(node))
    return handle
  }

  toAst(): SelectNode {
    if (this.#ast === undefined) {
      // 03 §2.1: there is no implicit `select *`. An unprojected builder used to compile to
      // `select` with an empty list, which is neither what the caller asked for nor legal SQL.
      if (this.s.projection === undefined) throw needsSelect()
      this.#ast = select(
        compact({
          with: this.s.ctes.length > 0 ? this.s.ctes : undefined,
          distinct: this.s.distinct,
          projection: this.s.projection,
          from: this.s.from,
          joins: this.s.joins.length > 0 ? this.s.joins : undefined,
          where: this.s.where,
          groupBy: this.s.groupBy,
          having: this.s.having,
          windows: this.s.windows.length > 0 ? this.s.windows : undefined,
          orderBy: this.s.orderBy.length > 0 ? this.s.orderBy : undefined,
          limit: this.s.limit,
          offset: this.s.offset,
          locking: this.s.locking,
        }) as Omit<SelectNode, 'k'>,
      )
    }
    return this.#ast
  }

  compile(): Compiled<unknown> {
    // 03 §1.4a: memoised on the INSTANCE. A builder cannot change, so the memo cannot go stale;
    // deriving produces a different instance and therefore a different (empty) memo.
    this.#compiled ??= compileAst(this.toAst())
    return this.#compiled
  }


  async execute(): Promise<unknown[]> {
    if (this.s.projection === undefined) throw needsSelect()
    return runnerOf(this.s.ctx).run(this.compile())
  }

  /** `rows[0]`. See `terminals.ts` for why this is not `maxRows: 1`. */
  async executeTakeFirst(): Promise<unknown> {
    return takeFirst(await this.execute())
  }

  /** The compiled artifact with typed holes (03 §1.4b). */
  prepare(name?: string, opts?: PrepareOptions): PreparedQueryImpl<unknown> {
    if (this.s.projection === undefined) throw needsSelect()
    return prepareFrom(this.s.ctx, this.compile(), name, opts)
  }

  /** Transaction-scoped server-side cursor (07 §6.3). */
  stream(opts?: StreamOptions): AsyncIterable<unknown> {
    if (this.s.projection === undefined) throw needsSelect()
    return streamWith(this.s.ctx, this.compile(), opts)
  }

  explain(opts?: ExplainOptions): Promise<ExplainResult> {
    return explainWith(this.s.ctx, this.compile(), opts)
  }

  /** Never throws — not on an unfilled placeholder, and not on a query with no executor. */
  toSQL(): SqlSnapshot {
    return toSQLOf(this.compile())
  }
}

function needsSelect(): BuilderError {
  return new BuilderError(
    'pg-prime: .select() is required before this query can be used — there is no implicit ' +
      'SELECT *, so the result shape is always explicit (03 §2.1).',
  )
}

export interface LockOpts {
  readonly strength?: 'update' | 'no key update' | 'share' | 'key share'
  readonly of?: readonly string[]
  readonly wait?: 'block' | 'nowait' | 'skip locked'
}

const LOCK_STRENGTHS = ['update', 'no key update', 'share', 'key share'] as const
const LOCK_WAITS = ['block', 'nowait', 'skip locked'] as const

/** The method a set-operation node came from, for an error message. */
function opMethod(op: SetOpNode['op']): string {
  return op.replace(/ (\w)/g, (_m, c: string) => c.toUpperCase())
}

function aliasTaken(alias: string): BuilderError {
  return new BuilderError(
    `pg-prime: alias "${alias}" is already in scope. Give the second one a name — ` +
      `.innerJoin(t, 'other', …).`,
  )
}

/**
 * `_r1`, `_r2`, … are the compiler's own names for the LATERALs and shared subqueries it hoists
 * (`src/compile/hoist.ts`). A user alias in that shape collides with one of them at emit time and
 * the server answers 42712 — a name clash a caller cannot debug from the SQL, because both
 * occurrences look deliberate.
 */
const RESERVED_ALIAS = /^_r\d+$/

export function checkAlias(alias: string): string {
  if (RESERVED_ALIAS.test(alias)) {
    throw new BuilderError(
      `pg-prime: "${alias}" is reserved — the compiler names its own hoisted subqueries _r1, _r2, ` +
        `…, and a user alias in that shape collides with one. Pick another name.`,
    )
  }
  return alias
}

function conjoin(existing: Node | undefined, added: Node): Node {
  return existing === undefined ? added : andNode(existing, added)
}

function unknownAlias(alias: string, scope: Scope): BuilderError {
  return new BuilderError(
    `pg-prime: no alias "${alias}" in scope (have: ${Object.keys(scope).join(', ') || 'none'}).`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Set operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A finished set operation. Deliberately narrower than {@link SelectBuilder}: PostgreSQL applies
 * `ORDER BY` / `LIMIT` / `OFFSET` to the whole result and there is no scope left to filter or join
 * against, so those methods are absent rather than present-and-wrong (03 §2.8).
 */
export class SetOpBuilder {
  readonly s: SetOpState
  #ast: SetOpNode | undefined
  #compiled: Compiled<unknown> | undefined

  constructor(s: SetOpState) {
    this.s = Object.freeze(s)
    registerBuilder(this)
  }

  #next(patch: Partial<SetOpState>): SetOpBuilder {
    return new SetOpBuilder({ ...this.s, ...patch })
  }

  orderBy(f: Lambda<unknown>): SetOpBuilder {
    const items = toOrderItems((f as unknown as (r: unknown) => unknown)(this.s.resultRefs))
    return this.#next({ orderBy: [...this.s.orderBy, ...items] })
  }

  limit(n: number): SetOpBuilder {
    return this.#next({ limit: param(n, int4Codec) })
  }

  offset(n: number): SetOpBuilder {
    return this.#next({ offset: param(n, int4Codec) })
  }

  union(q: unknown): SetOpBuilder {
    return this.#chain('union', q)
  }
  unionAll(q: unknown): SetOpBuilder {
    return this.#chain('union all', q)
  }
  intersect(q: unknown): SetOpBuilder {
    return this.#chain('intersect', q)
  }
  intersectAll(q: unknown): SetOpBuilder {
    return this.#chain('intersect all', q)
  }
  except(q: unknown): SetOpBuilder {
    return this.#chain('except', q)
  }
  exceptAll(q: unknown): SetOpBuilder {
    return this.#chain('except all', q)
  }

  #chain(op: SetOpNode['op'], q: unknown): SetOpBuilder {
    return new SetOpBuilder({
      ...this.s,
      node: setop({ op, left: this.toAst(), right: queryAstOf(q, `.${opMethod(op)}()`) }),
      orderBy: [],
      limit: undefined,
      offset: undefined,
    })
  }

  as(name: string): object {
    const node = this.toAst()
    const handle = { [NAME]: name, $: derivedRuntime(name) }
    registerDerived(handle, name, node, fieldsOfQuery(node))
    return handle
  }

  toAst(): SetOpNode {
    this.#ast ??= setop(
      compact({
        op: this.s.node.op,
        left: this.s.node.left,
        right: this.s.node.right,
        orderBy: this.s.orderBy.length > 0 ? this.s.orderBy : undefined,
        limit: this.s.limit,
        offset: this.s.offset,
      }) as Omit<SetOpNode, 'k'>,
    )
    return this.#ast
  }

  compile(): Compiled<unknown> {
    this.#compiled ??= compileAst(this.toAst())
    return this.#compiled
  }


  async execute(): Promise<unknown[]> {
    return runnerOf(this.s.ctx).run(this.compile())
  }

  async executeTakeFirst(): Promise<unknown> {
    return takeFirst(await this.execute())
  }

  prepare(name?: string, opts?: PrepareOptions): PreparedQueryImpl<unknown> {
    return prepareFrom(this.s.ctx, this.compile(), name, opts)
  }

  stream(opts?: StreamOptions): AsyncIterable<unknown> {
    return streamWith(this.s.ctx, this.compile(), opts)
  }

  explain(opts?: ExplainOptions): Promise<ExplainResult> {
    return explainWith(this.s.ctx, this.compile(), opts)
  }

  toSQL(): SqlSnapshot {
    return toSQLOf(this.compile())
  }
}

function makeSetOp(ctx: BuilderCtx, node: SetOpNode, left: SelectNode | SetOpNode): SetOpBuilder {
  const refs: Record<string, Node> = {}
  for (const f of fieldsOfQuery(left)) refs[f.key] = outputColumn(f.key, f.codec)
  return new SetOpBuilder({
    ctx,
    node,
    orderBy: [],
    limit: undefined,
    offset: undefined,
    resultRefs: Object.freeze(refs),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction
// ─────────────────────────────────────────────────────────────────────────────

export function makeSelect(
  ctx: BuilderCtx,
  ctes: readonly CteNode[],
  h: object,
  alias: string | undefined,
): SelectBuilder {
  const source = sourceOf(h)
  const name = checkAlias(alias ?? source.name)
  const sources: Sources = Object.freeze({ [name]: h })
  return new SelectBuilder({
    ctx,
    ctes,
    distinct: undefined,
    projection: undefined,
    from: source.fromItem(name, false),
    joins: [],
    where: undefined,
    groupBy: undefined,
    having: undefined,
    windows: [],
    orderBy: [],
    limit: undefined,
    offset: undefined,
    locking: undefined,
    sources,
    scope: rebuildScope(sources, ctx),
  })
}

export type { OrderItem }
