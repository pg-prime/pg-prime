/**
 * The codec seam (design/09 WS2): schema `ColumnRuntime` → compiler `ColumnMeta` → `src/codec`.
 *
 * This is the one place a `pgTable(...)` column's declared PostgreSQL type is turned into a real
 * `Codec`. Everything downstream — the compiler's `::type` casts, `json_build_object`'s per-column
 * cast, the positional decoder, `assertShape`'s OID check — reads the codec off the `ColumnMeta`
 * this module produces, so there is exactly one lookup per (table, registry) and none per query.
 *
 * Three rules, each of which exists because of a specific failure:
 *
 *  1. **Fail at `metaOf` time, never at query time.** A column whose type has no codec cannot be
 *     encoded or decoded. Discovering that while a statement is in flight means the query already
 *     reached the server; `NoCodecError` fires here instead, once, naming the column.
 *
 *  2. **Identifiers are pre-quoted here and nowhere else** (03 §7). The compiler must never quote
 *     a schema identifier on the hot path, so `tableMeta`/`columnMeta` do it at seam-build time.
 *
 *  3. **The cache is keyed by (registry, table) and invalidated by `registry.generation`.** A
 *     `TableMeta` built before `resolveDynamic` carries an enum codec whose `oid` is `undefined`;
 *     after resolution the registry holds one with the real OID. Without the generation check the
 *     stale meta would survive and `assertShape` would compare a live `dataTypeID` against nothing.
 */

import { arrayCodecOf, defaultRegistry } from '../codec/index.js'
import type { AnyCodec, CodecRegistry } from '../codec/index.js'
import type { ColumnMeta, TableMeta } from '../compile/ast.js'
import { columnMeta, tableMeta } from '../compile/nodes.js'
import type { ColumnDdl } from '../schema/column.js'
import type { TableRuntime } from '../schema/table.js'
import { NoCodecError } from '../sql/errors.js'
import { quoteIdentPart } from '../sql/ident.js'

/**
 * Anything carrying a `TableRuntime`: a `Table` from `pgTable(...)`, or a `Handle` from
 * `defineSchema(...)`. The seam reads `$` and nothing else, and `db.from()` is handed handles —
 * so constraining to `AnyTable` here would force a cast at every builder call site (R12).
 */
export type TableLike = { readonly $: TableRuntime }

/**
 * Everything the compile layer needs about one table. `columns` is in declaration order, which is
 * the order `insert into t (...) values (...)` and a `select *` projection use.
 */
export interface TableCodecMeta {
  readonly table: TableMeta
  /** Declaration order. */
  readonly columns: readonly ColumnMeta[]
  /** Declaration order, TS keys — parallel to `columns`. */
  readonly keys: readonly string[]
  /** TS key → column. `posts.authorId` → the `"author_id"` meta. */
  readonly byKey: Readonly<Record<string, ColumnMeta>>
}

const CACHE = new WeakMap<CodecRegistry, { gen: number; tables: WeakMap<TableLike, TableCodecMeta> }>()

/**
 * Schema table → compiler metadata, memoised per (registry, table).
 *
 * Idempotent: two calls with the same registry return the *same object*, so a builder can call it
 * per query method without allocating. The memo is dropped wholesale when the registry's
 * generation moves, which is the only way a column's codec can change.
 */
export function metaOf(t: TableLike, registry: CodecRegistry = defaultRegistry()): TableCodecMeta {
  let entry = CACHE.get(registry)
  if (entry === undefined || entry.gen !== registry.generation) {
    entry = { gen: registry.generation, tables: new WeakMap() }
    CACHE.set(registry, entry)
  }
  const hit = entry.tables.get(t)
  if (hit !== undefined) return hit
  const built = build(t, registry)
  entry.tables.set(t, built)
  return built
}

function build(t: TableLike, registry: CodecRegistry): TableCodecMeta {
  const rt = t.$
  const table = tableMeta(rt.schema ?? 'public', rt.name)

  const columns: ColumnMeta[] = []
  const keys: string[] = []
  const byKey: Record<string, ColumnMeta> = {}

  for (const ref of rt.columns) {
    const meta = columnMeta(
      ref.dbName,
      codecFor(ref.column.ddl, registry, rt.name, ref.key, rt.schema ?? 'public'),
    )
    columns.push(meta)
    keys.push(ref.key)
    byKey[ref.key] = meta
  }

  return {
    table,
    columns: Object.freeze(columns),
    keys: Object.freeze(keys),
    byKey: Object.freeze(byKey),
  }
}

/**
 * Resolve one column's codec.
 *
 * The DSL records the *declared* PG type in `ddl.pgType`, with `[]` appended once per `.array()`
 * call and `arrayDim` counting them. Three cases, in order:
 *
 *  - **enum** — `ddl.enumName` is set. The codec comes from the registry, which only has it after
 *    `resolveDynamic` has read this database's `pg_enum`. Before that we mint a *pending* codec
 *    from the labels the schema declared: it encodes and decodes correctly (an enum is text plus a
 *    membership check) and its `oid` is `undefined`, which is exactly what 02 §4.6 promises —
 *    a user type's OID is not stable across databases and is never baked in.
 *
 *  - **array** — `arrayDim >= 1`. Resolved by stripping every `[]` and wrapping the element codec
 *    ONCE, no matter how many times `.array()` was called. That is not a shortcut: PostgreSQL has
 *    no distinct multi-dimensional array *type*. `text[]` and `text[][]` are both OID 1009 and
 *    dimensionality is a property of the value, which is why `arrayCodec.decodeText` already walks
 *    nested literals. Wrapping twice would invent a type PG does not have.
 *
 *  - **scalar** — `registry.byName(pgType)`.
 */
export function codecFor(
  ddl: ColumnDdl,
  registry: CodecRegistry,
  table: string,
  column: string,
  schema?: string,
): AnyCodec {
  if (ddl.enumName !== undefined) {
    const found = registry.byName(arrayName(ddl.enumName, ddl.arrayDim))
    if (found) return found
    const element = pendingEnumCodec(ddl.enumName, ddl.enumValues ?? [], schema)
    return ddl.arrayDim > 0 ? arrayCodecOf(element, registry) : element
  }

  const base = ddl.pgType.replace(/(\[\])+$/, '')
  const element = registry.byName(base)
  if (element === undefined) {
    throw new NoCodecError(
      table,
      column,
      ddl.pgType,
      `Register one with \`registry.register(codec)\`, or declare the column with a built-in ` +
        `builder. Names the registry knows are the PostgreSQL type names ('int8', 'timestamptz', ` +
        `'jsonb', …) plus the named alternates ('int8:number', 'numeric:number', ` +
        `'timestamptz:string').`,
    )
  }
  return ddl.arrayDim > 0 ? arrayCodecOf(element, registry) : element
}

function arrayName(name: string, dim: number): string {
  return dim > 0 ? `${name}[]` : name
}

/**
 * An enum codec with no OID, for the window between schema definition and `resolveDynamic`.
 *
 * Deliberately NOT registered: registering it by name would make the real one look like an
 * override at connect time, and registering it by OID is impossible because it has none.
 */
function pendingEnumCodec(name: string, labels: readonly string[], schema?: string): AnyCodec {
  const set = new Set(labels)
  const check = (v: unknown): string => {
    if (typeof v !== 'string' || (set.size > 0 && !set.has(v))) {
      throw new TypeError(
        `pgorm: '${String(v)}' is not a member of enum ${name} [${labels.join(', ')}]`,
      )
    }
    return v
  }
  return {
    name,
    oid: undefined,
    paramOid: undefined,
    // Quoted and qualified exactly as `registry.sqlNameOf` does after `resolveDynamic`, so the
    // `::type` cast a statement emits is byte-identical before and after the registry has met the
    // database. The bare spelling was two bugs at once: `::user_role` differs from
    // `::"public"."user_role"` — so a golden taken before connect did not match one taken after —
    // and an unqualified name 42704s whenever the type's schema is off `search_path`.
    sqlName:
      schema === undefined
        ? quoteIdentPart(name)
        : `${quoteIdentPart(schema)}.${quoteIdentPart(name)}`,
    typeClass: 'enum',
    jsonEncode: 'native',
    encode: (v) => check(v),
    decodeText: (raw) => check(raw),
    decodeJson: (raw) => check(raw),
  }
}
