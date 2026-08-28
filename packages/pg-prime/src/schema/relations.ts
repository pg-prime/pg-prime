import { SchemaError } from '../sql/errors.js'
import { COLS, NAME, OUT, REFS, RELS, SCHEMA, SEL, TABLES } from './symbols.js'
import type { RefLike } from './ddl.js'
import type { AnyRef } from './ref.js'
import type { AnyTable, TableRuntime } from './table.js'
import type { Defer, RelMeta, Rels, Simplify } from './types.js'

export type Tables = Record<string, AnyTable>

/** Per-table relation records. Tables without relations simply omit the key. */
export type RelsRecord<T extends Tables> = { [K in keyof T]?: Rels }

// ─────────────────────────────────────────────────────────────────────────────
// defineRelations (design/05 D6, typed per design/04 §1.5)
// ─────────────────────────────────────────────────────────────────────────────

/** What a relation-level `where` may return: anything that yields a boolean. */
type RelBool = { readonly [OUT]: boolean }

/**
 * What a relation-level `orderBy` may return.
 *
 * Structural twins of `Order` and `OrderArg` from `src/query/ops.types.ts`, restated rather than
 * imported: `src/schema` may not depend on `src/query` (design/08 §2.1), and both shapes are two
 * properties wide. `test/query/relations.test.ts` pins that `desc(...)` and a bare ref are both
 * accepted, which is what would catch a drift.
 */
type RelOrderArg = { readonly dir: 'asc' | 'desc' } | { readonly [OUT]: unknown }
type RelOrderBy = RelOrderArg | readonly RelOrderArg[]

/**
 * The half of a relation declaration that does not depend on the target table.
 *
 * Split out so that instantiating {@link RelConfig} for a concrete target instantiates **two**
 * members rather than six: four of them are `unknown`/`string` and identical for every relation
 * in the program, so they resolve once on the non-generic base and are then shared.
 */
export interface RelConfigBase {
  /**
   * Parent-side column reference(s).
   *
   * **Optional since `12` B**: with `from`/`to` omitted, the correlation is inferred from the one
   * `.references()` / `foreignKey(...)` path that joins the two tables in the stated direction —
   * a `one` follows the child's own foreign key to its parent, a `many` follows the inverse
   * (`12` decision 18). Zero or several candidates is a `SchemaError` naming them, never a guess.
   * Declared `from`/`to` always win, and the two are declared together or not at all.
   */
  readonly from?: unknown
  /** Target-side column reference(s), positionally paired with {@link RelConfigBase.from}. */
  readonly to?: unknown
  /**
   * The m2m junction: `{ table, from, to }`, or just the table — in which case **both** hops are
   * inferred the same way as a single-hop relation (parent then junction, junction then target).
   */
  readonly through?: unknown
  /** The child's alias inside the lateral. Only worth setting to make EXPLAIN output readable. */
  readonly alias?: string
}

/**
 * Runtime-only relation configuration. Carries FK columns / `through` table /
 * per-parent predicates. **It must never enter the type parameters**
 * (design/04 §7.3).
 *
 * `T` is the *target table*, and it is here for one reason: `where` and `orderBy` are callbacks
 * over its refs, and without it every declaration site had to annotate the parameter by hand
 * (`09` §3.5's third deferral). `T[REFS]` and not `T['cols']`, although the two are the same slot:
 * the symbol-keyed access hits the instantiation cache the table already filled, and the named
 * property re-instantiates `RefsOfCols<N, C>` — measured at +2.5 instantiations per declared
 * relation for the named spelling (`12 B`'s RESULT).
 */
export interface RelConfig<T extends AnyTable = AnyTable> extends RelConfigBase {
  /** Always-applied per-parent predicate — `where: (t) => isNull(t.deletedAt)` (03 §4.1). */
  readonly where?: (t: T[typeof REFS]) => RelBool
  /** Default ordering for `.many()` when the caller supplies none. */
  readonly orderBy?: (t: T[typeof REFS]) => RelOrderBy
}

/**
 * Three namespaces instead of design/05's `{ optional: false }` flag: each
 * picker returns a *fixed* `opt` literal, so a declared relation costs no
 * conditional. `one` is non-nullable and `maybeOne` opts into `| null`, which
 * is design/04's `one`/`maybeOne`/`many` trio and matches NOT-NULL-by-default.
 */
export interface RelBuilders<T extends Tables> {
  readonly one: {
    readonly [K in keyof T & string]: (cfg?: RelConfig<T[K]>) => { kind: 'one'; opt: false; to: K }
  }
  readonly maybeOne: {
    readonly [K in keyof T & string]: (cfg?: RelConfig<T[K]>) => { kind: 'one'; opt: true; to: K }
  }
  readonly many: {
    readonly [K in keyof T & string]: (cfg?: RelConfig<T[K]>) => { kind: 'many'; opt: false; to: K }
  }
}

/** Runtime relation node — what the query compiler reads. */
export interface RelNode {
  readonly kind: 'one' | 'many'
  readonly opt: boolean
  readonly to: string
  readonly config: RelConfig | undefined
}

function namespace(
  keys: readonly string[],
  kind: 'one' | 'many',
  opt: boolean,
): Record<string, unknown> {
  // Null-prototype: a table registered under the key `__proto__` would otherwise retarget the
  // namespace's prototype instead of becoming a picker, and `r.many.__proto__(...)` would be
  // `Object.prototype`, not a function.
  const ns: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const to of keys) ns[to] = (config?: RelConfig): RelNode => ({ kind, opt, to, config })
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

export type ColsAt<Sc, N extends PropertyKey> = TableOf<Sc, N>[typeof COLS & keyof TableOf<Sc, N>]

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

type LoadedIn<
  Sc extends AnySchema,
  N extends string,
  K extends string,
  F extends PropertyKey,
> = Defer<
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
export type ResolvedRelations = Readonly<Record<string, Readonly<Record<string, ResolvedRelation>>>>

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
  const declared = cfg !== undefined && (cfg.from !== undefined || cfg.to !== undefined)
  if (declared && (cfg.from === undefined || cfg.to === undefined)) {
    throw new SchemaError(
      `pg-prime: ${where} declares \`${cfg.from === undefined ? 'to' : 'from'}\` without ` +
        `\`${cfg.from === undefined ? 'from' : 'to'}\`. They are paired positionally, so declare ` +
        `both — or neither, and the foreign key between "${parent}" and "${node.to}" is used.`,
    )
  }

  const junction = junctionOf(cfg, where)
  let from: readonly string[]
  let to: readonly string[]
  let through: ResolvedThrough | undefined

  if (junction === undefined) {
    if (declared) {
      from = keysOf(cfg.from, parentTable, `${where} \`from\``)
      to = keysOf(cfg.to, target, `${where} \`to\``)
    } else {
      // `12` decision 18. A `one` follows the child's own foreign key to its parent — the child
      // being the table the relation is DECLARED on — and a `many` follows the inverse.
      const hop =
        node.kind === 'one'
          ? inferFk(parentTable, target, where, parent, node.to, node.kind)
          : inferFk(target, parentTable, where, parent, node.to, node.kind)
      from = node.kind === 'one' ? hop.child : hop.parent
      to = node.kind === 'one' ? hop.parent : hop.child
    }
    arity(from, to, where, 'from', 'to')
    compat(from, parentTable, to, target, where, 'from', 'to')
    return finish(node, name, parent, from, to, undefined, cfg, where)
  }

  // m2m. Both hops point AT the junction's neighbours, so both are inferred the same way as a
  // single-hop relation: parent <- junction, junction -> target.
  const jFrom = junction.from
  const jTo = junction.to
  if ((jFrom === undefined) !== (jTo === undefined)) {
    throw new SchemaError(
      `pg-prime: ${where} declares \`through.${jFrom === undefined ? 'to' : 'from'}\` without ` +
        `\`through.${jFrom === undefined ? 'from' : 'to'}\`. Declare both hops or neither.`,
    )
  }
  if (jFrom !== undefined && jTo !== undefined) {
    if (!declared) {
      throw new SchemaError(
        `pg-prime: ${where} declares \`through.from\`/\`through.to\` but no \`from\`/\`to\`. The ` +
          `junction hop is parent -> from/through.from, through.to -> to, so all four are ` +
          `declared together — or none of them, and both hops are inferred.`,
      )
    }
    from = keysOf(cfg.from, parentTable, `${where} \`from\``)
    to = keysOf(cfg.to, target, `${where} \`to\``)
    through = Object.freeze({
      table: junction.table,
      from: keysOf(jFrom, junction.table, `${where} \`through.from\``),
      to: keysOf(jTo, junction.table, `${where} \`through.to\``),
    })
  } else {
    const h1 = inferFk(
      junction.table,
      parentTable,
      `${where} \`through\` (junction to parent)`,
      parent,
      node.to,
      node.kind,
    )
    const h2 = inferFk(
      junction.table,
      target,
      `${where} \`through\` (junction to target)`,
      parent,
      node.to,
      node.kind,
    )
    from = declared ? keysOf(cfg.from, parentTable, `${where} \`from\``) : h1.parent
    to = declared ? keysOf(cfg.to, target, `${where} \`to\``) : h2.parent
    through = Object.freeze({ table: junction.table, from: h1.child, to: h2.child })
  }
  arity(from, through.from, where, 'from', 'through.from')
  compat(from, parentTable, through.from, junction.table, where, 'from', 'through.from')
  arity(through.to, to, where, 'through.to', 'to')
  compat(through.to, junction.table, to, target, where, 'through.to', 'to')
  return finish(node, name, parent, from, to, through, cfg, where)
}

/** `through: junction` and `through: { table, from?, to? }` are the same declaration. */
function junctionOf(
  cfg: RelConfig | undefined,
  where: string,
): { table: AnyTable; from: unknown; to: unknown } | undefined {
  const t = cfg?.through
  if (t === undefined) return undefined
  if (typeof t !== 'object' || t === null) {
    throw new SchemaError(
      `pg-prime: ${where} \`through\` must be the junction table, or ` +
        `{ table, from, to } naming both hops.`,
    )
  }
  const rec = t as { table?: unknown; from?: unknown; to?: unknown; $?: unknown }
  // A bare table IS a `{ $: TableRuntime }`, which is how the short spelling is recognised.
  if (rec.table === undefined) {
    if (rec.$ === undefined) {
      throw new SchemaError(
        `pg-prime: ${where} \`through\` has no \`table\`. Pass the junction table itself — ` +
          `\`through: postTags\` — or { table, from, to }.`,
      )
    }
    return { table: t as AnyTable, from: undefined, to: undefined }
  }
  return { table: rec.table as AnyTable, from: rec.from, to: rec.to }
}

function finish(
  node: RelNode,
  name: string,
  parent: string,
  from: readonly string[],
  to: readonly string[],
  through: ResolvedThrough | undefined,
  cfg: RelConfig | undefined,
  where: string,
): ResolvedRelation {
  return Object.freeze({
    name,
    kind: node.kind,
    required: node.kind === 'many' ? true : !node.opt,
    parent,
    target: node.to,
    from,
    to,
    through,
    where: fnOr(cfg?.where, `${where} \`where\``),
    orderBy: fnOr(cfg?.orderBy, `${where} \`orderBy\``),
    alias: cfg?.alias,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Foreign-key inference (design/03 §4.1's open ask; `12` decision 18)
// ─────────────────────────────────────────────────────────────────────────────

/** One foreign key, read as a correlation: `child.<child> = parent.<parent>`. */
interface FkPath {
  readonly child: readonly string[]
  readonly parent: readonly string[]
  /** `posts.author_id -> users.id`, for the ambiguity sentence. */
  readonly label: string
}

/**
 * The one foreign key that joins `child` to `parent`, or a sentence.
 *
 * Zero and "more than one" are both refused, and refused with the candidates spelled out, because
 * both mistakes are the same mistake from the reader's side: the declaration does not say which
 * columns correlate and neither does the schema. Guessing "the first one" is how a relation
 * silently returns the wrong rows — the failure mode `09` §3.5 finding 3 already found once, where
 * a relation with no correlation at all resolved to a cross join wearing a relation's name.
 */
function inferFk(
  child: AnyTable,
  parent: AnyTable,
  where: string,
  parentKey: string,
  targetKey: string,
  kind: 'one' | 'many',
): FkPath {
  const paths = fkPaths(child, parent)
  const spelling =
    `r.${kind === 'many' ? 'many' : 'one'}.${targetKey}({ from: ${parentKey}[REFS].…, ` +
    `to: ${targetKey}[REFS].… })`
  if (paths.length === 0) {
    throw new SchemaError(
      `pg-prime: ${where} has no \`from\`/\`to\` and no foreign key to infer them from — nothing ` +
        `in "${child.$.name}" references "${parent.$.name}". Declare the key on the column ` +
        `(\`.references(() => ${parent.$.name}.cols.id)\`) or as a ` +
        `\`foreignKey({ columns, references })\` extra, or write the correlation: ${spelling}.`,
    )
  }
  if (paths.length > 1) {
    throw new SchemaError(
      `pg-prime: ${where} could be inferred from ${paths.length} foreign keys and pg-prime will ` +
        `not guess which: ${paths.map((p) => p.label).join(', ')}. Name the columns you mean: ` +
        `${spelling}.`,
    )
  }
  return paths[0] as FkPath
}

/**
 * Every foreign key of `child` that lands on `parent`, from both spellings the DSL has.
 *
 * Deduplicated on the correlation itself, so a column that declares `.references()` *and* appears
 * in an equivalent `foreignKey(...)` extra — which is one key in the database — is one candidate
 * here and not an ambiguity the schema does not actually have.
 */
function fkPaths(child: AnyTable, parent: AnyTable): readonly FkPath[] {
  const out: FkPath[] = []
  const seen = new Set<string>()
  const push = (childKeys: readonly string[], parentKeys: readonly string[]): void => {
    const id = `${childKeys.join(',')}\u0000${parentKeys.join(',')}`
    if (seen.has(id)) return
    seen.add(id)
    out.push({
      child: Object.freeze([...childKeys]),
      parent: Object.freeze([...parentKeys]),
      label: `${child.$.name}.${childKeys.join('+')} -> ${parent.$.name}.${parentKeys.join('+')}`,
    })
  }
  for (const c of child.$.columns) {
    const spec = c.column.ddl.references
    if (spec === undefined) continue
    const parentKeys = keysOfTargets(spec.target(), parent)
    if (parentKeys !== undefined) push([c.key], parentKeys)
  }
  for (const x of child.$.extras) {
    if (x.node !== 'foreignKey') continue
    const parentKeys = keysOfTargets(x.references(), parent)
    if (parentKeys === undefined) continue
    const childKeys = keysOfDbNames(child, x.columns)
    if (childKeys !== undefined) push(childKeys, parentKeys)
  }
  return out
}

/** The parent's TS keys a FK's targets name, or `undefined` if they are not this parent's. */
function keysOfTargets(
  targets: readonly RefLike[],
  parent: AnyTable,
): readonly string[] | undefined {
  if (targets.length === 0) return undefined
  const names: string[] = []
  for (const t of targets) {
    // Schema-qualified, because two schemas may hold a table of the same name — the cross-schema
    // case `11` §3 K2a's own FK test exists for.
    if (t.$.table !== parent.$.name || t.$.schema !== parent.$.schema) return undefined
    names.push(t.$.dbName)
  }
  return keysOfDbNames(parent, names)
}

function keysOfDbNames(table: AnyTable, dbNames: readonly string[]): readonly string[] | undefined {
  const keys: string[] = []
  for (const dbName of dbNames) {
    const hit = table.$.columns.find((c) => c.dbName === dbName)
    if (hit === undefined) return undefined
    keys.push(hit.key)
  }
  return keys
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

function arity(
  a: readonly string[],
  b: readonly string[],
  where: string,
  an: string,
  bn: string,
): void {
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
