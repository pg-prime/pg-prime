/**
 * Sources, scopes and projections — the three things every builder stage needs (design/09 WS4).
 *
 * ## A source is whatever can sit in a FROM clause
 *
 * A table, a CTE, or a derived table. The builder never asks which: it asks a {@link SourceRuntime}
 * for a `FromItem` and for a record of refs, and both answers are cached per `(registry, source,
 * alias)`. That is what keeps `.from()` allocation-free on a repeated query *and* keeps the
 * "is this alias a CTE?" question out of the hot path — the same property `03` §2.7's amendment
 * claims at the type level, held at the value level for the same reason.
 *
 * ## Scope lambdas run at call time, exactly once
 *
 * `03`'s contract, and `09` WS4 restates it: `.where(t => …)` invokes the lambda immediately, not
 * at `.compile()` time. So a `Math.random()` or a `Date.now()` inside a callback happens where the
 * reader sees it, and `.compile()` twice cannot produce two different queries.
 *
 * ## Relations live on the scope, next to the columns
 *
 * Fork F3 (09 §3.0). A scope is the ref record plus one accessor per declared relation, merged
 * into one frozen object — and merged **only when there is something to merge**, so a table with
 * no relations hands back the cached ref record itself. `./projection.ts` owns what may appear in
 * a projection; `./relations.ts` owns what an accessor emits.
 */

import type { AnyCodec, CodecRegistry } from '../codec/index.js'
import { jsonCodecJson } from '../codec/index.js'
import type { FromItem, SelectNode, SetOpNode } from '../compile/ast.js'
import type { FieldPlan } from '../compile/contract.js'
import { planSelect } from '../compile/hoist.js'
import { col, cteRef, isAstNode, mkNode, subquery, table as tableFrom } from '../compile/nodes.js'
import type { ColumnRuntime, RefRuntime } from '../schema/index.js'
import { NAME } from '../schema/index.js'
import { BuilderError } from '../sql/errors.js'
import type { BuilderCtx } from './builder-state.js'
import type { TableLike } from './meta.js'
import { metaOf } from './meta.js'
import type { RefNode, RefScope } from './ref.js'
import { refsOf } from './ref.js'
import { mergeAccessors } from './relations.js'

// ─────────────────────────────────────────────────────────────────────────────
// Sources
// ─────────────────────────────────────────────────────────────────────────────

export interface SourceRuntime {
  readonly kind: 'table' | 'cte' | 'derived'
  /** The default alias — the schema key for a table handle, the declared name for a CTE. */
  readonly name: string
  fromItem(alias: string, lateral: boolean): FromItem
  refs(alias: string, registry: CodecRegistry): RefScope
}

/**
 * Non-table sources, keyed by the handle object.
 *
 * A `WeakMap` and not a property on the handle, for the reason `nodes.ts` keeps its node registry
 * in a `WeakSet`: membership is then **nominal**, so a plain object that happens to have the right
 * shape — `JSON.parse` of a request body, say — cannot pass itself off as a query source.
 */
const SOURCES = new WeakMap<object, SourceRuntime>()

/** Column list of a sub-select, for the refs of a CTE or derived table. */
export interface DerivedField {
  readonly key: string
  readonly codec: AnyCodec
}

/**
 * The addressable columns of a sub-select.
 *
 * A `nest({...})` group is skipped: it is several columns with dotted aliases, so there is no
 * single column an outer query could name. Referencing such a key off a CTE scope is therefore
 * `undefined` and fails at the call site rather than compiling to something plausible.
 */
export function fieldsOfQuery(node: SelectNode | SetOpNode): readonly DerivedField[] {
  const target = node.k === 'setop' ? leftmostSelect(node) : node
  const out: DerivedField[] = []
  for (const f of planSelect(target).fields as readonly FieldPlan[]) {
    if (f.k === 'col') out.push({ key: f.key, codec: f.codec })
    else if (f.k === 'json') out.push({ key: f.key, codec: jsonCodecJson })
  }
  return Object.freeze(out)
}

function leftmostSelect(n: SetOpNode): SelectNode {
  let cur: SelectNode | SetOpNode = n
  while (cur.k === 'setop') cur = cur.left
  return cur
}

/** A synthetic `ColumnRuntime` for a derived column: enough for `$` to exist, nothing claimed. */
function derivedColumn(): ColumnRuntime {
  return {
    ddl: {
      pgType: 'unknown',
      dbName: undefined,
      notNull: false,
      default: undefined,
      identity: undefined,
      primaryKey: false,
      unique: false,
      uniqueSpec: undefined,
      enumName: undefined,
      enumValues: undefined,
      enumSchema: undefined,
      arrayDim: 0,
      references: undefined,
      checks: [],
      comment: undefined,
      renamedFrom: undefined,
    },
    ts: { defaultFn: undefined, onUpdateFn: undefined, narrowed: false },
  }
}

function derivedRefs(source: string, alias: string, fields: readonly DerivedField[]): RefScope {
  const out: Record<string, RefNode> = {}
  const column = derivedColumn()
  for (const f of fields) {
    const rt: RefRuntime = { table: source, schema: undefined, key: f.key, dbName: f.key, column }
    out[f.key] = mkNode({ ...col(alias, f.key, f.codec), $: rt })
  }
  return Object.freeze(out)
}

/** Register a CTE handle: it resolves to `"name" as "alias"` and to refs built from its columns. */
export function registerCte(handle: object, name: string, fields: readonly DerivedField[]): void {
  SOURCES.set(handle, {
    kind: 'cte',
    name,
    fromItem: (alias) => cteRef(name, alias),
    refs: (alias) => derivedRefs(name, alias, fields),
  })
}

/** Register a derived-table handle (`db.from(...).select(...).as('recent')`). */
export function registerDerived(
  handle: object,
  name: string,
  node: SelectNode | SetOpNode,
  fields: readonly DerivedField[],
): void {
  SOURCES.set(handle, {
    kind: 'derived',
    name,
    fromItem: (alias, lateral) => subquery(node, alias, lateral),
    refs: (alias) => derivedRefs(name, alias, fields),
  })
}

/**
 * Register a `fromRaw` handle: one already-built FROM item, and refs over the declared shape.
 *
 * The item is built once by `fromRaw` rather than per call, because a raw FROM item carries the
 * caller's parameters — rebuilding it per alias would re-encode them, and `lateral` is meaningless
 * for it (a `lateral` keyword before hand-written SQL would be the caller's to write).
 */
export function registerRawFrom(
  handle: object,
  name: string,
  item: FromItem,
  fields: readonly DerivedField[],
): void {
  SOURCES.set(handle, {
    kind: 'derived',
    name,
    fromItem: () => item,
    refs: (alias) => derivedRefs(name, alias, fields),
  })
}

/**
 * Memo for the table branch of {@link sourceOf}.
 *
 * A table handle's `SourceRuntime` is a constant of the handle — the schema key and two closures
 * over it — and `sourceOf` is called once per `.from()`/`.join()` **and once per alias inside
 * every scope rebuild**, which is O(aliases²) over a chain. Rebuilding the record each time
 * allocated an object and two closures per call for an answer that cannot change. `SOURCES` above
 * cannot hold these because it is the *nominal* registry for CTEs and derived tables: membership
 * there means "registered by this library", and a bare table handle is recognised structurally,
 * by its `$`.
 */
const TABLE_SOURCES = new WeakMap<object, SourceRuntime>()

/** The runtime behind whatever `.from()` / `.innerJoin()` was handed. */
export function sourceOf(h: unknown): SourceRuntime {
  if (typeof h === 'object' && h !== null) {
    const registered = SOURCES.get(h)
    if (registered !== undefined) return registered
    const memo = TABLE_SOURCES.get(h)
    if (memo !== undefined) return memo
    const like = h as TableLike & Record<symbol, unknown>
    if (like.$ !== undefined && typeof like.$.name === 'string') {
      // The schema KEY, not the DB name: `defineSchema` keys `postTags` onto a table called
      // `post_tags`, and the alias the type layer promises is the key.
      const key = typeof like[NAME] === 'string' ? (like[NAME] as string) : like.$.name
      const built: SourceRuntime = {
        kind: 'table',
        name: key,
        fromItem: (alias) => tableFrom(metaOf(like).table, alias),
        refs: (alias, registry) => refsOf(like, alias, registry),
      }
      TABLE_SOURCES.set(h, built)
      return built
    }
  }
  throw new BuilderError(
    'pg-prime: not a query source. Pass a table handle from `defineSchema(...).h`, a CTE from ' +
      '`db.with(...).cte`, or a derived table from `.as(name)`.',
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Scopes
// ─────────────────────────────────────────────────────────────────────────────

interface ScopeEntry {
  gen: number
  byHandle: WeakMap<object, Map<string, RefScope>>
}

/**
 * Keyed by **registry** first, then handle, then alias — the shape `refsOf` already uses.
 *
 * Two registries can share a generation number (both start at 0), so keying only on the
 * generation would let a scope built against one database's enum OIDs be handed to a query
 * against another's.
 */
const SCOPE_CACHE = new WeakMap<CodecRegistry, ScopeEntry>()

/**
 * The scope object for one alias: the refs, plus a relation accessor per declared relation.
 *
 * Cached like `refsOf` is, and for the same reason — two `.where()` calls on one builder must
 * allocate nothing. A source with no relations (a CTE, a derived table, a table the schema
 * declares none for) gets the ref record back **by reference**, so fork F3's merged namespace
 * costs a relation-free query nothing at runtime, exactly as it costs it nothing at the type
 * level (`ScopeOf`'s `[N] extends [never]` branch).
 */
export function scopeFor(
  handle: object,
  alias: string,
  ctx: BuilderCtx,
  visible: readonly string[] = [alias],
): RefScope {
  const registry = ctx.registry
  let entry = SCOPE_CACHE.get(registry)
  if (entry === undefined || entry.gen !== registry.generation) {
    entry = { gen: registry.generation, byHandle: new WeakMap() }
    SCOPE_CACHE.set(registry, entry)
  }
  let byAlias = entry.byHandle.get(handle)
  if (byAlias === undefined) {
    byAlias = new Map()
    entry.byHandle.set(handle, byAlias)
  }
  // The avoid-list is part of the identity of the scope, not just of the alias: the same table at
  // the same alias produces different relation-child aliases in a statement that also binds
  // "posts" and in one that does not.
  //
  // `rebuildScope` calls this once per alias with the SAME array, so the suffix is recomputed
  // O(aliases²) times over a chain. Two things were tried against that (design/09 §3.7 follow-up):
  //
  //  - **dropping the `[...avoid].sort()` that used to be here** — kept. It only ever
  //    *canonicalised* two spellings of the same alias set so they could share a cache entry, and
  //    `Object.keys` of a frozen sources record is already deterministic for a given chain shape.
  //    Two chains that reach the same set in different orders now miss the cache and build the
  //    scope twice, which is a cost, never a wrong answer — the avoid-list itself is read with
  //    `includes`, which does not care about order. Measured at **4 506 B per compile**, 14 % of
  //    the whole thing, because the copy is per alias per rebuild;
  //  - **memoising the joined string on the array's identity** — reverted. It measured 206 B per
  //    compile, 0.6 %, and it was a process-global one-entry cache: a mutation that made it hand
  //    back the *previous* statement's key passed all 733 tier-0 tests and all 1 452 tier-1 ones
  //    (R10 M10). 0.6 % is not worth a correctness property with no oracle behind it.
  const avoid = visible.includes(alias) ? visible : [alias, ...visible]
  const key = avoid.length === 1 ? alias : `${alias}\u0000${avoid.join('\u0000')}`
  const hit = byAlias.get(key)
  if (hit !== undefined) return hit

  const source = sourceOf(handle)
  const refs = source.refs(alias, registry)
  // Only a table can have relations. Every alias bound in the enclosing statement is an avoid-list
  // entry: shadowing the parent turns `child.parent_id = parent.id` into a self-comparison, and
  // shadowing a SIBLING does the same to any predicate the sub-query writes against it.
  const built = withAll(
    source.kind === 'table' ? mergeAccessors(ctx, source.name, alias, refs, avoid) : refs,
    refs,
    alias,
  )
  byAlias.set(key, built)
  return built
}

/**
 * Hang `$all` — the alias's own ref record — off the scope object (`03` §2.1).
 *
 * `refs` and not `scope`: `{ ...u.$all }` means every *column*, so the relation accessors are not
 * in it, and neither is `$all` itself. It is the cached frozen record, shared by reference, so the
 * whole feature costs one property on an object that is itself built at most once per
 * (registry, handle, alias, avoid-list).
 */
function withAll(scope: RefScope, refs: RefScope, alias: string): RefScope {
  if (Object.hasOwn(refs, ALL)) {
    throw new BuilderError(
      `pg-prime: "${alias}" has a column named "${ALL}", which is the name of the scope's ` +
        `every-column record (\`{ ...t.${alias}.${ALL} }\`). One would hide the other. Rename the ` +
        `column's TS key — \`dbName\` can keep the database's spelling.`,
    )
  }
  return Object.freeze({ ...scope, [ALL]: refs }) as unknown as RefScope
}

/** The scope member `03` §2.1 spells `u.$all`. One string, so the runtime and the type agree. */
const ALL = '$all'

/** Every ref of an alias, as a projection record — `selectAll` and `RETURNING *`. */
export function allOf(scope: RefScope): Record<string, RefNode> {
  const out: Record<string, RefNode> = {}
  for (const key of Object.keys(scope)) {
    const v = scope[key]
    // A relation accessor is an object of methods and `$all` is a record of refs; neither is a
    // ref, and `selectAll` means every *column*. `isAstNode` is the nominal test that says so.
    if (v !== undefined && typeof v !== 'function' && isAstNode(v)) out[key] = v
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Projections
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-exported, not defined here. `./projection.ts` owns the projection markers so that
 * `./relations.ts` — which produces both of them — can reach them without importing this module,
 * which imports it. The surface every builder sees is unchanged.
 */
export {
  assertSafeKey,
  compileProjection,
  isGroup,
  isNested,
  makeNested,
  nest,
  nestNullable,
  NO_LEFT_JOINS,
  omit,
  outputColumn,
  projectionItem,
  registryOr,
  toExprList,
  toExprNode,
  toOrderItems,
} from './projection.js'
