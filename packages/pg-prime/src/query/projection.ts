/**
 * Projections, and the two markers that can appear in one (design/09 WS4–WS5).
 *
 * A projection record is the one place a *user value* becomes an AST node, so this is where the
 * library decides what is and is not an expression. Two things in a projection are not expressions
 * at all but markers the planner expands:
 *
 *  - **`nest({...})`** (fork F2, `03` §2.2) — pure grouping, zero SQL cost. `hoist.ts` expands it
 *    into ordinary projection columns and the decoder reassembles the object positionally, so the
 *    SQL of a query with `nest` is byte-identical to the same query written flat.
 *  - **a relation projection** (`u.posts.many(…)`, `03` §2.3) — a {@link NestedPlan} that
 *    `hoist.ts` turns into a `LEFT JOIN LATERAL`.
 *
 * Both are nominal: membership in a module-private `WeakSet`, never a structural `'plan' in v`
 * test, for the same reason `nodes.ts` keeps its node registry that way — a plain object out of
 * `JSON.parse` must not be able to pass itself off as one.
 *
 * It lives apart from `./scope.ts` so that `./relations.ts`, which produces both markers, can
 * reach them without closing an import cycle back through the scope builder that consumes it.
 */

import type { AnyCodec, CodecRegistry } from '../codec/index.js'
import { defaultRegistry } from '../codec/index.js'
import type {
  Expr as Node,
  GroupPlan,
  NestedPlan,
  OrderItem,
  ProjectionItem,
} from '../compile/ast.js'
import {
  group as groupItem,
  isAstNode,
  mkNode,
  nested as nestedItem,
  order as orderNode,
  projection,
} from '../compile/nodes.js'
import { isFragment, toNode } from '../sql/fragment.js'
import { quoteIdentPart } from '../sql/ident.js'
import { BuilderError } from '../sql/errors.js'
import type { RefNode } from './ref.js'
import type { Expr, Project, ProjectPreJoin, Projection } from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// nest() — fork F2's runtime
// ─────────────────────────────────────────────────────────────────────────────

interface GroupMarker {
  /**
   * The plan as `nest`/`nestNullable` could build it: eagerly, so a malformed member is reported
   * from the call the caller wrote, and assuming no outer join. Exactly right whenever the
   * enclosing statement has no LEFT JOIN, which is every RETURNING clause and most selects.
   */
  readonly plan: GroupPlan
  /** The caller's record, kept so {@link projectionItem} can rebuild once the joins are known. */
  readonly source: Record<string, unknown>
  readonly nullable: boolean
}

const GROUPS = new WeakSet<object>()

export function isGroup(v: unknown): v is GroupMarker {
  return typeof v === 'object' && v !== null && GROUPS.has(v)
}

/**
 * Reject `__proto__` as a result key, an insert column key or a SET key.
 *
 * It is an own property of a `JSON.parse`d record and of `{['__proto__']: v}`, so `Object.keys`
 * hands it over like any other key — but every consumer downstream writes it into a plain object
 * (`out[key] = …`, `meta.byKey[key]`), where it silently sets the prototype instead of adding a
 * member. A column would vanish from the result, and a lookup would return `Object.prototype`
 * rather than `undefined`. Naming the key in an error is the only outcome that is not a surprise.
 */
export function assertSafeKey(key: string, where: string): string {
  if (key === '__proto__') {
    throw new BuilderError(
      `pg-prime: "__proto__" cannot be used as a ${where} key — it sets an object's prototype ` +
        `rather than a property, so the column would silently disappear. Rename it.`,
    )
  }
  return key
}

/** The {@link RefNode} behind a projected value, or `undefined` if it is not a plain column. */
function asColRef(v: unknown): RefNode | undefined {
  if (!isAstNode(v) || v.k !== 'col') return undefined
  const r = v as RefNode
  return r.$ === undefined ? undefined : r
}

/**
 * A column the schema declares NOT NULL — the witness `nestNullable` needs.
 *
 * When it is null in a result row, the only possible cause is that a LEFT JOIN found no row, so
 * the whole object is `null`. See `GroupPlan` in `src/compile/ast.ts` for the fallback.
 *
 * `arrayDim === 0` because a NOT NULL `text[]` column can still hold an array *containing* nulls;
 * only a scalar's nullness is a clean signal.
 */
function isNotNullRef(r: RefNode): boolean {
  return r.$.column.ddl.notNull === true && r.$.column.ddl.arrayDim === 0
}

/**
 * Which of a nullable group's members decide that the whole object is `null` (`03` §2.2).
 *
 * The rule the *builder* can state and the decoder cannot: a group is null exactly when the
 * outer join that produced its columns found no row, so only a member whose alias was LEFT
 * JOINed is evidence of anything. In preference order:
 *
 *  1. **left-joined members the schema declares NOT NULL** — a null there has one possible cause.
 *  2. **every left-joined member**, when the group projects no NOT NULL one. This is the Drizzle
 *     heuristic ("all fields null ⇒ the object is null"), but narrowed to the columns that can
 *     actually be nulled by the join, so a driving-side column no longer votes.
 *  3. **`[]` — never null** — when the group references no left-joined alias at all. Its columns
 *     all come from the driving side (or from an inner join), so there is no row-absence to
 *     report and the object always exists.
 *
 * This replaces "the first NOT NULL member in key order, whatever its alias", which was wrong in
 * both directions: for `posts p LEFT JOIN users u`, `nestNullable({ pid: p.id, email: u.email })`
 * picked the driving `p.id` and so was *never* null, and merely reordering the two keys changed
 * the answer. Key order is a caller's formatting choice and must not decide nullability.
 */
function groupWitnesses(
  refs: readonly (RefNode | undefined)[],
  leftJoined: ReadonlySet<string>,
): readonly number[] {
  const outer: number[] = []
  const notNull: number[] = []
  for (let i = 0; i < refs.length; i++) {
    const r = refs[i]
    if (r === undefined || !leftJoined.has(r.alias)) continue
    outer.push(i)
    if (isNotNullRef(r)) notNull.push(i)
  }
  return Object.freeze(notNull.length > 0 ? notNull : outer)
}

function buildGroupPlan(
  p: Record<string, unknown>,
  nullable: boolean,
  leftJoined: ReadonlySet<string>,
): GroupPlan {
  const items: ProjectionItem[] = []
  const refs: (RefNode | undefined)[] = []
  let sentinel: number | undefined
  const keys = Object.keys(p)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string
    const value = p[key]
    const ref = asColRef(value)
    refs.push(ref)
    if (sentinel === undefined && ref !== undefined && isNotNullRef(ref)) sentinel = i
    // Recurses: a group nested inside a group needs the same join information to answer the
    // same question about itself.
    items.push(projectionItem(key, value, leftJoined))
  }
  // Only a nullable group has a nullability question, so a plain `nest({...})` carries no
  // `witnesses` and its plan is byte-identical to what it was before.
  return Object.freeze(
    nullable
      ? { items: Object.freeze(items), nullable, sentinel, witnesses: groupWitnesses(refs, leftJoined) }
      : { items: Object.freeze(items), nullable, sentinel },
  )
}

function makeGroup(p: Record<string, unknown>, nullable: boolean): GroupMarker {
  const marker: GroupMarker = Object.freeze({
    plan: buildGroupPlan(p, nullable, NO_LEFT_JOINS),
    source: p,
    nullable,
  })
  GROUPS.add(marker)
  return marker
}

/** Group columns into a nested object in the result. Pure grouping: zero SQL cost (03 §2.2). */
export function nest<P extends Projection>(p: P): Expr<Project<P>> {
  return makeGroup(p as Record<string, unknown>, false) as unknown as Expr<Project<P>>
}

/**
 * As {@link nest}, but the **whole object** is `null` when its source alias was left-joined.
 *
 * Which members decide that is {@link groupWitnesses}' job, and it needs the enclosing
 * statement's join list — so the answer is settled by `compileProjection`, not here. The
 * *static* type always says `| null`; see the note on `nest`/`nestNullable` in `./types.ts` for
 * why that over-approximation is deliberate.
 */
export function nestNullable<P extends Projection>(p: P): Expr<ProjectPreJoin<P> | null> {
  return makeGroup(p as Record<string, unknown>, true) as unknown as Expr<ProjectPreJoin<P> | null>
}

// ─────────────────────────────────────────────────────────────────────────────
// Relation projections (03 §2.3)
// ─────────────────────────────────────────────────────────────────────────────

interface NestedMarker {
  readonly plan: NestedPlan
}

const NESTEDS = new WeakSet<object>()

export function isNested(v: unknown): v is NestedMarker {
  return typeof v === 'object' && v !== null && NESTEDS.has(v)
}

/**
 * Wrap a {@link NestedPlan} as a projectable value.
 *
 * It is a marker rather than an AST node because a relation is not an expression until the planner
 * has hoisted it: there is nothing to emit in its place until a lateral alias exists. `hoist.ts`
 * supplies both.
 */
export function makeNested(plan: NestedPlan): unknown {
  const marker: NestedMarker = Object.freeze({ plan })
  NESTEDS.add(marker)
  return marker
}

// ─────────────────────────────────────────────────────────────────────────────
// Coercion — the one place a user value becomes an AST node
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A projectable value → an AST expression.
 *
 * Deliberately no `param()` fallback. A bare JavaScript value in a projection has no PostgreSQL
 * type, and guessing one is how `sql<T>` becomes a cast (03 §3.2): `val(v, codec)` says which
 * type, `` sql`…`.as(codec) `` says which type, and a naked `'user'` says nothing.
 */
export function toExprNode(v: unknown, where: string): Node {
  if (isAstNode(v)) return v
  if (isFragment(v)) return toNode(v)
  if (isNested(v)) {
    throw new BuilderError(
      `pg-prime: ${where} is a relation projection, which is only valid directly in a projection ` +
        `record — not inside an expression. Give it its own key.`,
    )
  }
  throw new BuilderError(
    `pg-prime: ${where} is not an expression (got ${describe(v)}). A projection takes a column ` +
      `reference, an operator result, \`val(value, codec)\`, or \`sql\`…\`.as(codec)\` — a bare ` +
      `value has no PostgreSQL type and pg-prime will not guess one.`,
  )
}

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  return typeof v
}

/**
 * A statement with no outer join. The honest answer for a RETURNING clause and for a relation's
 * inner select, neither of which can left-join anything: every `nestNullable` in one is therefore
 * `[]` — never null — rather than falling back to a heuristic.
 */
export const NO_LEFT_JOINS: ReadonlySet<string> = Object.freeze(new Set<string>())

export function projectionItem(
  key: string,
  v: unknown,
  leftJoined: ReadonlySet<string>,
): ProjectionItem {
  assertSafeKey(key, 'projection')
  if (isGroup(v)) {
    // With nothing left-joined, the eagerly-built plan already assumed exactly that, at every
    // depth — so the common case rebuilds nothing.
    const plan =
      leftJoined.size === 0 ? v.plan : buildGroupPlan(v.source, v.nullable, leftJoined)
    return groupItem(key, plan)
  }
  if (isNested(v)) return nestedItem(key, v.plan)
  return projection(key, toExprNode(v, `projection "${key}"`))
}

/**
 * A `Projection` record → the ordered projection list. Key order is result-column order.
 *
 * `leftJoined` is the set of aliases the enclosing statement brought in with a LEFT JOIN; it is
 * what {@link groupWitnesses} needs and the only thing a projection cannot work out for itself.
 * Callers with no joins at all pass {@link NO_LEFT_JOINS}.
 *
 * Taking it here — rather than at `toAst()` — is sound for the joins this builder can express.
 * `.select(…)` can only reference aliases already in scope, so a LEFT JOIN added *after* the
 * projection introduces an alias no group in it mentions; and `innerJoin`/`leftJoin` are the only
 * two forms, so a later join can never turn an alias that was inner into an outer one. (A RIGHT
 * or FULL join would, which is the reason neither is exposed without revisiting this.)
 */
export function compileProjection(
  p: Record<string, unknown>,
  leftJoined: ReadonlySet<string>,
): readonly ProjectionItem[] {
  const items: ProjectionItem[] = []
  for (const key of Object.keys(p)) items.push(projectionItem(key, p[key], leftJoined))
  return Object.freeze(items)
}

/** `asc(x)` / `desc(x)` produce an `OrderItem` node; a bare expression means `asc`. */
function isOrderItem(v: unknown): v is OrderItem {
  return isAstNode(v) && !('k' in v) && 'dir' in (v as object)
}

export function toOrderItems(v: unknown): readonly OrderItem[] {
  const list = Array.isArray(v) ? (v as readonly unknown[]) : [v]
  const out: OrderItem[] = []
  for (const x of list) {
    out.push(isOrderItem(x) ? x : orderNode(toExprNode(x, 'orderBy()'), 'asc'))
  }
  return Object.freeze(out)
}

export function toExprList(v: unknown, where: string): readonly Node[] {
  const list = Array.isArray(v) ? (v as readonly unknown[]) : [v]
  return Object.freeze(list.map((x) => toExprNode(x, where)))
}

/**
 * A reference to an **output column by name**, for `ORDER BY` on a set-operation result.
 *
 * A set op has no scope: `order by "id"` names the result column of the whole union, and
 * qualifying it (`"users"."id"`) is a syntax error there. So `q` and `qn` are both the bare quoted
 * name, which makes the node emit identically in qualified and unqualified position.
 */
export function outputColumn(key: string, codec: AnyCodec): Node {
  const quoted = quoteIdentPart(key)
  return mkNode({ k: 'col' as const, alias: '', name: key, q: quoted, qn: quoted, codec })
}

/** The default registry, so a builder made without a db still resolves codecs. */
export function registryOr(r: CodecRegistry | undefined): CodecRegistry {
  return r ?? defaultRegistry()
}
