# 03 — Query Building Engine

**Agent:** 03 (query builder / compiler / `sql` tag)
**Date:** 2026-08-14
**Status:** DESIGN DECISIONS — not a survey. Every section below is a commitment, or an explicit punt.
**Inputs honoured:** `research/SUMMARY.md` §3 (convergent signals), §4 (PORT/ADAPT/SKIP), §5.3 (the unclaimed seam), §6.1 (type-perf is risk #1); `research/kysely.md` §1–2, §5.2, §5.4, §7–8; `research/drizzle.md` §2, §6, §7; `research/prisma.md` §2.3, §3; `research/mikroorm.md` §3–4; `research/pg-drivers.md` §7.

**Coordination:** agent 02 owns `Codec`; agent 05 owns the schema/relation *declaration* surface; agent 06 owns the driver adapter. This document owns the AST, the compiler, the public query API, the `sql` tag, and the *consumption* contract for codecs and relation metadata. Each of those contracts is stated explicitly in §7 so the other agents have a hard interface to build against.

---

## 0. Decisions at a glance

| # | Decision | Rationale (one line) |
|---|---|---|
| D1 | **Typed AST → single-pass compiler**, never string composition | Enables plugins/RLS rewriting, result-shape descriptors, safe caching, and `.compile()` without a DB |
| D2 | **One query API.** Relation nesting is a *projection expression*, not a second API | The unclaimed seam (SUMMARY §5.3): nesting composes with aggregates, windows, CTEs, set ops |
| D3 | **References are values, not strings.** Scope-lambda `({users: u}) => u.email` | Fixes Kysely's #1 ergonomic gap (generic fragments) *and* its superlinear type cost |
| D4 | **`LEFT JOIN LATERAL` + `json_agg(json_build_object(...))`**, explicit per-column JSON casts | One round trip, per-parent LIMIT, and **no dehydration tax** — nested types == top-level types |
| D5 | **Compiler emits a `ResultShape` carrying codecs**; driver runs `rowMode: 'array'` | Positional decode; duplicate join column names cannot clobber; no per-row object alloc |
| D6 | **`sql` carries a codec, never a bare cast**; the codec is *verified* against `RowDescription` in dev | Drizzle's `sql<T>` is a documented lie; we own decoding, so we can check it |
| D7 | **JSON path positions are parameters, not literals.** `sql.lit` refuses strings | Structurally deletes the Kysely CVE class (GHSA-wmrf/pv5w/8cpq) rather than sanitizing around it |
| D8 | **`sql.ident` takes parts, never a dotted string**; always-quote; security-critical + fuzzed | Identifier position is the other injection surface |
| D9 | **`.prepare()` is the sanctioned cache**, not a hidden fingerprint cache | Compilation is O(nodes) and allocation-light; implicit caches are where correctness bugs live |
| D10 | Builders are **immutable and invariant in the output type** | Kysely §1.8(3): covariant `O` silently drops columns with no error |

---

## 1. Internal architecture

### 1.1 Decision: typed AST → single-pass PG SQL compiler

**Decided: a typed AST (immutable node tree) compiled in a single pass to `{ sql, params, shape }`.** String composition is rejected.

The alternative — building SQL fragments as strings while accumulating a params array, which is what `postgres.js`-style libraries and many hand-rolled builders do — is cheaper to write and strictly worse here, for five reasons that all have citations in the research:

1. **Result shape.** We own decoding end-to-end (SUMMARY §3.4). A decoder needs to know, per output column, *which codec* and *which position*. A string builder throws that information away at exactly the moment it is known. The AST lets the compiler emit the SQL and the decode plan in the same walk.
2. **Rewriting is a product requirement, not a nicety.** ZenStack v3 injects row-level access-control predicates by walking Kysely's ~100 operation nodes (kysely.md §8.0); soft-delete filters, tenant scoping, and `SET LOCAL`-free RLS emulation all want the same hook. Kysely's own verdict table marks the operation-node IR **PORT** precisely because "a real IR (not string concat) is what makes plugins, `EXPLAIN` tooling, and query rewriting possible at all."
3. **Nesting is a tree transform.** Relation projection (D4) hoists a sub-select into a `LEFT JOIN LATERAL` on the *parent* `FROM` clause while leaving a reference behind in the *projection*. That is trivially a tree operation and genuinely painful as string splicing.
4. **Testability without a database.** Kysely's Appendix A verifies compiled SQL with a `DummyDriver`. `.compile()` returning a plain value makes SQL generation unit-testable and makes CI free of Postgres for the compiler suite.
5. **Injection surface containment.** With an AST there is exactly one function that can put a non-`$n` string into the output (`emitIdent`, `emitRawChunk`). Those two functions are the entire audit surface. With string composition, the audit surface is every call site.

**What we do *not* do:** no multi-pass optimizer, no cost model, no normalization/canonicalization pass. Postgres has a planner; a second one in TypeScript is pure latency. The compiler is one recursive descent over the node tree, appending to a chunk array, with a params array threaded through. Optional plugin transforms run **before** compilation, never during.

**Performance contract:** compilation must be cheap enough that caching is an optimization, not a requirement. Budget: **< 25 µs** to compile a 12-column select with two joins and one nested relation on Node 22 / M-series, **zero** intermediate SQL strings (chunks are pushed to a `string[]` and `join('')`d once), and **one** params array allocation. Enforced by a benchmark in CI alongside the type-instantiation benchmark (risk #1 mitigation, SUMMARY §6.1).

### 1.2 Core AST node set

PG-only lets us be small. Kysely needs 108 operation nodes to span four dialects; we target **~40**. The full sketch:

```ts
// ── Discriminated union, `k` is the tag. All nodes are frozen plain objects.
// No classes, no methods on nodes: the compiler is the only thing that reads them.

export type Node = Statement | FromItem | Expr | Clause

// ─────────────────────────── Statements ───────────────────────────
export type Statement = SelectNode | InsertNode | UpdateNode | DeleteNode | SetOpNode

export interface SelectNode {
  k: 'select'
  with?: readonly CteNode[]
  distinct?: { on?: readonly Expr[] } | undefined
  projection: readonly ProjectionItem[]     // ordered; index === result column index
  from?: FromItem
  joins: readonly JoinNode[]                // includes compiler-hoisted LATERALs
  where?: Expr
  groupBy?: readonly Expr[]
  having?: Expr
  windows?: readonly { name: string; def: WindowDef }[]
  orderBy?: readonly OrderItem[]
  limit?: Expr                              // param or literal-int
  offset?: Expr
  locking?: { strength: 'update' | 'no key update' | 'share' | 'key share'
              of?: readonly string[]; wait: 'block' | 'nowait' | 'skip locked' }
}

export interface InsertNode {
  k: 'insert'
  with?: readonly CteNode[]
  into: TableRefNode
  columns: readonly ColumnMeta[]
  source:
    | { k: 'values'; rows: readonly (readonly Expr[])[] }       // multi-row VALUES
    | { k: 'unnest'; arrays: readonly Expr[] }                  // bulk: 1 param per column
    | { k: 'select'; query: SelectNode | SetOpNode }
    | { k: 'defaults' }
  onConflict?: OnConflictNode
  returning?: readonly ProjectionItem[]
}

export interface OnConflictNode {
  target?: { k: 'columns'; columns: readonly ColumnMeta[]; where?: Expr }
         | { k: 'expressions'; exprs: readonly Expr[]; where?: Expr }   // expression indexes
         | { k: 'constraint'; name: string }
  action: { k: 'nothing' } | { k: 'update'; set: readonly SetItem[]; where?: Expr }
}

export interface UpdateNode {
  k: 'update'
  with?: readonly CteNode[]
  target: TableRefNode
  set: readonly SetItem[]
  from?: readonly FromItem[]                // UPDATE ... FROM (bulk update-by-key)
  where?: Expr
  returning?: readonly ProjectionItem[]
}

export interface DeleteNode {
  k: 'delete'
  with?: readonly CteNode[]
  from: TableRefNode
  using?: readonly FromItem[]
  where?: Expr
  returning?: readonly ProjectionItem[]
}

export interface SetOpNode {
  k: 'setop'
  op: 'union' | 'union all' | 'intersect' | 'intersect all' | 'except' | 'except all'
  left: SelectNode | SetOpNode
  right: SelectNode | SetOpNode
  orderBy?: readonly OrderItem[]; limit?: Expr; offset?: Expr
}

export interface CteNode {
  name: string
  columns?: readonly string[]
  recursive: boolean                        // v1: only via sql`` (see §6)
  materialized?: boolean                    // MATERIALIZED / NOT MATERIALIZED hint
  query: Statement                          // writable CTEs: INSERT/UPDATE/DELETE allowed
}

// ─────────────────────────── FROM items ───────────────────────────
export type FromItem = TableRefNode | SubqueryNode | ValuesNode | FuncNode | CteRefNode

export interface TableRefNode { k: 'table'; schema: string; name: string; alias: string }
export interface SubqueryNode { k: 'subquery'; query: SelectNode | SetOpNode; alias: string; lateral: boolean }
export interface ValuesNode   { k: 'values'; rows: readonly (readonly Expr[])[]; alias: string
                                columns: readonly string[]; casts: readonly (string|null)[] }
export interface FuncNode     { k: 'func'; fn: string; args: readonly Expr[]; alias: string
                                lateral: boolean; ordinality: boolean }
export interface CteRefNode   { k: 'cteRef'; name: string; alias: string }

export interface JoinNode {
  k: 'join'
  type: 'inner' | 'left' | 'right' | 'full' | 'cross'
  item: FromItem
  on?: Expr                                 // undefined => ON TRUE (lateral projections)
}

// ─────────────────────────── Expressions ───────────────────────────
export type Expr =
  | ColumnNode | ParamNode | PlaceholderNode | LiteralNode
  | BinaryNode | UnaryNode | BetweenNode | InNode | IsNode
  | FuncCallNode | AggNode | OverNode | CaseNode | CastNode
  | RowNode | ArrayNode | SubqueryExprNode | ExistsNode
  | JsonBuildNode | JsonAggNode
  | RawNode

export interface ColumnNode { k: 'col'; alias: string; name: string; codec: Codec }
/** A user value. `codec.encode` runs at bind time, not compile time. */
export interface ParamNode { k: 'param'; value: unknown; codec: Codec }
/** A named hole filled at `.execute(args)` time on a prepared query. */
export interface PlaceholderNode { k: 'ph'; name: string; codec: Codec }
/** Non-string literals ONLY (see §3.4). Strings are always params. */
export interface LiteralNode { k: 'lit'; value: number | bigint | boolean | null; codec: Codec }

export interface BinaryNode { k: 'bin'; op: BinaryOp; l: Expr; r: Expr; resultCodec: Codec }
export interface UnaryNode  { k: 'un'; op: 'not' | '-' | '+' | '~'; e: Expr; resultCodec: Codec }
export interface IsNode     { k: 'is'; e: Expr; test: 'null'|'not null'|'true'|'not true'|'false'|
                                                     'not false'|'distinct from'|'not distinct from'
                              r?: Expr }
export interface InNode     { k: 'in'; e: Expr; not: boolean
                              set: { k: 'list'; items: readonly Expr[] }
                                 | { k: 'query'; query: SelectNode | SetOpNode }
                                 | { k: 'any'; array: Expr } }   // `= ANY($1)` — see §2.9
export interface BetweenNode{ k: 'between'; e: Expr; lo: Expr; hi: Expr; symmetric: boolean; not: boolean }

export interface FuncCallNode { k: 'fn'; name: string; args: readonly Expr[]; resultCodec: Codec }
export interface AggNode {
  k: 'agg'; name: 'count'|'sum'|'avg'|'min'|'max'|'bool_and'|'bool_or'|'array_agg'|'string_agg'|'json_agg'|string
  args: readonly Expr[]; distinct: boolean
  orderBy?: readonly OrderItem[]            // agg(x ORDER BY y)
  filter?: Expr                             // agg(x) FILTER (WHERE ...)
  resultCodec: Codec
}
export interface OverNode { k: 'over'; fn: AggNode | FuncCallNode; window: WindowDef | { ref: string } }
export interface WindowDef {
  partitionBy?: readonly Expr[]
  orderBy?: readonly OrderItem[]
  frame?: { mode: 'rows'|'range'|'groups'; start: FrameBound; end?: FrameBound
            exclude?: 'current row'|'group'|'ties'|'no others' }
}

export interface CaseNode { k: 'case'; operand?: Expr
                            whens: readonly { when: Expr; then: Expr }[]
                            else?: Expr; resultCodec: Codec }
export interface CastNode { k: 'cast'; e: Expr; to: string; resultCodec: Codec }
export interface RowNode  { k: 'row'; items: readonly Expr[] }        // tuple comparison / keyset
export interface ArrayNode{ k: 'array'; items: readonly Expr[]; elemCodec: Codec }
export interface SubqueryExprNode { k: 'sq'; query: SelectNode | SetOpNode; resultCodec: Codec }
export interface ExistsNode { k: 'exists'; not: boolean; query: SelectNode }

/** Relation projection support. The compiler builds these; users never construct them. */
export interface JsonBuildNode { k: 'jsonBuild'; entries: readonly [string, Expr][]; variant: 'json'|'jsonb' }
export interface JsonAggNode   { k: 'jsonAgg'; e: Expr; orderBy?: readonly OrderItem[]
                                 variant: 'json'|'jsonb'; emptyAs: '[]' }

/** The escape hatch. `chunks` and `parts` interleave: chunks[0] parts[0] chunks[1] ... */
export interface RawNode {
  k: 'raw'
  chunks: readonly string[]                 // compile-time constant strings only
  parts: readonly (Expr | IdentPart | RawSpliceNode)[]
  resultCodec: Codec | null                 // null => decode dynamically by OID (§3.2)
}
export interface IdentPart { k: 'ident'; parts: readonly string[] }     // §3.4
export interface RawSpliceNode { k: 'unsafeRaw'; text: string; origin?: string }  // §3.5

// ─────────────────────────── Clauses ───────────────────────────
export interface ProjectionItem { key: string; expr: Expr; nested?: NestedPlan }
export interface OrderItem { e: Expr; dir: 'asc'|'desc'; nulls?: 'first'|'last' }
export interface SetItem { column: ColumnMeta; value: Expr }
export type FrameBound = { k: 'unbounded preceding' } | { k: 'current row' }
                       | { k: 'unbounded following' } | { k: 'preceding'|'following'; n: Expr }
```

Node count: 5 statements + 5 from-items + 1 join + 24 expressions + 4 clause types ≈ **39**. Every node is a frozen object literal; there are no node classes and no methods, which keeps them cheap to allocate and trivial to structurally share when a builder method returns a new tree.

### 1.3 The compiler contract

```ts
export interface Compiled<Row> {
  /** Complete SQL text with `$1..$n`. Never contains a user-supplied value. */
  readonly sql: string
  /**
   * Bind plan. Entries are either a concrete value already run through
   * `codec.encode`, or a placeholder slot filled at execute() time.
   */
  readonly binds: readonly Bind[]
  /** How to turn `unknown[][]` (rowMode: 'array') into `Row[]`. Carries codecs. */
  readonly shape: ResultShape
  /** Cheap metadata for cache invalidation hooks, tracing, and lint rules. */
  readonly meta: {
    readonly kind: 'select' | 'insert' | 'update' | 'delete' | 'setop'
    readonly reads: readonly QualifiedName[]
    readonly writes: readonly QualifiedName[]
    readonly placeholders: readonly string[]
    readonly usedUnsafeRaw: boolean
  }
}

export type Bind =
  | { k: 'value'; encoded: string | Uint8Array | null }
  | { k: 'slot'; name: string; codec: Codec }

/** Decode plan. Indexes are positions in the driver's array row. */
export type ResultShape =
  | { k: 'row'; fields: readonly FieldPlan[] }
  | { k: 'scalar'; idx: number; codec: Codec }        // for count/exists fast paths
  | { k: 'void' }                                     // no RETURNING

export type FieldPlan =
  | { key: string; k: 'col'; idx: number; codec: Codec }
  | { key: string; k: 'json'; idx: number; plan: JsonPlan; nullable: boolean }

export type JsonPlan =
  | { k: 'obj'; fields: readonly { key: string; plan: JsonPlan }[]; nullable: boolean }
  | { k: 'arr'; item: JsonPlan }
  | { k: 'leaf'; codec: Codec }                       // uses codec.decodeJson
```

Three properties of this contract matter:

- **`rowMode: 'array'`** (agent 06 §7.5, and independently what Drizzle and Prisma both do — pg-drivers.md §4). The decode plan is positional, so two joined tables both exposing `id` cannot clobber each other, and we skip a per-row object allocation in the driver.
- **Codecs travel with the plan, not with the row.** Nothing looks up an OID at decode time on the hot path. `RowDescription` OIDs are used only (a) for `sql`-tag fragments with no declared codec, and (b) in `assertShape` dev mode, where we compare each field's `dataTypeID` against `codec.oid` and throw a precise error on mismatch. That is what turns D6 from a promise into a check.
- **Decoding is a compiled closure tree.** `buildDecoder(shape)` is called once per `Compiled` and returns `(rows: unknown[][]) => Row[]`. It is a tree of closures, **not** `new Function` — CSP-restricted runtimes (Workers, some Electron/Deno configurations) forbid eval, and a closure tree measured within noise of generated code in prototypes. If benchmarks later disagree, `new Function` becomes an opt-in `{ decoder: 'codegen' }` flag, never the default.

### 1.4 Caching and `.prepare()`

Three layers, only one of which is implicit:

**(a) Per-builder memo (implicit, safe).** Builders are immutable, so `.compile()` memoizes onto the builder instance. Re-executing the same builder object in a loop compiles once. This cannot go stale because the object cannot change.

**(b) `.prepare()` (explicit, the sanctioned path).** Turns a builder into a reusable compiled artifact with typed holes:

```ts
const byEmail = db
  .from(users)
  .select(({ users: u }) => ({ id: u.id, email: u.email, createdAt: u.createdAt }))
  .where(({ users: u }, $) => u.email.eq($.email))     // `$` is the placeholder scope
  .prepare<{ email: string }>('users_by_email')

const rows = await byEmail.execute({ email: 'a@b.c' })  // no AST walk, no compile
```

`PreparedQuery` holds `sql`, `binds` (with `slot` entries), a prebuilt decoder, and the `meta`. `execute()` walks `binds` once, calling `codec.encode` for slots, and hands the array to the driver. **Server-side** prepared statements are a separate, orthogonal opt-in: the default is unnamed extended-protocol statements (1 RTT, pooler-safe on every pooler including Supavisor — pg-drivers.md §5.7/§7.5), and `prepare(name)` only becomes a server-side named statement when the user opts in globally or per query with `{ statement: 'named' }`. Naming the JS-side artifact and the PG-side statement the same thing is Drizzle's mistake; we keep them separate and document the distinction in one sentence: *`.prepare()` caches our work; `{ statement: 'named' }` caches Postgres's.*

**(c) Description cache (implicit, keyed by SQL text).** For `sql`-tag queries with no declared codecs we need `Parse + Describe` to learn result OIDs. That result is cached process-wide in a bounded LRU keyed on the SQL text (pgx's `CacheDescribe` shape — pg-drivers.md §7.5), invalidated on `0A000` / `42P18` / `42804`. Builder-compiled queries never touch this cache because their codecs are known statically.

**Deliberately *not* implemented: a global structural-fingerprint cache.** Computing a fingerprint of an AST costs the same order as compiling it, and a fingerprint cache keyed on anything less than the full tree is a correctness bug waiting to happen (wrong SQL for a similar-looking query is the worst possible failure mode). If profiling later shows compile time matters in a real workload, the answer is `.prepare()`, which is explicit and exact.

**Param-count ceiling.** The wire protocol caps parameters at 65535 (int16). The compiler tracks the bind count and, on overflow, throws a typed `TooManyParametersError` naming the offending statement and suggesting `strategy: 'unnest'` (§2.6). Bulk helpers auto-chunk before they can hit it.

### 1.5 Type-level machinery (risk #1 mitigation)

Kysely's measured cost is **superlinear in schema size, not query count** (kysely.md §1.9): `AnyColumn<DB, TB>` and the alias template-literal parsers distribute over the *entire* `Database` interface, so every query pays for every table. That is the single scaling property to design against.

**D3 (references are values) deletes that cost at the root.** There is no `DB` interface, no `AnyColumn<DB, TB>` distributed union, and no template-literal alias parsing. A scope object is a plain record `{ [alias]: TableScope }`, and a `TableScope` is a plain record of `Ref` objects computed **once per table at schema-definition time** and reused by reference. A query touching 3 tables instantiates types for 3 tables. Cost becomes linear in *query* size, independent of schema size.

The Kysely techniques we still port verbatim (kysely.md §7):

- `DrainOuterGeneric<T> = [T] extends [unknown] ? T : never` on every mapped type — required to avoid TS2589.
- Tuple-wrapped conditionals `[T] extends [X]` to suppress union distribution (enum columns break without it).
- `OrmTypeError<'sentence'>` branded error types instead of constraint-mismatch spew.
- `never`-returning illegal methods (`tx.transaction(): never`).
- Version-gated type errors via the export map (`"types@<5.6"` → a stub whose every export is an `OrmTypeError` explaining the TS version requirement).

Two Kysely bugs we fix, both prototyped and verified in kysely.md Appendix B:

```ts
// B.1 — literal-condition overloads. Kysely always returns Partial; we don't have to.
$if<O2>(cond: true,    f: (qb: this) => QB<O & O2>): QB<O & O2>
$if<O2>(cond: false,   f: (qb: this) => QB<O & O2>): QB<O>
$if<O2>(cond: boolean, f: (qb: this) => QB<O & O2>): QB<O & Partial<Omit<O2, keyof O>>>

// B.2 — invariant O. Without this, `let q = ...; if (f) q = q.select(x)` silently
// discards `x` from the result type with NO error (kysely.md §1.8 pattern 3).
declare const INV: unique symbol
interface SelectBuilder<S, O> { readonly [INV]: (o: O) => O }
```

Invariance makes the imperative build-up pattern a compile error, so `$if` and `$call` must be ergonomic enough to absorb it. Both are type-preserving, and `$call` is the composition primitive Kysely users already reach for:

```ts
const paginate = (page: number, size: number) =>
  <S, O>(q: SelectBuilder<S, O>) => q.limit(size).offset(page * size)

db.from(users).select(({ users: u }) => ({ ...u.$all })).$call(paginate(2, 20))
```

**CI budget:** `@ark/attest`-style instantiation counting on a 300-table synthetic schema with 200 queries, asserting (a) instantiations grow **linearly** in query count with a schema-size-independent per-query constant, and (b) a per-query ceiling. Kysely's measured baseline at that size is 4.57M instantiations / 30 s on TS 5.9; that number is the thing we must not reproduce.

---

## 2. The public API

Setup used by every example below (declaration surface is agent 05's; shown only for context):

```ts
// schema.ts
export const users = table('users', {
  id:        int8().generatedAlwaysAsIdentity().primaryKey(),
  email:     citext().notNull().unique(),
  name:      text().notNull(),
  role:      pgEnum(userRole)().notNull(),
  tags:      text().array().notNull().default([]),
  meta:      jsonb<UserMeta>().notNull().default({}),
  createdAt: timestamptz().notNull().defaultNow(),
  deletedAt: timestamptz(),
})

export const posts = table('posts', {
  id: int8().generatedAlwaysAsIdentity().primaryKey(),
  authorId: int8().notNull().references(() => users.id),
  title: text().notNull(),
  body: tsvectorBacked(text()).notNull(),
  amount: numeric(12, 2).notNull(),
  published: bool().notNull().default(false),
  createdAt: timestamptz().notNull().defaultNow(),
})

export const relations = defineRelations({
  users: { posts: many(posts, { from: users.id, to: posts.authorId }) },
  posts: { author: one(users, { from: posts.authorId, to: users.id, required: true }) },
})

export const db = pgOrm({ pool, schema: { users, posts }, relations })
```

### 2.1 Select, where, order, limit

```ts
const rows = await db
  .from(users)
  .select(({ users: u }) => ({
    id: u.id,
    email: u.email,
    joined: u.createdAt,
  }))
  .where(({ users: u }) => and(u.deletedAt.isNull(), u.role.in(['admin', 'owner'])))
  .orderBy(({ users: u }) => [desc(u.createdAt), asc(u.id)])
  .limit(20)
  .execute()

// rows: { id: bigint; email: string; joined: Date }[]
```

```sql
select "users"."id" as "id", "users"."email" as "email", "users"."created_at" as "joined"
from "public"."users" as "users"
where ("users"."deleted_at" is null and "users"."role" = any($1))
order by "users"."created_at" desc, "users"."id" asc
limit $2
```

Notes on shape:

- **The scope object is keyed by alias.** `.from(users)` aliases to `users` (the schema key). `.from(users, 'u')` renames, which is how self-joins work. Destructuring in the lambda (`({ users: u }) => …`) is the idiom and reads well. There is no string-reference form; strings are the thing we removed.
- **`u.$all`** is a real record of refs, so `{ ...u.$all }` is `SELECT *` with an exact type, and `{ ...omit(u.$all, 'passwordHash') }` is Prisma's `omit` for free. This deletes Prisma's `select`-vs-`include`-can't-coexist papercut (prisma.md §3.1) because there is only one mechanism.
- **`.select()` is required** before `.execute()` on a select — no implicit `SELECT *`, which keeps the result shape always explicit and always exact.
- `in([])` compiles to `false`, by construction. (Kysely ships a plugin for this; it should not need a plugin — kysely.md §5.1.)
- Comparison RHS accepts a value, a ref, or an expression: `u.createdAt.gt(otherRef)` needs no separate `whereRef`.

### 2.2 Joins

```ts
const rows = await db
  .from(posts)
  .innerJoin(users, ({ posts: p, users: u }) => p.authorId.eq(u.id))
  .leftJoin(posts, 'reply', ({ posts: p, reply: r }) => r.replyToId.eq(p.id))
  .select(({ posts: p, users: u, reply: r }) => ({
    id: p.id,
    title: p.title,
    author: { id: u.id, name: u.name },       // nested literal — grouped, not a relation
    replyTitle: r.title,                       // string | null (left join)
  }))
  .where(({ posts: p }) => p.published.isTrue())
  .execute()

// rows: { id: bigint; title: string;
//         author: { id: bigint; name: string };
//         replyTitle: string | null }[]
```

Left-join nullability propagates to the **whole nested literal object**, not to each field individually (`author: {…} | null` when `users` is left-joined). Drizzle gets this right and almost everyone else gets it wrong; drizzle.md §7 marks it **PORT**. Nested object literals in the projection are *grouping only* — they compile to plain columns and are assembled by the decoder positionally, with zero SQL cost. Relations (§2.3) are a different, explicitly-marked mechanism.

Lateral joins are first-class: `.innerJoinLateral(sub, alias, on)` / `.leftJoinLateral(...)`, where `sub` is a select builder that may reference outer scope refs.

### 2.3 Relational projection — the differentiator

**This is D2.** A relation accessor lives on the table scope next to the columns, and returns an *expression* usable anywhere in a projection. Because it is an expression, it composes with everything else in the same query: aggregates, window functions, `GROUP BY`, CTEs, set operations, `RETURNING`.

```ts
const feed = await db
  .from(users)
  .select(({ users: u }) => ({
    ...u.$all,

    // ── scalar aggregate over a relation (correlated subquery)
    postCount: u.posts.count(),
    revenue:   u.posts.sum(p => p.amount),

    // ── window function over that aggregate, in the same projection
    revenueRank: fn.rank().over(w => w.orderBy(desc(u.posts.sum(p => p.amount)))),

    // ── nested one-to-many, paginated PER PARENT, with its own nested aggregate
    latestPosts: u.posts.many(q => q
      .select(({ posts: p }) => ({
        id: p.id,
        title: p.title,
        commentCount: p.comments.count(),         // nesting inside nesting
        author: p.author.one(),                   // to-one inside to-many
      }))
      .where(({ posts: p }) => p.published.isTrue())
      .orderBy(({ posts: p }) => desc(p.createdAt))
      .limit(3)),
  }))
  .where(({ users: u }) => u.posts.some(p => p.published.isTrue()))
  .orderBy(({ users: u }) => desc(u.createdAt))
  .limit(20)
  .execute()
```

Result type (exact, no `Partial`, no dehydration):

```ts
{
  id: bigint; email: string; name: string; role: UserRole; tags: string[]
  meta: UserMeta; createdAt: Date; deletedAt: Date | null
  postCount: bigint
  revenue: string                                    // numeric → string, precision-preserving
  revenueRank: bigint
  latestPosts: {
    id: bigint
    title: string
    commentCount: bigint
    author: { id: bigint; email: string; /* … */ }   // non-null: relation declared required
  }[]
}[]
```

Compiled SQL:

```sql
select
  "users"."id" as "id", "users"."email" as "email", /* … $all … */
  "pc"."v"   as "postCount",
  "rev"."v"  as "revenue",
  rank() over (order by "rev"."v" desc) as "revenueRank",
  "lp"."v"   as "latestPosts"
from "public"."users" as "users"
left join lateral (
  select count(*) as "v"                            -- top level: no cast; int8 decodes to bigint
  from "public"."posts" as "posts"
  where "posts"."author_id" = "users"."id"
) as "pc" on true
left join lateral (
  select coalesce(sum("posts"."amount"), 0) as "v"  -- numeric stays numeric; ordering is numeric
  from "public"."posts" as "posts"
  where "posts"."author_id" = "users"."id"
) as "rev" on true
left join lateral (
  select coalesce(json_agg("x"."o" order by "x"."k0" desc), '[]'::json) as "v"
  from (
    select
      json_build_object(
        'id',           "posts"."id"::text,
        'title',        "posts"."title",
        'commentCount', "cc"."v",
        'author',       "au"."o"
      ) as "o",
      "posts"."created_at" as "k0"
    from "public"."posts" as "posts"
    left join lateral (
      select count(*)::text as "v"   -- ::text because this value flows into JSON (int8 > 2^53)
      from "public"."comments" as "comments"
      where "comments"."post_id" = "posts"."id"
    ) as "cc" on true
    left join lateral (
      select json_build_object('id', "users2"."id"::text, 'email', "users2"."email" /* … */) as "o"
      from "public"."users" as "users2"
      where "users2"."id" = "posts"."author_id"
      limit 1
    ) as "au" on true
    where "posts"."author_id" = "users"."id" and "posts"."published"
    order by "posts"."created_at" desc
    limit $1
  ) as "x"
) as "lp" on true
where exists (
  select 1 from "public"."posts" as "posts"
  where "posts"."author_id" = "users"."id" and "posts"."published"
)
order by "users"."created_at" desc
limit $2
```

Five design points, each deliberate:

1. **`LEFT JOIN LATERAL … ON TRUE`, not a correlated scalar subquery in the select list.** Kysely's `jsonArrayFrom` emits the latter and never uses its own `leftJoinLateral`; kysely.md §2.3 flags this as an opportunity left on the table, because for large fan-outs `LEFT JOIN LATERAL` plans better. Drizzle RQB v2 uses lateral. We use lateral, and expose `{ strategy: 'lateral' | 'subquery' }` per relation projection for the rare case where the planner prefers the other.

2. **`json_build_object` with explicit per-column casts, not `row_to_json(t)`.** This is the mechanism behind "no dehydration tax." Kysely models JSON round-tripping *in the types* (`ShallowDehydrateValue`: `Date` becomes `string` inside `json_agg`, kysely.md §1.7) and correctly so — for a library that does not own decoding. **We own decoding, so we can make the degradation not happen:** each codec declares how it must be rendered into JSON, the compiler applies that cast, and the decoder calls `codec.decodeJson`. Consequences:
   - `int8` → `::text` (a JSON number would silently lose precision past 2^53) → decodes to `bigint`
   - `numeric` → `::text` → decodes to `string` (or a user Decimal), exact
   - `timestamptz` → native (`to_json` emits ISO 8601 with offset) → decodes to `Date`
   - `date` → native (`YYYY-MM-DD`) → decodes to `PlainDate`, and **cannot** shift a day
   - `bytea`, `interval`, ranges, composites, user enums → codec-declared
   - `json`/`jsonb` columns → embedded natively, not double-encoded

   The rule for the whole library becomes one sentence: **a column's type is the same whether you read it at the top level or five relations deep.** No competitor can say that.

3. **Ordering uses hidden keys.** `json_agg` preserves input order only incidentally; relying on a subquery's `ORDER BY` feeding an aggregate is unspecified. So the inner select emits the ordering expressions as hidden columns `k0, k1, …` alongside the built object, and `json_agg(x.o ORDER BY x.k0 desc)` re-states the order explicitly. The hidden keys never appear in the JSON, because the JSON is built by an explicit key list rather than by `row_to_json`.

4. **Per-parent pagination is free**, because `LIMIT` lives inside the lateral. Combining `u.posts.count()` with `u.posts.many(q => q.limit(3))` gives page + total in one round trip. MikroORM needs a whole per-relation `populateHints` mechanism for this and has to fall back to `select-in` (mikroorm.md §3.3); Drizzle RQB v2 has it but forbids aggregates in the same query (drizzle.md §2.2). Here it is the ordinary case.

5. **`coalesce(json_agg(...), '[]'::json)`** for empty sets — the detail everyone gets wrong once — and `json` not `jsonb` by default (jsonb reorders keys and dedupes; json is cheaper and order-preserving). `{ variant: 'jsonb' }` is available per projection.

6. **Identical relation subexpressions are emitted once.** `revenue: u.posts.sum(p => p.amount)` and the `rank()` window that orders by the same expression share one `rev` lateral, because the compiler keys hoisted laterals on a structural digest of `(relation, predicate, projection)`. This is the *only* place the compiler does common-subexpression elimination, and it is confined to nodes the compiler itself generated — never to user expressions, where deduplication could change semantics (volatile functions, `random()`, `nextval()`).

**Relation filters** (`some` / `every` / `none`) compile to `EXISTS` / `NOT EXISTS`, ported from MikroORM's `$some`/`$none`/`$every` (mikroorm.md §4.1), with the null-safety that `every` requires:

```ts
.where(({ users: u }) => u.posts.every(p => p.published.isTrue()))
// not exists (select 1 from posts p where p.author_id = u.id and (p.published) is not true)
```

**Aggregates + `GROUP BY` + nesting.** Relation accessors that produce a *row set* (`.many()`, `.one()`) require the parent row to be identifiable. After `.groupBy()`, the scope type only exposes relation accessors on a table whose primary key is in the grouping list; otherwise the accessor's type resolves to `OrmTypeError<'…relation projection requires the parent primary key in GROUP BY…'>`. Relation *aggregates* (`.count()`, `.sum()`) are scalar subqueries and are always available. This is the one place where the unified API needs a guard rail, and it is a compile-time one.

**`Loaded`-style typing.** The projection form is already exact (Prisma-grade narrowing), so `Loaded` is not load-bearing for inference — but it is load-bearing for *signatures*, which is MikroORM's real insight (mikroorm.md §3.2). We ship it as a derived alias so a function can demand a load state:

```ts
type Feed = Loaded<typeof users, { posts: { author: true } }>
function render(u: Feed) { u.posts[0].author.name }   // checked, sync, no undefined
```

`Loaded<T, H>` is defined structurally from the relation metadata, and `InferResult<typeof query>` recovers the exact row type of any built query (Kysely's trick, kysely.md §2.6) for cases where the projection is the source of truth.

### 2.4 Expression builder and composition

`and` / `or` / `not` are free functions (tree-shakeable, no `eb` parameter to thread), and take arrays or varargs:

```ts
import { and, or, not, exists, coalesce, fn, asc, desc } from 'pg-orm-ts'

.where(({ users: u }) => and(
  u.deletedAt.isNull(),
  or(u.role.eq('admin'), u.email.ilike('%@acme.com')),
  not(exists(db.from(bans).where(({ bans: b }) => b.userId.eq(u.id)))),
))
```

**Reusable fragments — the thing Kysely cannot do.** kysely.md §1.8(9) documents that a helper generic over the table parameter does not typecheck at all, because `ReferenceExpression<DB, TB>` cannot be evaluated for an unresolved `TB`, and §1.8(10) documents that such helpers poison `.d.ts` output with ~800-character unresolved conditionals. Because our refs are *values with concrete types*, fragments are ordinary structurally-typed functions:

```ts
// Generic over the column's codec class — no DB/TB generics anywhere.
const withinDays = (c: Ref<Timestamptz>, days: number) =>
  c.gt(sql`now() - make_interval(days => ${days})`.as(codecs.timestamptz))

// Generic over "any scope that has a deletedAt column" — plain structural typing.
const alive = <T extends { deletedAt: Ref<Timestamptz | null> }>(t: T) => t.deletedAt.isNull()

db.from(users)
  .select(({ users: u }) => ({ ...u.$all }))
  .where(({ users: u }) => and(alive(u), withinDays(u.createdAt, 7)))
```

Both compile, both keep exact types, and both emit short, readable `.d.ts`. This is the single biggest day-to-day ergonomic win over Kysely and it falls out of D3 rather than costing anything.

Builder-level composition is `$call` (type-preserving) and `$if` (with the literal overloads from §1.5).

### 2.5 Insert / upsert / update / delete with RETURNING

```ts
const [created] = await db
  .insertInto(users)
  .values({ email: 'a@b.c', name: 'Ada', role: 'admin' })   // Insertable<users>: generated cols absent
  .returning(({ users: u }) => ({ id: u.id, createdAt: u.createdAt }))
  .execute()
// created: { id: bigint; createdAt: Date }
```

```sql
insert into "public"."users" ("email", "name", "role") values ($1, $2, $3)
returning "id" as "id", "created_at" as "createdAt"
```

Upsert models PG's `EXCLUDED` by handing the update callback a second scope — the runtime-object analogue of Kysely's `OnConflictDatabase` virtual-table trick (kysely.md §2.4), which is the right idea expressed in the right form here:

```ts
await db
  .insertInto(users)
  .values(batch)
  .onConflict(c => c
    .columns(({ users: u }) => [u.email])
    .where(({ users: u }) => u.deletedAt.isNull())         // partial-index predicate
    .doUpdate((set, excluded) => ({
      name: excluded.name,
      tags: set.tags.concat(excluded.tags),                // reference the existing row too
      updatedAt: fn.now(),
    }))
    .whereUpdate(({ users: u }, excluded) => u.updatedAt.lt(excluded.updatedAt)))
  .returning(({ users: u }) => ({ id: u.id }))
  .execute()
```

Full PG `ON CONFLICT` coverage: `.columns()`, `.expressions()` (expression indexes), `.constraint(name)`, index predicate `.where()`, `.doNothing()`, `.doUpdate()`, and `DO UPDATE … WHERE` via `.whereUpdate()`.

Update and delete, with `RETURNING` reusing the *same* projection machinery as `select` (so relations, aggregates, and `sql` fragments all work in `RETURNING` — kysely.md §2.5 marks this **PORT**):

```ts
await db.update(posts)
  .set(({ posts: p }) => ({ published: true, publishedAt: fn.now(), views: p.views.add(1) }))
  .where(({ posts: p }) => and(p.authorId.eq(uid), p.published.isFalse()))
  .returning(({ posts: p }) => ({ id: p.id, author: p.author.one(a => a.select(x => ({ email: x.email }))) }))
  .execute()

await db.deleteFrom(sessions)
  .where(({ sessions: s }) => s.expiresAt.lt(fn.now()))
  .returning(({ sessions: s }) => ({ id: s.id }))
  .execute()
```

### 2.6 Bulk operations

**`insertMany`** with two strategies and an automatic switch:

```ts
await db.insertInto(events).valuesMany(rows).execute()
```

- `strategy: 'values'` (default) — one multi-row `VALUES`, casts on the first row only:
  `insert into "events" ("kind","at") values ($1::text,$2::timestamptz),($3,$4),…`
- `strategy: 'unnest'` — **one parameter per column regardless of row count**, a PG-only trick that sidesteps the 65535-param ceiling and shrinks the parse cost of huge batches:

```sql
insert into "public"."events" ("kind", "at")
select * from unnest($1::text[], $2::timestamptz[])
```

Auto-selection: `unnest` when `rows × columns > 30_000`, `values` otherwise; both overridable. Chunking (default 5_000 rows) happens above that and executes chunks inside a single transaction unless the caller is already in one.

**Bulk update by key** via `UPDATE … FROM (VALUES …)`:

```ts
await db.update(products)
  .fromValues(patches, { id: codecs.int8, price: codecs.numeric })
  .set(({ products: p }, v) => ({ price: v.price, updatedAt: fn.now() }))
  .where(({ products: p }, v) => p.id.eq(v.id))
  .execute()
```

```sql
update "public"."products" as "products"
set "price" = "v"."price", "updated_at" = now()
from (values ($1::int8, $2::numeric), ($3, $4), ($5, $6)) as "v"("id", "price")
where "products"."id" = "v"."id"
```

`fromValues` also accepts `strategy: 'unnest'`, producing `from (select * from unnest($1::int8[], $2::numeric[])) as v(id, price)`.

**Bulk delete** is `deleteFrom(t).where(t => t.id.in(ids))`, which compiles to `= any($1)` rather than an `IN (…)` list — one parameter, no plan-cache pollution from varying list lengths. This is a small, real PG-only win that every list-based builder gives up.

### 2.7 CTEs, including writable

`.with()` widens the scope for the remainder of the chain (Kysely's model, and correct), and — unlike Kysely — **codecs flow through the CTE** because the CTE's row shape is our own `ResultShape`, not a string-parsed column list.

```ts
const q = db
  .with('recent', d => d.from(posts)
    .select(({ posts: p }) => ({ id: p.id, authorId: p.authorId, amount: p.amount }))
    .where(({ posts: p }) => p.createdAt.gt(since)))
  .with('archived', d => d.deleteFrom(posts)                 // ── writable CTE
    .where(({ posts: p }) => p.createdAt.lt(cutoff))
    .returning(({ posts: p }) => ({ id: p.id, body: p.body })))
  .from(cte.recent)
  .innerJoin(users, ({ recent: r, users: u }) => r.authorId.eq(u.id))
  .select(({ recent: r, users: u }) => ({ email: u.email, total: fn.sum(r.amount) }))
  .groupBy(({ users: u }) => [u.email])
  .having(({ recent: r }) => fn.sum(r.amount).gt(1000))
```

`INSERT … SELECT` from a writable CTE, the canonical archive-and-move pattern:

```ts
await db
  .with('moved', d => d.deleteFrom(staging)
    .where(({ staging: s }) => s.ready.isTrue())
    .returning(({ staging: s }) => ({ payload: s.payload, at: s.at })))
  .insertInto(live)
  .fromSelect(d => d.from(cte.moved).select(({ moved: m }) => ({ payload: m.payload, at: m.at })))
  .returning(({ live: l }) => ({ id: l.id }))
  .execute()
```

`MATERIALIZED` / `NOT MATERIALIZED` hints are one option on `.with()` — a PG-only planner lever that costs us one token and that no TS builder exposes ergonomically.

### 2.8 Set operations, window functions, subqueries

```ts
// ── set operations: shapes must match, checked at compile time
const all = db.from(users).select(({ users: u }) => ({ id: u.id, kind: lit('user') }))
  .unionAll(db.from(orgs).select(({ orgs: o }) => ({ id: o.id, kind: lit('org') })))
  .orderBy(r => asc(r.id))
  .limit(50)
// mismatch => OrmTypeError<'union branch 2 has no column "kind"'>

// ── window functions, inline or named
const ranked = await db.from(posts)
  .select(({ posts: p }) => ({
    id: p.id,
    n:      fn.rowNumber().over(w => w.partitionBy(p.authorId).orderBy(desc(p.createdAt))),
    total:  fn.sum(p.amount).over('byAuthor'),
    run:    fn.sum(p.amount).over(w => w
              .partitionBy(p.authorId).orderBy(asc(p.createdAt))
              .rows({ from: 'unbounded preceding', to: 'current row' })),
    dense:  fn.denseRank().over('byAuthor'),
  }))
  .window('byAuthor', ({ posts: p }) => ({ partitionBy: [p.authorId], orderBy: [desc(p.amount)] }))
  .execute()

// ── subqueries: scalar, IN, EXISTS, and derived tables
.select(({ users: u }) => ({
  lastPostAt: db.from(posts).select(({ posts: p }) => fn.max(p.createdAt))
                .where(({ posts: p }) => p.authorId.eq(u.id)).asScalar(),   // Date | null
}))
.where(({ users: u }) => u.id.inQuery(db.from(bans).select(({ bans: b }) => b.userId)))
.from(db.from(posts).select(…).as('recent'))                                 // derived table
```

`DISTINCT ON` ships in v1 (`.distinctOn(({posts:p}) => [p.authorId]).orderBy(…)`) — it is PG-only, extremely useful for "latest row per group", and free for us. So does row locking: `.forUpdate({ of: ['posts'], wait: 'skip locked' })`, which is what makes queue workloads possible.

### 2.9 PG operator vocabulary

Operators are **methods on refs, gated by the codec's type class**, not a stringly-typed operator union. This fixes the Kysely defect documented in kysely.md §5.2(3): Kysely types the right-hand operand from the *column's* type rather than the *operator's* semantics, so `jsonb ? key` (which takes `text`), `tsvector @@ tsquery`, and range `&&` are all typed wrong or accidentally right. A per-operator operand table is finite and writable for one dialect — so we write it, once, as method signatures.

Type-class dispatch is a single indexed access, which keeps the type cost flat:

```ts
type Ref<C extends Codec> = BaseOps<C> & OpsByClass<C>[TypeClassOf<C>]
```

| Class | Methods | SQL |
|---|---|---|
| all | `eq neq lt lte gt gte isNull isNotNull in inQuery between isDistinctFrom coalesce cast asc desc` | `= <> < <= > >= is null …` |
| text/citext | `like ilike notLike notILike startsWith regex(~) iregex(~*) notRegex similarTo` | `like ilike ^@ ~ ~*` |
| array `T[]` | `overlaps(T[]) contains(T[]) containedBy(T[]) has(T) hasAll(T[]) length concat any all` | `&& @> <@ = any() array_length` |
| jsonb | `get(k) getText(k) path(string[]) pathText(string[]) contains(J) containedBy(J) hasKey(string) hasAnyKey(string[]) hasAllKeys(string[]) jsonPathExists(jp) jsonPathMatch(jp) concat delete` | `-> ->> #> #>> @> <@ ? ?\| ?& @? @@ \|\| -` |
| tsvector | `matches(TsQuery) rank(q) rankCd(q)` | `@@ ts_rank ts_rank_cd` |
| range | `overlaps(R) contains(R\|T) containedBy(R) strictlyLeft strictlyRight adjacent union intersection lower upper` | `&& @> <@ << >> -\|- + *` |
| numeric/int | `add sub mul div mod abs` | arithmetic, result codec preserved |
| net (inet/cidr) | `containsNet containedByNet overlapsNet` | `>> << &&` |
| vector (pgvector) | `l2 cosine innerProduct l1 hamming jaccard` | `<-> <=> <#> <+>` |

```ts
.where(({ users: u, posts: p }) => and(
  u.email.ilike('%@acme.com'),
  u.tags.overlaps(['vip', 'beta']),                       // text[] && text[]
  u.meta.contains({ plan: 'pro' }),                       // jsonb @> jsonb
  u.meta.pathText(['billing', 'country']).eq('DE'),       // #>> — path is a PARAMETER (§3.4)
  u.meta.hasAnyKey(['trial', 'grandfathered']),           // ?|
  p.body.matches(websearchToTsquery('english', term)),    // tsvector @@ tsquery
  p.validRange.overlaps(range(from, to, '[)')),           // tstzrange &&
))
```

Full-text gets the small set of helpers that make it usable without leaving the API: `toTsvector`, `toTsquery`, `plaintoTsquery`, `phrasetoTsquery`, `websearchToTsquery`, `tsRank`, `tsRankCd`. Text-search *configuration* management, `ts_headline`, and dictionary handling are v2 (§6).

Every operator method returns an expression carrying its own **result codec**, so `count()` is `bigint` and `sum(numeric)` is `string` — one exact type, no generic to supply. Kysely returns `string | number | bigint` for these because it cannot know the driver (kysely.md §5.2(2)); PG-only plus owned codecs makes it exact. Likewise `SqlBool = boolean | 0 | 1` does not exist here; a boolean is a `boolean`.

---

## 3. The `sql` tagged template

### 3.1 Design summary

Four primitives, three safe and one loudly named:

| Primitive | Position | Safety |
|---|---|---|
| `` sql`…${value}…` `` | value | **Always parameterized.** Never interpolated. Never optional. |
| `sql.ident(parts)` | identifier | Sanitized + always quoted (§3.4). Security-critical, fuzzed. |
| `sql.lit(v)` | literal | **Non-strings only** (`number \| bigint \| boolean \| null`). |
| `sql.unsafeRaw(text)` | anything | Interpolates verbatim. Named to be greppable and lintable. |

Plus composition helpers: `sql.join(fragments, separator)`, `sql.empty`, and fragments-in-fragments (a `Fragment` interpolated into another `Fragment` splices its chunks and renumbers its params — no string round-trip).

### 3.2 `sql<T>` carries a codec, not a cast

The research verdict is unambiguous. Drizzle's docs say outright that `sql<T>` "cannot perform any type casts based on the provided type generic" (drizzle.md §2.1), which makes every `sql<number>` over a `bigint` or `numeric` column a latent lie; Kysely's `sql<T>` is an assertion too, though it at least defaults to `unknown` rather than `any`. We own decoding, so a cast is not merely unsafe here — it is *unnecessary*.

```ts
// The `sql` tag takes NO type parameter. `sql<number>` is a compile error
// ("Expected 0 type arguments"), which is the cheapest possible guard rail.
const frag = sql`lower(${users.email})`          // Fragment<unknown>

// Typing requires a codec, which supplies BOTH the TS type and the decoder.
const lowered = sql`lower(${u.email})`.as(codecs.text)          // Fragment<string>
const total   = sql`sum(${p.amount})`.as(codecs.numeric)        // Fragment<string>
const hit     = sql`${p.body} @@ ${q}`.as(codecs.bool)          // Fragment<boolean>
```

**The codec is verified, not trusted.** In dev mode (`NODE_ENV !== 'production'`, or `{ assertShape: true }`) the executor compares each declared codec's OID against the `dataTypeID` the server reported in `RowDescription` — metadata `pg` already hands us and which our `PgResult` is required to carry (pg-drivers.md §4.4). A mismatch throws:

```
CodecMismatchError: column "total" was declared as codec `int4` (oid 23)
but Postgres returned `numeric` (oid 1700).
  at src/reports.ts:42  sql`sum(${p.amount})`.as(codecs.int4)
Fix: use codecs.numeric, or cast in SQL.
```

That single check converts the entire class of "the type says `number`, production says `'1234.56'`" bugs into a test failure. No competitor does it, and it costs one integer comparison per column per query in dev.

**Untyped fragments still decode correctly.** A `Fragment<unknown>` used in a projection decodes *dynamically* via the OID registry using the `RowDescription`. So the escape hatch is honest at the type level (`unknown` forces acknowledgement) and *correct* at the value level (you still get a `Date`, not a string). Kysely gives you `unknown` and the driver's guess; we give you `unknown` and our decoder.

### 3.3 Fragments are first-class and composable

A `Fragment<T>` is an `Expr` (a `RawNode`), so it works anywhere an expression works — projections, `where`, `orderBy`, `groupBy`, `having`, `RETURNING`, `ON CONFLICT` targets, join predicates, and inside nested relation projections. That first-class-ness is what makes the escape hatch a gradient rather than a cliff (kysely.md §2.6).

```ts
const distance = (a: Ref<Vector>, q: number[]) => sql`${a} <=> ${vec(q)}`.as(codecs.float8)

const conditions = [
  term && sql`${p.body} @@ websearch_to_tsquery('english', ${term})`.as(codecs.bool),
  authorId && posts.authorId.eq(authorId),
].filter(Boolean)

db.from(posts)
  .select(({ posts: p }) => ({ id: p.id, d: distance(p.embedding, query) }))
  .where(() => and(...conditions))
  .orderBy(({ posts: p }) => asc(distance(p.embedding, query)))

// sql.join for list construction
const cols = sql.join(names.map(n => sql.ident([n])), sql`, `)
```

Interpolating a fragment into a fragment splices node arrays; parameters are numbered once, at compile time, by the compiler — never by the fragment. This is why fragment reuse across queries is safe here and was a v6 MikroORM wart (mikroorm.md §4.3): our fragments carry no positional state at all.

### 3.4 Identifier and JSON-path sanitization (security-critical)

Kysely shipped **three high-severity CVEs** in exactly these positions (kysely.md §5.4): `GHSA-wmrf-hv6w-mr66` and `GHSA-pv5w-4p9q-p3v2` (JSON-path injection, exploitable *even in fully type-safe code* through `.key()`/`.at()` on a `Record<string, T>` column) and `GHSA-8cpq-38p9-67gx` (`sql.lit(string)` backslash escaping). SUMMARY §3.8 makes these sanitizers a named design axis. Our response is to **design two of the three positions out of existence** and fuzz the third.

**JSON paths are parameters, not literals — the CVE class is deleted, not patched.**

Every PG JSON accessor takes a value operand, so there is no reason to ever emit user text into a path position:

| API | SQL | User input goes to |
|---|---|---|
| `meta.get('k')` | `"meta" -> $1` | a parameter |
| `meta.pathText(['a','b'])` | `"meta" #>> $1` | a parameter (`text[]`) |
| `meta.hasKey(k)` | `"meta" ? $1` | a parameter |
| `meta.jsonPathExists(jp)` | `"meta" @? $1::jsonpath` | a parameter |

There is no `sanitizeJSONPathMemberValue` in this codebase because there is no code path that needs one. The only cost is that a JSON key cannot be a compile-time constant in the SQL text, which is irrelevant — PG plans `->` on a parameter identically.

**`sql.lit` refuses strings.** Signature is `lit(v: number | bigint | boolean | null): Fragment`. String literals in a query position are always parameters. (DDL genuinely needs string literals — index predicates, `COMMENT ON` — and that lives in agent 04/05's DDL emitter with its own reviewed literal quoter, out of scope here.) This deletes the third CVE.

**`sql.ident` — the one remaining sanitizer.** Contract:

```ts
export function ident(parts: readonly [string, ...string[]]): IdentFragment
```

Rules, all enforced, all tested:

1. **Parts, never a dotted string.** `ident(['public', 'my.table'])` yields `"public"."my.table"` — two identifiers, one of which contains a dot. There is **no** overload that splits a string on `.`; that overload is precisely how an attacker turns one identifier into two. Schema-qualified names are tuples by construction.
2. **Always quote.** No "is this a safe bare identifier" fast path — an unquoted-when-safe optimization is where `quote_ident`-style bugs live, and quoting is free.
3. **Escape by doubling `"`.** `name.replaceAll('"', '""')`, applied to the *whole* part.
4. **Reject rather than mangle:** non-string input; empty string; any `U+0000`; unpaired surrogates; UTF-8 byte length > 63 (`NAMEDATALEN - 1`; PG silently *truncates*, which can collide two distinct identifiers into one — we throw). Rejection is a thrown `InvalidIdentifierError` naming the offending part.
5. **Nothing else is transformed.** No case folding, no trimming, no Unicode normalization — normalization would make two distinct PG identifiers compare equal.
6. **Schema-derived identifiers never take this path.** Table and column names from the schema are quoted once at schema-build time and stored pre-quoted, so the hot path does zero string work and the dynamic sanitizer is reached only by explicit `sql.ident` calls.

**Fuzz-test plan** (in CI from the first commit, per SUMMARY §3.8):

- **Generator** (hand-written, ~60 lines, no dependency): random Unicode strings biased toward adversarial content — `"`, `""`, `\`, `\\`, `'`, `;`, `--`, `/*`, newline/CR/tab, NUL, lone surrogates, RTL overrides, zero-width joiners, combining marks, 4-byte astral planes, PG keywords, `*`, `.`, `$1`, and lengths straddling 62/63/64 **bytes** (not chars).
- **Differential oracle:** for every input PG accepts, assert `ident([s])` equals `SELECT format('%I', $1)` from a live PG (`format('%I')` is the canonical server-side quoter). Divergence is a bug in us or a deliberate, documented, test-pinned difference (we always quote; `%I` sometimes does not — so the comparison is against `quote_ident`-normalized output, with the always-quote difference asserted explicitly).
- **Round-trip oracle:** `CREATE TEMP TABLE <ident> (x int)`, then read `information_schema.tables.table_name` back and assert **byte equality** with the input. This catches truncation, normalization, and escaping errors that a string comparison against `format` might miss.
- **Token invariant:** a tiny tokenizer asserts the output is exactly one identifier token — starts and ends with `"`, contains no odd-length run of `"` internally, and contains no statement separator outside quotes.
- **Whole-compiler fuzz:** generate random ASTs (bounded depth), compile, and assert (a) `binds.length` equals the maximum `$n` in the SQL, (b) no bind's *value* appears as a substring of the SQL, (c) the statement count (`;` outside string/identifier tokens) is exactly 1, and (d) PG `PREPARE`s the SQL without error (a describe-only round trip, no execution).
- **Budget:** 10k cases per PR, 1M nightly, failing seeds auto-committed to a regression corpus. Any advisory-class finding gets a corpus entry before the fix lands.

### 3.5 `unsafeRaw`

```ts
sql.unsafeRaw(text: string): Fragment<unknown>
```

Named per SUMMARY §4 ("`sql.raw` → `unsafeRaw`"). Interpolates verbatim; the only primitive in the library that can. Supporting measures: it sets `Compiled.meta.usedUnsafeRaw`, it captures a stack frame in dev for the error message if the statement fails to parse, and we ship an ESLint rule (`pg-orm-ts/no-unsafe-raw`) enabled in the recommended config. It exists because ordering by a user-selected column direction and similar dynamic-DDL-ish cases are real; it should be a deliberate, greppable act.

---

## 4. Relation metadata: the consumption contract

Agent 05 owns *how relations are declared*. This section pins *what the query layer needs to receive*, which is the seam between us.

### 4.1 What the query layer consumes

```ts
export interface RelationMeta {
  readonly name: string
  readonly kind: 'one' | 'many'
  /** Source (parent) side. */
  readonly from: { readonly table: TableMeta; readonly columns: readonly ColumnMeta[] }
  /** Target (child) side. */
  readonly to:   { readonly table: TableMeta; readonly columns: readonly ColumnMeta[] }
  /** m2m: the junction hop. from -> through.fromColumns, through.toColumns -> to. */
  readonly through?: {
    readonly table: TableMeta
    readonly fromColumns: readonly ColumnMeta[]
    readonly toColumns: readonly ColumnMeta[]
  }
  /** `one` relations only: false => result type is `T | null`. */
  readonly required: boolean
  /** Always-applied predicate (relation-level scoping, e.g. `where: { deleted: false }`). */
  readonly where?: (scope: AnyScope) => Expr
  /** Default ordering for `.many()` when the caller supplies none. */
  readonly orderBy?: (scope: AnyScope) => readonly OrderItem[]
}
```

Everything the compiler does with a relation is derived from this and nothing else:

| Accessor | Uses | Emits |
|---|---|---|
| `.many(q)` | `to`, `through`, `where`, `orderBy` | `LEFT JOIN LATERAL (select coalesce(json_agg(…), '[]'))` |
| `.one(q)` | `to`, `required` | `LEFT JOIN LATERAL (select json_build_object(…) … limit 1)`; nullable iff `!required` |
| `.count()` / `.sum(f)` / `.exists()` | `to`, `where` | correlated scalar subquery |
| `.some(p)` / `.none(p)` / `.every(p)` | `to`, `where` | `EXISTS` / `NOT EXISTS` / null-safe double negation |

Three requirements on agent 05's surface, stated as hard asks:

1. **Relation names must not collide with column names** on the same table — the schema builder must reject the collision at definition time with a clear error, because both live on the same scope object. (Rejecting is better than namespacing under `$rel`, which taxes every call site to prevent a rare mistake.)
2. **Composite keys must be expressible** (`columns` are arrays, not scalars) — PG applications use them and Drizzle's relation model handles them.
3. **m2m goes through `through`**, matching Drizzle v2's `defineRelations` model (drizzle.md §2.2), which is strictly better than v1's junction-traversal and is the shape to copy.

The query layer does **not** need: cascade rules, load strategies, an inverse-side declaration (a `many` needs no matching `one`), or lazy-loading wrappers. All are either the migration layer's business or things we deliberately do not have.

### 4.2 How nesting types as `Loaded`-style results

Two forms, one mechanism:

```ts
// (a) Projection form — exact, structural, Prisma-grade narrowing. The default.
const r = await db.from(users).select(({ users: u }) => ({
  id: u.id,
  posts: u.posts.many(q => q.select(({ posts: p }) => ({ id: p.id, title: p.title }))),
})).execute()
// r: { id: bigint; posts: { id: bigint; title: string }[] }[]

// (b) Entity form — sugar over the same thing, for "give me the row plus these relations".
const r2 = await db.from(users).select(({ users: u }) => ({
  ...u.$all,
  posts: u.posts.all(),                     // == .many(q => q.select(p => ({ ...p.$all })))
})).execute()
// r2: Loaded<typeof users, { posts: true }>[]
```

`Loaded<T, H>` is a derived alias over the relation graph, used to *declare* load state in function signatures — MikroORM's insight, which converts "did someone populate this?" from a runtime `undefined` into a compile error (mikroorm.md §3.2):

```ts
type WithPosts = Loaded<typeof users, { posts: { author: true } }>
function renderFeed(u: WithPosts) { u.posts[0].author.name }   // checked
```

Two divergences from MikroORM worth stating: (i) there is no runtime `Collection`/`Ref` wrapper — a loaded relation is a plain array or object, so `JSON.stringify` and structural equality just work; (ii) there is no `AutoPath` dotted-string hint type, which is one of MikroORM's most expensive types — hints are nested object literals, which TypeScript resolves far more cheaply.

And, restating D4 because it is the payoff: **`Loaded` types are not degraded.** `u.posts[0].createdAt` is a `Date`, `amount` is a precision-exact `string`, `id` is a `bigint`, at any nesting depth, because the compiler emits codec-directed casts into the JSON and the decoder runs `codec.decodeJson`. Kysely's `ShallowDehydrateObject` (kysely.md §1.7) correctly models the loss that a non-decoding library must suffer; we do not have to suffer it.

---

## 5. What we deliberately punt to v2

Scoping v1 brutally small is SUMMARY risk #2 (Drizzle: 9.5 months of RC; Kysely: no 1.0, ever). Everything below is *reachable from v1* via the `sql` tag, so nothing on this list is a wall — it is a missing convenience.

| Punted | Why | v1 workaround |
|---|---|---|
| **Typed recursive CTEs** (`withRecursive`) | Self-referential row typing is the single most expensive type in any builder that has it; trees/graphs are a minority of queries | `db.withRaw('tree', sql\`…\`, shape)` — an explicit column→codec map, fully decoded |
| **`MERGE`** | PG 15 has it, but `RETURNING` only landed in PG 17; the API pays for itself only with `RETURNING` | `INSERT … ON CONFLICT` covers ~95% of real usage |
| **Streaming / cursors / portals** (`for await`) | Needs adapter capability negotiation and a second execution path; the adapter interface already reserves `stream()` | `.limit()`-based batching, or drop to the driver |
| **`GROUPING SETS` / `CUBE` / `ROLLUP`** | Typing "column may be NULL because it was rolled up" correctly is genuinely hard | `sql` fragment in `groupBy` |
| **Relay cursor pagination helper** | Well-scoped and self-contained, so it is a clean v2 add-on | Keyset predicates compose today: `row(a, b).gt(row($1, $2))` |
| **Nested writes / `saveGraph`** | Needs FK ordering and is adjacent to the UoW we rejected; deserves its own design | Explicit `insertMany` + writable CTEs, which is more predictable anyway |
| **Set-returning functions as FROM items** (beyond `unnest` / `generate_series`) | `jsonb_to_recordset` etc. need a column-definition-list DSL | `db.fromRaw(sql\`…\`, shape)` |
| **Query-plan middleware / budgets** (Prisma-next's inspectable plan) | Genuinely good idea; needs the plugin type-channel designed first | `.toSQL()` + `.explain()` ship in v1 |
| **Polymorphic relations** | Prisma's oldest top-voted open issue for a reason | Explicit union queries + set ops |
| **`ts_headline`, text-search config management, dictionaries** | Long tail | `sql` fragments; the operators and `*_to_tsquery` helpers ship in v1 |
| **`COPY`-based bulk load** | Session-pooling-only, needs its own protocol path | `unnest` insert strategy handles very large batches |
| **Result caching** | Explicit non-goal — scope creep (drizzle.md §7). We expose `meta.reads`/`meta.writes` as invalidation hooks and nothing more | userland |

---

## 6. Alternatives rejected

**A dual API (Drizzle: core builder + RQB).** Rejected — this is the thing we exist to fix. Drizzle's relational builder emits exactly the right SQL but *forbids aggregations in `extras`*, while the core builder has full SQL power and returns flat rows the user must `reduce()` by hand (drizzle.md §2.1–2.2, §6). Users hit that wall constantly, and the fix is not a better second API but the deletion of the seam: nesting becomes a projection expression, so aggregates, windows, CTEs and set operations compose with it by construction (§2.3). SUMMARY §5.3 names this the unclaimed gap; it is D2.

**Prisma-style fluent client only.** Rejected. The narrowing is genuinely best-in-class and we port the *result narrowing*, but the API cannot express CTEs, window functions, `UNION`, or recursive queries at all (prisma.md §3.1, all open issues), `groupBy` cannot `select`, there is no `upsertMany`, and — decisively — **the nested-object API does not compose**: you cannot build a `where` from fragments without hand-wrestling `Prisma.UserWhereInput`, and conditional filters degrade into spread-with-`undefined`, which was a data-leak bug class serious enough to warrant the `strictUndefinedChecks` flag. Object-literal filters are also a mass-assignment surface if untrusted JSON is spread into them (drizzle.md §2.2 community concerns). Our filters are *closures over typed refs*, which cannot be constructed from untrusted JSON by accident.

**Raw-SQL-first (postgres.js style).** Rejected. It is the most honest option and the most limited: no result typing without a codegen-from-live-DB step (Prisma's TypedSQL is the best version of this and is still preview after 2 years, blocked precisely on requiring a live DB in CI — prisma.md §2.3), no dynamic composition without string concatenation, and no relation nesting at all. We keep its virtue — `sql` is first-class everywhere and can express anything PG can — while making it the *escape hatch* rather than the *floor*.

**String composition instead of an AST.** Rejected in §1.1: it discards the information the result-shape descriptor needs, makes plugin/RLS rewriting impossible, makes relation hoisting painful, and scatters the injection audit surface across every call site.

**Kysely-style string references (`'person.first_name as name'`).** Rejected. They read well and they are the direct cause of two measured problems: generic expression fragments *cannot* typecheck (kysely.md §1.8(9)) and helper return types blow up `.d.ts` output (§1.8(10)); and the alias-parsing plus `AnyColumn<DB, TB>` unions distribute over the whole schema, making type-check cost superlinear in schema size (§1.9 — 4.57M instantiations at 300 tables). Value refs fix both.

**Drizzle-style imported table objects (`eq(users.id, posts.authorId)`).** Rejected as the *primary* form. It has the right idea (refs are values) but no notion of alias, so self-joins and aliased subqueries need a separate `alias()` ceremony and the scope of a predicate is not statically knowable. The scope-lambda keeps refs-as-values and adds correct aliasing.

**Wrapping Kysely rather than building tiers 1–2.** Rejected, consistent with kysely.md §8.1. ZenStack v3 proves it works (§8.0) — but only by owning the schema, the type derivation, and the node-transformation layers anyway, at which point you have inherited a permanently-0.x dependency with a bus factor of ~1, plus every multi-dialect compromise you cannot opt out of: ~10 invalid-on-PG methods polluting `InsertQueryBuilder` autocomplete, `count() → string | number | bigint`, `SqlBool = boolean | 0 | 1`, and operand types derived from the column instead of the operator.

**Multi-pass compiler with an optimizer/normalizer.** Rejected: pure added latency and a second source of truth for query semantics. Postgres has a planner. We expose `MATERIALIZED` hints, `DISTINCT ON`, lateral-vs-subquery strategy, and `EXPLAIN`, and let the planner plan.

**Proxy-based lazy relations.** Rejected — lazy loading *is* the N+1 generator (drizzle.md §6), proxies break `JSON.stringify` and `structuredClone`, and it is upstream of the UoW we already declined (SUMMARY §3.3).

---

## 7. Contracts other agents must satisfy

**Agent 02 — `Codec`.** The query layer needs exactly this surface; two of these fields are unusual and load-bearing:

```ts
export interface Codec<T = unknown> {
  readonly name: string
  readonly oid: number                                  // for RowDescription assertion (§3.2)
  readonly typeClass: TypeClass                         // drives operator method dispatch (§2.9)
  readonly pgType: string                               // for VALUES/unnest casts (§2.6)
  encode(v: T): string | Uint8Array | null
  decodeText(s: string): T                              // top-level wire value
  /** REQUIRED: value as it arrives inside a json_agg payload. */
  decodeJson(v: unknown): T
  /**
   * REQUIRED: how this column must be rendered inside json_build_object so that
   * decodeJson can be exact. 'native' | 'text' | a custom expression wrapper.
   * int8/numeric MUST be 'text' — a JSON number loses precision. (§2.3 point 2)
   */
  readonly jsonEncode: 'native' | 'text' | ((e: Expr) => Expr)
  readonly arrayOf?: Codec                              // element codec for T[]
}
```

**Agent 05 — relations.** `RelationMeta` as specified in §4.1; relation/column name collisions rejected at definition time; composite keys as arrays; m2m via `through`. Also: columns must expose a pre-quoted identifier string computed once at schema-build time (the compiler must never quote a schema identifier on the hot path).

**Agent 06 — driver.** `execute(sql, params, { rowMode: 'array', name? })` returning `{ rows: unknown[][], fields: PgField[], rowCount }`, with `fields[].dataTypeID` **required** (it powers §3.2's assertion and dynamic decode) and `describe()` optional-but-expected (it powers the description cache in §1.4(c)). Default statement mode unnamed; `{ statement: 'named' }` is our opt-in pass-through.

**Transactions (whoever owns the session layer).** The query layer targets an `Executor` interface — `db` and `tx` both implement it — and the *type-level* prevention of using the outer `db` inside a transaction scope (Drizzle's #1 footgun, drizzle.md §2.3) lives there, not here. What we owe that layer: `Compiled.meta.writes`, so a read-only executor can reject a mutating statement at both the type level and runtime.

---

## Appendix A — Compiled SQL reference

Every example in §2 with its exact output, to be pinned as compiler snapshot tests (no database required — the compiler is pure).

```sql
-- §2.1 select/where/order/limit
select "users"."id" as "id", "users"."email" as "email", "users"."created_at" as "joined"
from "public"."users" as "users"
where ("users"."deleted_at" is null and "users"."role" = any($1))
order by "users"."created_at" desc, "users"."id" asc
limit $2

-- §2.5 upsert with partial-index predicate + EXCLUDED + DO UPDATE WHERE
insert into "public"."users" ("email", "name", "role") values ($1, $2, $3)
on conflict ("email") where "users"."deleted_at" is null
do update set "name" = "excluded"."name",
              "tags" = "users"."tags" || "excluded"."tags",
              "updated_at" = now()
where "users"."updated_at" < "excluded"."updated_at"
returning "id" as "id"

-- §2.6 bulk insert, unnest strategy (2 params for 50k rows)
insert into "public"."events" ("kind", "at")
select * from unnest($1::text[], $2::timestamptz[])

-- §2.6 bulk update from values
update "public"."products" as "products"
set "price" = "v"."price", "updated_at" = now()
from (values ($1::int8, $2::numeric), ($3, $4)) as "v"("id", "price")
where "products"."id" = "v"."id"

-- §2.7 writable CTE feeding an INSERT ... SELECT
with "moved" as (
  delete from "public"."staging" as "staging" where "staging"."ready"
  returning "payload" as "payload", "at" as "at"
)
insert into "public"."live" ("payload", "at")
select "moved"."payload", "moved"."at" from "moved"
returning "id" as "id"

-- §2.9 jsonb path as a PARAMETER (the CVE class, designed out)
select "users"."id" as "id"
from "public"."users" as "users"
where ("users"."meta" #>> $1) = $2
-- params: [['billing','country'], 'DE']
```

## Appendix B — Type-perf and fuzz budgets (CI gates from day one)

| Gate | Threshold | Source of the number |
|---|---|---|
| Type instantiations / query, 300-table schema | must be **flat** vs the 80-table schema (±10%) | Kysely's per-query cost rose 12.4k → 22.9k over that range (kysely.md §1.9); flatness is the whole point of D3 |
| `tsc --noEmit`, 300 tables / 200 queries, TS 5.9 | < 8 s | Kysely measures 30.1 s |
| `.d.ts` bytes, whole package | < 400 KB | Drizzle 1.0-rc: 1.96 MB across 720 files (drizzle.md §4.4) |
| Compile time, 12-col select + 2 joins + 1 nested relation | < 25 µs | §1.1 |
| Decode throughput, 10k rows × 12 cols | within 15% of a hand-written positional mapper | near-raw is the bar (SUMMARY §6.4) |
| Ident fuzz | 10k cases/PR, 1M nightly, 0 findings | §3.4 |
| Compiler fuzz (params ≡ placeholders, 1 statement, no value in SQL text) | 10k cases/PR | §3.4 |
