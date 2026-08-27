import { SchemaError } from '../sql/errors.js'
import { COLS, NAME, RELS, SCHEMA, SEL, TABLES } from './symbols.js'
import type { AnyRef } from './ref.js'
import type { AnyTable, TableRuntime } from './table.js'
import type { Defer, RelMeta, Rels, Simplify } from './types.js'

export type Tables = Record<string, AnyTable>

/** Per-table relation records. Tables without relations simply omit the key. */
export type RelsRecord<T extends Tables> = { [K in keyof T]?: Rels }

// ─────────────────────────────────────────────────────────────────────────────
// defineRelations (design/05 D6, typed per design/04 §1.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runtime-only relation configuration. Carries FK columns / `through` table /
 * per-parent predicates. **It must never enter the type parameters**
 * (design/04 §7.3).
 */
export interface RelConfig {
  /**
   * Parent-side column reference(s). **Required**: the column DSL has no `.references()`, so
   * there is no foreign key in the schema for a resolver to infer from (design/09 §3.5 decision
   * 4). The runtime has always thrown without it; the type now says so too.
   */
  readonly from: unknown
  /** Target-side column reference(s), positionally paired with {@link RelConfig.from}. */
  readonly to: unknown
  readonly through?: unknown
  /** Always-applied per-parent predicate — `where: (t) => isNull(t.deletedAt)` (03 §4.1). */
  readonly where?: unknown
  /** Default ordering for `.many()` when the caller supplies none. */
  readonly orderBy?: unknown
  /** The child's alias inside the lateral. Only worth setting to make EXPLAIN output readable. */
  readonly alias?: string
}

/**
 * Three namespaces instead of design/05's `{ optional: false }` flag: each
 * picker returns a *fixed* `opt` literal, so a declared relation costs no
 * conditional. `one` is non-nullable and `maybeOne` opts into `| null`, which
 * is design/04's `one`/`maybeOne`/`many` trio and matches NOT-NULL-by-default.
 */
export interface RelBuilders<T extends Tables> {
  readonly one: { readonly [K in keyof T & string]: (cfg: RelConfig) => { kind: 'one'; opt: false; to: K } }
  readonly maybeOne: { readonly [K in keyof T & string]: (cfg: RelConfig) => { kind: 'one'; opt: true; to: K } }
  readonly many: { readonly [K in keyof T & string]: (cfg: RelConfig) => { kind: 'many'; opt: false; to: K } }
}

/** Runtime relation node — what the query compiler reads. */
export interface RelNode {
  readonly kind: 'one' | 'many'
  readonly opt: boolean
  readonly to: string
  readonly config: RelConfig | undefined
}

function namespace(keys: readonly string[], kind: 'one' | 'many', opt: boolean): Record<string, unknown> {
  // Null-prototype: a table registered under the key `__proto__` would otherwise retarget the
  // namespace's prototype instead of becoming a picker, and `r.many.__proto__(...)` would be
  // `Object.prototype`, not a function.
  const ns: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const to of keys) ns[to] = (config: RelConfig): RelNode => ({ kind, opt, to, config })
  return ns
}

/**
 * `defineRelations(tables, r => ({ ... }))`.
 *
 * Relations produce **zero DDL** — this is purely a query-layer artifact.
 */
export function defineRelations<
  T extends Tables,
  R extends { [K in keyof T]?: Record<string, RelMeta<keyof T & string>> },
>(tables: T, build: (r: RelBuilders<T>) => R): R {
  const keys = Object.keys(tables)
  const r = {
    one: namespace(keys, 'one', false),
    maybeOne: namespace(keys, 'one', true),
    many: namespace(keys, 'many', false),
  } as unknown as RelBuilders<T>
  return build(r)
}

// ─────────────────────────────────────────────────────────────────────────────
// The schema registry (design/04 §1.5)
// ─────────────────────────────────────────────────────────────────────────────

export interface AnySchema {
  readonly [TABLES]: any
  readonly [RELS]: any
}

/**
 * A table handle: two indexed accesses reach anything, and nothing is
 * structurally inlined. This is what makes a fully-cyclic relation graph
 * typecheck with no thunks and no `.d.ts` explosion.
 */
export interface Handle<Sc extends AnySchema, N extends string> {
  readonly [SCHEMA]: Sc
  readonly [NAME]: N
  readonly $: TableRuntime
}

export interface AnyHandle {
  readonly [SCHEMA]: any
  readonly [NAME]: any
  readonly $: TableRuntime
}

export interface Schema<T extends Tables, R extends RelsRecord<T>> {
  readonly [TABLES]: T
  readonly [RELS]: R
  readonly tables: T
  readonly rels: R
  /** Table handles, one per registry key. The one fixed O(N) cost per program. */
  readonly h: { readonly [K in keyof T & string]: Handle<Schema<T, R>, K> }
}

export function defineSchema<T extends Tables, R extends RelsRecord<T> = {}>(
  tables: T,
  rels?: R,
): Schema<T, R> {
  // Null-prototype: a table keyed `__proto__` must produce a handle, not silently reassign the
  // prototype of the handle record and then read back as `undefined`.
  const h: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(tables)) {
    h[key] = Object.freeze({ [SCHEMA]: undefined, [NAME]: key, $: tables[key]!.$ })
  }
  // Eagerly, so a bad declaration fails on the import of the schema file rather than on the first
  // query that happens to touch the relation (design/03 §4.1). The result is memoised on
  // (tables, rels), so the query layer's own call is a map lookup.
  if (rels !== undefined) resolveRelations(tables, rels as RelsRecord<Tables>)
  const empty = Object.freeze({}) as R
  return Object.freeze({
    [TABLES]: tables,
    [RELS]: rels ?? empty,
    tables,
    rels: rels ?? empty,
    h: Object.freeze(h),
  }) as unknown as Schema<T, R>
}

/** Two indexed accesses; never a conditional, never a distribution. */
export type TableOf<Sc, N extends PropertyKey> = Sc[typeof TABLES & keyof Sc][N &
  keyof Sc[typeof TABLES & keyof Sc]]

export type RelsAt<Sc, N extends PropertyKey> = NonNullable<
  Sc[typeof RELS & keyof Sc][N & keyof Sc[typeof RELS & keyof Sc]]
>

export type ColsAt<Sc, N extends PropertyKey> = TableOf<Sc, N>[typeof COLS &
  keyof TableOf<Sc, N>]

export type SelAt<Sc, N extends PropertyKey> = TableOf<Sc, N>[typeof SEL & keyof TableOf<Sc, N>]

/** `many` → `O[]`; optional `one` → `O | null`; required `one` → `O`. */
export type RelOut<M extends RelMeta, O> = M['kind'] extends 'many'
  ? O[]
  : M['opt'] extends true
    ? O | null
    : O

// ─────────────────────────────────────────────────────────────────────────────
// Loaded<> — a structural contract, not a brand (design/04 §2.5, D7)
// ─────────────────────────────────────────────────────────────────────────────

type LoadedIn<Sc extends AnySchema, N extends string, K extends string, F extends PropertyKey> = Defer<
  Simplify<
    { [P in F & keyof ColsAt<Sc, N>]: ColsAt<Sc, N>[P]['t'] } & {
      [P in K & keyof RelsAt<Sc, N>]-?: RelOut<RelsAt<Sc, N>[P], SelAt<Sc, RelsAt<Sc, N>[P]['to']>>
    }
  >
>

/**
 * Three parameters: the handle, the **required** relations, and the
 * **selected** columns.
 *
 * Because query results are plain object types, a result that projected all of
 * `users` plus `posts` is *assignable* to `Loaded<typeof users, 'posts'>` with
 * no cast, no runtime marker and no `Ref`/`Collection` wrapper.
 */
export type Loaded<
  H extends AnyHandle,
  K extends keyof RelsAt<H[typeof SCHEMA], H[typeof NAME]> & string = never,
  F extends keyof ColsAt<H[typeof SCHEMA], H[typeof NAME]> = keyof ColsAt<
    H[typeof SCHEMA],
    H[typeof NAME]
  >,
> = LoadedIn<H[typeof SCHEMA], H[typeof NAME], K, F>

// ─────────────────────────────────────────────────────────────────────────────
// Resolution — design/03 §4.1's consumption contract (design/09 WS5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A relation, resolved down to column **TS keys** and the schema keys of the tables involved.
 *
 * Deliberately *not* `03` §4.1's `RelationMeta`, which carries `ColumnMeta` — and therefore
 * codecs, and therefore a registry. A codec's OID is per-database (`02` §4.6), so binding one at
 * `defineSchema` time would freeze whatever the default registry held before `resolveDynamic` ran.
 * The split is the same seam `metaOf` already draws: *structure* is resolved once here, at
 * definition time, where a mistake is a thrown sentence; *codecs* are resolved per registry in
 * `src/query/relations.ts`, where they can be re-resolved when the generation moves.
 */
export interface ResolvedRelation {
  readonly name: string
  readonly kind: 'one' | 'many'
  /** `false` ⇒ a `one` relation decodes as `T | null`. Always true for `many`. */
  readonly required: boolean
  /** Schema key of the table the relation is declared on. */
  readonly parent: string
  /** Schema key of the table it points at. */
  readonly target: string
  /** Parent-side column keys. Composite keys are the reason this is an array (§4.1 hard ask #2). */
  readonly from: readonly string[]
  /** Target-side column keys, positionally paired with {@link from} (or with `through.to`). */
  readonly to: readonly string[]
  readonly through: ResolvedThrough | undefined
  /** Always-applied per-parent predicate, from the declaration. */
  readonly where: ((t: never) => unknown) | undefined
  /** Default ordering for `.many()` when the caller supplies none. */
  readonly orderBy: ((t: never) => unknown) | undefined
  /** `alias` from the declaration — the child alias inside the lateral, when the caller named one. */
  readonly alias: string | undefined
}

/** The m2m hop: parent → `from`/`through.from`, `through.to`/`to` → target (§4.1 hard ask #3). */
export interface ResolvedThrough {
  readonly table: AnyTable
  readonly from: readonly string[]
  readonly to: readonly string[]
}

/** Table key → relation name → resolved relation. Frozen. */
export type ResolvedRelations = Readonly<
  Record<string, Readonly<Record<string, ResolvedRelation>>>
>

/**
 * Keyed on **both** halves, `tables` outermost.
 *
 * A single-level memo on `rels` was wrong: one relation record is legitimately shared by two
 * registries (`defineSchema(tablesA, rels)`, `defineSchema(tablesB, rels)` — the pattern a
 * multi-tenant or test harness reaches for), and the second call would then hand back the first
 * registry's resolution *and skip validation entirely*, so a relation pointing at a table
 * `tablesB` does not have would sail through `defineSchema` and fail later as a `42P01`.
 */
const RESOLVED = new WeakMap<object, WeakMap<object, ResolvedRelations>>()

/**
 * Resolve — and validate — a whole relation record. Memoised on `(tables, rels)`, so the eager
 * call in `defineSchema` and the query layer's later call share one result.
 */
export function resolveRelations(
  tables: Tables,
  rels: RelsRecord<Tables> | undefined,
): ResolvedRelations {
  if (rels === undefined) return EMPTY
  let byRels = RESOLVED.get(tables)
  if (byRels === undefined) {
    byRels = new WeakMap()
    RESOLVED.set(tables, byRels)
  }
  const hit = byRels.get(rels)
  if (hit !== undefined) return hit
  const built = build(tables, rels)
  byRels.set(rels, built)
  return built
}

const EMPTY: ResolvedRelations = Object.freeze({})

function build(tables: Tables, rels: RelsRecord<Tables>): ResolvedRelations {
  // Null-prototype throughout: a table or relation named `__proto__` must be a key, never a
  // prototype reassignment that reads back as `Object.prototype` (E11).
  const out: Record<string, Record<string, ResolvedRelation>> = Object.create(null) as Record<
    string,
    Record<string, ResolvedRelation>
  >
  for (const parent of Object.keys(rels)) {
    const table = tables[parent]
    if (table === undefined) {
      throw new SchemaError(
        `pg-prime: defineRelations declares relations on "${parent}", which is not a table in this ` +
          `schema (have: ${Object.keys(tables).join(', ')}).`,
      )
    }
    const declared = rels[parent] as Record<string, RelNode> | undefined
    if (declared === undefined) continue
    const columns = new Set(table.$.columns.map((c) => c.key))
    const byName: Record<string, ResolvedRelation> = Object.create(null) as Record<
      string,
      ResolvedRelation
    >
    for (const name of Object.keys(declared)) {
      // 03 §4.1 hard ask #1. Fork F3 put relations on the same scope object as the columns, so a
      // collision is not a namespacing question — one of the two would simply be unreachable.
      if (columns.has(name)) {
        throw new SchemaError(
          `pg-prime: relation "${parent}.${name}" has the same name as a column of "${parent}". ` +
            `Relation accessors live on the same scope object as the columns, so one would hide ` +
            `the other. Rename the relation.`,
        )
      }
      byName[name] = one(tables, table, parent, name, declared[name] as RelNode)
    }
    out[parent] = Object.freeze(byName)
  }
  return Object.freeze(out)
}

function one(
  tables: Tables,
  parentTable: AnyTable,
  parent: string,
  name: string,
  node: RelNode,
): ResolvedRelation {
  const where = `relation "${parent}.${name}"`
  const target = tables[node.to]
  if (target === undefined) {
    throw new SchemaError(
      `pg-prime: ${where} points at "${node.to}", which is not a table in this schema ` +
        `(have: ${Object.keys(tables).join(', ')}).`,
    )
  }
  const cfg = node.config
  if (cfg === undefined || cfg.from === undefined || cfg.to === undefined) {
    throw new SchemaError(
      `pg-prime: ${where} needs explicit \`from\` and \`to\` column references — ` +
        `r.${node.kind === 'many' ? 'many' : 'one'}.${node.to}({ from: ${parent}[REFS].xId, ` +
        `to: ${node.to}[REFS].id }). Inferring them from a foreign key is not possible yet: the ` +
        `column DSL has no \`.references()\`, so there is nothing in the schema to read.`,
    )
  }

  const from = keysOf(cfg.from, parentTable, `${where} \`from\``)
  const to = keysOf(cfg.to, target, `${where} \`to\``)

  let through: ResolvedThrough | undefined
  if (cfg.through !== undefined) {
    const t = cfg.through as { table?: AnyTable; from?: unknown; to?: unknown }
    if (t.table === undefined || t.from === undefined || t.to === undefined) {
      throw new SchemaError(
        `pg-prime: ${where} declares \`through\` but not all of { table, from, to }. The junction ` +
          `hop is parent → from/through.from, through.to → to.`,
      )
    }
    through = Object.freeze({
      table: t.table,
      from: keysOf(t.from, t.table, `${where} \`through.from\``),
      to: keysOf(t.to, t.table, `${where} \`through.to\``),
    })
    arity(from, through.from, where, 'from', 'through.from')
    compat(from, parentTable, through.from, t.table, where, 'from', 'through.from')
    arity(through.to, to, where, 'through.to', 'to')
    compat(through.to, t.table, to, target, where, 'through.to', 'to')
  } else {
    arity(from, to, where, 'from', 'to')
    compat(from, parentTable, to, target, where, 'from', 'to')
  }

  return Object.freeze({
    name,
    kind: node.kind,
    required: node.kind === 'many' ? true : !node.opt,
    parent,
    target: node.to,
    from,
    to,
    through,
    where: fnOr(cfg.where, `${where} \`where\``),
    orderBy: fnOr(cfg.orderBy, `${where} \`orderBy\``),
    alias: cfg.alias,
  })
}

/**
 * Types PostgreSQL compares across without a cast, as *families*.
 *
 * The check below is deliberately family-based rather than exact: the failure it exists to catch
 * is `users.id (uuid) → posts.createdAt (timestamptz)`, a copy-paste slip that PostgreSQL rejects
 * with `42883: operator does not exist: uuid = timestamp with time zone` at query time. It must
 * never reject a join the server would accept, so every cross-type comparison PostgreSQL resolves
 * through an implicit cast is one family here.
 */
const TYPE_FAMILIES: readonly (readonly string[])[] = [
  // Numerics: `int4 = int8` and `int8 = numeric` both resolve. 03 §2.9 / design/04 §5 row 9 make
  // the same allowance for `eq`.
  ['int2', 'int4', 'int8', 'numeric', 'float4', 'float8'],
  // The string types are one type family in PostgreSQL's own catalog (`bpchar`/`varchar` are
  // domains over the same comparison operators as `text`); `citext` is an extension type that
  // declares implicit casts both ways.
  ['text', 'varchar', 'bpchar', 'char', 'citext', 'name'],
  ['timestamptz', 'timestamp'],
]

/** `text[]` and `text` correlate elementwise (a `from` of `int8[]` against a `to` of `int8`). */
function elemType(pg: string): string {
  return pg.endsWith('[]') ? pg.slice(0, -2) : pg
}

function comparable(a: string, b: string): boolean {
  const ea = elemType(a)
  const eb = elemType(b)
  if (ea === eb) return true
  return TYPE_FAMILIES.some((f) => f.includes(ea) && f.includes(eb))
}

function pgTypeOf(table: AnyTable, key: string): string {
  // `keysOf` already proved the ref belongs to this table, so the lookup cannot miss.
  return table.$.column(key)?.ddl.pgType ?? '?'
}

/**
 * Pairwise type check of a correlation. `keysOf` only proves each ref belongs to the right
 * *table*; nothing proved the two columns can be compared at all, so
 * `r.many.posts({ from: users[REFS].id, to: posts[REFS].createdAt })` used to resolve cleanly and
 * fail as a `42883` on the first query that projected the relation.
 */
function compat(
  a: readonly string[],
  ta: AnyTable,
  b: readonly string[],
  tb: AnyTable,
  where: string,
  an: string,
  bn: string,
): void {
  for (let i = 0; i < a.length; i++) {
    const ak = a[i] as string
    const bk = b[i] as string
    const at = pgTypeOf(ta, ak)
    const bt = pgTypeOf(tb, bk)
    if (comparable(at, bt)) continue
    throw new SchemaError(
      `pg-prime: ${where} correlates \`${an}\` ${ta.$.name}.${ak} (${at}) with \`${bn}\` ` +
        `${tb.$.name}.${bk} (${bt}). PostgreSQL has no \`=\` for those two types, so the ` +
        `relation would fail at query time with 42883. Did you name the wrong column?`,
    )
  }
}

function arity(a: readonly string[], b: readonly string[], where: string, an: string, bn: string): void {
  if (a.length !== b.length) {
    throw new SchemaError(
      `pg-prime: ${where} pairs ${a.length} column(s) in \`${an}\` with ${b.length} in \`${bn}\`. ` +
        `A composite relation pairs them positionally, so the two lists must be the same length.`,
    )
  }
}

/**
 * A column reference (or an array of them) → the TS keys, checked against the table they must
 * belong to.
 *
 * The check is what turns a copy-paste slip — `to: posts[REFS].id` on a relation into `tags` —
 * into a sentence at definition time instead of a `42703` from the server much later.
 */
function keysOf(v: unknown, table: AnyTable, where: string): readonly string[] {
  const list = Array.isArray(v) ? (v as readonly unknown[]) : [v]
  if (list.length === 0) throw new SchemaError(`pg-prime: ${where} is an empty list.`)
  const keys: string[] = []
  for (const item of list) {
    const ref = item as AnyRef | undefined
    if (ref === undefined || ref === null || typeof ref !== 'object' || ref.$ === undefined) {
      throw new SchemaError(
        `pg-prime: ${where} is not a column reference. Write \`myTable[REFS].columnName\`.`,
      )
    }
    if (ref.$.table !== table.$.name) {
      throw new SchemaError(
        `pg-prime: ${where} is a column of "${ref.$.table}", but it must be a column of ` +
          `"${table.$.name}".`,
      )
    }
    keys.push(ref.$.key)
  }
  return Object.freeze(keys)
}

function fnOr(v: unknown, where: string): ((t: never) => unknown) | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'function') {
    throw new SchemaError(`pg-prime: ${where} must be a callback taking the relation's own scope.`)
  }
  return v as (t: never) => unknown
}
