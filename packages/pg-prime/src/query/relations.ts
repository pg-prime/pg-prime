/**
 * Relation accessors — design/03 §2.3, the differentiator (design/09 WS5).
 *
 * ## One resolved declaration, four emitted shapes
 *
 * `src/schema/relations.ts` has already turned the declaration into a {@link ResolvedRelation}:
 * which table, which columns, which junction, which defaults. Everything below is derived from
 * that and from nothing else, which is `03` §4.1's contract held literally — there is no second
 * source of truth about what a relation means.
 *
 *  | accessor                    | emits                                                        |
 *  |-----------------------------|--------------------------------------------------------------|
 *  | `.many(q)` / `.all()`       | `LEFT JOIN LATERAL (select coalesce(json_agg(…), '[]'))`      |
 *  | `.one(q)`                   | `LEFT JOIN LATERAL (select json_build_object(…) … limit 1)`   |
 *  | `.count()` / `.sum(f)`      | a correlated subquery, hoisted and shared (`03` §2.3 pt 6)    |
 *  | `.exists()/.some/.none/.every` | `EXISTS` / `NOT EXISTS` / null-safe double negation         |
 *
 * ## Per-parent pagination is the whole point
 *
 * `.many(q => q.orderBy(…).limit(3))` puts the `LIMIT` *inside* the lateral, so it is three rows
 * **per parent** and not three rows in total. MikroORM needs `populateHints` and a `select-in`
 * fallback for this; Drizzle's RQB has it but forbids aggregates in the same query. The live
 * suite proves it against a hand-written `row_number() over (partition by …) <= 3`, because this
 * is the one relation semantic that is easy to get subtly, silently wrong.
 *
 * ## Aliases
 *
 * The child is bound under its own registry key (`posts`, `tags`), which is what makes the
 * compiled SQL readable. A child alias may *shadow* a sibling alias of the outer query harmlessly
 * — the correlation only ever names an ancestor — so only a collision with an **ancestor** forces
 * a suffix, and `users` inside a `users` relation becomes `users2`. Everything else the planner
 * generates is named `_rN` so it cannot be confused with something a caller wrote.
 */

import type { CodecRegistry } from '../codec/index.js'
import { int4Codec } from '../codec/index.js'
import type {
  Expr as Node,
  FromItem,
  JoinNode,
  NestedPlan,
  OrderItem,
  ProjectionItem,
  SelectNode,
} from '../compile/ast.js'
import { codecOf } from '../compile/hoist.js'
import {
  and as andNode,
  countStar,
  eq as eqNode,
  exists as existsNode,
  fn as fnNode,
  is as isNode,
  join as joinNode,
  lit,
  param,
  projection,
  scalarSubquery,
  select,
  table as tableFrom,
} from '../compile/nodes.js'
import type { AnyTable, ResolvedRelation } from '../schema/index.js'
import { resolveRelations } from '../schema/index.js'
import { BuilderError } from '../sql/errors.js'
import type { BuilderCtx } from './builder-state.js'
import { fn } from './fn.js'
import type { TableLike } from './meta.js'
import { metaOf } from './meta.js'
import {
  compileProjection,
  makeNested,
  NO_LEFT_JOINS,
  toExprNode,
  toOrderItems,
} from './projection.js'
import type { RefNode, RefScope } from './ref.js'
import { refsOf } from './ref.js'

/** `{ variant, strategy }` — `03` §2.3 points 1 and 5, per relation projection. */
export interface RelOpts {
  readonly variant?: 'json' | 'jsonb'
  readonly strategy?: 'lateral' | 'subquery'
}

// ─────────────────────────────────────────────────────────────────────────────
// Correlation
// ─────────────────────────────────────────────────────────────────────────────

/** Everything a relation's sub-select needs before the caller has said anything about it. */
interface Correlated {
  readonly from: FromItem
  readonly joins: readonly JoinNode[]
  /** The correlation predicate, plus the declaration's own `where` if it has one. */
  readonly where: Node
  readonly refs: RefScope
  /** Refs **and** the child's own relation accessors — one object, per fork F3. */
  readonly scope: RefScope
}

function tableOf(ctx: BuilderCtx, key: string, rel: ResolvedRelation): AnyTable {
  const t = ctx.tables?.[key]
  if (t === undefined) {
    throw new BuilderError(
      `pg-prime: relation "${rel.parent}.${rel.name}" points at table "${key}", which this ` +
        `executor's schema does not have. Build the db from the same \`defineSchema(...)\`.`,
    )
  }
  return t
}

/**
 * A name that no *ancestor* scope already binds.
 *
 * Shadowing a sibling is safe and left alone: the correlation predicate of a lateral only ever
 * names an alias further out, so an inner `"posts"` hiding a joined `"posts"` changes nothing.
 * Shadowing an ancestor is not safe — it would turn `child.parent_id = parent.id` into a
 * self-comparison — so that is the one case that gets a suffix.
 */
function uniqueAlias(want: string, ancestors: readonly string[]): string {
  if (!ancestors.includes(want)) return want
  for (let i = 2; ; i++) {
    const candidate = `${want}${i}`
    if (!ancestors.includes(candidate)) return candidate
  }
}

/**
 * `refsOf`'s untyped overload, reached explicitly.
 *
 * The typed overloads infer `RefsOfCols<A, C>` from a concrete table; here the table is only
 * known to be `AnyTable`, so `C` is `any` and the result is a record of `Ref` phantoms rather
 * than of runtime `RefNode`s. Widening to `TableLike` selects the runtime overload, which is the
 * one this module actually wants — the same seam `src/query/scope.ts` uses.
 */
function refsAt(t: AnyTable, alias: string, registry: CodecRegistry): RefScope {
  return refsOf(t as TableLike, alias, registry)
}

function refAt(scope: RefScope, key: string, where: string): RefNode {
  const r = scope[key]
  if (r === undefined) throw new BuilderError(`pg-prime: ${where} has no column "${key}".`)
  return r
}

function conjoin(a: Node | undefined, b: Node | undefined): Node | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return andNode(a, b)
}

function allOfPreds(preds: readonly Node[]): Node {
  return preds.length === 1 ? (preds[0] as Node) : andNode(...preds)
}

function correlate(
  ctx: BuilderCtx,
  rel: ResolvedRelation,
  parentRefs: RefScope,
  ancestors: readonly string[],
): Correlated {
  const target = tableOf(ctx, rel.target, rel)
  const childAlias = uniqueAlias(rel.alias ?? rel.target, ancestors)
  const inner = [...ancestors, childAlias]
  const refs = refsAt(target, childAlias, ctx.registry)
  const where = `relation "${rel.parent}.${rel.name}"`

  const preds: Node[] = []
  const joins: JoinNode[] = []

  if (rel.through !== undefined) {
    // m2m: parent → junction → target. The junction is an inner join inside the lateral rather
    // than a second lateral, so the planner sees one correlated scan and not two.
    const junction = rel.through.table
    const jAlias = uniqueAlias(junction.$.name, inner)
    inner.push(jAlias)
    const jRefs = refsAt(junction, jAlias, ctx.registry)
    const on = rel.to.map((k, i) =>
      eqNode(
        refAt(jRefs, rel.through!.to[i] as string, `${where} \`through.to\``),
        refAt(refs, k, `${where} \`to\``),
      ),
    )
    joins.push(
      joinNode('inner', tableFrom(metaOf(junction, ctx.registry).table, jAlias), allOfPreds(on)),
    )
    for (let i = 0; i < rel.from.length; i++) {
      preds.push(
        eqNode(
          refAt(jRefs, rel.through.from[i] as string, `${where} \`through.from\``),
          refAt(parentRefs, rel.from[i] as string, `${where} \`from\``),
        ),
      )
    }
  } else {
    for (let i = 0; i < rel.from.length; i++) {
      preds.push(
        eqNode(
          refAt(refs, rel.to[i] as string, `${where} \`to\``),
          refAt(parentRefs, rel.from[i] as string, `${where} \`from\``),
        ),
      )
    }
  }

  const scope = mergeAccessors(ctx, rel.target, childAlias, refs, inner)

  return {
    from: tableFrom(metaOf(target, ctx.registry).table, childAlias),
    joins: Object.freeze(joins),
    where: allOfPreds(preds),
    refs,
    scope,
  }
}

/**
 * The declaration's own `where`, evaluated **per use**.
 *
 * `rel.orderBy` has always been re-run on every accessor call (`nestedOf`), and the contract every
 * scope lambda obeys is "runs at call time". `rel.where` was the exception: it was folded into the
 * memoised `Correlated`, so a declaration like
 * `r.many.posts({ …, where: p => eq(p.tenantId, currentTenant()) })` captured the first tenant the
 * process ever queried and kept it for the process's lifetime. Evaluating it here costs one lambda
 * call per accessor use and makes the two halves of a declaration behave the same way.
 */
function declaredWhere(rel: ResolvedRelation, corr: Correlated): Node | undefined {
  if (rel.where === undefined) return undefined
  return toExprNode(
    (rel.where as (t: unknown) => unknown)(corr.scope),
    `relation "${rel.parent}.${rel.name}" \`where\``,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The relation sub-query
// ─────────────────────────────────────────────────────────────────────────────

interface SubState {
  readonly corr: Correlated
  readonly projection: readonly ProjectionItem[] | undefined
  readonly where: Node | undefined
  readonly orderBy: readonly OrderItem[] | undefined
  readonly limit: Node | undefined
  readonly offset: Node | undefined
}

/**
 * `q` inside `u.posts.many(q => …)`.
 *
 * Immutable for the same reason the outer builders are, and for a sharper one: the accessor reads
 * whatever the lambda *returned*, so a mutating `.where()` would make `q.where(a); return q.limit(1)`
 * and `return q.where(a).limit(1)` differ in a way nobody would predict.
 */
class RelSub {
  readonly s: SubState
  constructor(s: SubState) {
    this.s = Object.freeze(s)
  }
  #next(patch: Partial<SubState>): RelSub {
    return new RelSub({ ...this.s, ...patch })
  }
  #call<R>(f: (t: never) => R): R {
    return (f as unknown as (t: RefScope) => R)(this.s.corr.scope)
  }

  where(f: (t: never) => unknown): RelSub {
    return this.#next({ where: conjoin(this.s.where, toExprNode(this.#call(f), 'where()')) })
  }
  orderBy(f: (t: never) => unknown): RelSub {
    return this.#next({ orderBy: [...(this.s.orderBy ?? []), ...toOrderItems(this.#call(f))] })
  }
  /** A bind, exactly like the parent's `.limit()` — and numbered before it (03 §2.3's golden). */
  limit(n: number): RelSub {
    return this.#next({ limit: param(n, int4Codec) })
  }
  offset(n: number): RelSub {
    return this.#next({ offset: param(n, int4Codec) })
  }
  select(f: (t: never) => Record<string, unknown>): RelSub {
    return this.#next({ projection: compileProjection(this.#call(f), NO_LEFT_JOINS) })
  }
}

function subOf(corr: Correlated): RelSub {
  return new RelSub({
    corr,
    projection: undefined,
    where: undefined,
    orderBy: undefined,
    limit: undefined,
    offset: undefined,
  })
}

function runSub(corr: Correlated, f: ((q: never) => unknown) | undefined): SubState {
  if (f === undefined) return subOf(corr).s
  const out = (f as unknown as (q: RelSub) => unknown)(subOf(corr))
  if (!(out instanceof RelSub)) {
    throw new BuilderError(
      'pg-prime: a relation sub-query callback must return the sub-query it was given — ' +
        '`u.posts.many(q => q.select(...).limit(3))`.',
    )
  }
  return out.s
}

/** Every ref of the child, as a projection record: the `.all()` / no-`.select()` shape. */
function allRefs(refs: RefScope): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(refs)) {
    const v = refs[key]
    if (v !== undefined && typeof v !== 'function' && !Array.isArray(v)) out[key] = v
  }
  return out
}

function compact<T extends Record<string, unknown>>(o: T): T {
  // A copy rather than `delete`, which would put the object into dictionary mode — see the note
  // on the same function in `./select.ts`.
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(o)) {
    const v = o[k]
    if (v !== undefined) out[k] = v
  }
  return out as T
}

function nestedOf(
  kind: NestedPlan['kind'],
  rel: ResolvedRelation,
  s: SubState,
  opts: RelOpts | undefined,
): unknown {
  const corr = s.corr
  const projection = s.projection ?? compileProjection(allRefs(corr.refs), NO_LEFT_JOINS)
  // The declaration's ordering is a *default*: any `.orderBy()` on the sub-query replaces it
  // wholesale, because two orderings that disagree is not a thing a reader can predict.
  const declared =
    rel.orderBy === undefined
      ? undefined
      : toOrderItems((rel.orderBy as (t: unknown) => unknown)(corr.scope))
  const orderBy = s.orderBy ?? declared

  const query: SelectNode = select(
    compact({
      projection,
      from: corr.from,
      joins: corr.joins.length > 0 ? corr.joins : undefined,
      where: conjoin(corr.where, s.where),
      orderBy: orderBy !== undefined && orderBy.length > 0 ? orderBy : undefined,
      limit: s.limit,
      offset: s.offset,
    }) as Omit<SelectNode, 'k'>,
  )

  return makeNested(
    compact({
      kind,
      query,
      variant: opts?.variant,
      required: kind === 'one' ? rel.required : undefined,
      strategy: opts?.strategy,
    }) as NestedPlan,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Scalar accessors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `select <expr> as "v" from <child> where <correlation>`, marked for sharing.
 *
 * The mark is what lets `03` §2.3 point 6 hold: two occurrences of the same aggregate collapse
 * into one `LEFT JOIN LATERAL`, so `revenue` and a `rank()` window that orders by it are computed
 * once. Unhoisted — in a RETURNING list, say — the identical node is still a perfectly good
 * correlated subquery, so the mark can change the plan but never the answer.
 */
function scalarOf(corr: Correlated, value: Node, extraWhere: Node | undefined): unknown {
  return scalarSubquery(
    select(
      compact({
        projection: [projection('v', value)],
        from: corr.from,
        joins: corr.joins.length > 0 ? corr.joins : undefined,
        where: conjoin(corr.where, extraWhere),
      }) as Omit<SelectNode, 'k'>,
    ),
    codecOf(value),
    true,
  )
}

function existsOf(corr: Correlated, extra: Node | undefined, negated: boolean): unknown {
  return existsNode(
    select(
      compact({
        projection: [projection('v', lit(1, int4Codec))],
        from: corr.from,
        joins: corr.joins.length > 0 ? corr.joins : undefined,
        where: conjoin(corr.where, extra),
      }) as Omit<SelectNode, 'k'>,
    ),
    negated,
  )
}

function predicateOf(
  corr: Correlated,
  f: ((t: never) => unknown) | undefined,
  where: string,
): Node | undefined {
  if (f === undefined) return undefined
  return toExprNode((f as unknown as (t: RefScope) => unknown)(corr.scope), where)
}

/**
 * The value an aggregate accessor aggregates: the caller's lambda, run against the child scope.
 *
 * One function for all four (`sum`/`avg`/`min`/`max`) so the error sentence — which names the
 * accessor and the relation — cannot drift between them.
 */
function operandOf(
  corr: Correlated,
  f: (t: never) => unknown,
  what: string,
  rel: ResolvedRelation,
): Node {
  return toExprNode(
    (f as unknown as (t: RefScope) => unknown)(corr.scope),
    `${what}() on relation "${rel.parent}.${rel.name}"`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The accessor object
// ─────────────────────────────────────────────────────────────────────────────

function accessor(
  ctx: BuilderCtx,
  rel: ResolvedRelation,
  parentRefs: RefScope,
  ancestors: readonly string[],
): Record<string, unknown> {
  // One `Correlated` per accessor, built lazily on first use: a scope is built for every alias of
  // every query, and most queries project no relation at all. The *structure* is memoised; the
  // declaration's `where` is not — see `declaredWhere`.
  let memo: Correlated | undefined
  const base = (): Correlated => (memo ??= correlate(ctx, rel, parentRefs, ancestors))
  const corr = (): Correlated => {
    const c = base()
    const declared = declaredWhere(rel, c)
    return declared === undefined ? c : { ...c, where: andNode(c.where, declared) }
  }

  return {
    many: (f?: (q: never) => unknown, opts?: RelOpts) =>
      nestedOf('many', rel, runSub(corr(), f), opts),
    one: (f?: (q: never) => unknown, opts?: RelOpts) =>
      nestedOf('one', rel, runSub(corr(), f), opts),
    all: (opts?: RelOpts) => nestedOf(rel.kind, rel, subOf(corr()).s, opts),

    count: () => scalarOf(corr(), countStar(), undefined),
    sum: (f: (t: never) => unknown) => {
      const c = corr()
      const operand = operandOf(c, f, 'sum', rel)
      // `coalesce(sum(x), 0)`: an empty relation sums to NULL, and `03` §2.3 types `revenue` as a
      // precision-exact string rather than `string | null` — which is only honest if the SQL says
      // so. The zero is a literal of the *result* codec, so `sum(int8)` coalesces against a
      // numeric zero and not an int4 one.
      const agg = fn.sum(operand as never) as unknown as Node
      const codec = codecOf(agg)
      return scalarOf(c, fnNode('coalesce', [agg, lit(0, codec)], codec), undefined)
    },
    // `avg`/`min`/`max` are NOT coalesced, and that is the one thing to know about them next to
    // `sum`. Zero is the sum of no rows; it is not their average, their minimum or their maximum,
    // and a `coalesce(avg(x), 0)` would report a 0 % conversion rate for a user with no orders.
    // The scalar subquery is NULL over an empty relation and the type says so.
    avg: (f: (t: never) => unknown) => {
      const c = corr()
      return scalarOf(c, fn.avg(operandOf(c, f, 'avg', rel) as never) as unknown as Node, undefined)
    },
    min: (f: (t: never) => unknown) => {
      const c = corr()
      return scalarOf(c, fn.min(operandOf(c, f, 'min', rel) as never) as unknown as Node, undefined)
    },
    max: (f: (t: never) => unknown) => {
      const c = corr()
      return scalarOf(c, fn.max(operandOf(c, f, 'max', rel) as never) as unknown as Node, undefined)
    },

    exists: () => existsOf(corr(), undefined, false),
    some: (f?: (t: never) => unknown) => existsOf(corr(), predicateOf(corr(), f, 'some()'), false),
    none: (f?: (t: never) => unknown) => existsOf(corr(), predicateOf(corr(), f, 'none()'), true),
    // Null-safe, which is the whole reason `every` is not `not exists (… and not p)`: a NULL
    // predicate is neither true nor false, and `p is not true` is the only spelling that treats
    // "unknown" as "does not satisfy". Vacuously true on an empty relation, which is what
    // PostgreSQL's own `NOT EXISTS` gives and what `03` §2.3 pins.
    every: (f: (t: never) => unknown) => {
      const c = corr()
      const p = predicateOf(c, f, 'every()')
      return existsOf(c, p === undefined ? undefined : isNode(p, 'not true'), true)
    },
  }
}

/**
 * A `sum()` over a relation needs the aggregate's own result codec, and `fn.sum` already owns the
 * `sum(int8) → numeric` table. Importing it here rather than restating it is deliberate: two
 * copies of that table is exactly how `revenue` would start decoding as a `bigint` in one place
 * and a `string` in another.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Scope integration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The relation accessors declared for `tableKey`, or `undefined` when there are none.
 *
 * Returning `undefined` rather than `{}` is what keeps a relation-free schema paying nothing: the
 * caller then hands back the cached ref record itself, with no copy and no merge.
 */
export function accessorsFor(
  ctx: BuilderCtx,
  tableKey: string,
  refs: RefScope,
  ancestors: readonly string[],
): Record<string, unknown> | undefined {
  if (ctx.tables === undefined || ctx.rels === undefined) return undefined
  const declared = resolveRelations(ctx.tables, ctx.rels)[tableKey]
  if (declared === undefined) return undefined
  const names = Object.keys(declared)
  if (names.length === 0) return undefined
  const out: Record<string, unknown> = {}
  for (const name of names) {
    out[name] = accessor(ctx, declared[name] as ResolvedRelation, refs, ancestors)
  }
  return out
}

/** Refs and accessors in one frozen object, which is fork F3's whole shape. */
export function mergeAccessors(
  ctx: BuilderCtx,
  tableKey: string,
  _alias: string,
  refs: RefScope,
  ancestors: readonly string[],
): RefScope {
  const accessors = accessorsFor(ctx, tableKey, refs, ancestors)
  if (accessors === undefined) return refs
  return Object.freeze({ ...refs, ...accessors }) as RefScope
}
