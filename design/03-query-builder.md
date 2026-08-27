# 03 — Query Building Engine

> **Amended 2026-08-25 — nullability inverted.** Examples here originally used `.notNull()`;
> sign-off 4 made **NOT NULL the default** with `.nullable()` opting in. The `.notNull()` calls
> have been dropped; a column that is meant to be nullable in these examples would carry
> `.nullable()`. See 05 §0.

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


> **AS BUILT (WS4, `09` §3.4).** The node set grew four members, all of them things this section
> declared in prose and the spike had not implemented: `SelectNode.windows` (a `WINDOW` clause),
> `FuncNode.columns` (`unnest($1, $2) as "v"("a","b")` — the bulk-update source), and
> `ProjectionItem.group` + `GroupPlan`, which is fork F2's `nest({...})`. A group is the one
> projection item that is **not** 1:1 with a result column: it contributes `n` columns and one
> `FieldPlan`, so `hoist.ts` threads a column index through the walk rather than taking it from the
> loop counter. `GroupPlan.sentinel` carries the NOT NULL witness that decides whether a
> `nestNullable` object is `null` — see §2.2's note.
>
> `update`, `delete`, `setop`, `with`, `on conflict`, the `values` and set-returning-function FROM
> items and the `unnest` insert source were all declared here and are now implemented; `case`,
> `row` and `array` remain declared-not-implemented and fail with `UnsupportedNodeError` naming the
> kind.

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
  | { k: 'value'; encoded: string | Uint8Array | null; oid: number | undefined }
  | { k: 'slot'; name: string; codec: Codec }

/**
 * WS2 addition. `oid` is the codec's `paramOid` — the type this `$n` is DECLARED as in `Parse`.
 * `paramTypesOf(binds)` produces the positional array the driver sends, spelling "no declared
 * type" as `0` ("unspecified, infer from context"); measured indistinguishable from 705.
 *
 * It is not cosmetic. With no declared type PostgreSQL coerces an untyped `$n` to whatever the
 * other operand is, which hides operand-type nonsense until the day a codec changes. Declaring the
 * type is what turned the compiler fuzz's plan-only oracle into one that can fail (`09` §3.2).
 */

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

> **AS BUILT 2026-08-27 (the perf pass, `09` §3.7 follow-up).** The third bullet's conditional
> fired. "A closure tree measured within noise of generated code" was true of the prototype and is
> not true of the shipped decoder, so `{ decoder: 'codegen' }` exists — **opt-in, never the
> default**, exactly as this paragraph specified in advance.
>
> **What the measurement says.** A closure tree cannot write a row as an object *literal*: the keys
> are only known at run time, so it must write N dynamic properties into a fresh object. On the
> 10 000 × 12 fixture with identity codecs on both sides — so the only difference is the shape of
> the row loop — that is **~1.9 ms against ~0.08 ms** for a literal, ~24×. Through real codecs the
> loop is ~20 % of a decode and the gap comes out as **1.50–1.55× a same-checks hand mapper for the
> closure tree and 1.13–1.15× for the generated one** (1.17 on a busy machine), against Appendix
> B's 1.15. Both are gated in
> `bench/runtime/budget.json` and printed against 1.15 on every run.
>
> ```ts
> const db = pgPrime({ driver, schema, decoder: 'codegen' })   // 'closure' | 'codegen', default 'closure'
> ```
>
> **The default does not change, and the reason is unchanged.** A Content-Security-Policy without
> `unsafe-eval` — a Cloudflare Worker, a hardened Electron renderer, some Deno configurations —
> forbids `new Function`, and a database client whose default row decoder cannot run there is a
> client that fails in production for a reason its user never chose. So the closure tree stays the
> default, and it is *tested* on a runtime with no code generation at all
> (`test/compile/decode-oracle.test.ts` replaces `globalThis.Function` with one that throws and
> decodes the fixture anyway).
>
> **What the generator may write.** The generated source names nothing but its own parameters.
> Every codec, every per-column `CodecContext` and every fallback sub-decoder is passed **by
> position** into the outer `new Function`, so no identifier derived from a schema, a column name
> or a value is ever code. The only interpolated text is a result key inside a string literal
> (`JSON.stringify`, plus an explicit U+2028/U+2029 escape) and a column index proven to be a
> non-negative integer; `__proto__` is refused at plan time for *both* builders, because in
> generated source it would be an ordinary key and the two builders must not disagree about it.
> `json` and `group` fields keep the closure tree's own decoder, bound as a parameter — only the
> row loop is generated.
>
> **Choosing it on a runtime that forbids it is a start-up error**, not a first-query error:
> `pgPrime({ decoder: 'codegen' })` probes `new Function` once and throws a `PgPrimeError` naming
> the option and the fix. Finding out under load is the whole complaint against eval-based fast
> paths.
>
> **R1 is three implementations now.** `test/compile/decode-oracle.test.ts` runs every assertion
> for both builders and asserts they agree cell for cell with each other and with the hand-written
> positional mapper — one of which was written to be readable rather than general, and one of which
> shares no row-materialisation code with the other two.

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

> **AS BUILT (WS4, `09` §3.4).** (a) ships: `.compile()` memoises on the builder *instance*, and so
> does `.toAst()`. Neither can go stale, because a builder method returns a **new** instance over a
> new frozen state record — copying a dozen pointers, never the AST, whose nodes are frozen at
> construction and therefore shareable by reference. `toAst()` is pure and deterministic: scope
> lambdas run at *call* time, exactly once, so two `.compile()` calls cannot produce two queries.
>
> The param-count error now says `compiled insert uses 65538 bind parameters …` — naming the
> statement kind, because the fix differs by kind (an INSERT wants `strategy: 'unnest'`; a SELECT
> with a huge list already gets `= any($1)`).
>
> **AS BUILT (WS6, `09` §3.6).** (b) and (c) ship.
>
> **(b) `.prepare<P>(name?, opts?)`** returns a `PreparedQuery<P, O>` with `sql`, `meta`,
> `compile()`, `toSQL()`, `execute` / `executeTakeFirst` / `stream` / `explain`. `execute(params)`
> walks `binds` once and calls `codec.encode` per slot per execution; it does not compile, does not
> walk the AST and does not rebuild the decoder, and all three are pinned with spies
> (`test/query/prepared.test.ts`).
>
> The hole is a **free function**, not the `$` scope this section sketches:
>
> ```ts
> .where(({ users: u }) => eq(u.email, placeholder('email', textCodec)))
> .prepare<{ email: string }>('users_by_email')
> ```
>
> `$` cannot be typed. Its shape is `P`, and `P` arrives at `.prepare<P>()` — *after* the
> `.where()` that used it — so a typed `$` needs `P` threaded through `Query` as a fourth type
> parameter, which is what `04` §1.3 rule 3 forbids. Both arms were measured (`09` §3.6): the `$`
> parameter costs **zero** instantiations, because nobody instantiates a callback parameter the
> caller never declares, so the decision is about what the surface can *express* and not about its
> price. `P` is therefore written by hand and checked against `meta.placeholders` at execute time;
> a missing or extra key throws a `BuilderError` naming it.
>
> The name argument is the **JS-side** artifact's, for logs and errors. It never reaches the wire:
> the server-side name is `pgprime_<fnv1a(sql)>_<seq>` per `07` §2.4, because the cache key has to
> be per SQL text and per parameter-OID signature, which a caller-chosen string is not.
>
> **(c) The description cache** ships as a bounded LRU (256) keyed on SQL text, reached through
> the one statement kind that needs it: ``db.sql`…` ``. What it caches is the **resolved decode
> plan**, not a `Describe` round trip, and the difference is a deviation worth reading — see the
> AS BUILT note in §3.2. `describeCacheStats()` exposes `{ hits, misses, builds, size }` so the
> claim is falsifiable; a builder-compiled query never touches it, which is asserted rather than
> assumed.

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
  email:     citext().unique(),
  name:      text(),
  role:      pgEnum(userRole)(),
  tags:      text().array().default([]),
  meta:      jsonb<UserMeta>().default({}),
  createdAt: timestamptz().defaultNow(),
  deletedAt: timestamptz(),
})

export const posts = table('posts', {
  id: int8().generatedAlwaysAsIdentity().primaryKey(),
  authorId: int8().references(() => users.id),
  title: text(),
  body: tsvectorBacked(text()),
  amount: numeric(12, 2),
  published: bool().default(false),
  createdAt: timestamptz().defaultNow(),
})

export const relations = defineRelations({
  users: { posts: many(posts, { from: users.id, to: posts.authorId }) },
  posts: { author: one(users, { from: posts.authorId, to: users.id, required: true }) },
})

export const db = pgPrime({ pool, schema: { users, posts }, relations })
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

> **AS BUILT (WS4, `09` §3.4).** The example above predates two decisions and is kept for its
> *shape*. As shipped:
>
> ```ts
> const rows = await db
>   .from(db.h.users)                                   // a HANDLE, not the bare table — see below
>   .select(({ users: u }) => ({ id: u.id, email: u.email, joined: u.createdAt }))
>   .where(({ users: u }) => and(isNull(u.deletedAt), inList(u.role, ['admin', 'owner'])))
>   .orderBy(({ users: u }) => [desc(u.createdAt), asc(u.id)])
>   .limit(20)
>   .execute()
> ```
>
> Operators are free functions (fork F1, §2.9's amendment), so `u.deletedAt.isNull()` is
> `isNull(u.deletedAt)` and `u.role.in([...])` is `inList(u.role, [...])`. And `db.h.users` rather
> than `users`: WS1 typed the builder against a *handle* — a `[SCHEMA]` + `[NAME]` pair — because
> relations live on the schema and a bare `pgTable(...)` would silently have none. `pgPrime({ schema })`
> puts the handles on `db.h`, so a query file still needs one import.
>
> Everything else holds byte for byte: the compiled SQL is Appendix A's, `in([])` is the constant
> `false`, and a comparison's right-hand side takes a value, a ref or an expression. `u.$all` is
> spelled `.selectAll('users')` (every column of one alias, nullable as a whole when that alias was
> left-joined); a `{ ...u.$all }` spread would have to be a runtime record, and the builder's scope
> objects are cached per `(table, alias)` precisely so that they are not rebuilt per query.
> Repeated `.where()` conjoins and repeated `.orderBy()` appends — see `09` §3.4 decision 3.

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

> **AMENDED 2026-08-26 — fork F2 decided against this spelling (09 §3.0).** Grouping is written `author: nest({ id: u.id, name: u.name })`, per 04 §2.1, not as a bare literal. Bare literals force `Project<P>` to be conditional *and* recursive, and measured that costs **+16 % to +22 %** on every projection in the program (and +4.8 % / +9.3 % whole-program). Semantics are unchanged, including the whole-object left-join nullability above — `nestNullable({…})` is the left-joined form. Six characters, 16–22 %.

> **AS BUILT (WS4, `09` §3.4).** Whole-object left-join nullability needs a *witness* at runtime,
> and the witness is a column the schema declares NOT NULL: if it is null in the result row, the
> LEFT JOIN found nothing and the whole object is `null`. Drizzle's rule — "the object is null when
> every field is null" — agrees on every single-alias group and is wrong the moment one group spans
> two left-joined aliases, which is why `GroupPlan.sentinel` exists (R10 M6 survived without it).
> A group projecting no NOT NULL column falls back to the all-null rule, which is the honest answer
> there. `nest({...})` deliberately does not do any of this: a grouped ref off a left-joined alias
> is `T | null` per field, because the row exists and that one column is null.
>
> **Lateral joins**: derived tables ship (`.from(db.from(posts).select(…).as('recent'))`), and
> `.innerJoinLateral` / `.leftJoinLateral` do not — the emitter handles `lateral`, the builder has
> no method for it yet. `right` / `full` / `cross` joins likewise: the emitter has all four, `Query`
> offers `innerJoin` and `leftJoin`, which is what this section shows.

Lateral joins are first-class: `.innerJoinLateral(sub, alias, on)` / `.leftJoinLateral(...)`, where `sub` is a select builder that may reference outer scope refs.

### 2.3 Relational projection — the differentiator

**This is D2.** A relation accessor lives on the table scope next to the columns, and returns an *expression* usable anywhere in a projection. Because it is an expression, it composes with everything else in the same query: aggregates, window functions, `GROUP BY`, CTEs, set operations, `RETURNING`.

> **CONFIRMED 2026-08-26 — fork F3 decided in favour of this spelling (09 §3.0).** 04 §2.4 proposed a second lambda parameter (`(t, r) => r.u.posts(…)`) "specifically to avoid an intersection". Measured, that reason does not survive: the intersection is instantiated once per (alias, table) and cached, while the second parameter forces `RelsNs<S>` on **every** `select`, including the majority that project no relation. On-scope is cheaper or equal on every shape and both compilers (−1.1 % to −4.2 % per query, −0.4 % / −2.0 % whole-program). The price is that a relation may now collide with a column name — §4.1's "fail loudly on a relation/column name collision" is what pays for this fork and is owed by WS5.

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

> **AS BUILT 2026-08-26 (WS5, `09` §3.5).** Four spelling deltas in the sketch above, each with a
> reason that is not about relations:
> - **`u.posts.many(q)`, `u.posts.count()`** — the accessor is an *object*, not a callable. `09`'s
>   own goal line says so; WS1 had shipped a callable picker and every probe, golden and bench arm
>   moved with it. A to-many has no `.one()` and a to-one has no `.many()`: `RelAccessor` splits on
>   `kind` before either interface is instantiated.
> - **`over(fn.rank(), w => …)`** rather than `fn.rank().over(…)` — fork F1 (§2.8's amendment).
> - **the sub-query lambda takes bare refs**, not `({ posts: p })`. A relation sub-query has exactly
>   one source, so an alias key would be a destructure for nothing; the refs come with the child's
>   *own* relation accessors merged in, which is fork F3 held one level down and what makes
>   `p.comments.count()` read as one expression.
> - **`.limit(3)` inside the relation is a bind**, `$1`, exactly as the compiled SQL below shows.
>
> `...u.$all` is not implemented; `.all()` is its relation-side equivalent and is what `09` WS5's
> goal line asks for. A `$`-prefixed member on every scope object is a decision about the *column*
> surface, and it is not this section's to make.

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

> **AS BUILT 2026-08-26 (WS5, `09` §3.5).** This is the emitted SQL, with the lateral aliases
> generated rather than named: `pc` → `_r0`, `rev` → `_r1`, `lp` → `_r2`, `cc` → `_r3`, `au` → `_r4`.
> An accessor cannot name its own lateral — it does not know how many siblings precede it — so
> `planSelect` assigns them left to right and shares one number between the occurrences CSE
> collapsed. `test/query/__sql__/feed.sql` is this query, byte for byte, compiled from the builder.
>
> One other difference: `commentCount` is cast where it is *used* (`"_r3"."v"::text`, inside
> `json_build_object`) rather than where it is produced (`count(*)::text as "v"`). Same value, and
> it falls out of the existing per-codec JSON cast rather than needing a second rule.

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

> **AS BUILT 2026-08-26 (WS5, `09` §3.5).** Point 6 is implemented as a *mark plus a digest*, and
> the two halves are deliberately in different layers. `.count()` / `.sum(f)` produce an ordinary
> correlated subquery node carrying `hoist: true`; nothing else in the library sets that flag,
> which is how "confined to nodes the compiler itself generated" is held literally rather than by
> convention. `planSelect` then walks every clause of the select — projection, where, group by,
> having, windows, order by — lifting each marked node into a `LEFT JOIN LATERAL … ON TRUE`.
> Walking the WHERE clause is safe because a left lateral on `true` neither adds nor removes a
> parent row.
>
> The digest is computed **in the compiler, from the node**, not by the relation layer, so it
> cannot disagree with the tree that is actually emitted. It includes encoded parameter *values*:
> `sum(amount + 1)` and `sum(amount + 2)` differ only in a bind, and that is exactly the case where
> sharing would return one answer to two questions. It returns "not shareable" for a `sql`
> fragment, for a volatile function, and for **any node kind it does not recognise** — so a node
> added later can stop being deduplicated, never start.
>
> Unhoisted, the same node is still a valid correlated subquery, which is what lets a relation
> aggregate work in a `RETURNING` list where there is no FROM clause to hang a lateral on. The flag
> can change the plan; it cannot change the answer.

> **AS BUILT 2026-08-27 (the three distinct findings, `09` §3.7 follow-up).** Point 5's "`json` not
> `jsonb` by default" has **one exception, and the builder applies it itself**: when the statement
> compares whole rows, a relation column is built as `jsonb`.
>
> PostgreSQL's `json` has no equality operator, so `select distinct` — and `union` / `intersect` /
> `except`, which deduplicate — over a relation column is `42883 could not identify an equality
> operator for type json` at execute time. `jsonb` has one. Found by the WS7 builder fuzzer at seeds
> 2802423309 and 3300751089, and fixed where the statement is known rather than where the accessor
> is written: `planSelect(node, rowEquality)` in `src/compile/hoist.ts` decides the variant from the
> *statement*, so no list of accessors can be incomplete — which is exactly how the first attempt at
> this class shipped a fix that named `many` and forgot `all()`.
>
> Three boundaries, each pinned by a test rather than left to the reader:
> - **`distinct on (…)` does not switch.** It compares only its own key expressions, not the row.
> - **A relation nested inside a relation does not switch.** It is a member of the enclosing json
>   object, not a column of the row; `jsonb_build_object` coerces it on the way in.
> - **An explicit `{ variant: 'json' }` under a distinct statement is a `BuilderError`**, not a
>   silent override. Ignoring what a caller wrote is worse than refusing it.
>
> The value is unchanged by the switch and that is a measurement, not an argument: the decode plan
> is byte-identical (`ResultShape` is `toStrictEqual` either way, because the variant never reaches
> a codec) and `test/live-query/relations.test.ts` asserts the two forms' *decoded rows* are
> `toStrictEqual` on PGlite and PostgreSQL 17.11, `int8` past 2^53 and `numeric`'s trailing zero
> included. Key order cannot matter — the json decoder reads by key, positionally over the plan.

**Relation filters** (`some` / `every` / `none`) compile to `EXISTS` / `NOT EXISTS`, ported from MikroORM's `$some`/`$none`/`$every` (mikroorm.md §4.1), with the null-safety that `every` requires:

```ts
.where(({ users: u }) => u.posts.every(p => p.published.isTrue()))
// not exists (select 1 from posts p where p.author_id = u.id and (p.published) is not true)
```

**Aggregates + `GROUP BY` + nesting.** Relation accessors that produce a *row set* (`.many()`, `.one()`) require the parent row to be identifiable. After `.groupBy()`, the scope type only exposes relation accessors on a table whose primary key is in the grouping list; otherwise the accessor's type resolves to `OrmTypeError<'…relation projection requires the parent primary key in GROUP BY…'>`. Relation *aggregates* (`.count()`, `.sum()`) are scalar subqueries and are always available. This is the one place where the unified API needs a guard rail, and it is a compile-time one.

> **AMENDED 2026-08-26 — WS1 built this, and it reaches less far than the sentence above (09 §3.1).**
> Three qualifications, each pinned by a probe in `test/query/types/group-by-guard.probe.ts`:
> **(a) it is one-directional.** `.groupBy(…).select(…)` is guarded, as written; `.select(…).groupBy(…)`
> — the order §2.7's own example uses — is not, because `Query` does not carry the projection record
> and adding a fourth type parameter to carry it would put a distributed conditional over every
> projection in the program. WS4 owes the runtime check; PostgreSQL catches it meanwhile.
> **(b) it is keyed on the table name, not the alias**, because `[SRC]` on a pre-computed ref *is*
> the table name — so a self-join lets a grouped `p.id` unlock a second alias onto `posts`.
> **(c) a composite key declared with the table-level `primaryKey(a, b)` extra is invisible** to the
> type system, and the guard reads that as "cannot prove it is ungrouped" and allows. All three
> deviations are in the permissive direction on purpose: an unmodelled key must never produce a
> false rejection. `ColMeta` gained a fifth field, `pk`, to carry per-column keys.
> The guard costs an *ungrouped* query nothing, because `.groupBy()` returns a separate
> `GroupedQuery` stage and that is where its conditionals live.

**`Loaded`-style typing.** The projection form is already exact (Prisma-grade narrowing), so `Loaded` is not load-bearing for inference — but it is load-bearing for *signatures*, which is MikroORM's real insight (mikroorm.md §3.2). We ship it as a derived alias so a function can demand a load state:

```ts
type Feed = Loaded<typeof users, { posts: { author: true } }>
function render(u: Feed) { u.posts[0].author.name }   // checked, sync, no undefined
```

`Loaded<T, H>` is defined structurally from the relation metadata, and `InferResult<typeof query>` recovers the exact row type of any built query (Kysely's trick, kysely.md §2.6) for cases where the projection is the source of truth.

### 2.4 Expression builder and composition

`and` / `or` / `not` are free functions (tree-shakeable, no `eb` parameter to thread), and take arrays or varargs:

```ts
import { and, or, not, exists, coalesce, fn, asc, desc } from 'pg-prime'

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

> **AS BUILT (WS4, `09` §3.4).** All seven ship, and the two `where`s are two methods on purpose:
> `.where()` is the **partial-index predicate** (which unique index is the arbiter — omit it against
> a partial index and PostgreSQL raises 42P10), `.whereUpdate()` is `DO UPDATE … WHERE` (whether to
> write *this* row). Calling `.where()` without a target, or `.whereUpdate()` without a
> `.doUpdate()`, is a named error rather than a silently misplaced clause. `excluded` is the target
> table's own refs under PostgreSQL's pseudo-alias, so every operator works on it —
> `set.tags.concat(excluded.tags)` above is `arrayConcat(set.tags, excluded.tags)` (fork F1).
>
> An insert's column list is the **table's declaration order**, filtered to the keys present, so
> `values({ role, email })` and `values({ email, role })` are one prepared statement and not two.

> **AS BUILT 2026-08-26 (WS5, `09` §3.5).** Relations in a `RETURNING` list work, with one
> qualification the sketch below does not show: `RETURNING` has no FROM clause, so there is nothing
> to hang a `LEFT JOIN LATERAL` on. A relation **aggregate** needs no change — a correlated
> subquery is valid there — but a relation **projection** must be asked for as
> `p.author.one(…, { strategy: 'subquery' })`, and the error names the option if it is missing.
>
> The reason this needed finding rather than assuming: `RETURNING` emits the target's own columns
> unqualified, and until WS5 that setting leaked into the correlated subquery, turning
> `comments.post_id = posts.id` into `post_id = id` — two columns of `comments`, silently counting
> zero. Well-formed SQL, no error, wrong number. `09` §3.5 finding 1.

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

> **AS BUILT (WS4, `09` §3.4).** The thresholds are exactly as written — `unnest` above
> `rows × columns > 30 000`, chunks of 5 000 — and both boundaries are pinned to the row, through a
> *one-column* insert so that `rows` is `cells` and the comparison is reachable (a three-column test
> straddles 30 000 and 30 003, and R10 M9 walked straight through it). Chunks run on one connection
> inside one `BEGIN … COMMIT`, and open none of their own inside `db.transaction(...)`.
>
> Two spellings differ from the sketch. The casts come from `codec.sqlName`, so a bulk insert of an
> `int8` column emits `::bigint[]`, not `::int8[]` (WS2's finding, and the reason Appendix A is now
> generated). And a row that omits a key the other rows set is a **named error**, not a `DEFAULT`
> and not a NULL: those are two different intentions and quietly picking one is how a bulk insert
> writes NULLs over a `defaultNow()`.
>
> `fromValues` ships in both strategies. Its `unnest` form is
> `from unnest($1::bigint[], $2::numeric[]) as "v"("id","price")` — one FROM item rather than the
> `(select * from unnest(…)) as v(…)` above, which is the same relation with one less subquery.

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

> **AMENDED 2026-08-26 — WS1 typed this (09 §3.1).** Two things the sketch above leaves open.
> **Where `cte` comes from:** `.with()` returns an executor carrying the declared CTEs, so they are
> reachable as `d.cte.recent` (an ordinary handle, usable with the ordinary `.innerJoin`), and
> `.fromCte('recent', 'r')` is the sugar that keeps the single-CTE case one chain. **How the CTE is
> modelled:** as a handle over a *synthetic one-table schema*, so `RefsAt`, `ScopeOf`, `innerJoin`,
> `leftJoin` and all ~60 operators work on it unchanged and **no** "is this alias a CTE?" conditional
> exists anywhere on the hot path. The claim in this section holds — codecs do flow through, so
> `recent.amount` still reads `string` for a `numeric` and `bigint` for an `int8` — with one measured
> limit: the *PG type class* does not flow through (`pg` is `any` on a CTE ref), so a class-gated
> operator degrades to a shape-only check there. Recovering it needs the projection record on the
> `Query` type; revisited in WS4. Pinned in `test/query/types/cte.probe.ts`.

> **AS BUILT (WS4, `09` §3.4).** `.with()` has a runtime, and the type-class limit above was
> revisited and **kept**: recovering the class needs a fourth `Query` type parameter threaded
> through every method, which is the one shape `04` §1.3 rules out. WS4 found the second
> consequence and wrote it down next to the first — an aggregate whose result type is a *function
> of* the operand's PG type cannot narrow over a CTE column, so `fn.sum(r.amount)` types as
> `string | number | bigint | null` where the same call on the base table is exactly
> `string | null`. The decoded value is exact either way.
>
> Writable CTEs work because a `CteNode` holds a `Statement` and an insert/update/delete builder's
> `toAst()` is one; a writable CTE's columns are its `RETURNING` list, with real codecs. One thing
> worth knowing and easy to get backwards: **a data-modifying CTE runs even when nothing references
> it** — PostgreSQL executes it exactly once and to completion regardless — so an unused writable
> CTE is not free. `MATERIALIZED` / `NOT MATERIALIZED` is `{ materialized: boolean }` on `.with()`.
>
> Recursive CTEs are not offered: `.with(name, f)` cannot hand `f` a handle to the CTE it is
> defining without a second signature, and no `03` §2 example needs one. The emitter already
> spells `with recursive`.

### 2.8 Set operations, window functions, subqueries

```ts
// ── set operations: shapes must match, checked at compile time
const all = db.from(users).select(({ users: u }) => ({ id: u.id, kind: lit('user') }))
  .unionAll(db.from(orgs).select(({ orgs: o }) => ({ id: o.id, kind: lit('org') })))
  .orderBy(r => asc(r.id))
  .limit(50)
// mismatch => OrmTypeError<'union branch 2 has no column "kind"'>   [built in WS1; see below]

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

> **AMENDED 2026-08-26 — WS1 built the set-op check, and *where* it resolves is load-bearing (09 §3.1).**
> The sentence is produced in **return** position — a mismatched branch makes the call resolve to
> `OrmTypeError<'…'>`, so the diagnostic lands on the next thing done with it (`.execute()`,
> `.orderBy()`, an assignment). Checking in parameter position instead was built first and measured:
> TypeScript then prints the whole `Query<…>` argument twice, once in the TS2345 headline and once in
> the "Property `[ERR]` is missing" elaboration, and a `Query` carries its entire `Schema<…>` type
> argument — **926 characters on TS 5.9.3 and 1 319 on 7.0.2**, against design/04 D9's 300. Return
> position gives 143 characters on one line, on both compilers. The branch number is a real count, so
> `a.union(b).union(c)` blames branch 3. `union` / `unionAll` / `intersect` / `intersectAll` /
> `except` / `exceptAll` all ship, and the result is a narrower `SetQuery` stage carrying only
> `orderBy` / `limit` / `offset` / `execute` — PostgreSQL applies those to the whole set-op result and
> there is no scope left to filter or join against, so they are absent rather than present-and-wrong.
> Exact text: `tools/type-errors/__golden__/setop-*.txt`.

`DISTINCT ON` ships in v1 (`.distinctOn(({posts:p}) => [p.authorId]).orderBy(…)`) — it is PG-only, extremely useful for "latest row per group", and free for us. So does row locking: `.forUpdate({ of: ['posts'], wait: 'skip locked' })`, which is what makes queue workloads possible.

> **AS BUILT (WS4, `09` §3.4).** Everything in this section ships. Three spellings differ, and the
> first is a decision rather than a detail:
>
> ```ts
> const ranked = await db.from(db.h.posts)
>   .select(({ posts: p }) => ({
>     id:    p.id,
>     n:     over(fn.rowNumber(), w => w.partitionBy(p.authorId).orderBy(desc(p.createdAt))),
>     total: over(fn.sum(p.amount), 'byAuthor'),
>     run:   over(fn.sum(p.amount), w => w
>              .partitionBy(p.authorId).orderBy(asc(p.createdAt))
>              .rows({ from: 'unbounded preceding', to: 'current row' })),
>     dense: over(fn.denseRank(), 'byAuthor'),
>   }))
>   .window('byAuthor', ({ posts: p }) => ({ partitionBy: [p.authorId], orderBy: [desc(p.amount)] }))
>   .execute()
> ```
>
> **`over(x, w)`, not `x.over(w)`** — fork F1's measurement applies unchanged (a method on an
> expression costs +105 instantiations per table where the free function costs zero), and it applies
> harder at runtime, because an `Expr` *is* a frozen AST node: `.over()` would mean a wrapper
> allocation per aggregate on the hot path. A frame offset (`{ preceding: 3 }`) is emitted as a
> literal, never a parameter: it is part of the plan's shape, and parameterising it would re-cost
> the plan for every distinct window size.
>
> **`lit('user')` is `val('user', codecs.text)`.** `lit` takes non-strings only (D7 — a string in a
> query position is always a parameter), so the set-op example above could not have compiled.
>
> **A one-column subquery is still a record**: `.select(({ bans: b }) => ({ userId: b.userId }))`,
> not the bare-ref shorthand. One mechanism, and `.asScalar()` reads the result codec off it. It
> refuses a projection that is not exactly one column.
>
> `forUpdate({ wait: 'skip locked' })` is proven on tier 2 against PostgreSQL 17.11 with two real
> backends (`test/pg/locking.test.ts`): `skip locked` returns the other rows immediately, `nowait`
> raises `55P03`, and the default blocks until the holder commits. It cannot be tested on PGlite,
> which multiplexes every connection onto one backend and would pass a completely broken
> implementation.

> **AS BUILT 2026-08-27 — the two `distinct` rules this section did not state (`09` §3.7 follow-up).**
> The WS7 builder fuzzer found both on its first live runs. A builder that holds the projection, the
> ORDER BY and the DISTINCT clause at once must never emit a statement it can know PostgreSQL will
> reject; Kysely, Drizzle and SQLAlchemy pass these through, and Django documents the first rule and
> still lets the database fail.
>
> **1. The emitted `ORDER BY` leads with the `DISTINCT ON` expressions, in their order.** PostgreSQL
> requires the `DISTINCT ON` list to match the *initial* `ORDER BY` expressions (`42P10 SELECT
> DISTINCT ON expressions must match initial ORDER BY expressions`) and `.orderBy()` **appends**, so
> `.distinctOn(a).orderBy(desc(b))` used to compile cleanly and fail at execute. The two clauses are
> not in conflict — "the first row of each `a`, and among those the greatest `b`" is what `order by
> a, b desc` means and what "latest row per group" means — so `alignDistinctOn`
> (`src/compile/hoist.ts`) reconciles them at compile time. A list that already leads with the keys
> is returned **unchanged and by reference**, direction and `nulls` placement intact, so the goldens
> of every query written the correct way stand; a partial match keeps the items that matched and
> inserts only what is missing; keys the caller ordered by in a different order are emitted first
> and the caller's list follows *in full*, deliberately duplicating rather than discarding a clause
> the caller wrote (a repeated ORDER BY item is a no-op for the server). With no `.orderBy()` at all
> the keys become the ordering, which costs the sort `DISTINCT ON` was going to do anyway. "Same
> expression" is the CSE digest of `03` §2.3 point 6, reused rather than re-invented, and it runs
> after the hoist so a `distinctOn(u.posts.count())` compares the `"_r0"."v"` the emitter will
> actually print.
>
> **2. `.distinct()` with an `ORDER BY` the projection does not carry is refused at compile time.**
> `42P10 for SELECT DISTINCT, ORDER BY expressions must appear in select list`. Here there is no
> reconciliation, and the asymmetry with rule 1 is the point: widening the projection would change
> the row shape the caller declared *and* — `distinct` being a set operation — which rows come back,
> so every repair is a different query. `.compile()` throws a `BuilderError` naming the offending
> expression in its own SQL and the two fixes ("order by a selected column, or add it to
> `select()`"), one line, 216 characters, well inside `04` D9's 300. Both lists are read
> post-`planSelect`, so a `nest({...})` has already flattened into its leaf columns; an expression
> the digest cannot describe — a `sql` fragment, a volatile call — is **allowed through**, because
> `null` means unknown and a false rejection would refuse a query PostgreSQL accepts.
>
> **No type-level guard.** Deciding this in the type system needs the *expressions* of the
> projection, not its row type, and `Query<S, O, N>` carries only the latter — `O` is
> `{ id: bigint }`, which cannot say which column produced it. Carrying the projection record is the
> fourth type parameter §2.3's GROUP BY amendment already rejected by measurement, so the check is
> the runtime one and nothing was added to `bench/types`.
>
> **`union` / `intersect` / `except` compare rows too**, so their branches carry the same flag as a
> `select distinct` and it inherits downwards: in `(a union all b) except c` the `except` compares
> what the inner `union all` produced, and all three branches switch. `… all` never does. §2.3's AS
> BUILT note of the same date has the json/jsonb half.

### 2.9 PG operator vocabulary

> **AMENDED 2026-08-26 — fork F1 decided against methods (09 §3.0).** Operators are **free
> functions** (`ilike(u.email, '%@acme.com')`, per 04 §2.2), not methods. Measured, the methods
> cost **exactly zero** per query — and so do gated free functions — but **+105 instantiations per
> table**, one-time, which nets to **+3.0 %** across a whole program at both 2 and 8 queries per
> table. Methods do emit a 43 % smaller operator `.d.ts` (4 462 B vs 7 853 B), but that tiebreaker
> ranks below instantiation count and neither figure threatens Appendix B's 400 KB.
>
> **Everything else in this section stands, and one part of it is now mandatory rather than
> incidental: the type-class gate.** A free-function surface typed the obvious way loses exactly
> the defect this section exists to fix — of seven nonsense operator/column pairings, **four
> compiled** (`jsonContains` on `text`, `hasKey` on `int4`, `@@` on `text`, a range operator on
> `timestamptz`). So each class-specific free function takes a *class-gated* operand whose
> `[META]['pg']` must be in that class, which is 04 §2.2's own "operand selected from `M['pg']` via
> a small per-operator table" made structural. `src/query/ops-free.ts` ships the gates.
>
> Two accepted DX costs: `contains` must be spelled `arrayContains` / `jsonContains` /
> `rangeContains`, and an import list cannot narrow to the column's class the way `u.email.` would
> have. One open item for WS3: the gate reads `[META]`, which only a `Ref` carries, so a
> `` sql`…`.as(codec) `` fragment cannot yet be a class-specific operand — a method surface has the
> identical hole, so it is not a cost of this decision, but it must be closed.

Operators are **methods on refs, gated by the codec's type class**, not a stringly-typed operator union. This fixes the Kysely defect documented in kysely.md §5.2(3): Kysely types the right-hand operand from the *column's* type rather than the *operator's* semantics, so `jsonb ? key` (which takes `text`), `tsvector @@ tsquery`, and range `&&` are all typed wrong or accidentally right. A per-operator operand table is finite and writable for one dialect — so we write it, once, as method signatures.

Type-class dispatch is a single indexed access, which keeps the type cost flat:

```ts
type Ref<C extends Codec> = BaseOps<C> & OpsByClass<C>[TypeClassOf<C>]
```

> **REGENERATED 2026-08-26 (WS3).** The table below is produced from `src/query/ops.manifest.ts`
> by `packages/pg-prime/test/query/ops-table.test.ts`, which fails CI if the two disagree. Edit the
> manifest, then run `PG_PRIME_UPDATE_DOCS=1 pnpm test -- ops-table`. Two corrections it forced on the
> hand-written version it replaced: `avg` is **not** always `numeric` (it is `float8` for `float4`
> and `float8` operands), and the json/jsonb accessors are the *only* members of that row that
> accept a `json` operand — everything else there is jsonb-only.

<!-- ops-table:start — generated from src/query/ops.manifest.ts; do not edit -->

| Class | Function | SQL | Result codec |
|---|---|---|---|
| **all** | `eq` | `a = $n` | bool |
|  | `neq` | `a <> $n` | bool |
|  | `lt` | `a < $n` | bool |
|  | `lte` | `a <= $n` | bool |
|  | `gt` | `a > $n` | bool |
|  | `gte` | `a >= $n` | bool |
|  | `isNull` | `a is null` | bool |
|  | `isNotNull` | `a is not null` | bool |
|  | `isDistinctFrom` | `a is distinct from $n` | bool |
|  | `isNotDistinctFrom` | `a is not distinct from $n` | bool |
|  | `between` | `a between $n and $n` | bool |
|  | `inList` | `a = any($n)  ·  [] ⇒ false` | bool |
|  | `notInList` | `a <> all($n)  ·  [] ⇒ true` | bool |
|  | `inQuery` | `a in (select …)` | bool |
|  | `coalesce` | `coalesce(a, $n)` | a's codec |
|  | `cast` | `a::<codec.sqlName>` | the given codec |
|  | `val` | `$n` | the given codec |
| **text / citext** | `like` | `a like $n` | bool |
|  | `ilike` | `a ilike $n` | bool |
|  | `notLike` | `a not like $n` | bool |
|  | `notILike` | `a not ilike $n` | bool |
|  | `startsWith` | `a ^@ $n` | bool |
|  | `regex` | `a ~ $n` | bool |
|  | `iregex` | `a ~* $n` | bool |
|  | `notRegex` | `a !~ $n` | bool |
|  | `notIRegex` | `a !~* $n` | bool |
|  | `similarTo` | `a similar to $n` | bool |
|  | `concat` | `a \|\| $n` | text |
| **array `T[]`** | `overlaps` | `a && $n` | bool |
|  | `arrayContains` | `a @> $n` | bool |
|  | `arrayContainedBy` | `a <@ $n` | bool |
|  | `has` | `$n = any(a)` | bool |
|  | `hasAll` | `a @> $n` | bool |
|  | `arrayLength` | `array_length(a, 1)` | int4 |
|  | `arrayConcat` | `a \|\| $n` | a's codec |
|  | `anyOf` | `any(a)` | a's element codec |
|  | `allOf` | `all(a)` | a's element codec |
| **json / jsonb** | `jsonGet` | `a -> $n` | a's json codec |
|  | `jsonGetText` | `a ->> $n` | text |
|  | `jsonPath` | `a #> $n` | a's json codec |
|  | `jsonPathText` | `a #>> $n` | text |
|  | `jsonContains` | `a @> $n` | bool |
|  | `jsonContainedBy` | `a <@ $n` | bool |
|  | `hasKey` | `a ? $n` | bool |
|  | `hasAnyKey` | `a ?\| $n` | bool |
|  | `hasAllKeys` | `a ?& $n` | bool |
|  | `jsonPathExists` | `a @? $n` | bool |
|  | `jsonPathMatch` | `a @@ $n` | bool |
|  | `jsonConcat` | `a \|\| $n` | jsonb |
|  | `jsonDelete` | `a - $n` | jsonb |
|  | `jsonDeletePath` | `a #- $n` | jsonb |
| **numeric / int** | `add` | `a + $n` | a's codec |
|  | `sub` | `a - $n` | a's codec |
|  | `mul` | `a * $n` | a's codec |
|  | `div` | `a / $n` | a's codec |
|  | `mod` | `a % $n` | a's codec |
|  | `abs` | `abs(a)` | a's codec |
| **tsvector** | `matches` | `a @@ q` | bool |
|  | `tsRank` | `ts_rank(a, q)` | float4 |
|  | `tsRankCd` | `ts_rank_cd(a, q)` | float4 |
| **range** | `rangeOverlaps` | `a && $n` | bool |
|  | `rangeContains` | `a @> $n` | bool |
|  | `rangeContainedBy` | `a <@ $n` | bool |
|  | `strictlyLeft` | `a << $n` | bool |
|  | `strictlyRight` | `a >> $n` | bool |
|  | `adjacent` | `a -\|- $n` | bool |
|  | `rangeUnion` | `a + $n` | a's codec |
|  | `rangeIntersection` | `a * $n` | a's codec |
|  | `rangeLower` | `lower(a)` | a's subtype |
|  | `rangeUpper` | `upper(a)` | a's subtype |
| **net (inet / cidr)** | `containsNet` | `a >> $n` | bool |
|  | `containedByNet` | `a << $n` | bool |
|  | `overlapsNet` | `a && $n` | bool |
| **vector (pgvector)** | ~~`l2`~~ | `a <-> $n` | float8 |
|  | ~~`cosine`~~ | `a <=> $n` | float8 |
|  | ~~`innerProduct`~~ | `a <#> $n` | float8 |
|  | ~~`l1`~~ | `a <+> $n` | float8 |
|  | ~~`hamming`~~ | `a <~> $n` | float8 |
|  | ~~`jaccard`~~ | `a <%> $n` | float8 |
| **boolean / ordering** | `and` | `(a and b and …)  ·  () ⇒ true` | bool |
|  | `or` | `(a or b or …)  ·  () ⇒ false` | bool |
|  | `not` | `not a` | bool |
|  | `isTrue` | `a is true` | bool |
|  | `isNotTrue` | `a is not true` | bool |
|  | `isFalse` | `a is false` | bool |
|  | `isNotFalse` | `a is not false` | bool |
|  | `exists` | `exists (select …)` | bool |
|  | `notExists` | `not exists (select …)` | bool |
|  | `asc` | `a asc [nulls first\|last]` | — |
|  | `desc` | `a desc [nulls first\|last]` | — |
| **aggregates & full text** | `fn.count` | `count(*) · count(a)` | int8 |
|  | `fn.sum` | `sum(a)` | int2/int4 ⇒ int8 · int8/numeric ⇒ numeric · float4 ⇒ float4 · float8 ⇒ float8 |
|  | `fn.avg` | `avg(a)` | float4/float8 ⇒ float8 · everything else ⇒ numeric |
|  | `fn.min` | `min(a)` | a's codec |
|  | `fn.max` | `max(a)` | a's codec |
|  | ~~`fn.rank`~~ | `rank()` | int8 |
|  | `fn.toTsvector` | `to_tsvector($n::regconfig, a)` | tsvector |
|  | `fn.toTsquery` | `to_tsquery($n::regconfig, $n)` | tsquery |
|  | `fn.plaintoTsquery` | `plainto_tsquery($n::regconfig, $n)` | tsquery |
|  | `fn.phrasetoTsquery` | `phraseto_tsquery($n::regconfig, $n)` | tsquery |
|  | `fn.websearchToTsquery` | `websearch_to_tsquery($n::regconfig, $n)` | tsquery |

Struck-through rows are declared but have no live differential yet:

- `fn.rank` — WS4 — `rank()` is legal only inside OVER (…), which the emitter does not build yet.
- `l2`, `cosine`, `innerProduct`, `l1`, `hamming`, `jaccard` — WS5 — `vector` is a pgvector EXTENSION type: per-database OID, resolveDynamic path, and not present in PGlite, so neither a codec nor a live differential exists yet.

<!-- ops-table:end -->

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

> **AS BUILT (WS3), and how the claim above is kept honest.** Every row of the table is executed as
> `select <expr>` against a live server and its `RowDescription.dataTypeID` is compared to the
> operator's own result codec — so the exactness is *confirmed*, not asserted. That is how the two
> corrections above were found, and how `ts_rank` was found to be `float4` (`real`) rather than
> `float8`. A second differential runs each predicate against hand-written SQL over a seeded
> fixture and compares id sets, with an expected row count so a two-sided empty result cannot pass.
> Both are table-driven from the same manifest; see `09` §3.3.
>
> Three notes on the vocabulary as shipped:
>
> - **`contains` is spelled three ways** (`arrayContains` / `jsonContains` / `rangeContains`), the
>   accepted DX cost of `09` §3.0's F1 decision.
> - **`json` and `jsonb` are separate gates.** The four accessors take either; the other ten
>   operators are jsonb-only, because `json @> json` is not an operator PostgreSQL has. The
>   accessors also return the operand's *own* json codec — `json -> k` is OID 114, `jsonb -> k` is
>   3802.
> - **`val(value, codec)` was added.** Without it a class-gated operator has no literal operand: a
>   value in a `sql` hole is an untyped `$n` and `.as(codec)` types the fragment's result, not the
>   hole, so `int4range && $1` had no unique resolution.
>
> `eq(a, null)` is a **compile error** and a runtime `NullOperandError`, not a rewrite to `IS NULL`
> — a rewrite would make the emitted SQL depend on a runtime value, so one call site would mint two
> prepared statements. `isNull(a)` and `isDistinctFrom(a, b)` say each of the two things a caller
> might mean. Reasoning in `09` §3.3.

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
const lowered = sql`lower(${u.email})`.as(codecs.text)      // TypedFragment<string, 'text'>
const total   = sql`sum(${p.amount})`.as(codecs.numeric)    // TypedFragment<string, 'numeric'>
const hit     = sql`${p.body} @@ ${q}`.as(codecs.bool)      // TypedFragment<boolean, 'bool'>
```

> **AS BUILT (WS3).** `.as(codec)` returns a `TypedFragment<T, P>`, where `P` is the **codec's own
> `name`** — the same string a column's `ColMeta['pg']` carries, because `metaOf` resolves a
> column's codec by `registry.byName(ddl.pgType)`. That second parameter is what closes the one
> item `09` §3.0 left open when fork F1 was decided: §2.9's operator gates read `[META]['pg']`,
> which only a `Ref` carried, so a fragment could not be a class-specific operand. Now it can, and
> a method surface would have had the identical hole, so the closure is the design's, not the arm's.
>
> Three phantom slots, none present at runtime: `[OUT]` (so a typed fragment is `Projectable`),
> `[META].pg` (the gate), `[SRC]` (so it is an `Expr` and composes per §3.3). A **bare**
> `` sql`…` `` still has none of them, which is `04` §2.2's "you physically cannot put it in a
> projection without choosing a codec", unchanged.
>
> `asUnsafe<T>()` returns `TypedFragment<T, 'unknown'>`: the same shape with the type-class slot
> deliberately poisoned, since `'unknown'` is in no gate. The value still decodes correctly by OID.
>
> Not `sqlName`, which `09` §3.0 guessed: `int4`'s `sqlName` is `'integer'` and `int8`'s is
> `'bigint'`, and neither is in the `NumPg` gate.

**The codec is verified, not trusted.** In dev mode (`NODE_ENV !== 'production'`, or `{ assertShape: true }`) the executor compares each declared codec's OID against the `dataTypeID` the server reported in `RowDescription` — metadata `pg` already hands us and which our `PgResult` is required to carry (pg-drivers.md §4.4). A mismatch throws:

```
CodecMismatchError: column "total" was declared as codec `int4` (oid 23)
but Postgres returned `numeric` (oid 1700).
  at src/reports.ts:42  sql`sum(${p.amount})`.as(codecs.int4)
Fix: use codecs.numeric, or cast in SQL.
```

That single check converts the entire class of "the type says `number`, production says `'1234.56'`" bugs into a test failure. No competitor does it, and it costs one integer comparison per column per query in dev.

**Untyped fragments still decode correctly.** A `Fragment<unknown>` used in a projection decodes *dynamically* via the OID registry using the `RowDescription`. So the escape hatch is honest at the type level (`unknown` forces acknowledgement) and *correct* at the value level (you still get a `Date`, not a string). Kysely gives you `unknown` and the driver's guess; we give you `unknown` and our decoder.

> **AS BUILT (WS6, `09` §3.6).** Both halves ship, with four notes.
>
> **The message** is the block above with one substitution: the third line is the captured stack
> frame (`  at /path/reports.ts:42:19`), not a re-rendering of the expression, because there is no
> way to recover the *text* of `` sql`sum(…)`.as(codecs.int4) `` at runtime. The file and line —
> the part that answers "where do I go and fix it" — survive. The frame is captured in `.as()`
> with `new Error().stack`, **outside production only** and once per `.as()` call (never per row
> and never per execution), the same mechanism and the same gate `sql.unsafeRaw` already used.
>
> **A second variant** exists, because the same mismatch on a *schema column* is a different
> mistake with a different fix: the caller's source is innocent and the database has moved. It
> names the column and says so —
> `  "users"."created_at" is schema drift: the database no longer matches the pgTable(...)
> declaration.` — and its `Fix:` line points at the migration rather than at a codec.
>
> **What is skipped, and why:** a statement with no field metadata (nothing to compare against);
> a codec with no OID (an enum before `resolveDynamic` — comparing against nothing would fire on
> every query touching one); an untyped fragment (it declares nothing, so it cannot be wrong); and
> a relation / `nest` column, which is checked against `json` **or** `jsonb` only, because the
> decoder does not care which and the declared variant is not in the plan. A `nest({...})` group
> *is* walked into: its members are ordinary columns at their own row positions.
>
> **`richFieldMetadata: false` is deliberately NOT a skip condition**, which deviates from `09`
> WS6's own test list. That capability governs `dataTypeModifier` / `tableID` / `columnID`, not
> `dataTypeID`; gating on it would silently disable the check on PGlite, where WS6's exit gate
> requires the lying-codec test to be green. The gate is `fields.length === 0`.
>
> **The dynamic path** resolves any column whose plan carries `unknownCodec` against
> `registry.forOid(dataTypeID)` at execute time, and an OID with no codec keeps the raw wire text
> (the same answer `planFor` gives — at runtime an unregistered type must not take the query
> down). The decode-plan memo is keyed on the resolved OID **signature** as well as the `Compiled`,
> so a fragment whose type changed after a migration cannot keep decoding with the old codec.

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

> **AS BUILT 2026-08-26 (WS5, `09` §3.5).** `RelationMeta` ships as **two** structures, split at
> the same seam `metaOf` already draws. The interface above carries `ColumnMeta`, and therefore
> codecs, and therefore a registry — but an enum's OID is per-database (`02` §4.6), so binding one
> at `defineSchema` time would freeze whatever the default registry held before `resolveDynamic`
> ran. So `ResolvedRelation` (`src/schema/relations.ts`) resolves *structure* — target table,
> column keys, junction, defaults — once and eagerly at definition time, where a mistake is a
> thrown sentence; `src/query/relations.ts` resolves *codecs* per registry, where the generation
> counter can invalidate them.
>
> `from`/`to` are **mandatory**. Inference from a foreign key is not deferred, it is not currently
> possible: the column DSL has no `.references()`, so there is no foreign key in a `pgTable(...)`
> for a resolver to read. The error names the exact call to write.
>
> `defineSchema` throws on five things, all at definition time so the failure lands on the import
> of the schema file rather than on the first query that touches the relation: hard ask #1's
> name collision, a relation pointing at a table the registry does not have, a missing `from`/`to`,
> a `from`/`to` arity mismatch, and a column reference belonging to the wrong table.
>
> One row of the table below reads differently in practice. `.count()` / `.sum(f)` are described as
> "a correlated scalar subquery", and that is what they *are* — but §2.3's own compiled SQL shows
> them hoisted into laterals, and §2.3 point 6 needs a named value to share. The subquery is what
> goes *inside* the lateral; both statements are true.

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

> **AS BUILT 2026-08-26 (WS5, `09` §3.5).** Form (b)'s `u.posts.all()` ships; `...u.$all` does not
> — a projection still names its columns, or reaches for `selectAll(alias)` at the top level. The
> `Loaded` claim itself is what matters here and it holds unchanged: a projection that loaded
> `posts` is assignable to `Loaded<typeof users, 'posts'>` with no cast, no `Collection` and no
> `Ref`, which is pinned by `test/query/types/relations.probe.ts` passing a builder result straight
> into a function that demands the load state.

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

> **AS BUILT (WS2, 2026-08-26 — `design/09` §3.2).** The shipped interface is
> `Codec<TIn, TOut>` in `src/codec/types.ts`, and it differs from this sketch in five ways, four of
> them anticipated by `09` WS2's contract:
>
> - `pgType` is **`sqlName`**, and it is also what the DDL emitter uses. One consumer in the
>   compiler: the first-row `::type` cast of a multi-row `VALUES`.
> - `oid` is `number | undefined` — a user type's OID is resolved per physical database
>   (`02` §4.6), so it is `undefined` until `resolveDynamic`. A second field, **`paramOid`**, is
>   the OID sent in `Parse`; it differs from `oid` where we deliberately widen (domains → 705).
> - `decodeText`/`decodeJson` take a **`CodecContext`** (typmod, registry, session parameters,
>   column name). `buildDecoder(shape, ctx)` binds it once per plan, never per row.
> - `TIn` and `TOut` split. The **AST does not carry the split**: every node slot is
>   `AnyCodec = Codec<never, unknown>`, because nothing reads a node's TypeScript type. `TIn`/`TOut`
>   discrimination lives in `src/query/types.ts`.
> - **`jsonEncode` has two members, not three.** The custom `(e: Expr) => Expr` wrapper above is
>   **not implemented and will not be**: a codec that builds compiler AST inverts the layering
>   (`src/compile` depends on `src/codec`), and every case it could express is already a codec with
>   `jsonEncode: 'text'` whose `decodeJson` parses the text spelling — which is how `int8`,
>   `numeric` and every array of them work. If a case ever needs more, the cheap extension is a
>   `{ cast: string }` member, not a function.
>
> The seam that produces a `ColumnMeta` from a `pgTable` column is `metaOf` in
> `src/query/meta.ts`, memoised per `(registry, table)`. It is also where the pre-quoted identifiers
> demanded two paragraphs down are computed.

**Agent 05 — relations.** `RelationMeta` as specified in §4.1; relation/column name collisions rejected at definition time; composite keys as arrays; m2m via `through`. Also: columns must expose a pre-quoted identifier string computed once at schema-build time (the compiler must never quote a schema identifier on the hot path).

**Agent 06 — driver.** `execute(sql, params, { rowMode: 'array', name? })` returning `{ rows: unknown[][], fields: PgField[], rowCount }`, with `fields[].dataTypeID` **required** (it powers §3.2's assertion and dynamic decode) and `describe()` optional-but-expected (it powers the description cache in §1.4(c)). Default statement mode unnamed; `{ statement: 'named' }` is our opt-in pass-through.

**Transactions (whoever owns the session layer).** The query layer targets an `Executor` interface — `db` and `tx` both implement it — and the *type-level* prevention of using the outer `db` inside a transaction scope (Drizzle's #1 footgun, drizzle.md §2.3) lives there, not here. What we owe that layer: `Compiled.meta.writes`, so a read-only executor can reject a mutating statement at both the type level and runtime.

---

## Appendix A — Compiled SQL reference

Every example in §2 with its exact output.

> **REGENERATED 2026-08-26 (WS4).** This block is no longer hand-written: it is produced by
> `test/query/appendix-a.test.ts`, which builds each statement through the public API and
> compares the compiled SQL byte for byte. `PG_PRIME_UPDATE_DOCS=1 pnpm test -- appendix-a`
> rewrites it. The compiler is pure, so no database is involved.

<!-- appendix-a:start — generated from test/query/appendix-a.test.ts; do not edit -->

```sql
-- §2.1 select/where/order/limit
select "users"."id" as "id", "users"."email" as "email", "users"."created_at" as "joined"
from "public"."users" as "users"
where ("users"."deleted_at" is null and "users"."role" = any($1))
order by "users"."created_at" desc, "users"."id" asc
limit $2
-- params: ["{admin,owner}","20"]

-- §2.5 upsert with partial-index predicate + EXCLUDED + DO UPDATE WHERE
insert into "public"."users" ("email", "name", "role") values ($1, $2, $3)
on conflict ("email") where "users"."deleted_at" is null
do update set "name" = "excluded"."name", "tags" = "users"."tags" || "excluded"."tags", "updated_at" = now()
where "users"."updated_at" < "excluded"."updated_at"
returning "id" as "id"
-- params: ["a@b.c","Ada","admin"]

-- §2.6 bulk insert, unnest strategy (2 params for any row count)
insert into "public"."events" ("kind", "at")
select * from unnest($1::text[], $2::timestamptz[])
-- params: ["{click}","{\"2026-01-01 00:00:00.000Z\"}"]

-- §2.6 bulk update from values
update "public"."products" as "products"
set "price" = "v"."price", "updated_at" = now()
from (values ($1::bigint, $2::numeric), ($3, $4)) as "v"("id", "price")
where "products"."id" = "v"."id"
-- params: ["1","9.99","2","4.50"]

-- §2.7 writable CTE feeding an INSERT … SELECT
with "moved" as (
  delete from "public"."staging" as "staging"
  where "staging"."ready"
  returning "payload" as "payload", "at" as "at"
)
insert into "public"."live" ("payload", "at")
select "moved"."payload" as "payload", "moved"."at" as "at"
from "moved" as "moved"
returning "id" as "id"

-- §2.9 jsonb path as a PARAMETER (the CVE class, designed out)
select "users"."id" as "id"
from "public"."users" as "users"
where ("users"."meta" #>> $1) = $2
-- params: ["{billing,country}","DE"]
```

<!-- appendix-a:end -->

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

<!-- as-built:appendix-b -->
**AS BUILT · 2026-08-27 (design/09 WS7 · §3.7).** Every row above is now a job and a JSON budget.
The measured numbers are in `09` §3.7; this table says only *what gates what*, because a budget
nobody runs is a paragraph.

| Row | Gated by | Where it runs |
|---|---|---|
| instantiations / query, 300 tables, flat vs 80 | `bench/types/budget.json` → `schemaSizeIndependenceRatio` (1.15), measured 1.000 at 25/100/300 on TS 5.9.3 and 7.0.2 | `pnpm bench:types`, `ci.yml` job `types`, every PR |
| `tsc --noEmit`, 300 tables / 200 queries, < 8 s | `bench/types/budget.json` → `headline.checkTimeSeconds` | same |
| `.d.ts` bytes < 400 KB | `bench/types/budget.json` → `packageDtsBytes`, measured 350.1 KB | same |
| **compile time, 12-col + 2 joins + 1 nested relation, < 25 µs** | `bench/runtime/budget.json` → `compile.emitP50Us` (absolute, the emitter) **and** `compile.buildAndCompileRefRatio` + `compile.buildAndCompileBytes` (the builder chain). `bench/runtime/structure.mjs` gates §1.1's other two claims — one `join('')`, one params array — as exact integers | `pnpm bench:compile`, `ci.yml` job `types`, every PR |
| **decode throughput, 10k × 12, within 15 % of a hand mapper** | `bench/runtime/budget.json` → `decode.ratioVsUncheckedMapperP50` and `…VsCheckedMapperP50` for the default closure tree, and the same two under `decode.codegen` for the opt-in generated one (plus `decode.codegen.fractionOfClosureTree`, which fails if the flag stops being worth having), against `bench/runtime/hand-mapper.mjs`; the oracle equivalence itself is tier 0 (`test/compile/decode-oracle.test.ts`), for both builders | same |
| ident fuzz, 10k/PR · 1M nightly · 0 findings | `test/fuzz/ident-oracle.test.ts` + `test/fuzz/corpus/ident.json` | `ci.yml` job `live`/`pg` at 10k; `ci-nightly.yml` job `fuzz` at 1M |
| compiler fuzz, 10k/PR | `test/fuzz/compiler-fuzz.test.ts` + `corpus/compiler.json` | same |
| *(new)* **builder fuzz** — the same invariants through the public API, plus (e′) determinism and (f) immutability | `test/fuzz/builder-fuzz.test.ts` + `corpus/builder.json` | same |
| *(new)* nine `raw()`/`orm()` pairs, `08` §5 | `bench/runtime/budget.json` → `e2e.overheadP50/P95/P99`, per case | `ci-nightly.yml` job `bench`; `ci.yml` job `perf` on a label |

**Where the two runtime rows stand, after the 2026-08-27 perf pass** (`09` §3.7 follow-up; WS7's
own reading of them is `09` §3.7 finding 1, kept there because the before-numbers are the point):

- **compile < 25 µs** — **met**, and now from the builder chain and not only from the emitter:
  3.9–4.1 µs for `compile(ast)` and **19.8–20.2 µs** for `db.from(…)….compile()`, against
  33.7–46.0 µs before. The gate is still a *ratio* to a fixed reference workload rather than a raw
  microsecond count, because `08` §5 is right that a wall clock on a shared runner is noise.
- **decode within 15 % of a hand-written positional mapper** — **met by the opt-in
  `{ decoder: 'codegen' }` builder** (1.126–1.146× a mapper doing the codecs' own checks) and
  **missed by the default closure tree** (1.50–1.55×, from 1.55–1.65×). §1.3's AS BUILT has the
  reason the default does not change and the measurement that says the closure tree is at its
  floor. Both builders are gated; the design number is printed beside all four ratios on every run.

`08` §5's third runtime number — 200 000 simple selects/sec, which this table does not carry —
went 91k–142k to **264k–350k** best-case (200k–306k taken from the p50) in the same pass, and its
`_overDesign` waiver is deleted; `09` §3.7's follow-up records why the floor gates the best-case
figure. What
remains above design is four decode entries, each with its measurement and its reason in
`budget.json`'s `_overDesign`, which `run.mjs` fails without.
<!-- as-built:appendix-b:end -->
