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

import type { AnyCodec } from '../codec/index.js'
import {
  arrayCodecOf,
  boolCodec,
  int4Codec,
  jsonCodecJson,
  jsonbCodec,
  unknownCodec,
} from '../codec/index.js'
import { BuilderError, UnsupportedNodeError } from '../sql/errors.js'
import { MAX_IDENT_BYTES, utf8ByteLength } from '../sql/ident.js'
import type {
  Expr,
  FromItem,
  JoinNode,
  OrderItem,
  ProjectionItem,
  SelectNode,
  SetOpNode,
  SubqueryExprNode,
  WindowDef,
} from './ast.js'
import type { FieldOrigin, FieldPlan, JsonPlan } from './contract.js'
import {
  cast,
  col,
  jsonAgg,
  jsonBuild,
  leftJoinLateral,
  lit,
  mkNode,
  order,
  projection,
  scalarSubquery,
  select,
  siteOf,
  subquery,
} from './nodes.js'

/** The codec that describes an expression's result. */
export function codecOf(e: Expr): AnyCodec {
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
    case 'over':
      // `sum(x) over (…)` has the type of `sum(x)`; the window changes which rows it sees, never
      // what it returns. Found in WS4: without this line every window function decoded through
      // `unknown`, so `row_number()` came back as the string `'1'` rather than `1n`.
      return codecOf(e.fn)
    case 'bool':
    case 'is':
    case 'in':
    case 'between':
    case 'exists':
      return boolCodec
    case 'jsonBuild':
    case 'jsonAgg':
      return e.variant === 'jsonb' ? jsonbCodec : jsonCodecJson
    case 'array':
      // The node carries the ELEMENT codec; the expression's type is the array of it. The spike
      // read `elemCodec.arrayOf`, which is the wrong direction (`arrayOf` points from an array
      // codec down to its element) and so always fell through to `text[]`.
      return arrayCodecOf(e.elemCodec)
    case 'raw':
      return e.resultCodec ?? unknownCodec
    default:
      return unknownCodec
  }
}

/**
 * Apply `codec.jsonEncode` so that `decodeJson` can be exact. This is the no-dehydration-tax
 * mechanism: `int8` and `numeric` MUST be `'text'` (a JSON number loses precision past 2^53).
 */
export function jsonCast(e: Expr, codec: AnyCodec): Expr {
  // Two members, exhaustively. 03 §7 also sketched a custom `(e: Expr) => Expr` wrapper; it is
  // not implemented, because a codec that builds compiler AST would make `src/codec` depend on
  // `src/compile`, which depends on `src/codec`. See `JsonEncode` in `src/codec/types.ts`.
  return codec.jsonEncode === 'text' ? cast(e, 'text', codec) : e
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared relation aggregates — the compiler's only CSE (03 §2.3 point 6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The alias counter for one plan pass.
 *
 * Threaded through every level so `_r3` names exactly one lateral in the whole statement, even
 * when the levels are a relation inside a relation. Per-*select* state (which laterals to append,
 * which digests have been seen) lives in {@link Cse} instead, because a lateral belongs to the
 * select whose FROM clause its correlation can reach.
 */
interface Seq {
  n: number
}

interface Cse {
  joins: JoinNode[]
  /** digest → the `"_rN"."v"` reference that replaces every occurrence of it. */
  shared: Map<string, Expr>
  seq: Seq
}

function newCse(seq: Seq): Cse {
  return { joins: [], shared: new Map(), seq }
}

/**
 * Functions whose value may differ between two evaluations in one statement.
 *
 * Sharing a lateral collapses N evaluations into one, which is only sound if the expression is
 * stable. `now()` is *not* here on purpose: it is `transaction_timestamp()`, constant for the
 * whole transaction, so collapsing it changes nothing. `clock_timestamp()` is.
 */
const VOLATILE: ReadonlySet<string> = new Set([
  'random',
  'gen_random_uuid',
  'uuid_generate_v1',
  'uuid_generate_v4',
  'nextval',
  'currval',
  'setval',
  'clock_timestamp',
  'timeofday',
  'statement_timestamp',
  'pg_sleep',
])

/**
 * A structural digest of a marked subquery, or `null` when the node must not be shared.
 *
 * `null` is returned for anything the serializer does not *recognise* as well as for anything it
 * recognises as volatile — a `sql` fragment, a `random()` call, a node kind added after this was
 * written. That default is the safety property: a new AST node cannot silently start being
 * deduplicated, it can only stop being deduplicated, and the worst case is the SQL PostgreSQL
 * would have got anyway.
 */
function digest(n: SubqueryExprNode): string | null {
  const out: string[] = []
  return digExpr(n, out) ? out.join(SEP) : null
}

/**
 * The same digest, over **any** expression — the "is this the same expression?" test the two
 * `DISTINCT` rules need (03 §2.8 AS BUILT 2026-08-27).
 *
 * It is the CSE digest deliberately, and not a second comparator written for the occasion: the
 * properties that make it safe to collapse two laterals into one — injective (every list is
 * length-prefixed, every free-text token is `JSON.stringify`d, every optional member writes a
 * present/absent marker) and `null` rather than a guess for anything it does not recognise — are
 * exactly the properties "PostgreSQL will consider these two expressions equal" needs. Two
 * comparators would be two things to keep in step.
 *
 * `null` means *unknown*, never *different*, and every caller must read it that way: a `sql`
 * fragment or a volatile function is a query we cannot reason about, so the server decides.
 */
export function exprDigest(e: Expr): string | null {
  const out: string[] = []
  return digExpr(e, out) ? out.join(SEP) : null
}

/** Structural equality of two expressions, by {@link exprDigest}. Unknown ⇒ not equal. */
export function sameExpr(a: Expr, b: Expr): boolean {
  if (a === b) return true
  const da = exprDigest(a)
  return da !== null && da === exprDigest(b)
}

/**
 * The token separator, and the two rules that keep the digest injective.
 *
 * A digest is only sound if two *different* node trees cannot serialise to the same string.
 * Two ways that used to fail, both confirmed:
 *
 *  1. **Unescaped separators.** A `param` whose value contains the separator byte could spell
 *     out the tokens of an entirely different subtree, so
 *     `in (a, b)` and `in ('a\x01text\x01param\x01sb')` digested identically — two different
 *     queries collapsed into one lateral and one query's bind vanished. Every free-text token
 *     therefore goes through {@link tok}, i.e. `JSON.stringify`, which escapes control
 *     characters (`\u0001`) and the quote, so no token can contain the separator.
 *  2. **Unmarked boundaries.** A list wrote its items with no length, and an optional member
 *     (`filter`, `else`, `is`'s right operand, an `order by`) wrote nothing when absent, so
 *     "one item and no filter" and "no items and a filter" produced the same tokens. Every list
 *     now writes its length and every optional member writes a present/absent marker.
 */
const SEP = '\x01'

/** A free-text token: an identifier, a codec name, a function name, a projection key. */
function tok(s: string): string {
  return JSON.stringify(s)
}

function scalar(v: unknown): string | null {
  if (v === null) return '\x00'
  switch (typeof v) {
    case 'string':
      return `s${tok(v)}`
    case 'number':
      return `n${String(v)}`
    case 'bigint':
      return `i${v.toString()}`
    case 'boolean':
      return v ? 'b1' : 'b0'
    case 'undefined':
      return 'u'
    default:
      break
  }
  if (v instanceof Date) return `d${v.getTime()}`
  if (v instanceof Uint8Array) {
    let hex = 'x'
    for (const b of v) hex += b.toString(16).padStart(2, '0')
    return hex
  }
  try {
    return `j${JSON.stringify(v)}`
  } catch {
    // A bigint (or a cycle) inside a jsonb parameter. Unrepresentable here ⇒ not shareable.
    return null
  }
}

/** Length-prefixed, so two adjacent lists cannot be re-cut into a different pair of lists. */
function digAll(xs: readonly Expr[], out: string[]): boolean {
  out.push(`#${xs.length}`)
  for (const x of xs) if (!digExpr(x, out)) return false
  return true
}

function digOrder(xs: readonly OrderItem[] | undefined, out: string[]): boolean {
  if (xs === undefined) {
    out.push('o-')
    return true
  }
  out.push('o+', `#${xs.length}`)
  for (const o of xs) {
    out.push(`O${o.dir}|${o.nulls ?? ''}`)
    if (!digExpr(o.e, out)) return false
  }
  return true
}

/** Marker for an optional member, so "absent" is a token rather than the absence of one. */
function digOpt(e: Expr | undefined, out: string[]): boolean {
  if (e === undefined) {
    out.push('?-')
    return true
  }
  out.push('?+')
  return digExpr(e, out)
}

function digExpr(e: Expr, out: string[]): boolean {
  out.push(e.k)
  switch (e.k) {
    case 'col':
      out.push(tok(e.q), tok(e.codec.name))
      return true
    case 'param': {
      const v = scalar(e.value)
      if (v === null) return false
      out.push(v, tok(e.codec.name))
      return true
    }
    case 'ph':
      out.push(tok(e.name), tok(e.codec.name))
      return true
    case 'lit': {
      const v = scalar(e.value)
      if (v === null) return false
      out.push(v, tok(e.codec.name))
      return true
    }
    case 'bin':
      out.push(tok(e.op))
      return digExpr(e.l, out) && digExpr(e.r, out)
    case 'bool':
      out.push(e.op)
      return digAll(e.args, out)
    case 'un':
      out.push(tok(e.op))
      return digExpr(e.e, out)
    case 'between':
      out.push(e.symmetric ? '1' : '0', e.not ? '1' : '0')
      return digExpr(e.e, out) && digExpr(e.lo, out) && digExpr(e.hi, out)
    case 'is':
      out.push(e.test)
      return digExpr(e.e, out) && digOpt(e.r, out)
    case 'in':
      out.push(e.not ? '1' : '0', e.set.k)
      if (!digExpr(e.e, out)) return false
      if (e.set.k === 'list') return digAll(e.set.items, out)
      if (e.set.k === 'any') return digExpr(e.set.array, out)
      return digSelect(e.set.query, out)
    case 'fn':
      if (VOLATILE.has(e.name)) return false
      out.push(tok(e.name), tok(e.resultCodec.name))
      return digAll(e.args, out)
    case 'agg':
      if (VOLATILE.has(e.name)) return false
      out.push(tok(e.name), e.distinct ? '1' : '0', e.star ? '1' : '0', tok(e.resultCodec.name))
      return digAll(e.args, out) && digOrder(e.orderBy, out) && digOpt(e.filter, out)
    case 'over':
      return digExpr(e.fn, out) && digWindow(e.window, out)
    case 'case':
      out.push(`#${e.whens.length}`, tok(e.resultCodec.name))
      if (!digOpt(e.operand, out)) return false
      for (const w of e.whens) {
        if (!digExpr(w.when, out) || !digExpr(w.then, out)) return false
      }
      return digOpt(e.else, out)
    case 'cast':
      out.push(tok(e.to), tok(e.resultCodec.name))
      return digExpr(e.e, out)
    case 'row':
      return digAll(e.items, out)
    case 'array':
      out.push(tok(e.elemCodec.name))
      return digAll(e.items, out)
    case 'sq':
      out.push(tok(e.resultCodec.name))
      return digSelect(e.query, out)
    case 'exists':
      out.push(e.not ? '1' : '0')
      return digSelect(e.query, out)
    case 'jsonBuild':
      out.push(e.variant, `#${e.entries.length}`)
      for (const [k, v] of e.entries) {
        out.push(tok(k))
        if (!digExpr(v, out)) return false
      }
      return true
    case 'jsonAgg':
      out.push(e.variant, e.emptyAs === undefined ? 'e-' : `e+${tok(e.emptyAs)}`)
      return digExpr(e.e, out) && digOrder(e.orderBy, out)
    default:
      // `raw` lands here, and so would any node kind added after this was written.
      return false
  }
}

function digWindow(w: WindowDef | { ref: string }, out: string[]): boolean {
  if ('ref' in w) {
    out.push('W', tok(w.ref))
    return true
  }
  out.push('w', w.frame === undefined ? 'F-' : `F+${w.frame.mode}|${w.frame.exclude ?? ''}`)
  if (w.frame !== undefined) {
    for (const b of [w.frame.start, w.frame.end]) {
      if (b === undefined) {
        out.push('B-')
        continue
      }
      out.push('B+', b.k)
      if ((b.k === 'preceding' || b.k === 'following') && !digExpr(b.n, out)) return false
    }
  }
  if (w.partitionBy === undefined) out.push('p-')
  else {
    out.push('p+')
    if (!digAll(w.partitionBy, out)) return false
  }
  return digOrder(w.orderBy, out)
}

function digFrom(f: FromItem, out: string[]): boolean {
  out.push(f.k, tok(f.alias))
  switch (f.k) {
    case 'table':
      out.push(tok(f.table.schema), tok(f.table.name))
      return true
    case 'cteRef':
      out.push(tok(f.name))
      return true
    case 'subquery':
      out.push(f.lateral ? '1' : '0')
      return digSelect(f.query, out)
    default:
      // `values` / `func` — never produced by the relation layer, so never worth serialising.
      return false
  }
}

function digSelect(n: SelectNode | SetOpNode, out: string[]): boolean {
  if (n.k === 'setop') {
    out.push('U', n.op)
    return (
      digSelect(n.left, out) &&
      digSelect(n.right, out) &&
      digOrder(n.orderBy, out) &&
      digOpt(n.limit, out) &&
      digOpt(n.offset, out)
    )
  }
  // A CTE list or a locking clause inside a shared lateral is not something the relation layer
  // emits; refusing to serialise them keeps this honest rather than optimistic.
  if (n.with !== undefined || n.locking !== undefined || n.windows !== undefined) return false
  out.push('S', `#${n.projection.length}`)
  if (n.distinct === undefined) out.push('D-')
  else {
    out.push('D+')
    if (n.distinct.on === undefined) out.push('n-')
    else {
      out.push('n+')
      if (!digAll(n.distinct.on, out)) return false
    }
  }
  for (const item of n.projection) {
    if (item.nested !== undefined || item.group !== undefined) return false
    out.push(tok(item.key))
    if (!digExpr(item.expr, out)) return false
  }
  if (n.from === undefined) out.push('f-')
  else {
    out.push('f+')
    if (!digFrom(n.from, out)) return false
  }
  const joins = n.joins ?? []
  out.push('J', `#${joins.length}`)
  for (const j of joins) {
    out.push(j.type)
    if (!digFrom(j.item, out)) return false
    if (!digOpt(j.on, out)) return false
  }
  if (!digOpt(n.where, out)) return false
  if (n.groupBy === undefined) out.push('g-')
  else {
    out.push('g+')
    if (!digAll(n.groupBy, out)) return false
  }
  return (
    digOpt(n.having, out) && digOrder(n.orderBy, out) && digOpt(n.limit, out) && digOpt(n.offset, out)
  )
}

/**
 * Lift one marked subquery into a `LEFT JOIN LATERAL … ON TRUE` and return the reference that
 * stands in for it. A second occurrence with the same digest returns the *same* reference and
 * emits no second lateral, which is what makes `revenue` and the `rank()` window that orders by
 * it share one `"v"`.
 */
function share(e: SubqueryExprNode, cse: Cse): Expr {
  const key = digest(e)
  if (key !== null) {
    const hit = cse.shared.get(key)
    if (hit !== undefined) return hit
  }
  const alias = `_r${cse.seq.n++}`
  cse.joins.push(leftJoinLateral(subquery(e.query, alias, true)))
  const ref = col(alias, 'v', e.resultCodec)
  if (key !== null) cse.shared.set(key, ref)
  return ref
}

/**
 * Replace every marked subquery in an expression, rebuilding only the spine that changed.
 *
 * Returns the **same object** when nothing was marked, which is what keeps `planSelect`'s identity
 * fast path intact: a query with no relation aggregates gets an AST that is `toStrictEqual` — and
 * in fact reference-equal — to the one it went in with.
 *
 * It deliberately does not descend into another subquery's `query`: that is a different scope, and
 * a lateral hoisted out of it would lose the correlation it was built with.
 */
function rewrite(e: Expr, cse: Cse): Expr {
  switch (e.k) {
    case 'sq':
      return e.hoist === true ? share(e, cse) : e
    case 'bin': {
      const l = rewrite(e.l, cse)
      const r = rewrite(e.r, cse)
      return l === e.l && r === e.r ? e : mkNode({ ...e, l, r })
    }
    case 'bool': {
      const args = rewriteAll(e.args, cse)
      return args === e.args ? e : mkNode({ ...e, args })
    }
    case 'un':
    case 'cast': {
      const inner = rewrite(e.e, cse)
      return inner === e.e ? e : mkNode({ ...e, e: inner })
    }
    case 'is': {
      const inner = rewrite(e.e, cse)
      const r = e.r === undefined ? undefined : rewrite(e.r, cse)
      return inner === e.e && r === e.r ? e : mkNode({ ...e, e: inner, r })
    }
    case 'between': {
      const inner = rewrite(e.e, cse)
      const lo = rewrite(e.lo, cse)
      const hi = rewrite(e.hi, cse)
      return inner === e.e && lo === e.lo && hi === e.hi ? e : mkNode({ ...e, e: inner, lo, hi })
    }
    case 'in': {
      const inner = rewrite(e.e, cse)
      let set = e.set
      if (e.set.k === 'list') {
        const items = rewriteAll(e.set.items, cse)
        if (items !== e.set.items) set = { k: 'list', items }
      } else if (e.set.k === 'any') {
        const array = rewrite(e.set.array, cse)
        if (array !== e.set.array) set = { k: 'any', array }
      }
      return inner === e.e && set === e.set ? e : mkNode({ ...e, e: inner, set })
    }
    case 'fn':
    case 'row': {
      const args = rewriteAll(e.k === 'fn' ? e.args : e.items, cse)
      if (e.k === 'fn') return args === e.args ? e : mkNode({ ...e, args })
      return args === e.items ? e : mkNode({ ...e, items: args })
    }
    case 'array': {
      const items = rewriteAll(e.items, cse)
      return items === e.items ? e : mkNode({ ...e, items })
    }
    case 'agg': {
      const args = rewriteAll(e.args, cse)
      const orderBy = rewriteOrder(e.orderBy, cse)
      const filter = e.filter === undefined ? undefined : rewrite(e.filter, cse)
      return args === e.args && orderBy === e.orderBy && filter === e.filter
        ? e
        : mkNode({ ...e, args, orderBy, filter })
    }
    case 'over': {
      const f = rewrite(e.fn, cse) as typeof e.fn
      const window = rewriteWindow(e.window, cse)
      return f === e.fn && window === e.window ? e : mkNode({ ...e, fn: f, window })
    }
    case 'case': {
      const operand = e.operand === undefined ? undefined : rewrite(e.operand, cse)
      let changed = operand !== e.operand
      const whens = e.whens.map((w) => {
        const when = rewrite(w.when, cse)
        const then = rewrite(w.then, cse)
        if (when === w.when && then === w.then) return w
        changed = true
        return { when, then }
      })
      const alt = e.else === undefined ? undefined : rewrite(e.else, cse)
      changed ||= alt !== e.else
      return changed ? mkNode({ ...e, operand, whens: Object.freeze(whens), else: alt }) : e
    }
    case 'jsonBuild': {
      let changed = false
      const entries = e.entries.map((entry) => {
        const v = rewrite(entry[1], cse)
        if (v === entry[1]) return entry
        changed = true
        return [entry[0], v] as const
      })
      return changed ? mkNode({ ...e, entries: Object.freeze(entries) }) : e
    }
    case 'jsonAgg': {
      const inner = rewrite(e.e, cse)
      const orderBy = rewriteOrder(e.orderBy, cse)
      return inner === e.e && orderBy === e.orderBy ? e : mkNode({ ...e, e: inner, orderBy })
    }
    case 'raw': {
      let changed = false
      const parts = e.parts.map((part) => {
        if (part.k === 'ident' || part.k === 'unsafeRaw') return part
        const v = rewrite(part, cse)
        if (v === part) return part
        changed = true
        return v
      })
      return changed ? mkNode({ ...e, parts: Object.freeze(parts) }) : e
    }
    default:
      // Leaves (`col`, `param`, `ph`, `lit`) and `exists`, whose query is a scope of its own.
      return e
  }
}

/**
 * The identity fast path is the common one — most clauses contain no marked subquery at all — so
 * nothing is allocated until the first element actually changes. `xs.map(...)` allocated a fresh
 * array per clause per nesting level even when the answer was `xs`.
 */
function rewriteAll(xs: readonly Expr[], cse: Cse): readonly Expr[] {
  let out: Expr[] | undefined
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i] as Expr
    const v = rewrite(x, cse)
    if (v === x) {
      if (out !== undefined) out.push(v)
      continue
    }
    if (out === undefined) out = xs.slice(0, i)
    out.push(v)
  }
  return out === undefined ? xs : Object.freeze(out)
}

function rewriteOrder(
  xs: readonly OrderItem[] | undefined,
  cse: Cse,
): readonly OrderItem[] | undefined {
  if (xs === undefined) return xs
  let out: OrderItem[] | undefined
  for (let i = 0; i < xs.length; i++) {
    const o = xs[i] as OrderItem
    const e = rewrite(o.e, cse)
    if (e === o.e) {
      if (out !== undefined) out.push(o)
      continue
    }
    if (out === undefined) out = xs.slice(0, i)
    out.push(order(e, o.dir, o.nulls))
  }
  return out === undefined ? xs : Object.freeze(out)
}

function rewriteWindow(
  w: WindowDef | { ref: string },
  cse: Cse,
): WindowDef | { ref: string } {
  if ('ref' in w) return w
  const partitionBy = w.partitionBy === undefined ? undefined : rewriteAll(w.partitionBy, cse)
  const orderBy = rewriteOrder(w.orderBy, cse)
  return partitionBy === w.partitionBy && orderBy === w.orderBy ? w : { ...w, partitionBy, orderBy }
}

/**
 * The whole select, clause by clause.
 *
 * Every clause is walked, not just the projection: `.orderBy(desc(u.posts.sum(…)))` and
 * `.where(gt(u.posts.count(), 3))` are as ordinary as putting the aggregate in the select list,
 * and a `LEFT JOIN LATERAL … ON TRUE` neither adds nor removes parent rows, so lifting one out of
 * a WHERE cannot change which rows come back.
 *
 * `from` and `joins` are deliberately *not* walked: a hoisted lateral is appended after them and
 * correlates on what they bind, so an aggregate found there could not reference itself into
 * existence.
 */
function rewriteClauses(n: SelectNode, cse: Cse): SelectNode {
  let changed = false
  const projection = n.projection.map((item) => {
    if (item.nested !== undefined) return item
    if (item.group !== undefined) {
      const items = rewriteItems(item.group.items, cse)
      if (items === item.group.items) return item
      changed = true
      return mkNode({ ...item, group: { ...item.group, items } })
    }
    const expr = rewrite(item.expr, cse)
    if (expr === item.expr) return item
    changed = true
    return mkNode({ ...item, expr })
  })

  // `distinctOn(u.posts.count())` hoists the same aggregate the ORDER BY does, and DISTINCT ON
  // requires its expressions to be a prefix of the ORDER BY *syntactically*: leaving this one
  // un-rewritten left a `(select …)` next to a rewritten `"_r0"."v"`, which is 42P10.
  let distinct = n.distinct
  if (n.distinct?.on !== undefined) {
    const on = rewriteAll(n.distinct.on, cse)
    if (on !== n.distinct.on) distinct = { ...n.distinct, on }
  }

  const where = n.where === undefined ? undefined : rewrite(n.where, cse)
  const groupBy = n.groupBy === undefined ? undefined : rewriteAll(n.groupBy, cse)
  const having = n.having === undefined ? undefined : rewrite(n.having, cse)
  const orderBy = rewriteOrder(n.orderBy, cse)
  let windows = n.windows
  if (n.windows !== undefined) {
    let wchanged = false
    const next = n.windows.map((entry) => {
      const def = rewriteWindow(entry.def, cse) as WindowDef
      if (def === entry.def) return entry
      wchanged = true
      return { name: entry.name, def }
    })
    if (wchanged) windows = Object.freeze(next)
  }

  changed ||=
    distinct !== n.distinct ||
    where !== n.where ||
    groupBy !== n.groupBy ||
    having !== n.having ||
    orderBy !== n.orderBy ||
    windows !== n.windows

  if (!changed) return n
  return select({
    ...n,
    distinct,
    projection: Object.freeze(projection),
    where,
    groupBy,
    having,
    orderBy,
    windows,
  })
}

function rewriteItems(
  items: readonly ProjectionItem[],
  cse: Cse,
): readonly ProjectionItem[] {
  let changed = false
  const out = items.map((item) => {
    if (item.nested !== undefined) return item
    if (item.group !== undefined) {
      const inner = rewriteItems(item.group.items, cse)
      if (inner === item.group.items) return item
      changed = true
      return mkNode({ ...item, group: { ...item.group, items: inner } })
    }
    const expr = rewrite(item.expr, cse)
    if (expr === item.expr) return item
    changed = true
    return mkNode({ ...item, expr })
  })
  return changed ? Object.freeze(out) : items
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
function buildJsonEntries(
  items: readonly ProjectionItem[],
  variant: 'json' | 'jsonb',
  seq: Seq,
): JsonBuildResult {
  const entries: (readonly [string, Expr])[] = []
  const fields: { key: string; plan: JsonPlan }[] = []
  const joins: JoinNode[] = []

  for (const item of items) {
    if (item.group !== undefined) {
      // A `nest({...})` inside a relation projection is a nested `json_build_object`, which is
      // both the cheapest spelling and the one whose decode plan is already expressible.
      const inner = buildJsonEntries(item.group.items, variant, seq)
      joins.push(...inner.joins)
      entries.push([item.key, jsonBuild(inner.entries, variant)] as const)
      fields.push({
        key: item.key,
        plan: { k: 'obj', fields: inner.fields, nullable: item.group.nullable },
      })
      continue
    }
    if (item.nested !== undefined) {
      // `rowEquality: false`, always: a relation *inside* a relation is a member of the enclosing
      // json object, not a column of the statement's row, so nothing ever compares it. The
      // enclosing object is what needs an equality operator, and {@link jsonVariant} gave it one.
      const hoisted = hoistOne(item.nested, seq, item.key, false)
      if (hoisted.join !== undefined) joins.push(hoisted.join)
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
  /** `undefined` under `strategy: 'subquery'`, where the whole relation is one expression. */
  join: JoinNode | undefined
  /** The expression the parent projection uses in place of the nested item. */
  ref: Expr
  plan: JsonPlan
  /** `many` is never null (coalesce); `one` is null iff the relation is optional. */
  nullable: boolean
}

/** The alias of the derived table inside a `many` lateral. Never user-visible. */
const INNER_ALIAS = 'x'

/**
 * `json` by default (03 §2.3 point 5 — jsonb reorders keys and dedupes; json is cheaper and
 * order-preserving), **`jsonb` when the statement compares whole rows for equality**.
 *
 * PostgreSQL's `json` has no equality operator, so `select distinct` / `union` / `intersect` /
 * `except` over a relation column is `42883 could not identify an equality operator for type
 * json` at execute time — found by the WS7 builder fuzzer at seeds 2802423309 and 3300751089.
 * `jsonb` has equality, the value is the same value, and the decoder is a `JSON.parse` plus
 * per-key lookups either way (`compile/decode.ts`), so the switch is invisible above the SQL.
 *
 * An **explicit** `{ variant: 'json' }` is not overridden, because silently ignoring what a caller
 * wrote is worse than refusing it: it is the one case that gets a sentence instead.
 */
function jsonVariant(
  nested: NonNullable<ProjectionItem['nested']>,
  label: string,
  rowEquality: boolean,
): 'json' | 'jsonb' {
  if (!rowEquality) return nested.variant ?? 'json'
  if (nested.variant === 'json') {
    throw new BuilderError(
      `pg-prime: relation "${label}" asks for { variant: 'json' } in a statement that compares ` +
        'whole rows (distinct, union, intersect, except), and PostgreSQL cannot compare json ' +
        "(42883). Drop the option — jsonb is used there automatically — or drop the distinct.",
    )
  }
  return 'jsonb'
}

function hoistOne(
  nested: NonNullable<ProjectionItem['nested']>,
  seq: Seq,
  label: string,
  rowEquality: boolean,
): HoistedRelation {
  const variant = jsonVariant(nested, label, rowEquality)
  const jsonCodec = variant === 'jsonb' ? jsonbCodec : jsonCodecJson
  const lateral = nested.strategy !== 'subquery'
  // Allocated before recursing, so a lateral's number is lower than those of the laterals nested
  // inside it — which is the order a reader of the SQL meets them.
  const alias = lateral ? (nested.alias ?? `_r${seq.n++}`) : ''

  // The relation's own select is its own scope: aggregates inside it hoist onto *it*, never onto
  // the parent, or the correlation they were built with would no longer be in scope.
  const cse = newCse(seq)
  const inner = rewriteClauses(nested.query, cse)

  const built = buildJsonEntries(inner.projection, variant, seq)
  const innerJoins = [...(inner.joins ?? []), ...cse.joins, ...built.joins]
  const obj = jsonBuild(built.entries, variant)

  if (nested.kind === 'one') {
    // `one` is a *cardinality* claim, and the LEFT JOIN LATERAL is what enforces it: with any
    // other limit the lateral returns n rows and the PARENT row comes back n times, silently.
    // So the limit is not negotiable and a caller-supplied one is an error rather than a
    // suggestion — found in WS5, where `.one(...).limit(2)` duplicated every parent row.
    if (inner.limit !== undefined || inner.offset !== undefined) {
      throw new UnsupportedNodeError(
        'nested',
        `relation "${label}": a one() relation cannot carry its own limit/offset — the ` +
          'LEFT JOIN LATERAL would return several rows and duplicate the parent row. ' +
          'Use a many() relation if more than one row is wanted.',
      )
    }
    const innerSelect = select({
      ...inner,
      projection: [projection('o', obj)],
      joins: innerJoins,
      limit: lit(1, int4Codec),
    })
    const nullable = nested.required !== true
    const plan: JsonPlan = { k: 'obj', fields: built.fields, nullable }
    if (!lateral) {
      return { join: undefined, ref: scalarSubquery(innerSelect, jsonCodec), plan, nullable }
    }
    return {
      join: leftJoinLateral(subquery(innerSelect, alias, true)),
      ref: col(alias, 'o', jsonCodec),
      plan,
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

  const plan: JsonPlan = { k: 'arr', item: { k: 'obj', fields: built.fields, nullable: false } }
  if (!lateral) {
    return { join: undefined, ref: scalarSubquery(outerSelect, jsonCodec), plan, nullable: false }
  }
  return {
    join: leftJoinLateral(subquery(outerSelect, alias, true)),
    ref: col(alias, 'v', jsonCodec),
    plan,
    nullable: false,
  }
}

export interface PlannedSelect {
  node: SelectNode
  fields: FieldPlan[]
  /** Positional provenance for `assertShape` (03 §3.2). See `Compiled.origins`. */
  origins: (FieldOrigin | undefined)[]
}

/** What {@link flatten} writes into: the emitted projection list and any hoisted laterals. */
interface FlatOut {
  items: ProjectionItem[]
  joins: JoinNode[]
  /** Indexed by ROW position, like `FieldPlan.idx` — never by position in `items`. */
  origins: (FieldOrigin | undefined)[]
  /** `false` for a RETURNING list, which has no FROM clause to hoist a LATERAL onto. */
  hoist: boolean
  /** The statement compares whole rows, so a relation column must be `jsonb`. {@link jsonVariant} */
  rowEquality: boolean
  seq: Seq
  /** Numbers the fallback aliases of {@link dottedAlias}. Separate from `seq` so a long key
   *  cannot renumber the laterals and move every golden. */
  colSeq: Seq
}

/**
 * The alias a nested key is emitted under: the dotted spelling (`"author.city.name"`) while it
 * fits, and a generated `_gN` when it would not.
 *
 * The alias is cosmetic — the decoder is positional and never reads it (see {@link flatten}) —
 * but it is still an *identifier*, so `quoteIdentPart` rejects it past 63 UTF-8 bytes. Letting
 * that through meant a deeply nested `nest()` of ordinary column names failed with
 * "identifier part 0 rejected (too-long)" from inside `compile()`, naming an identifier the
 * caller never wrote. Legibility is worth having; it is not worth failing a valid query for.
 */
function dottedAlias(prefix: string, key: string, out: FlatOut): string {
  const dotted = `${prefix}.${key}`
  // UTF-8 bytes, as PostgreSQL counts them — never `.length`, which under-counts every non-ASCII
  // name. A UTF-16 code unit is at least one byte, so a too-long `.length` is a sound fast reject.
  if (dotted.length <= MAX_IDENT_BYTES && utf8ByteLength(dotted) <= MAX_IDENT_BYTES) return dotted
  return `_g${out.colSeq.n++}`
}

/**
 * Walk a projection list, emitting one SQL column per leaf and one {@link FieldPlan} per *key*.
 *
 * The two are no longer 1:1, which is the whole point: a `nest({...})` item (03 §2.2) contributes
 * `n` columns and one `group` field, and a relation contributes one column and one `json` field.
 * `idx` is therefore threaded through rather than taken from the loop counter — the decoder is
 * positional, so an off-by-one here is a silently wrong *value*, not an error.
 *
 * Nested keys are emitted with a dotted alias (`"author.id"`). The decoder never reads it; it is
 * there so `EXPLAIN` output and a `psql` paste of the compiled SQL stay legible.
 */
function flatten(
  items: readonly ProjectionItem[],
  prefix: string,
  start: number,
  out: FlatOut,
): { fields: FieldPlan[]; next: number } {
  const fields: FieldPlan[] = []
  let idx = start

  for (const item of items) {
    const alias = prefix === '' ? item.key : dottedAlias(prefix, item.key, out)

    if (item.group !== undefined) {
      const inner = flatten(item.group.items, alias, idx, out)
      fields.push({
        key: item.key,
        k: 'group',
        fields: inner.fields,
        nullable: item.group.nullable,
        sentinel: sentinelRow(item.group.sentinel, inner.fields),
        witnesses: witnessRows(item.group.witnesses, inner.fields),
      })
      idx = inner.next
      continue
    }

    if (item.nested !== undefined) {
      if (!out.hoist && item.nested.strategy !== 'subquery') {
        throw new UnsupportedNodeError(
          'nested',
          `RETURNING "${alias}": a relation projection there needs the subquery strategy, ` +
            'because RETURNING has no FROM clause to hoist a LATERAL onto. Pass ' +
            "`{ strategy: 'subquery' }` to the accessor.",
        )
      }
      // Every relation `flatten` reaches is a column of this statement's row — including one
      // inside a `nest({...})` group, which expands to row columns rather than to a json object.
      // So `out.rowEquality` applies to all of them; {@link buildJsonEntries}'s do not.
      const h = hoistOne(item.nested, out.seq, alias, out.rowEquality)
      if (h.join !== undefined) out.joins.push(h.join)
      out.items.push(projection(alias, h.ref))
      fields.push({ key: item.key, k: 'json', idx, plan: h.plan, nullable: h.nullable })
      idx += 1
      continue
    }

    // Reuse the caller's node when the alias is unchanged, so a projection with no groups and no
    // relations comes out of here `toStrictEqual` to what went in (the WS4 AST-equivalence oracle).
    out.items.push(prefix === '' ? item : projection(alias, item.expr))
    fields.push({ key: item.key, k: 'col', idx, codec: codecOf(item.expr) })
    out.origins[idx] = originOf(item.expr)
    idx += 1
  }

  return { fields, next: idx }
}

/**
 * `GroupPlan.sentinel` indexes the group's *children*; the decoder needs an index into the *row*.
 * Only a leaf column can serve — a nested group or a relation has no single column to test.
 */
function sentinelRow(sentinel: number | undefined, fields: readonly FieldPlan[]): number | undefined {
  if (sentinel === undefined) return undefined
  const f = fields[sentinel]
  return f !== undefined && f.k === 'col' ? f.idx : undefined
}

/**
 * `GroupPlan.witnesses` indexes the group's *children*; the decoder needs indexes into the *row*.
 * Same translation as {@link sentinelRow}, and same restriction: only a leaf column can serve.
 */
function witnessRows(
  witnesses: readonly number[] | undefined,
  fields: readonly FieldPlan[],
): readonly number[] | undefined {
  if (witnesses === undefined) return undefined
  const out: number[] = []
  for (const i of witnesses) {
    const f = fields[i]
    if (f !== undefined && f.k === 'col') out.push(f.idx)
  }
  return Object.freeze(out)
}

/** True iff the projection needs any rewriting at all — the identity fast path. */
function isFlat(items: readonly ProjectionItem[]): boolean {
  for (const item of items) {
    if (item.nested !== undefined || item.group !== undefined) return false
  }
  return true
}

function leafFields(items: readonly ProjectionItem[]): {
  fields: FieldPlan[]
  origins: (FieldOrigin | undefined)[]
} {
  const fields: FieldPlan[] = []
  const origins: (FieldOrigin | undefined)[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as ProjectionItem
    fields.push({ key: item.key, k: 'col', idx: i, codec: codecOf(item.expr) })
    origins[i] = originOf(item.expr)
  }
  return { fields, origins }
}

/**
 * Where this projection item's codec was **declared** — the two cases `03` §3.2's
 * `CodecMismatchError` distinguishes, and nothing else.
 *
 *  - a schema column reference → the qualified name, so the message can say "schema drift" and
 *    point at `"users"."created_at"` rather than at the caller's own file (which is innocent);
 *  - a `` sql`…`.as(codec) `` fragment → the `.as()` call site, which IS the caller's file.
 *
 * Everything else — an operator, an aggregate, a cast, a window, a `nest` group — returns
 * `undefined`, because its codec comes from the operator table and a mismatch there is our bug
 * to fix, not a sentence to print at a user's call site.
 */
function originOf(e: Expr): FieldOrigin | undefined {
  if (e.k === 'col') return { column: e.q }
  if (e.k === 'raw' && e.resultCodec !== null) {
    const site = siteOf(e)
    return site === undefined ? undefined : { site }
  }
  return undefined
}

/**
 * Memo for {@link planSelect}.
 *
 * The emitter calls `planSelect` on *every* select it meets, including the inner/outer selects the
 * planner itself just built, so a query nested k deep was planned k times over — the whole subtree
 * re-walked once per level. Planning is a pure function of a frozen node, so the answer can simply
 * be remembered; a `WeakMap` keeps it collectable with the AST. The planned node maps to itself,
 * which is also the cheapest way to state the idempotence the docblock below promises.
 */
const PLANNED = new WeakMap<SelectNode, PlannedSelect>()
/** The same memo for the `rowEquality: true` reading of a node. See {@link planSelect}. */
const PLANNED_EQ = new WeakMap<SelectNode, PlannedSelect>()

/**
 * `select distinct` compares every output column; `select distinct on (…)` compares only the
 * expressions in its own list, so it needs no equality operator for the row.
 *
 * Exported so the emitter's guard and the planner's memo key cannot drift into two readings of
 * "does this statement compare rows?".
 */
export function comparesWholeRows(n: SelectNode): boolean {
  return n.distinct !== undefined && (n.distinct.on === undefined || n.distinct.on.length === 0)
}

const NO_ORDER: readonly OrderItem[] = Object.freeze([])

/**
 * Make the emitted `ORDER BY` **lead with the `DISTINCT ON` expressions**, in their order
 * (03 §2.8 AS BUILT 2026-08-27).
 *
 * PostgreSQL requires a `DISTINCT ON` list to match the *initial* `ORDER BY` expressions and
 * answers `42P10 SELECT DISTINCT ON expressions must match initial ORDER BY expressions`
 * otherwise — while `.orderBy()` **appends** (`query/select.ts`), so
 * `.distinctOn(a).orderBy(desc(b))` is a statement the builder knew was invalid and emitted
 * anyway. Found by the WS7 builder fuzzer on its first live run.
 *
 * Reconciling is the right answer rather than an error because the two clauses are not in
 * conflict: "the first row of each `a`, and among the rows sharing an `a` the one with the
 * greatest `b`" is exactly what `order by a, b desc` means, and it is what "latest row per group"
 * means. Django documents the same rule and lets the database fail; here the builder holds both
 * halves and can simply write the statement the caller meant.
 *
 * A user list that already leads with the keys is returned **unchanged and by reference**, so its
 * directions, its `nulls` placement and its golden all stand. A partial match keeps the items that
 * did match — direction included — and only inserts what is missing.
 */
function alignDistinctOn(n: SelectNode): SelectNode {
  const on = n.distinct?.on
  if (on === undefined || on.length === 0) return n
  const user = n.orderBy ?? NO_ORDER

  let matched = 0
  while (matched < on.length) {
    const item = user[matched]
    if (item === undefined || !sameExpr(item.e, on[matched] as Expr)) break
    matched++
  }
  if (matched === on.length) return n

  const items: OrderItem[] = user.slice(0, matched)
  // `asc` is PostgreSQL's own default for an unqualified ORDER BY item, so a key the caller never
  // ordered by is ordered the way writing it out by hand would have.
  for (let i = matched; i < on.length; i++) items.push(order(on[i] as Expr, 'asc'))
  for (let i = matched; i < user.length; i++) items.push(user[i] as OrderItem)
  return select({ ...n, orderBy: Object.freeze(items) })
}

/**
 * Hoist every nested relation in a select's projection into `LEFT JOIN LATERAL`s, share every
 * relation aggregate that appears more than once, expand every `nest({...})` group, and produce
 * the positional decode plan.
 *
 * Idempotent on a select with none of the three, which it returns **unchanged and by reference**.
 *
 * `rowEquality` says the statement compares this select's rows for equality even though the
 * select itself carries no `distinct` — it is a branch of a `union` / `intersect` / `except`
 * (`compiler.ts` threads it down through the branches). It changes exactly one thing, the json
 * variant of a relation column; see {@link jsonVariant}. It is part of the memo key because the
 * same frozen node can legally be planned both ways in one program.
 */
export function planSelect(node: SelectNode, rowEquality = false): PlannedSelect {
  const eq = rowEquality || comparesWholeRows(node)
  const cache = eq ? PLANNED_EQ : PLANNED
  const memo = cache.get(node)
  if (memo !== undefined) return memo
  const planned = planSelectUncached(node, eq)
  cache.set(node, planned)
  if (planned.node !== node) {
    cache.set(planned.node, {
      node: planned.node,
      fields: planned.fields,
      origins: planned.origins,
    })
  }
  return planned
}

function planSelectUncached(node: SelectNode, rowEquality: boolean): PlannedSelect {
  const seq: Seq = { n: 0 }
  const cse = newCse(seq)
  // The alignment runs on the REWRITTEN node so that `distinctOn(u.posts.count())` compares the
  // `"_r0"."v"` the emitter will print against the `"_r0"."v"` in the ORDER BY, not two
  // structurally identical subqueries that CSE is about to collapse into one reference.
  const rewritten = alignDistinctOn(rewriteClauses(node, cse))

  if (cse.joins.length === 0 && isFlat(node.projection)) {
    const leaf = leafFields(node.projection)
    return { node: rewritten, fields: leaf.fields, origins: leaf.origins }
  }

  // `cse.joins` first: an aggregate lateral is written before a relation lateral, which is the
  // order 03 §2.3's golden shows and the order a reader meets them in the projection.
  const out: FlatOut = {
    items: [],
    joins: [...cse.joins],
    origins: [],
    hoist: true,
    rowEquality,
    seq,
    colSeq: { n: 0 },
  }
  const { fields } = flatten(rewritten.projection, '', 0, out)

  return {
    node: select({
      ...rewritten,
      projection: out.items,
      joins: [...(rewritten.joins ?? []), ...out.joins],
    }),
    fields,
    origins: out.origins,
  }
}

/**
 * Same, for a RETURNING list (which reuses the projection machinery — 03 §2.5).
 *
 * Groups expand exactly as they do in a select. What differs is that there is no FROM clause to
 * hang a LATERAL on, so nothing is hoisted here: a relation *aggregate* keeps the correlated-
 * subquery form it already has (which is valid in a RETURNING list and needs no special case),
 * and a relation *projection* is accepted only under `{ strategy: 'subquery' }`.
 */
export function planReturning(items: readonly ProjectionItem[]): {
  items: readonly ProjectionItem[]
  fields: FieldPlan[]
  origins: (FieldOrigin | undefined)[]
} {
  if (isFlat(items)) {
    const leaf = leafFields(items)
    return { items, fields: leaf.fields, origins: leaf.origins }
  }
  const out: FlatOut = {
    items: [],
    joins: [],
    origins: [],
    hoist: false,
    // A RETURNING list is never DISTINCT — the grammar has no such thing.
    rowEquality: false,
    seq: { n: 0 },
    colSeq: { n: 0 },
  }
  const { fields } = flatten(items, '', 0, out)
  return { items: out.items, fields, origins: out.origins }
}
