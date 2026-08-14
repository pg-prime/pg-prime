# pg-orm-ts — Canonical Feature Spec

**Status:** Design round 2, decision document. Supersedes nothing; consumed by every other design doc.
**Date:** 2026-08-14
**Input:** `research/SUMMARY.md` + the six round-1 research docs (all PORT/ADAPT items cross-checked in §12).
**Fixed baseline (not re-litigated here):** PG ≥15 only · TypeScript, ESM-only, Node ≥22 · zero runtime dependencies (structural driver adapter, `pg` as sole v1 adapter) · TS-code-as-schema with inference, no codegen · no Unit of Work / identity map · one unified query builder where relation nesting is a projection option (LATERAL + `json_agg`) · ORM-owned codecs end-to-end · migrations = TS schema → catalog diff → versioned SQL + fingerprinted plan, up-only, lock-safety rails · near-raw-driver performance bar.

---

## 1. Positioning

**pg-orm-ts is for TypeScript teams who run PostgreSQL in production, already know SQL, and treat schema change as an operational event rather than a build step.** It is not for people who want to be insulated from their database — it is for people who want their database's full surface *inside* the type system and inside one migration path. Five things differentiate it from Drizzle, Prisma, and MikroORM, and each one is structurally unavailable to a multi-dialect tool: **(1) the whole Postgres DDL surface is managed** — triggers, functions, domains, composite types, partitions, exclusion constraints, RLS policies, ranges, generated columns — so no real app needs a second, unmanaged migration path (Drizzle models none of these; Prisma's backlog on `CHECK` alone is 6.7 years); **(2) an operations-grade migration engine** — fingerprinted plans that refuse to apply against a drifted database, `pg_advisory_xact_lock`, hazard linting, and *lock-aware generation* that emits `CREATE INDEX CONCURRENTLY` / `NOT VALID` + `VALIDATE` rather than merely warning about the unsafe form, plus `migrate verify` and `migrate baseline`, which no bundled migrator ships; **(3) one query API in which relation nesting is a projection option**, so aggregates, window functions and CTEs compose with nested results — closing the seam that Drizzle's two disjoint APIs leave open and nobody has claimed; **(4) end-to-end owned type codecs** from schema to wire to result, so `numeric`, `timestamptz`, `int8`, enums, domains and composites decode identically everywhere and `DATE` never shifts a day — a guarantee a dialect-neutral core structurally cannot make; and **(5) relation load-state in the types** (`Loaded<T, Hint>`) sitting on a Kysely-grade expression type system — the two best type ideas in the ecosystem, which have never shipped in the same library — at zero runtime dependencies and near-raw-`pg` latency.

**The one-sentence version:** *Drizzle's philosophy without the multi-dialect tax, Prisma's type ergonomics without codegen, and a migration engine a DBA would actually sign off on.*

---

## 2. How to read the tiers

| Tier | Meaning | Rule |
|---|---|---|
| **v1** | Ships in 1.0. A real production app can adopt on this alone. | Every v1 row has a one-line acceptance criterion. Nothing ships to 1.0 without it. |
| **v1.x** | Fast-follow, 1.x minor releases. Additive, no breaking change required. | Must be *designed for* in v1 (API slot reserved) but not implemented. |
| **v2 / backlog** | May require breaking change, a new subsystem, or unproven demand. | Not on the 1.0 critical path. Not promised. |
| **never** | Explicit anti-feature. | Has a rationale. Saying no here is the product. |

**No preview flags.** Prisma has eight, several 2–3 years old. A feature is in a released version or it does not exist. The tier list is the roadmap; the roadmap is not a promise machine.

---

## 3. Schema definition

TS-code-as-schema, compiled to a canonical **schema IR** that migrations, introspection, codecs, the query compiler and all tooling read. Two authoring lanes feed the same IR: the **typed DSL** (structurally diffed) and a **`sql/` repeatable-object lane** (hash-based re-apply, participates in desired state, ordered in the dependency graph). Every IR object carries a provenance tag: `managed` | `unmanaged` | `external`.

> **The v1 lane decision, stated plainly.** Structured diffing of functions, triggers, views and policies is the long tail that broke MikroORM (phantom enum diffs), Prisma (phantom partial-index migrations) and Drizzle (enum ordering, still broken in 1.0 beta). In v1 those objects are **managed but not structurally diffed** — they live as hashed `sql/` files inside the desired-state model, get topologically ordered, get drift-detected, and get re-applied when their hash changes. That is strictly more than any competitor offers, it is honest, and it converts research risk #3 from an open-ended correctness project into a bounded one. Structured diffing for these object kinds arrives in v1.x once `migrate verify` has been green on real schemas for a release cycle.

| Feature | Tier | Acceptance criterion (v1: "done means…") |
|---|---|---|
| `defineTable` fluent column builders, chained `.notNull().default().primaryKey()` | **v1** | A 40-column table compiles with full autocomplete; column order in the IR is stable and deterministic. |
| `$inferSelect` / `$inferInsert` / `$inferUpdate` on every table | **v1** | The three shapes are derivable from a table value with no import of a generated file. |
| `.$type<T>()` cast escape hatch (jsonb, branded ids) | **v1** | `jsonb().$type<Config>()` narrows select/insert/filter without affecting the emitted DDL. |
| Extra-config **array** form: `(t) => [index(...), check(...), unique(...)]` | **v1** | Table-level objects are declared in one array; the deprecated object form does not exist. |
| Name decoupling: per-column `.name('first_name')` + a single-source, type-aware naming strategy (`snakeCase`) | **v1** | A camelCase TS schema maps to a snake_case DB with one config line; the mapping is visible in types, not applied by a runtime plugin. |
| Full PG scalar column set incl. `numeric`, `int8`, `uuid`, `bytea`, `inet`, `citext`, `interval`, `money`, `bit`, `xml` | **v1** | Every type in the v1 codec table (§4) has a builder, an encode, a decode, and a round-trip test. |
| Arrays (incl. multi-dim), `json`/`jsonb`, `tsvector`/`tsquery`, ranges + multiranges | **v1** | `int4range`, `tstzrange`, `text[]` round-trip through insert → select with exact TS types. |
| Native `pgEnum` (real PG enum type, not a lying string union) | **v1** | Enum values are a TS union *and* a `CREATE TYPE`; a value outside the union is a compile error and a DB error. |
| Primary keys, composite PKs, unique constraints, FKs with `onDelete`/`onUpdate` declared once at the relation | **v1** | A bidirectional FK is declared in one place and both sides' types follow. |
| `CHECK` constraints | **v1** | Expressible in the DSL, emitted in DDL, diffed, and round-tripped by `pull`. |
| `EXCLUDE` constraints (with operator + `WHERE`) | **v1** | A `tstzrange` overlap exclusion constraint is declarable and diffable. |
| Indexes: partial (`WHERE`), expression, opclass, `USING <method>`, `NULLS NOT DISTINCT`, `.concurrently()` | **v1** | All five index modifiers appear in the DSL, DDL, and diff; `.concurrently()` forces `txmode none` in the generated migration. |
| Generated columns (`GENERATED ALWAYS AS … STORED`) | **v1** | Un-insertable and un-updatable at the type level (`never` erases the key), correct DDL. |
| Identity / serial / sequences (`GENERATED … AS IDENTITY`, `defineSequence`) | **v1** | Identity columns are optional-on-insert; `GENERATED ALWAYS` is a compile error on insert. |
| Schemas / namespaces as a first-class typed concept | **v1** | `defineSchema('billing')` qualifies tables in types, in SQL, and in the diff; no `search_path` guessing. |
| `COMMENT ON` for tables/columns/types | **v1** | Comments round-trip both directions and appear in `pull` output. |
| Extensions (`CREATE EXTENSION`) — declared, version-tracked, ordered ahead of dependents | **v1** | `pgcrypto`/`vector` declared in schema is created before the objects that use it; never dropped by diff. |
| Ownership markers: `managed` / `unmanaged` / `external` per object | **v1** | An object marked `external` is never emitted, never dropped, and never raises a drift alarm. |
| **Catalog completeness check**: anything in `pg_catalog` we don't model is a diagnostic, never a silent drop | **v1** | `pull` and `diff` list unmodelled objects by kind and count; the exit is non-zero only if configured to be. |
| Views + materialized views as **typed read-only entities** (DDL body via `sql/` lane, `REFRESH` helper) | **v1** | `defineView` yields a queryable entity with no insert/update/delete method; `insertInto(view)` is a compile error. |
| Triggers, functions/procedures, RLS policies, roles/privileges, domains, composite types, partitions — via the `sql/` repeatable lane | **v1** | Declared in `sql/*.sql`, hashed, topologically ordered, re-applied on hash change, reported in drift. |
| Raw `sql/` DDL escape hatch compiled into the same IR + dependency graph | **v1** | A hand-written `CREATE FUNCTION` is ordered after its table and before its trigger, automatically. |
| `definePgType()` codec/extension registration API (Prisma-Next descriptor shape, one package) | **v1** | A third party can add `vector(1536) → Vector<1536>` with encode/decode/typeName/DDL and zero forks. |
| pgvector as the reference extension pack (column + index helpers, `<->`/`<=>` operators) | **v1** | `vector(1536)` column + HNSW index + KNN order-by works end to end and is our extension-API proof. |
| **Structured diffing** for views, matviews, functions, triggers, policies, domains, composites | **v1.x** | — |
| RLS policies + roles/privileges as first-class typed DSL objects (`definePolicy`) | **v1.x** | — |
| Declarative table partitioning (partitioned parent + partitions in the DSL) | **v1.x** | — |
| PostGIS extension pack (geometry/geography + GiST helpers) | **v1.x** (community-eligible) | — |
| Embeddables — object-mapped `jsonb` sub-shapes (JSON mode only) | **v1.x** | — |
| Per-table prefixing / multi-tenant schema fan-out | **v2** | — |
| Publications / subscriptions (logical replication) | **v2** | — |
| Custom `.prisma`-style DSL + parser + LSP | **never** | Structurally *creates* the feature backlog; TS gives us JSON types, generics and refactoring for free. |
| Decorators + `reflect-metadata` + `ts-morph` metadata provider | **never** | Needs `experimentalDecorators`, a runtime polyfill, and breaks under SWC/Babel. MikroORM itself demoted it in v7. |
| `EntitySchema`-style second authoring surface | **never** | Fully redundant with the builder; two surfaces means two diff paths. |
| `text({enum:[…]})` with no DB-side constraint | **never** | A TypeScript union the database doesn't enforce is a lie. Emit a real enum or a `CHECK`. |
| Polymorphic associations / STI / TPT inheritance | **never** | Large surface, small audience, disproportionate diffing complexity. Discriminator + `jsonb` covers the real cases. |

---

## 4. Type system & codecs

The type architecture is Kysely's, ported wholesale and fixed in six places. Codecs are ours, unconditionally: we install our own OID→parser table via the adapter and **never** call the global `pg.types.setTypeParser`.

| Feature | Tier | Acceptance criterion |
|---|---|---|
| `ColumnType<Select, Insert, Update>` phantom triple | **v1** | One column declaration yields three operation-specific types with zero runtime cost. |
| `Generated<T>` / `GeneratedAlways<T>` / `JsonColumnType<T>` aliases | **v1** | `GeneratedAlways` makes the key un-insertable via `never`-erasure, verified by a type test. |
| `Selectable` / `Insertable` / `Updateable` projections, nullable → optional derivation | **v1** | Optionality falls out of the insert type; nothing is declared twice. |
| Tuple-wrapped non-distributive conditionals (`[T] extends [X]`) | **v1** | Enum-typed columns do not distribute; a regression test locks this in. |
| `DrainOuterGeneric`-style instantiation flattening | **v1** | The reference schema (§11) does not hit TS2589 and stays inside the instantiation budget. |
| Readable type errors (`PgOrmTypeError<'message'>`) instead of inference cascades | **v1** | The five most common mistakes each produce one sentence, not a 40-line union dump. |
| Version-gated type errors via export map (`types@<5.9` → one-line stub) | **v1** | An unsupported TS version yields a single readable diagnostic. |
| JSON round-trip degradation model (`Date` → `string` inside `json_agg`) | **v1** | A nested relation projection types a `timestamptz` column exactly as it decodes, not as the parent does. |
| ORM-owned codec registry, passed per-pool, never global mutation | **v1** | `pg.types` global state is provably untouched; a test asserts another library's parsers survive. |
| Codec overrides for the known-broken defaults: `date`, `timestamp`, `int8`, `numeric`, ranges, `record` | **v1** | `DATE` never shifts a day across any `TZ`; `int8` → `bigint`; `numeric` → `string` by default. |
| User enum / domain / composite OIDs resolved from the schema catalogue | **v1** | A user enum decodes to its TS union, not to `string` — the thing no general driver can do. |
| `sql<Codec>` requires a real decoder, not a bare cast | **v1** | `sql<T>` without a codec is a compile error; there is no silent-lie generic. |
| Every result value is `JSON.stringify`-safe by default | **v1** | No class instances in payloads; `JSON.stringify(result)` never throws. |
| Per-operator operand table (`jsonb ? text`, `tsvector @@ tsquery`, range `&&`) | **v1** | Operand types come from the *operator*, not from the left-hand column. |
| Exact PG result types for aggregates (`count() → string`, no `string \| number \| bigint`) | **v1** | Aggregate return types are exact under `pg`; no dialect-union hedging. |
| Type-perf budget enforced in CI from the first table builder | **v1** | The reference app (§11) has a hard ceiling on instantiations, check time, and `.d.ts` bytes; CI fails on regression. |
| Invariant builder output type `O` (closes silent column loss) | **v1** | `let q = qb; if (f) q = q.select('x')` is a compile error, not a silently dropped column. |
| Literal-condition `$if` overloads (`true` → non-partial result) | **v1** | `$if(true, …)` returns `O & O2`, not `O & Partial<O2>`. |
| Explicit column union required for dynamic references | **v1** | A dynamic ref never silently degrades to `{}`; the unsafe form is loudly named. |
| `Loaded<T, Hint>` — relation load state in the type | **v1** | Accessing an unloaded relation is a compile error, not `undefined` at runtime. |
| `LazyRef<T>` type-only relation marker (no runtime wrapper) | **v1** | Relations are plain values; `instanceof`, `structuredClone` and JSON all behave normally. |
| `Opt` / `RequiredNullable` brands ("has a DB default" vs "nullable but must be passed") | **v1** | The two cases are distinguishable in the insert type. |
| Pluggable `numeric` representation (opt-in bignum codec) | **v1.x** | — |
| StandardSchema validator attachable per column (runtime validation on write) | **v1.x** | — |
| **TypedSQL**: `.sql` files typed from PG's describe protocol, with a **committed cache** so CI needs no DB | **v1.x** | — |
| Per-migration schema snapshot *types* (migrations typed as of their own point in history) | **v2** | — |
| `Decimal`/`decimal.js` class instances in payloads | **never** | Makes `JSON.stringify` throw; a serialization decision imposed on every consumer. |
| Three-null JSON (`JsonNull` / `DbNull` / `AnyNull` sentinels) | **never** | `NULL` vs JSON `null` is modelled at the type level on a nullable column. |
| Untyped `Json` / `JsonValue` as the default jsonb type | **never** | Free to type in a TS-authored schema; a `JsonValue` default just relocates the cast. |
| `undefined` in a filter silently meaning "no condition" | **never** | It is a security bug class. Always a type error, never behind a flag. |
| `SqlBool = boolean \| 0 \| 1` and other dialect-union hedges | **never** | Pure multi-dialect tax. PG has real booleans. |
| `.mapWith()`-style post-hoc result remapping | **never** | A symptom of casts-without-codecs; unnecessary once codecs are mandatory. |
| Codec type unification via a 150-member literal-union lookup table | **never** | 34 KB of `.d.ts` for what a small set of nominal codec types gives us. This is where Drizzle's type budget goes. |
| Codegen as the primary type mechanism (any required `generate` before `tsc`) | **never** | The ordering inversion (types depend on live DB / build step) is the failure Prisma is rewriting away from. Codegen is permitted only for the TypedSQL describe cache and migration artifacts, both of which are optional to typecheck. |

---

## 5. Query layer

**One builder.** Relation nesting is a projection option (`with:`) available on any query — so aggregates, window functions, CTEs and `DISTINCT ON` compose with nested results. Underneath: an operation-node IR (not string concat), a PG-only compiler, and `.compile()` for testing without a database.

| Feature | Tier | Acceptance criterion |
|---|---|---|
| `select` / `insert` / `update` / `delete` with full PG clause coverage | **v1** | Each verb supports `WHERE`, `RETURNING`, `ORDER BY`, `LIMIT`/`OFFSET`, and `FROM`/`USING` where PG allows. |
| Expression builder — callable + namespace (`eb('a','=',1)`, `eb.and([...])`) | **v1** | Scoped to the query's tables; out-of-scope columns are a compile error. |
| `and`/`or`/`not` in **both** array and object forms | **v1** | Object form is the common path; both compose and both are typed. |
| Object-literal `where` with **symbol-keyed or namespaced operators** (no `RAW` key in the object) | **v1** | A filter object built from untrusted JSON cannot inject an operator or a raw fragment; the unsafe path is `unsafeFromJson()`. |
| Full PG operator vocabulary: `@>`, `<@`, `&&`, `?`, `?&`, `?|`, `@@`, `<->`, `^@`, `~`, `ILIKE`, `IS DISTINCT FROM` | **v1** | Each has a typed operand table entry and a compiled-SQL test. |
| Joins: inner/left/right/full + **`INNER`/`LEFT JOIN LATERAL`** | **v1** | Nested-select-shape join nullability (`{pet:{…}} \| null`) types correctly. |
| CTEs (incl. recursive and data-modifying) that widen the schema for the rest of the chain | **v1** | `WITH … AS (INSERT … RETURNING …)` is typed and callable in the same chain. |
| Set operations (`UNION`/`INTERSECT`/`EXCEPT`, `ALL` variants) | **v1** | Compile-checked column compatibility. |
| `DISTINCT ON` | **v1** | Typed, and it is the *only* dedup mechanism — no in-memory distinct exists. |
| Aggregates + `GROUP BY` + `HAVING`, with grouped selection allowed | **v1** | `groupBy` can select non-grouped expressions where PG allows; no artificial restriction. |
| Window functions (`OVER`, `PARTITION BY`, frame clauses) | **v1** | Typed result column; composes with relation projection in the same query. |
| **Relation projection** (`with: { posts: { limit: 5, where, orderBy, select } }`) via LATERAL + `json_agg` | **v1** | One round trip, no row explosion, per-parent `limit`/`orderBy`, exact result types, `coalesce(json_agg(…), '[]')` for empty. |
| Exact `select` / `omit` result narrowing from a literal projection | **v1** | Selecting 3 of 40 columns produces a 3-key type; a non-existent key is a compile error. |
| Relation filters `some` / `every` / `none` / `is` / `isNot` → `EXISTS`/`NOT EXISTS` | **v1** | Compiles to correlated `EXISTS`, never to a join that duplicates parents. |
| `_count` on relations, with a filter | **v1** | Typed as a number-ish exact type and computed in the same round trip. |
| Cursor pagination with composite keys (correct multi-column tuple comparison) | **v1** | Stable under ties; `includeCount` defaults to `false`. |
| Raw `sql` tagged template: always-parameterised, `unknown` default, `sql.ref` / `sql.lit` / `sql.identifier` | **v1** | Interpolating a value never produces literal SQL text; a fuzz suite proves it for identifiers and JSON paths. |
| `unsafeRaw` as the only string-splicing door, lintable and greppable | **v1** | Named to be visible in code review; documented as the one unsafe API. |
| Reusable typed fragments **generic over the table they apply to** | **v1** | A shared `activeOnly(eb)` helper typechecks against any table that has the column — Kysely's single worst gap, closed. |
| `$call` / `$dynamic` / `$if` composition primitives | **v1** | Fully type-preserving; a conditional `.where()` needs no `any`. |
| `.compile()` → `{ sql, params, resultFields, hazards }`; `InferResult<Q>` | **v1** | SQL generation is unit-testable with no database, and the plan object is inspectable before execution. |
| Compiled-SQL cache keyed by query shape | **v1** | A warm repeated query pays no re-compilation cost; this is the Prisma-7 regression we refuse to inherit. |
| Pessimistic locking: `FOR UPDATE` / `FOR NO KEY UPDATE` / `SKIP LOCKED` / `NOWAIT` | **v1** | Job-queue pattern (`SELECT … FOR UPDATE SKIP LOCKED LIMIT n`) is a one-liner. |
| Query hook: `onQuery({ sql, params, durationMs, rowCount, error })` | **v1** | Every executed statement is observable with timing; logging/tracing is userland on top. |
| `EXPLAIN` / `EXPLAIN ANALYZE` helper on any built query | **v1** | `q.explain()` returns the plan without rewriting the query by hand. |
| Streaming results (`Promise` **and** `AsyncIterable`, cursor-backed) | **v1.x** | — |
| Server-side named prepared statements (per-connection LRU) + placeholders | **v1.x** | — |
| Computed fields expressible **in SQL** (so they are filterable and sortable) | **v1.x** | — |
| Query-scoped filters (soft-delete / tenancy) applied to `JOIN ON`, not just root `WHERE` | **v1.x** | — |
| Virtual entities (arbitrary SQL → typed named shape) | **v1.x** | — |
| Full-text search helpers (`to_tsquery`, ranking, weighted vectors, index-aware) | **v1.x** | — |
| Plugin API: IR visitor + **type-level channel** so plugins can change result types | **v2** | — |
| `applyFilters()`-style opt-in filter application | **never** | Data-leak footgun: filters that only apply when you remember to ask for them are worse than none. |
| Lazy loading via proxies / `Reference` runtime wrappers | **never** | Hidden N+1, hidden queries, broken `JSON.stringify`, broken `instanceof`. |
| Implicit flush / flush modes / queries that emit writes | **never** | Contradicts the core promise: nothing writes unless you call a write method. |
| In-memory `distinct` | **never** | `DISTINCT ON` exists; in-memory dedup lies about the row count and the LIMIT. |
| `select`/`include` mutually exclusive at a level | **never** | Arbitrary Prisma restriction; both are allowed at every level. |
| Built-in cache layer (Redis/Upstash) | **never** | Scope creep. We expose invalidation-grade hooks; the cache is userland. |
| `$queryRawUnsafe`-shaped cliff between the model API and raw SQL | **never** | The unified builder + typed `sql` tag means there is no cliff to fall off. |
| `HandleEmptyInLists` / `DeduplicateJoins`-style corrective plugins | **never** | Design them out: `in []` compiles to `false`; composition does not double-add joins. |

---

## 6. Mutations & bulk operations

This is where we pay back the Unit of Work we deliberately don't have. UoW's two real wins — write batching and FK ordering — are recovered **explicitly**.

| Feature | Tier | Acceptance criterion |
|---|---|---|
| `insert` / `insertMany` (multi-row `VALUES`) with `RETURNING` | **v1** | 10k rows insert in one statement (chunked by parameter limit) with typed `RETURNING`. |
| `update` / `updateMany` via `UPDATE … FROM (VALUES …)` | **v1** | Per-row differing values in one statement; typed `RETURNING`. |
| `delete` / `deleteMany` with `USING` | **v1** | Typed `RETURNING`; join-conditioned delete supported. |
| `upsert` / `upsertMany` on `INSERT … ON CONFLICT DO UPDATE` with exposed conflict target | **v1** | Conflict target by column list, constraint name, or expression; partial-index `WHERE` supported. |
| `excluded` synthesised as a typed virtual table in `DO UPDATE SET` | **v1** | `set: { name: excluded.name }` typechecks against the target table. |
| `RETURNING` reuses the full select expression language | **v1** | Any expression valid in `SELECT` is valid in `RETURNING`; no weaker second language. |
| Optimistic concurrency without change tracking: `.ifVersion(n)` | **v1** | Emits `WHERE version = $n`, throws a typed conflict error on zero rows affected. |
| Parameter-limit chunking with a single logical result | **v1** | >65535 parameters is transparently chunked inside a transaction, not an error the user must handle. |
| `saveGraph(root)` — topologically sorted single-graph write | **v1.x** | — |
| Nested writes (`create`/`connect`/`connectOrCreate` in one call) | **v1.x** | — |
| Scoped, explicit read-dedup session (`db.session(s => …)`, no change tracking, dies at block end) | **v1.x** | — |
| Lifecycle hooks — exactly four: `beforeInsert`/`afterInsert`/`beforeUpdate`/`beforeDelete` | **v1.x** | — |
| Explicit `serialize()` with `fields` / `exclude` / `forceObject` | **v1.x** | — |
| `COPY FROM`/`TO` bulk path (session-pooling-only, documented) | **v1.x** | — |
| Unit of Work / identity map / change tracking / `em.flush()` | **never** | It is not a feature, it is an architecture that colonizes everything: `RequestContext`, ALS, `fork()`, `clear()`, `refresh()`, three flush modes, seven propagation modes, a 16-hook lifecycle, detach-after-rollback, and a memory profile. 80% of its value is recovered above with 5% of the complexity. |
| Ambient `EntityManager` / `AsyncLocalStorage`-backed entity context | **never** | Exists only to make a mutable identity map survive a request. Handles are passed explicitly. |
| 16-hook UoW-phase lifecycle matrix | **never** | Over-built and self-constrained ("you may not flush in a hook", "collections don't fire updates"). |
| Implicit `toJSON` auto-attachment on results | **never** | Action at a distance on an object you didn't opt into; explicit `serialize()` is strictly better. |
| `Factory` + faker in core | **never** | An optional package at most. Not the ORM's job. |

---

## 7. Transactions

| Feature | Tier | Acceptance criterion |
|---|---|---|
| `db.transaction(async tx => …)` with commit/rollback semantics | **v1** | Throwing rolls back; returning commits; the connection is always released. |
| Isolation levels + access mode (`READ ONLY`, `DEFERRABLE`) | **v1** | All four PG isolation levels settable per transaction. |
| Savepoints with a **type-level savepoint stack** | **v1** | Releasing a non-existent savepoint is a compile error, not a runtime one. |
| `tx` vs `db` misuse prevented **at the type level** | **v1** | Using the outer `db` handle inside a transaction scope does not compile. This is Drizzle's #1 reported bug class. |
| Retry on serialization/deadlock failure (`40001`, `40P01`) with backoff | **v1** | `db.transaction(fn, { retry: 3 })` retries with jitter and surfaces the final error typed. |
| `never`-returning illegal methods (`tx.transaction()`, nested `begin`) | **v1** | Compile-time prevention, not a runtime throw. |
| Session-scoped settings API (`SET LOCAL`) for RLS / `statement_timeout` | **v1** | `tx.setLocal('app.user_id', v)` is parameter-safe and scoped to the transaction. |
| No default transaction timeout | **v1** | Timeouts are explicit and documented; we do not ship Prisma's 5-second surprise. |
| Opt-in ALS-backed **transaction-propagation** context (`withTx`) | **v1.x** | — |
| Two-phase commit / prepared transactions | **v2** | — |
| Spring-style propagation modes (`NOT_SUPPORTED`, `NEVER`, `MANDATORY`, …) | **never** | Enterprise-Java cosplay; `REQUIRED` + `REQUIRES_NEW` + `NESTED` covers reality and savepoints give us the third. |
| ALS used for anything other than transaction propagation | **never** | Ambient entity state is the mechanism we rejected; the ALS slot is deliberately narrow. |

---

## 8. Migrations — the headline subsystem

Flow: **TS schema + `sql/` lane → IR → diff against `pg_catalog` (shadow-normalized) → versioned `NNNN_name.sql` + `NNNN_name.plan.json` → review in PR → lint in CI → verify in CI → apply under advisory lock.** Up-only.

| Feature | Tier | Acceptance criterion |
|---|---|---|
| `pg_catalog` introspection → schema IR (tables, columns, types, defaults, constraints **incl. validation state**, indexes, sequences/identity, enums, comments, schemas, extensions) | **v1** | One round of catalog queries produces a deterministic IR; ordering is explicitly sorted, never catalog-order. |
| Diff engine over the IR with per-kind rules + topological sort of the full dependency graph | **v1** | Types before tables, tables before views, views before matviews, indexes last; the drizzle enum-ordering bug class cannot occur. |
| `--explain` / verbose diff explainer (why each statement was generated) | **v1** | Every emitted statement traces back to a named IR delta. |
| Shadow-DB normalization, **4-tier fallback**: `SHADOW_DATABASE_URL` → `CREATE DATABASE` → temp schema in the same DB → `--offline` with a loud warning | **v1** | Works on a managed PG account without `CREATEDB`. This is Prisma's #1 migration complaint, closed. |
| `generate` → `.sql` + `.plan.json` (SHA-256 from/to fingerprints, structured change list, hazards, txmode, resolved renames, confirmed data loss) | **v1** | The `.sql` is runnable in `psql` with our tooling absent; the plan is machine-readable. |
| Apply refuses to run when the live fingerprint ≠ plan's `from` | **v1** | Drift and concurrent-deploy races are hard failures, not silent overwrites. |
| Rename support, **annotation-first**: `.renamedFrom('old')` / `-- pg-orm:renamed_from` | **v1** | A rename emits `ALTER … RENAME`, never drop+add. The annotation is visible in the PR diff. |
| `missing_hints` decision protocol: typed hints, statuses `ok\|no_changes\|missing_hints\|error`, exit code per status, **never hangs in CI** | **v1** | `--output json` is always non-interactive; an unannotated ambiguous rename fails with a structured report. |
| Destructive-op consent recorded in the plan (`confirmed_data_loss: [...]`) | **v1** | Any drop of a named object requires explicit acknowledgement, which shows up as a diff line for the reviewer. |
| Change classification: additive / destructive / data | **v1** | Enables the CI policy "no destructive ops without an approval label". |
| Built-in linter: ~15 highest-value Squawk rules, Atlas severity codes, `-- pg-orm:nolint <rule>` | **v1** | Runs inside `generate` and standalone as `migrate lint`; severities configurable. |
| **Lock-aware generation** (emit the safe form, don't just warn): CIC + `DROP INDEX IF EXISTS` guard; FK/CHECK `NOT VALID` + `VALIDATE`; `SET NOT NULL` (PG18 `NOT VALID`+`VALIDATE`, PG15–17 CHECK dance); `UNIQUE`/`PK` via `CREATE UNIQUE INDEX CONCURRENTLY` + `ADD CONSTRAINT … USING INDEX`; volatile default split into add-nullable/backfill-stub/set-default | **v1** | Each of the six rewrites has a golden-file test; this is the differentiator no bundled migrator has. |
| Per-statement timeout preamble (`SET lock_timeout`, `SET statement_timeout`) with exemptions for CIC/VALIDATE | **v1** | Emitted automatically; retry-with-backoff on lock timeout in the runner. |
| Header directives: `-- pg-orm:txmode none|default`, `nolint`, `timeout`, `checkpoint` | **v1** | `txmode none` files run statement-by-statement outside a transaction. |
| Runner: dedicated **direct** connection, `pg_advisory_xact_lock(hashtext(...))`, per-file transaction wrapping DDL **and** the ledger insert | **v1** | Two concurrent deploys serialize correctly; a failed migration leaves no half-recorded ledger row. |
| `pg_orm_migrations` ledger: `id, name, checksum, applied_at, applied_by, duration_ms, txmode, statements_applied, fingerprint_from, fingerprint_to, status` | **v1** | Checksum drift on an applied file = hard fail in `deploy`, warning in `dev`. |
| Resumable non-transactional migrations (partial-application position recorded) | **v1** | A crashed `txmode none` migration resumes from the next unapplied statement rather than requiring manual repair. |
| Plan validation: apply the generated plan to the shadow DB before writing it out | **v1** | "The diff generated invalid SQL" is caught at author time, not deploy time. |
| **`migrate verify`**: replay all migrations onto an ephemeral DB, diff against the TS schema, assert empty | **v1** | Catches "the file doesn't do what the schema says". No ORM-bundled migrator ships this. |
| **`migrate baseline`**: adopt an existing database in one command | **v1** | An existing production DB is adoptable without a reset and without hand-editing a ledger. |
| Migration-generation snapshot (generate N+1 while N is pending) | **v1** | Generating a second migration before applying the first produces a correct delta, not a duplicate. |
| `migrate check` CI gate (pending migrations / uncommitted schema changes) | **v1** | Non-zero exit when the schema and the migration directory disagree. |
| Repeatable-object lane for `sql/` files (hash-based re-apply, graphile-migrate model) | **v1** | Changing a function body re-applies it in dependency order; unchanged files are skipped. |
| Migrations have **no ORM/query access** — SQL only | **v1** | Structurally prevented, not merely documented. (MikroORM's own docs warn against it; we enforce it.) |
| Migrator usable as a **library**, CLI as a thin wrapper | **v1** | Embeddable in app startup and integration tests without spawning a process. |
| `migrate diff --from-* --to-*` as a general primitive (empty / schema / migrations-dir / live DB) | **v1** | Any two of the four sources can be diffed. |
| Filename = timestamp + slug; ordering by the journal, duplicate timestamps merge cleanly | **v1** | Two branches each adding a migration merge without a manual renumber. |
| Data-migration lane (first-class, typed, batched, resumable, separate ledger) | **v1.x** | — |
| `migrate doctor` (invalid indexes, `_ccnew` leftovers, unvalidated constraints, drift) | **v1.x** | — |
| Checkpoints (squash-equivalent, fast path for fresh DBs) | **v1.x** | — |
| Precheck / execute / postcheck per operation with idempotent retry | **v1.x** | — |
| Hash-graph history (from-hash → to-hash, branch-mergeable DAG) | **v1.x** | — |
| Import from drizzle-kit / Prisma migration directories | **v1.x** | — |
| Best-effort `down.sql` for the **dev loop only**, refused by `deploy` | **v1.x** | — |
| PG18 `NOT NULL NOT VALID` / PG19 `REPACK CONCURRENTLY` feature-detected paths | **v1.x** | — |
| `--format pgroll` export for expand/contract zero-downtime | **v2** | — |
| Grants / roles / default privileges diffing (opt-in, never diff-and-drop) | **v2** | — |
| Down migrations as a production rollback path | **never** | Every serious tool abandoned them; a `down` that has never been tested against production data is a liability wearing a safety vest. Roll forward. |
| Full-state JSON snapshot per migration | **never** | drizzle's 11k-line files guarantee merge conflicts; their own docs tell you to hide the diff. Fingerprints + checkpoints instead. |
| `migrate dev` offering to **reset the database** on drift | **never** | Data loss behind a prompt. |
| Shelling out to Atlas / migra / pg-schema-diff / any external binary | **never** | Atlas paywalls exactly the objects we most need; migra is deprecated; a "minimal dependencies" ORM cannot require a vendor login or a Python runtime. |
| Downloading anything at install time | **never** | A CDN 403 broke `prisma generate` worldwide and drew 401 comments in a day. "No postinstall network access" is a cheap, defensible guarantee. |
| Requiring `CREATEDB` | **never** | The temp-schema fallback exists precisely so this is never required. |
| GUI / approval workflow / governance layer | **never** | That is Bytebase's business, not ours. |

---

## 9. Runtime & driver

| Feature | Tier | Acceptance criterion |
|---|---|---|
| Thin driver-adapter interface: 4 driver methods + 2 required connection methods (`execute`, `stream`), optional `describe`/`cancel` | **v1** | The whole seam is under ~300 LOC and the query layer is unit-testable with no database. |
| **Structural** `PgLikePool` typing (we never `import type` from `pg`) | **v1** | `package.json` has empty `dependencies` **and** empty `peerDependencies`; `@neondatabase/serverless` and Hyperdrive drop in with zero adapter code. |
| `pg` (≥8.23.0) as the sole bundled v1 adapter (~150 LOC) | **v1** | `npm i pg-orm-ts` installs zero transitive packages. |
| Array row mode internally | **v1** | No per-row object allocation on the hot path; duplicate column names from joins resolve correctly. |
| pgx-style explicit query-execution modes with a **pooler-safe default** (unnamed extended-protocol, Parse+Bind+Execute+Sync in one buffer, cached describe) | **v1** | 1 RTT per query; works on PgBouncer transaction mode, Supavisor, RDS Proxy and Hyperdrive without a flag. |
| Two-URL model (`DATABASE_URL` pooled, `DIRECT_URL` direct), routed **by feature** | **v1** | Migrations, session advisory locks and `WITH HOLD` cursors automatically use the direct URL. |
| `describe()` (Parse + Describe + Sync, no Execute) exposed on the adapter | **v1** | Powers migration plan validation in v1 and TypedSQL in v1.x. |
| No reset query by default; TLS `require` for non-localhost | **v1** | `DISCARD ALL` is never emitted (it breaks PgBouncer tracking and pins RDS Proxy). |
| One-function `RemoteCallback` escape hatch (`(sql, params, method) => rows`) | **v1** | An HTTP proxy, a test double or a queue can back the ORM in ~10 lines of user code. |
| Typed error taxonomy mapping PG `SQLSTATE` → machine-readable codes with suggested fixes | **v1** | Unique violation, FK violation, serialization failure, lock timeout, and check violation are each a distinct catchable type carrying constraint name and columns. |
| Binary result format for the hot numeric/temporal subset | **v1.x** | — |
| `LISTEN`/`NOTIFY` (documented session-pooling-only, routed to `DIRECT_URL`) | **v1.x** | — |
| PGlite adapter (internal from day one for the fast test suite; public if catalog fidelity validates) | **v1.x** | — |
| `postgres.js` adapter | **v1.x** (community-owned) | — |
| Connection pipelining | **v2** | — |
| Own wire-protocol client | **v2 / probably never** | 4–7 months for single-digit-percent gains; type-parsing control — the thing that actually matters — does not require owning the socket. The adapter seam makes this non-breaking whenever we want it. |
| `Bun.sql` adapter | **never** | No type-parser hook; disqualifying for an ORM that owns decoding. |
| Global `pg.types.setTypeParser` mutation | **never** | Process-wide state that corrupts other libraries in the user's app. |
| Native binaries / Rust / WASM anywhere in the query path | **never** | Prisma's 11× m2m speedup was mostly deleting a language boundary. |
| Hosted proxy / paid data plane as the serverless answer | **never** | Solve it with pooling guidance and adapter support, not a monetisation hook in the architecture. |
| Auto-detecting the pooler mode | **never** | No ORM does it because it cannot be done reliably. Explicit modes with a safe default. |

---

## 10. Ops, observability, tooling & CLI

| Feature | Tier | Acceptance criterion |
|---|---|---|
| `onQuery` hook with SQL, params, duration, row count, error | **v1** | Sufficient to build logging, tracing and slow-query alerting in userland with no ORM changes. |
| Machine-readable error codes with suggested fixes (`PGO####`) | **v1** | Every thrown ORM error has a stable code, a one-line cause, and a suggested fix. |
| `.compile()` as the public "assert the SQL" testing surface | **v1** | A user can snapshot-test generated SQL with no database. |
| Published benchmark vs raw `pg`, with p99 on a small indexed lookup as the headline | **v1** | Reproducible harness in-repo; overhead vs raw `pg` under the agreed bar on the headline case. |
| Type-perf benchmark in CI (instantiations, check time, `.d.ts` bytes) on the reference app | **v1** | Fails the build on regression beyond the budget. |
| Fuzz tests on identifier, literal and JSON-path sanitizers | **v1** | Kysely shipped three high-severity CVEs here; these are security-critical code with fuzzing from day one. |
| `sideEffects: false`, granular export paths, npm provenance attestation | **v1** | Verifiable provenance badge; tree-shaking demonstrated in a bundle-size test. |
| TS config file (`pgorm.config.ts`), env handled in userland, no magic dotenv | **v1** | Config is typechecked; we never read `.env` behind the user's back. |
| CLI verb set: `generate`, `migrate` (`deploy`/`status`), `check`, `verify`, `lint`, `baseline`, `pull`, `push`, `diff` | **v1** | Vocabulary users already know from drizzle-kit/Prisma; every verb documented with exit codes. |
| Every CLI command emits a **structured JSON envelope** (`--output json`), never interactive in CI | **v1** | The envelope is the machine surface; TTY prompts are a convenience layer that writes annotations for you. |
| Programmatic SDK returning the same envelope as the CLI | **v1** | The tool is scriptable and testable without spawning a process. |
| `pull` — one-shot bootstrap of a TS schema from an existing database, deterministic output | **v1** | Output is sorted and stable across runs, round-trips `.name()`, CHECK/EXCLUDE, partial/expression indexes, comments and extensions. |
| `push` — dev-only schema sync, **fenced**: refuses to run against a DB with applied migration history | **v1** | Labelled dev-only in help text and refuses in CI by default. |
| OpenTelemetry span helper (optional subpath, no dependency) | **v1.x** | — |
| Entity generator / maintained DB-first codegen loop (with an `onProcessedMetadata`-style hook) | **v1.x** | — |
| Seeding (thin `Seeder`, no faker) | **v1.x** | — |
| MCP server wrapping the JSON envelope | **v2** | — |
| Studio-style GUI | **never** | Large surface, low differentiation, and it is the component that breaks first on custom types. If we ever build one, it is MIT. |
| Writing agent-skill files into the user's repo on `init` | **never** | Invasive. If agents matter, serve them the schema IR and the JSON envelope, not files in `.claude/`. |
| Shipping database drivers as hard CLI dependencies | **never** | Our CLI should be a few hundred KB, not 95 MB of six dialect payloads. |
| Preview-feature flags | **never** | Eight flags, several 2–3 years old, is a broken-promise machine. Ship or don't. |

---

## 11. The v1 cut line — the brutal argument

### 11.1 The rule

> **v1 = a real production application can define its entire schema, query and mutate it with full type safety, and ship schema changes to production safely — without ever leaving the tool.**
> Anything that does not block that sentence is not in v1.

Research risk #2 is the one that kills projects: **Drizzle has been in 1.0 RC for 9.5 months**, and "is it 1.0 yet" is now the first question anyone asks about it. Kysely has *refused* a 1.0 on principle and its bus factor is 1. The competitive opening here is not a feature — it is **shipping a 1.0 and meaning it**. Every feature deferred below is a feature that cannot delay that.

### 11.2 What a real app can live without for six months

Nested writes · `saveGraph` · TypedSQL describe-cache · streaming results · named prepared statements · `COPY` · `LISTEN`/`NOTIFY` · soft-delete/tenancy filters · lifecycle hooks · `serialize()` · seeding · entity-generator loop · structured diffing of functions/triggers/views/policies (they are *managed*, just not *diffed*) · RLS policies as typed DSL objects (they work via the `sql/` lane) · data-migration lane · checkpoints · `migrate doctor` · down migrations · MCP · plugin API · PostGIS · binary result format.

Each is a real feature; none of them is why someone would fail to adopt. They are 1.x releases, and 1.x releases are how you demonstrate the project is alive.

### 11.3 What a real app cannot live without — and therefore is v1

Schema→migration→apply loop that survives contact with managed Postgres (no `CREATEDB`) · `migrate baseline` (without it, no existing app can adopt at all) · relation loading in one round trip with exact types · transactions with isolation, savepoints and 40001 retry · upsert and bulk insert (the UoW payback) · a safe raw-SQL escape hatch · `CHECK`/`EXCLUDE`/partial+expression indexes/generated columns (the "we're more Postgres than Drizzle" claim has to be true on day one) · lock-safe DDL generation (the "we're more operational than everyone" claim, same) · codecs that don't lie · `pull` (the adoption on-ramp) · error codes · a published benchmark.

### 11.4 Relative effort per v1 subsystem

| Subsystem | Effort | Note |
|---|---|---|
| Driver adapter + `pg` adapter | **S** | ~300 LOC seam + ~150 LOC adapter. Do it first; everything else mocks against it. |
| Transactions | **S** | Plain SQL above the adapter; the type-level savepoint stack is the only clever part. |
| Ops / observability / error taxonomy | **S** | Mostly a discipline, not a build. |
| Schema DSL → IR | **M** | Breadth, not depth. Parallelizable across contributors once the IR is frozen. |
| Codec registry + PG core type set | **M** | ~40 OIDs with encode/decode/round-trip tests. Tedious, low-risk. |
| Operation-node IR + PG compiler | **M** | Far smaller than Kysely's 108 nodes — PG-only deletes most of them. |
| Mutations / bulk ops | **M** | `ON CONFLICT` breadth and `UPDATE … FROM (VALUES)` are the work. |
| CLI + JSON envelope + `pull`/`push` | **M** | `pull` is cheap once the introspector exists for diffing. |
| Docs, benchmarks, type-perf CI, fuzzing | **M** | Non-negotiable and consistently under-budgeted. |
| Type core (`ColumnType` triple, projections, inference kernel) | **L** | Ported from Kysely with six fixes; the fixes are where the time goes. |
| Catalog introspection → IR | **L** | ~30 object kinds, deterministic ordering, PG15–19 version drift. |
| Migration runner + safety rails + linter | **L** | The six lock-safe rewrites are individually small, collectively a lot of golden files. |
| **Unified query builder (relation projection + select narrowing)** | **XL** | The differentiator and the risk. See §11.5. |
| **Diff engine** | **XL** | ~30 object kinds × per-kind rules × topological ordering × normalization. Mitigated by the `sql/` lane cut and by `migrate verify`. |

Two XLs is the honest shape of this v1. Both are load-bearing for the positioning; neither can be cut without cutting a differentiator.

### 11.5 The single riskiest v1 item

**The unified query builder's result-type inference — specifically, exact `select` narrowing composed with arbitrary-depth relation projection — staying inside a hard `tsc` budget.**

Why this one and not the diff engine: diff-engine bugs are *bounded and detectable*. `migrate verify` (replay → assert empty diff) turns every diff defect into a red CI run rather than a production incident, and the `sql/` repeatable lane removes the hardest object kinds from the diff path entirely. Type-system cost has no such mitigation. Drizzle measured **41k type instantiations per schema**, and their fix grew `.d.ts` output 77%. Kysely measured **743k instantiations at 80 tables / 60 queries**. Prisma's entire codegen architecture — the thing they are now rewriting away from — exists because they lost this fight. If our inference blows the budget, the no-codegen thesis fails, and the fallback (emit types) is not a patch, it is a different product.

**Mitigation, from commit one:** a reference app (50 tables, 12 relations deep in aggregate, 200 distinct queries) with CI-enforced ceilings on type instantiations, cold `tsc` time and shipped `.d.ts` bytes. The budget is a **release gate**, not a dashboard. Every inference technique lands with its measured cost. Nominal/shallow table types (the Drizzle ADAPT), `DrainOuterGeneric`, and tuple-wrapped conditionals are budget instruments, not stylistic preferences. If the reference app cannot stay in budget with relation projection at depth 3, we cap projection depth in v1 and say so out loud — we do not ship a schema size at which the IDE dies.

### 11.6 Ship discipline

1. **Time-box, don't feature-box.** Pre-1.0 exists to stabilise the *type API*, not to accumulate features. Anything not in §3–§10's v1 column is a 1.x issue the day it is proposed.
2. **1.0 means the type API is stable**, not that the feature list is complete. Say so in the README.
3. **Version-gate type errors** via the export map so a TS upgrade never produces an inference cascade the user has to decode.
4. **No preview flags, ever** (§2). The tier list *is* the public roadmap.
5. **`migrate verify` must be green on three real third-party schemas** before 1.0 is tagged. That is the correctness gate for the XL subsystem we can actually measure.

---

## 12. Cross-check — every research PORT/ADAPT item is placed

No silent drops. Grouped where a single decision covers several verbatim rows; **rejections are marked ✗ with a reason**.

### 12.1 `prisma.md`

| Research item | Verdict there | Placed |
|---|---|---|
| Declarative reviewable schema as SoT; compile to deterministic IR | PORT | §3 v1 (schema IR) |
| Bidirectional relations with `onDelete`/`onUpdate`; `@map`/`@@map` decoupling | PORT | §3 v1 |
| `Unsupported` → registerable codec API; extensions as a core concept | ADAPT | §3 v1 (`definePgType`, extensions) |
| Partial + expression indexes; `CHECK`; `EXCLUDE`; generated columns | PORT day one | §3 v1 |
| Views + matviews as read models; triggers/functions as *ownership* not bodies | PORT / ADAPT | §3 v1 (typed read-only entities; `sql/` lane) |
| RLS policies in the schema | PORT | §3 v1 via `sql/` lane; typed DSL v1.x |
| `externalTables` / `@@ignore` ownership markers | PORT | §3 v1 (provenance tags) |
| Exact `select`/`include` narrowing — but by inference, not emission | PORT / ADAPT | §5 v1, §4 v1 |
| Zero codegen except describe-cache + migration artifacts | ADAPT | §4 (`never` on codegen-as-primary; TypedSQL v1.x) |
| TypedSQL + committed describe cache + composable builder for dynamic cases | PORT / ADAPT | §4 v1.x (cache); §5 v1 (builder covers dynamic today) |
| `BigInt` / `numeric` as per-column codec choice | ADAPT | §4 v1 (`int8`→`bigint`, `numeric`→`string`), pluggable v1.x |
| `strictUndefinedChecks` unflagged; `omit` | ADAPT / PORT | §4 `never` (undefined always an error); §5 v1 (`omit`) |
| Nested writes; relation filters `some`/`every`/`none`/`is`/`isNot` | PORT | §6 v1.x; §5 v1 |
| Composable predicate values instead of `undefined`-spreading | ADAPT | §5 v1 (expression builder + object form) |
| LATERAL + `json_agg` as default, with an escape hatch | PORT / ADAPT | §5 v1 (only strategy in v1; escape hatch deferred to v1.x — **narrowed deliberately**, PG-only means no fallback is needed) |
| `_count` with filters; grouped selection allowed; `DISTINCT ON` over in-memory distinct | PORT / SKIP | §5 v1 |
| `upsert` on `ON CONFLICT` + `upsertMany` day one | ADAPT | §6 v1 |
| CTEs / windows / `UNION` / recursive in the SQL lane | PORT into builder | §5 v1 |
| Streaming results (Promise + AsyncIterable) | PORT | §5 v1.x (adapter `stream()` slot in v1) |
| Cursor pagination with composite keys | PORT | §5 v1 |
| `$extends` → query interception + SQL-expressible computed fields | ADAPT | §5 v1 (`onQuery`); computed fields v1.x; full plugin API v2 |
| Interactive tx with isolation; savepoints; serializable retry helper; no 5s default timeout | PORT / ADAPT / SKIP | §7 v1 |
| Inspectable query plan object before execution | PORT | §5 v1 (`.compile()`) |
| Plain hand-editable SQL files; `migrate diff --from/--to`; dev/deploy split | PORT | §8 v1 |
| Shadow-DB technique without the requirement; baselining as one command | ADAPT | §8 v1 (4-tier fallback; `migrate baseline`) |
| Ledger with checksums; `resolve --applied` recovery; advisory lock w/ configurable timeout | PORT / ADAPT | §8 v1 |
| Drift detection gated on ownership markers | ADAPT | §8 v1 + §3 provenance tags |
| Best-effort `down.sql` for local iteration | ADAPT | §8 **v1.x, dev-loop only** — v1 is up-only per baseline; `deploy` refuses it |
| Precheck/execute/postcheck with idempotent retry | PORT high value | §8 v1.x (v1 ships resumable `txmode none` + plan validation, which covers the acute case) |
| Additive/destructive/data classification; declarative op list compiled to **SQL** | PORT / ADAPT | §8 v1 |
| Hash-graph history (branch-mergeable) | PORT | §8 v1.x (v1: journal ordering + duplicate-timestamp merge) |
| First-class data migrations / backfill placeholders | PORT | §8 v1.x (v1 emits backfill stubs in the volatile-default rewrite) |
| Real rename support (annotation or prompt), never drop+add | build it | §8 v1 |
| CIC outside a transaction | PORT | §8 v1 (`txmode none` + lock-aware generation) |
| Rename-preserving introspection (`db pull`) | PORT | §10 v1 |
| `db push` renamed and fenced | PORT w/ fence | §10 v1 |
| No native binaries/WASM; driver adapters; extension packs; TS config file | PORT | §9 v1, §3 v1, §10 v1 |
| Emit only what must be emitted, gitignorable + CI-reproducible without a DB | ADAPT | §4 (`never` on required codegen); §8 v1 (plan artifacts are committed and DB-free) |
| Machine-readable error codes with suggested fixes | PORT | §9/§10 v1 |

### 12.2 `mikroorm.md`

| Research item | Verdict there | Placed |
|---|---|---|
| `Loaded<T, Hint>` populate-state typing; `LazyRef<T>` type-only marker | PORT | §4 v1 |
| `defineEntity` fluent builder + `InferEntity` | PORT | §3 v1 (`defineTable` + inference) |
| Migration snapshot files (generate N+1 while N pending) | PORT | §8 v1 |
| `migration:check` CI gate | PORT | §8 v1 (`migrate check`) |
| `migration:rollup` | PORT | §8 v1.x (checkpoints) |
| Migrations with no EM access, SQL only; in-house runner (no umzug) | PORT | §8 v1 (structurally enforced) |
| PG operator set (`$ilike`/`$overlap`/`$contains`/`$hasKey`) | PORT | §5 v1 |
| `$some`/`$none`/`$every`/`$size` collection operators → `EXISTS` | PORT | §5 v1 |
| Pessimistic lock matrix (`FOR UPDATE SKIP LOCKED`) | PORT | §5 v1 |
| Filters (soft-delete, tenancy) applied to `JOIN ON` | PORT | §5 **v1.x** — correctness-critical, and half-done it is a data leak; `applyFilters()` opt-in is `never` |
| Cursor pagination (Relay shape, `includeCount:false` default) | PORT | §5 v1 |
| Virtual entities (SQL → typed shape) | PORT | §5 v1.x (v1: `sql` tag with a row codec covers it) |
| `Opt` / `RequiredNullable` brands | PORT | §4 v1 |
| Per-parent relation limiting via LATERAL | ADAPT | §5 v1 (`with: { posts: { limit } }`) |
| Two loading strategies instead of three | ADAPT | §5 — **narrowed to one (LATERAL) in v1**; second strategy only if a benchmark demands it |
| Explicit tx + isolation + savepoints (minus Spring propagation) | ADAPT | §7 v1 |
| Explicit `serialize()` with fields/exclude/forceObject | ADAPT | §6 v1.x (v1 guarantees JSON-safe results) |
| Matviews + `REFRESH` first-class | ADAPT | §3 v1 |
| Tagged-template raw SQL with reusable fragments as the *primary* escape hatch | ADAPT | §5 v1 |
| Own diff engine against `pg_catalog` + `--verbose` diff explainer | ADAPT | §8 v1 |
| Entity generator with an extensibility hook | ADAPT, post-v1 | §10 v1.x |
| Embeddables, JSON mode only | ADAPT | §3 v1.x |
| Optimistic locking as explicit `.ifVersion(n)` | ADAPT | §6 v1 |
| Own PG-only AST → SQL QueryBuilder (no Kysely dependency) | ADAPT | §5 v1 (operation-node IR) |
| Seeders thin; Factory+faker as a separate package | ADAPT | §10 v1.x; faker `never` in core |
| Four lifecycle hooks + a query-level logging hook | ADAPT | §6 v1.x (hooks); §10 v1 (`onQuery`) |
| §8.2 explicit UoW payback: `insertMany`/`updateMany`/bulk upsert | design | §6 v1 |
| §8.2 `saveGraph(root)` topological write; scoped read-dedup session | design | §6 v1.x |

### 12.3 `drizzle.md`

| Research item | Verdict there | Placed |
|---|---|---|
| `$inferSelect`/`$inferInsert`; `.$type<T>()`; column-builder chaining; extra-config array form | PORT | §3 v1 |
| Shallower/nominal table type (cut error spew + instantiation cost) | ADAPT | §4 v1 (budget instrument) |
| `pgView`/`pgMaterializedView`/`pgSequence`/`pgEnum`/`pgSchema`; policies/roles/privileges/`COMMENT ON` | PORT | §3 v1 (typed DSL for the first group; policies/roles via `sql/` lane in v1, typed v1.x) |
| pgvector + PostGIS helpers | PORT | §3 v1 (pgvector) / v1.x (PostGIS) |
| Ranges/multiranges/tsvector/tsquery/xml/money/bit builders | PORT differentiator | §3 v1 |
| Triggers/functions/domains/composites/partitions/exclusions/`CREATE EXTENSION` | PORT differentiator | §3 v1 (`EXCLUDE` + extensions in the typed DSL; the rest via the `sql/` lane, structured diffing v1.x) |
| `text({enum})` must emit a real constraint | ADAPT | §3 `never` on the lying form; native `pgEnum` in v1 |
| `pgTableCreator` → first-class schema/namespace concept | ADAPT | §3 v1 (`defineSchema`); per-table prefixing v2 |
| Core CRUD + joins + CTE + set ops + `$dynamic()` | PORT | §5 v1 |
| Nested-select-shape join nullability | PORT | §5 v1 |
| RQB v2 LATERAL + `json_agg`; `defineRelations` graph with `from`/`to`/`through`/`optional` | PORT | §5 v1, §3 v1 |
| Object-literal `where` with the mass-assignment fix | ADAPT | §5 v1 (symbol-keyed operators + `unsafeFromJson`) |
| **Unify the two query APIs** | ADAPT — the differentiator | §5 v1 (relation projection on any query) |
| `sql<T>` must carry a real decoder; `sql.raw` → `unsafeRaw` | ADAPT | §4 v1, §5 v1 |
| `.prepare()` + `sql.placeholder()` | PORT | §5 **v1.x** (v1 ships compiled-SQL caching, which captures most of the win pooler-safely) |
| Transactions with isolation/access mode/savepoints; retry on serialization failure | PORT | §7 v1 |
| `tx` vs `db` prevented at the type level | ADAPT | §7 v1 |
| `generate`/`migrate`/`push`/`pull`/`check`/`export` verb set | PORT | §10 v1 |
| `missing_hints` decision protocol + `--explain`, never hangs in CI | PORT — highest value | §8 v1 |
| Programmatic SDK with the same envelope | PORT | §10 v1 |
| MCP wrapper over the JSON envelope | ADAPT | §10 v2 (envelope itself is v1) |
| Per-migration transactions + no-transaction escape | ADAPT | §8 v1 |
| Advisory lock; `CREATE INDEX CONCURRENTLY`; consent before dropping any named object; topological sort of the full dependency graph | PORT the fix | §8 v1, §3 v1 |
| Best-effort `down.sql` | PORT as differentiator | §8 **v1.x, dev-only** — baseline is up-only; a production `down` is `never` |
| Data migrations first-class: typed, batched, resumable, separate ledger | ADAPT | §8 v1.x |

### 12.4 `kysely.md`

| Research item | Verdict there | Placed |
|---|---|---|
| `ColumnType<S,I,U>`; `Generated`/`GeneratedAlways`/`JSONColumnType`; derived optionality; `never`-erasure; `Selectable`/`Insertable`/`Updateable` | PORT | §4 v1 |
| Tuple-wrapping; `DrainOuterGeneric`; readable type errors; version-gated type errors | PORT | §4 v1 |
| Type-level savepoint stack; `never`-returning illegal methods | PORT | §7 v1 |
| `ShallowDehydrateValue` JSON round-trip degradation | PORT | §4 v1 |
| `AnyColumn`/`AnyColumnWithTable` scope unions | PORT | §5 v1 (expression-builder scoping) |
| `.as()` combinators primary, alias strings as sugar | ADAPT | §5 v1 |
| `$if` literal-condition overloads; invariant `O`; dynamic refs must not default to `{}` | ADAPT / fix | §4 v1 |
| `ExpressionBuilder` callable+namespace; `and`/`or`/`not` both forms; CTEs widening the schema | PORT | §5 v1 |
| `jsonArrayFrom`/`jsonObjectFrom`; subquery-vs-`LEFT JOIN LATERAL` choice; `json_agg` vs `jsonb_agg` | PORT / ADAPT | §5 v1 (relation projection owns the choice) |
| `excluded` virtual table; `onConflict` breadth; `RETURNING` reusing `SelectExpression` | PORT | §6 v1 |
| `sql` tag always-parameterised with `unknown` default and explicit `ref`/`lit`/`raw` | PORT | §5 v1 |
| `InferResult` + `.compile()` split; `$call` | PORT | §5 v1 |
| Transaction API (`setIsolationLevel`, `setAccessMode`) | PORT | §7 v1 |
| **ALS-backed ambient transaction context as first-class** | ADAPT | §7 **v1.x, opt-in, transaction-propagation only** — explicit handles stay canonical; ALS for entity state is `never` (§6). This is the one place the two research docs disagreed; resolved here. |
| Expression-level fragments generic over table | fix Kysely's worst gap | §5 v1 |
| Exact aggregate types; per-operator operand table; PG operator strings | fix / PORT | §4 v1, §5 v1 |
| `innerJoinLateral`/`leftJoinLateral` | PORT | §5 v1 |
| Introspection as bootstrap + drift check; deterministic output; drift check that actually fails | PORT / fix | §10 v1 (`pull`), §8 v1 (`check`, fingerprints) |
| Emitting `Selectable`/`Insertable`/`Updateable` variants; views/matviews non-insertable | PORT | §4 v1, §3 v1 |
| Composite types, domains, ranges, routines in introspection | PORT | §8 v1 (IR + catalog completeness diagnostics) |
| Ephemeral-PGlite codegen (unclaimed opportunity) | PORT | §9 v1.x + §8 v1 (`--shadow=pglite` option; internal test suite from day one) — **not** shipped as a codegen product, since our types don't need a DB |
| PG advisory-lock migration locking with `lock_timeout` | PORT | §8 v1 |
| Transactional DDL by default; filename-ordered migrations; Migrator as a library | PORT | §8 v1 |
| Per-migration schema snapshot **types** | ADAPT, differentiator | §4 v2 |
| Diffing as editable generated migrations + destructive linting + CONCURRENTLY advice; DDL builder breadth | ADAPT | §8 v1 |
| Zero runtime deps; structural driver interface; `sideEffects:false`; provenance; ESM-only | PORT | §9 v1, §10 v1 |
| Sanitizers are security-critical, fuzz them | fix | §10 v1 |
| Operation-node IR + visitor transformer | PORT | §5 v1 (IR); visitor plugin API v2 |
| Two-hook plugin interface **plus a type-level channel** | ADAPT | §5 v2 |
| Schema qualification as a typed first-class concept (not `WithSchemaPlugin`) | ADAPT | §3 v1 |

### 12.5 `pg-drivers.md`

| Research item | Verdict there | Placed |
|---|---|---|
| Thin adapter interface (4 driver + 2 connection methods); structural `PgLikePool`; `pg` as sole v1 adapter | PORT | §9 v1 |
| Array row mode | PORT | §9 v1 |
| ORM-owned codec registry replacing driver parsers; never mutate globals; OID override table | PORT | §4 v1, §9 v1 |
| User enum/domain/composite OIDs resolved from the schema catalogue | PORT (the moat) | §4 v1 |
| pgx-style explicit exec modes with a pooler-safe default | PORT | §9 v1 |
| `describe()` (Parse+Describe+Sync) on the adapter | PORT | §9 v1 |
| `RemoteCallback` one-function escape hatch | PORT | §9 v1 |
| Two-URL model routed by feature | PORT | §9 v1 |
| Runtime defaults: no reset query, TLS require, pool sizing guidance, `pg_advisory_xact_lock` | PORT | §9 v1, §8 v1 |
| Instrumented-`Client` injection seam for tracing/metrics | PORT | §10 v1 (`onQuery` is the sanctioned surface) |
| Binary result format for the hot numeric/temporal subset | ADAPT | §9 v1.x |
| `LISTEN`/`NOTIFY` and `COPY`, documented session-pooling-only | ADAPT | §9 v1.x, §6 v1.x |
| PGlite adapter for our own fast test suite | deferred/internal | §9 v1.x (internal from day one) |
| `postgres.js` adapter published as an interface, community-owned | deferred | §9 v1.x |
| Own wire client | revisit post-v1 | §9 v2 / probably never |

### 12.6 `migrations.md`

| Research item | Verdict there | Placed |
|---|---|---|
| TS DSL + `sql/` raw-DDL directory in one desired-state model, one canonical IR | recommendation | §3 v1 |
| Provenance tags + catalog completeness check as diagnostics | steal from pg-delta | §3 v1 |
| `pg_catalog`-only introspection, PG15 floor | v1 | §8 v1 |
| Diff engine over the IR (evaluate `@supabase/pg-delta` first) | v1 | §8 v1 + §13 open decision |
| 4-tier shadow fallback (env URL → CREATE DATABASE → temp schema → offline) | v1 | §8 v1 |
| `.sql` + `.plan.json` with from/to fingerprints; apply refuses on fingerprint mismatch | v1 | §8 v1 |
| No per-migration full snapshots; checkpoints instead | v1 / v1.1 | §8 `never` (snapshots) + v1.x (checkpoints) |
| Filename = timestamp + slug; journal ordering; duplicate timestamps merge | v1 | §8 v1 |
| Header directives (`txmode`, `nolint`, `checkpoint`, `timeout`) | v1 | §8 v1 |
| `renamedFrom` annotations + structured non-interactive failure | v1 | §8 v1 |
| Linter: ~15 Squawk rules + Atlas DS/MF/BC severities, `nolint` escape | v1 | §8 v1 |
| Lock-safe generation: CIC, FK/CHECK `NOT VALID`+`VALIDATE`, `SET NOT NULL`, UNIQUE-via-index, volatile defaults | v1 | §8 v1 |
| Timeout preamble + retry-on-lock-timeout | v1 | §8 v1 |
| Plan validation against the shadow DB before writing | v1 | §8 v1 |
| Destructive ops require acknowledgement recorded in the plan | v1 | §8 v1 |
| Runner: direct connection, `pg_advisory_xact_lock`, per-file tx, ledger schema, checksum drift policy, resumable `txmode none` | v1 | §8 v1 |
| `migrate baseline`; `migrate verify`; `migrate lint`; `migrate plan --against=<fingerprint>` | v1 | §8 v1 (the `--against` form is folded into fingerprint checking) |
| Up-only, no down in v1 | v1 | §8 v1 |
| Views/matviews/functions/triggers as **repeatable** migrations before attempting true diffing | v1.1 | §3/§8 **v1** — pulled forward; it is what makes v1's DDL-coverage claim true |
| RLS policies in the IR | v1.1 | §3 v1 via `sql/` lane; typed DSL v1.x |
| `migrate doctor`; import from drizzle-kit/Prisma; data-migration lane; optional dev-only `down` | v1.1/v2 | §8 v1.x |
| Partitions, grants/roles, publications, `--format pgroll`, multi-schema fan-out, PG19 `REPACK` | v3/speculative | §3 v1.x–v2, §8 v1.x–v2 |
| graphile-migrate idempotent model for functions/triggers | ADAPT | §8 v1 (repeatable lane) |
| Shell out to Atlas / migra / pg-schema-diff / pgschema | ✗ | §8 `never` (Atlas Pro paywall on exactly our objects; migra deprecated; Python/Go runtime deps) — retained as **design references** for hazard taxonomy and the fingerprinted plan artifact |
| `--shadow=docker` (testcontainers) | recommendation | §8 v1 (used by `migrate verify`) |

**Items explicitly rejected rather than tiered:** the four "shell out to an external differ" options (reason above); Prisma's drop+add rename plan (replaced with real renames); Prisma's `select`/`include` exclusivity, in-memory `distinct`, three-null JSON, `Decimal` instances, and 5s tx timeout (all `never`, §4–§7); MikroORM's `applyFilters()` opt-in, `flushMode: AUTO`, `$re`, `EntitySchema`, decorators, `ts-morph`, Spring propagation, polymorphic/STI/TPT, and any Kysely runtime dependency (all `never`); Drizzle's snapshot JSON, `_journal.json`/`kit up` format upgrades, `.mapWith()`, codec union table, bundled Redis cache, closed-source Studio, and six-dialect packaging (all `never`); Kysely's `SqlBool`, `CamelCasePlugin`, `ParseJSONResultsPlugin`, corrective plugins, thin `DatabaseIntrospector`, and the full `Dialect` abstraction (all `never`); `Bun.sql` and global `setTypeParser` (§9 `never`).

---

## 13. Open decisions needing the lead's sign-off

1. **`@supabase/pg-delta`: adopt, fork, or reference?** Recommendation: **prototype in week 1 against our v1 object set; adopt only as a CLI-side optional dependency, never in the runtime package.** Default plan is our own diff engine seeded by pg-delta's data model and catalog queries (MIT, attributable). Decision rule: adopt only if the prototype round-trips ≥90% of the v1 object list with deterministic output; otherwise reference-only.
2. **Relation-projection depth cap.** If the type budget (§11.5) cannot absorb unbounded depth, do we ship a documented depth limit in v1 or slip? Recommendation: **ship the cap, document it, raise it in 1.x.**
3. **The performance bar, stated numerically.** "Near-raw-driver" needs a number before it can be a release gate. Recommendation: **≤1.15× raw `pg` p99 on a single-row indexed lookup; ≤1.3× on a 1k-row relation-projected read.** Needs sign-off because it constrains the compiled-SQL cache design.
4. **Package layout.** One package (`pg-orm-ts`) with subpath exports, or runtime + CLI split? Recommendation: **split** — the CLI may take dependencies the runtime may not, and "zero runtime dependencies" must remain literally true of the thing that ships to production.
