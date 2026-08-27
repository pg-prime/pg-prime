/**
 * Runtime column references and the per-alias scope cache (design/09 WS3).
 *
 * ## A ref *is* an AST node
 *
 * `u.email` has to be two things at once: a `ColumnNode` the compiler can emit, and a value the
 * type layer recognises as `Ref<'users', 'email', …>`. It is both, literally — the object below is
 * the `ColumnNode` the compiler already understands, with the schema's `RefRuntime` hung off `$`
 * (design/05 D2's one escape-hatch key). Three consequences worth stating, because each replaces
 * code that would otherwise have to exist:
 *
 *  1. `` sql`${u.id} = 1` `` needs no special case. The `sql` tag's hole classifier asks
 *     `isAstNode(v)`, and a ref *is* one, so it splices as `"u"."id"` rather than being treated as
 *     data. A ref that were a wrapper object would fall into the `param()` branch and silently
 *     become `$1` — the exact failure mode the tag's nominal test exists to prevent.
 *  2. `codecOf(ref)` is already written (`src/compile/hoist.ts`), so an operator reads its left
 *     operand's codec — which is how the right operand gets encoded — with no new machinery.
 *  3. There is nothing to unwrap on the hot path. `eq(u.id, 1n)` passes `u.id` to `bin()`
 *     unchanged.
 *
 * ## The cache, and what the F1 decision did to "prototype-based"
 *
 * `03` §2.9 asks for refs that are "prototype-based objects created once per (table, alias) and
 * cached". Half of that requirement died with fork F1: operators are free functions (09 §3.0), so
 * a ref has **no methods**, and there is no prototype to share. What survives — and what actually
 * pays — is the *caching*: `from(users, 'u')` looks up one frozen record instead of building a
 * `ColumnNode` per column per query. Every ref is built by the single object literal in `build()`,
 * so they all share one hidden class, which is the other thing a shared prototype would have
 * bought.
 *
 * Keyed by `(registry, table, alias)` and invalidated by `registry.generation`, for the same
 * reason `metaOf` is (see `./meta.ts`): before `resolveDynamic` an enum column's codec has no OID.
 */

import type { CodecRegistry } from '../codec/index.js'
import { defaultRegistry } from '../codec/index.js'
import type { ColumnNode } from '../compile/ast.js'
import { col, mkNode } from '../compile/nodes.js'
import type { COLS, REFS, RefRuntime, RefsOfCols } from '../schema/index.js'
import type { AnyTable } from '../schema/index.js'
import { metaOf } from './meta.js'
import type { TableLike } from './meta.js'

/**
 * A column reference at runtime: the compiler's `ColumnNode` plus the schema's `RefRuntime`.
 *
 * The type layer's `Ref<A, K, M>` describes the same object through phantom slots; they agree on
 * exactly one real property, `$`.
 */
export interface RefNode extends ColumnNode {
  readonly $: RefRuntime
}

/** One alias's worth of refs, by TS key. Frozen; `from(users, 'u')` hands this out as-is. */
export type RefScope = Readonly<Record<string, RefNode>>

/**
 * The refs of `T` under alias `A`, at the type level.
 *
 * Two indexed accesses and one mapped type, and the mapped type is the same `RefsOfCols` the
 * table already pre-computes for its own name (`Table[REFS]`) — so `refsOf(users)` costs nothing
 * new and only a *custom alias* pays for a second instantiation. That is unavoidable: `"u"."id"`
 * and `"users"."id"` are different references and `Ref` carries the alias in `[SRC]`.
 */
export type RefsAtAlias<T extends AnyTable, A extends string> = RefsOfCols<
  A,
  T[typeof COLS & keyof T]
>

interface Entry {
  gen: number
  tables: WeakMap<TableLike, Map<string, RefScope>>
}

const CACHE = new WeakMap<CodecRegistry, Entry>()

/**
 * The refs of `t` under `alias` (default: the table's own name, which is what `.from(users)` uses).
 *
 * Idempotent per `(registry, table, alias)`: two calls return the *same frozen object*, and so do
 * the refs inside it, which is what makes `.where(…)` and `.select(…)` on one builder allocate
 * nothing.
 */
export function refsOf<T extends AnyTable, A extends string>(
  t: T,
  alias: A,
  registry?: CodecRegistry,
): RefsAtAlias<T, A>
export function refsOf<T extends AnyTable>(
  t: T,
  alias?: undefined,
  registry?: CodecRegistry,
): T[typeof REFS & keyof T]
/**
 * The untyped form, for anything that merely carries a `TableRuntime` — a `Handle` from
 * `defineSchema(...)`, which the builder is handed. The typed overloads above stay the surface a
 * user sees; this one is what `src/query/scope.ts` calls once per (table, alias).
 */
export function refsOf(t: TableLike, alias: string, registry?: CodecRegistry): RefScope
export function refsOf(
  t: TableLike,
  alias?: string,
  registry: CodecRegistry = defaultRegistry(),
): unknown {
  const name = alias ?? t.$.name
  let entry = CACHE.get(registry)
  if (entry === undefined || entry.gen !== registry.generation) {
    entry = { gen: registry.generation, tables: new WeakMap() }
    CACHE.set(registry, entry)
  }
  let byAlias = entry.tables.get(t)
  if (byAlias === undefined) {
    byAlias = new Map()
    entry.tables.set(t, byAlias)
  }
  const hit = byAlias.get(name)
  if (hit !== undefined) return hit
  const built = build(t, name, registry)
  byAlias.set(name, built)
  return built
}

function build(t: TableLike, alias: string, registry: CodecRegistry): RefScope {
  const meta = metaOf(t, registry)
  const out: Record<string, RefNode> = {}
  for (let i = 0; i < meta.keys.length; i++) {
    const key = meta.keys[i] as string
    const column = meta.columns[i] as (typeof meta.columns)[number]
    const runtime = t.$.columns[i] as RefRuntime
    // `col()` pre-quotes `"alias"."name"` once, here, and registers the node in the AST WeakSet;
    // spreading it into a new object drops that registration, so `mkNode` puts the copy back.
    // Every ref in the program comes out of this one object literal ⇒ one hidden class.
    out[key] = mkNode({ ...col(alias, column.name, column.codec), $: runtime })
  }
  return Object.freeze(out)
}
