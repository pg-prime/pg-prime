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
| `defineTable` fluent column builders, chained `.nullable().default().primaryKey()` | **v1** | A 40-column table compiles with full autocomplete; column order in the IR is stable and deterministic. |
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

This was a one-time audit: every PORT/ADAPT item across the six research documents was walked and
assigned to a tier above. **162 items, no silent drops** — `prisma.md` 39 · `mikroorm.md` 28 · `drizzle.md` 25 · `kysely.md` 30 · `pg-drivers.md` 15 · `migrations.md` 25.

The full item-by-item matrix has been removed as redundant: each row's payload was a pointer back
to §3–§10 of this document, which is where the decisions actually live and stay maintained. Only
one item was rejected outright, and its reasoning is not recorded anywhere else:

| Research item | Verdict | Reason |
|---|---|---|
| Shell out to Atlas / migra / pg-schema-diff / pgschema | ✗ | §8 `never`. Atlas paywalls exactly our object set (triggers, functions, RLS); migra is deprecated and models a thin subset; all of them add a Python or Go runtime dependency. Retained as **design references** for the hazard taxonomy and the fingerprinted plan artifact. |

Two of those tools stayed relevant after the fact. `pg-schema-diff` is the closest independent
implementation of this design's hazard-classification and temp-database-validation ideas, and is
the sanest external second opinion if one is ever wanted again. The need it would serve is
otherwise met by 06 D10, which uses `pg_dump` — PostgreSQL's own serializer, no runtime dependency,
and it models the whole DDL surface rather than a subset.

## 13. Resolutions

All four items are decided; recorded so they are not re-opened.

1. **`@supabase/pg-delta`: adopt, fork, or reference?** — **None of the three.** We build the diff
   engine in-house (00-overview sign-off 7). pg-delta ran as a dev-time differential oracle for one
   release and was removed on 2026-08-25, superseded by the `pg_dump` witness (06 D10), which
   covers PostgreSQL's entire DDL surface instead of an alpha's modelled subset — and costs no
   dependency.
2. **Relation-projection depth cap.** — **No cap needed.** The type budget absorbs depth: the
   marginal cost of one more usage is flat at 25, 100 and 300 tables (measured ratio **1.00**
   against a 1.15 gate), because no whole-schema type parameter is threaded through the builder.
   Revisit only if the ratio regresses once the fluent builder lands.
3. **The performance bar, stated numerically.** — **≤1.15× raw `pg` median, ≤1.30× p99.** Carried
   into 08's 1.0 release list as a gate. Not yet measurable: there is no executor to benchmark.
4. **Package layout.** — **Four packages**: `pgormjs` (runtime, zero deps and zero peer deps),
   `@pgorm/kit` (CLI, may take dependencies the runtime may not), `@pgorm/testing`,
   `create-pgormjs`. "Zero runtime dependencies" stays literally true of the artefact that ships to
   production; verified — `packages/pgorm/src` has no non-relative imports at all.
