/**
 * Relation-nesting transform (03 §2.3, D4) — a pure AST → AST pre-pass.
 *
 * This is deliberately *not* part of the emitter. 03 §1.1 says "optional plugin transforms
 * run **before** compilation, never during", and it buys a concrete property: the transform
 * assigns no parameter numbers, so `$n` numbering remains a single left-to-right textual
 * pass over the already-hoisted tree. A `limit` inside a hoisted lateral therefore gets a
 * *lower* `$n` than the parent's `limit`, because the JOIN clause precedes the LIMIT clause
 * in the output — which is exactly what the design's golden SQL shows.
 *
 * A `{ key, nested: { kind: 'many', query } }` projection item becomes:
 *
 *   projection:  "lp"."v" as "latestPosts"
 *   joins:      +left join lateral (
 *                  select coalesce(json_agg("x"."o" order by "x"."k0" desc), '[]'::json) as "v"
 *                  from ( select json_build_object(…) as "o", <order expr> as "k0"
 *                         from … where <correlation> order by … limit $1 ) as "x"
 *                ) as "lp" on true
 *
 * Three details that are easy to get wrong and are load-bearing here:
 *
 *  - **Hidden order keys.** `json_agg` preserves the input order only incidentally, so the
 *    inner select re-exports each ORDER BY expression as `k0, k1, …` and the aggregate
 *    restates the order explicitly. The hidden keys never appear in the JSON because the
 *    object is built from an explicit key list, not `row_to_json`.
 *  - **`coalesce(json_agg(…), '[]'::json)`** so an empty relation is `[]`, not `null`.
 *  - **Per-codec JSON casts.** Every leaf goes through `codec.jsonEncode`; `int8` and
 *    `numeric` become `::text` inside `json_build_object`, which is the entire mechanism
 *    behind "a column's type is the same at the top level and five relations deep".
 */

import type { Codec } from '../sql/codec.js'
import { spikeCodecs } from '../sql/codec.js'
import { UnsupportedNodeError } from '../sql/errors.js'
import type { Expr, JoinNode, OrderItem, ProjectionItem, SelectNode } from './ast.js'
import type { FieldPlan, JsonPlan } from './contract.js'
import {
  cast,
  col,
  jsonAgg,
  jsonBuild,
  leftJoinLateral,
  lit,
  order,
  projection,
  select,
  subquery,
} from './nodes.js'

/** The codec that describes an expression's result. */
export function codecOf(e: Expr): Codec {
  switch (e.k) {
    case 'col':
    case 'param':
    case 'ph':
    case 'lit':
      return e.codec
    case 'bin':
    case 'un':
    case 'fn':
    case 'agg':
    case 'case':
    case 'cast':
    case 'sq':
      return e.resultCodec
    case 'bool':
    case 'is':
    case 'in':
    case 'between':
    case 'exists':
      return spikeCodecs.bool
    case 'jsonBuild':
    case 'jsonAgg':
      return e.variant === 'jsonb' ? spikeCodecs.jsonb : spikeCodecs.json
    case 'array':
      return e.elemCodec.arrayOf ?? spikeCodecs.textArray
    case 'raw':
      return e.resultCodec ?? spikeCodecs.unknownParam
    default:
      return spikeCodecs.unknownParam
  }
}

/**
 * Apply `codec.jsonEncode` so that `decodeJson` can be exact. This is the no-dehydration-tax
 * mechanism: `int8` and `numeric` MUST be `'text'` (a JSON number loses precision past 2^53).
 */
export function jsonCast(e: Expr, codec: Codec): Expr {
  const mode = codec.jsonEncode
  if (mode === 'native') return e
  if (mode === 'text') return cast(e, 'text', codec)
  return mode(e)
}

interface JsonBuildResult {
  entries: (readonly [string, Expr])[]
  fields: { key: string; plan: JsonPlan }[]
  joins: JoinNode[]
}

/**
 * Turn a projection list into `json_build_object` entries plus the matching `JsonPlan`,
 * recursing through any nested relations it contains (nesting inside nesting).
 */
function buildJsonEntries(items: readonly ProjectionItem[]): JsonBuildResult {
  const entries: (readonly [string, Expr])[] = []
  const fields: { key: string; plan: JsonPlan }[] = []
  const joins: JoinNode[] = []

  for (const item of items) {
    if (item.nested !== undefined) {
      const hoisted = hoistOne(item.nested)
      joins.push(hoisted.join)
      // The nested value is already a json/jsonb value; do NOT cast it to text, and do not
      // double-encode it. It embeds natively into the enclosing json_build_object.
      entries.push([item.key, hoisted.ref] as const)
      fields.push({ key: item.key, plan: hoisted.plan })
    } else {
      const codec = codecOf(item.expr)
      entries.push([item.key, jsonCast(item.expr, codec)] as const)
      fields.push({ key: item.key, plan: { k: 'leaf', codec } })
    }
  }
  return { entries, fields, joins }
}

interface HoistedRelation {
  join: JoinNode
  /** The expression the parent projection uses in place of the nested item. */
  ref: Expr
  plan: JsonPlan
  /** `many` is never null (coalesce); `one` is null iff the relation is optional. */
  nullable: boolean
}

/** The alias of the derived table inside a `many` lateral. Never user-visible. */
const INNER_ALIAS = 'x'

function hoistOne(nested: NonNullable<ProjectionItem['nested']>): HoistedRelation {
  const variant = nested.variant ?? 'json'
  const jsonCodec = variant === 'jsonb' ? spikeCodecs.jsonb : spikeCodecs.json
  const inner = nested.query

  const built = buildJsonEntries(inner.projection)
  const innerJoins = [...(inner.joins ?? []), ...built.joins]
  const obj = jsonBuild(built.entries, variant)

  if (nested.kind === 'one') {
    const innerSelect = select({
      ...inner,
      projection: [projection('o', obj)],
      joins: innerJoins,
      limit: inner.limit ?? lit(1, spikeCodecs.int4),
    })
    const nullable = nested.required !== true
    return {
      join: leftJoinLateral(subquery(innerSelect, nested.alias, true)),
      ref: col(nested.alias, 'o', jsonCodec),
      plan: { k: 'obj', fields: built.fields, nullable },
      nullable,
    }
  }

  // ── many ──────────────────────────────────────────────────────────────────
  const orderBy: readonly OrderItem[] = inner.orderBy ?? []
  const hiddenKeys = orderBy.map((o, i) => projection(`k${i}`, o.e))
  const innerSelect = select({
    ...inner,
    projection: [projection('o', obj), ...hiddenKeys],
    joins: innerJoins,
  })

  const aggOrder = orderBy.map((o, i) =>
    order(col(INNER_ALIAS, `k${i}`, codecOf(o.e)), o.dir, o.nulls),
  )
  const outerSelect = select({
    projection: [
      projection(
        'v',
        jsonAgg(col(INNER_ALIAS, 'o', jsonCodec), {
          ...(aggOrder.length > 0 ? { orderBy: aggOrder } : {}),
          variant,
          emptyAs: '[]',
        }),
      ),
    ],
    from: subquery(innerSelect, INNER_ALIAS, false),
  })

  return {
    join: leftJoinLateral(subquery(outerSelect, nested.alias, true)),
    ref: col(nested.alias, 'v', jsonCodec),
    plan: { k: 'arr', item: { k: 'obj', fields: built.fields, nullable: false } },
    nullable: false,
  }
}

export interface PlannedSelect {
  node: SelectNode
  fields: FieldPlan[]
}

/**
 * Hoist every nested relation in a select's projection into `LEFT JOIN LATERAL`s, and
 * produce the positional decode plan. Idempotent on selects with no nested items.
 */
export function planSelect(node: SelectNode): PlannedSelect {
  let anyNested = false
  for (const item of node.projection) {
    if (item.nested !== undefined) {
      anyNested = true
      break
    }
  }

  const fields: FieldPlan[] = []
  if (!anyNested) {
    for (let i = 0; i < node.projection.length; i++) {
      const item = node.projection[i] as ProjectionItem
      fields.push({ key: item.key, k: 'col', idx: i, codec: codecOf(item.expr) })
    }
    return { node, fields }
  }

  const projections: ProjectionItem[] = []
  const hoistedJoins: JoinNode[] = []
  for (let i = 0; i < node.projection.length; i++) {
    const item = node.projection[i] as ProjectionItem
    if (item.nested !== undefined) {
      const h = hoistOne(item.nested)
      hoistedJoins.push(h.join)
      projections.push(projection(item.key, h.ref))
      fields.push({ key: item.key, k: 'json', idx: i, plan: h.plan, nullable: h.nullable })
    } else {
      projections.push(item)
      fields.push({ key: item.key, k: 'col', idx: i, codec: codecOf(item.expr) })
    }
  }

  return {
    node: select({
      ...node,
      projection: projections,
      joins: [...(node.joins ?? []), ...hoistedJoins],
    }),
    fields,
  }
}

/**
 * Same, for a RETURNING list (which reuses the projection machinery — 03 §2.5).
 *
 * Nested relations are rejected here rather than hoisted: `RETURNING` has no FROM clause, so
 * a relation in a RETURNING list has to use the *subquery* strategy, not `LEFT JOIN LATERAL`.
 * That path is real but out of scope for this spike, and silently emitting invalid SQL would
 * be worse than a precise error.
 */
export function planReturning(items: readonly ProjectionItem[]): {
  items: readonly ProjectionItem[]
  fields: FieldPlan[]
} {
  const fields: FieldPlan[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as ProjectionItem
    if (item.nested !== undefined) {
      throw new UnsupportedNodeError(
        'nested',
        `RETURNING "${item.key}": relation projections in RETURNING need the subquery ` +
          'strategy (RETURNING has no FROM clause to hoist a LATERAL onto); not in this spike',
      )
    }
    fields.push({ key: item.key, k: 'col', idx: i, codec: codecOf(item.expr) })
  }
  return { items, fields }
}
