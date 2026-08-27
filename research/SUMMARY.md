# pg-orm-ts — Research Summary (Team Lead Synthesis)

> **Historical snapshot — 2026-08-14.** Distilled from the deep-dives in this directory. The
> design decisions these fed into, and their current status, live in
> [`../design/00-overview.md`](../design/00-overview.md), which is the maintained document.

**Date:** 2026-08-14
**Goal:** Design input for a PostgreSQL-only, type-safe TypeScript ORM with first-class migrations and minimal runtime dependencies. Multi-DB abstraction is an explicit non-goal.
**Method:** Six parallel research agents (Prisma, MikroORM, Drizzle, Kysely, PG drivers, migration tooling), each verifying against primary sources — npm registry, installed package source, GitHub issues, official docs — as of today.

## Document index

| Doc | Subject | One-line takeaway |
|---|---|---|
| [prisma.md](./prisma.md) | Prisma 7 stable + prisma-next 8 RC | The market leader is rewriting itself PG-first in pure TS — validating our thesis |
| [mikroorm.md](./mikroorm.md) | MikroORM v7 | Best-in-class relation typing; Unit of Work is the part to leave behind |
| [drizzle.md](./drizzle.md) | Drizzle 0.45 / 1.0-rc | Closest competitor; its multi-dialect tax is exactly our opening |
| [kysely.md](./kysely.md) | Kysely 0.29 | The type architecture to port — not the dependency to take |
| [pg-drivers.md](./pg-drivers.md) | pg, postgres.js, own wire client | Thin adapter interface, `pg` as sole v1 adapter, ORM owns type decoding |
| [migrations.md](./migrations.md) | Cross-cutting migration landscape | Declarative diff → versioned SQL files, up-only, safety rails as the differentiator |

---

## 1. Landscape snapshot (verified 2026-08-14)

- **Prisma**: stable `prisma@7.9.1` (Rust query engine gone, driver adapters mandatory, ESM-only — but ~11× avg / ~27× p99 latency vs raw `pg` on Prisma's own benchmarks, open perf regression #28845). `prisma-next@8.0.0-rc.1` is the real rewrite: **PG-first GA, pure TS**, codec/extension packs, typed SQL builder, hash-graph TS migrations. Weekly downloads: Drizzle 18.2M has passed Prisma 16.0M.
- **MikroORM**: `v7.1.11` (v7 GA 2026-03). Dropped Knex, `@mikro-orm/core` now zero-dep, migrations brought in-house (umzug removed), `defineEntity` is the primary style (decorators demoted). Uses Kysely only as a SQL *runner*.
- **Drizzle**: `drizzle-orm@0.45.2` stable; **1.0 still unshipped after ~9.5 months of beta/RC** (rc.4). Zero runtime deps. 1.4k open issues. drizzle-kit rc ships **95 MB unpacked** — six dialect payloads to every Postgres user.
- **Kysely**: `0.29.5`. **Use ≥0.28.17 / 0.29.x only** — three high-severity SQL-injection advisories (JSON-path/identifier sanitization) fixed there. ESM-only since 0.29, TS ≥5.4, Node ≥22. Bus factor ≈1; maintainer has publicly refused donations and a 1.0.
- **Drivers**: `pg@8.23.0` healthy (43.7M dl/wk, pipelining shipped in 8.23). `postgres.js` effectively stalled (~4 commits in 2026, single maintainer). `@vercel/postgres` deprecated. Bun.sql has no type-parser hook (disqualifying). PgBouncer ≥1.24 supports protocol-level prepared statements in transaction mode **by default**.

**The macro trend, from three independent agents: the industry is abandoning multi-DB abstraction.** MikroORM v7 deleted its dialect layer's foundation (Knex). Prisma's v8 rewrite is PG-first. Drizzle's worst weaknesses all trace to its six-dialect intersection. pg-orm-ts's premise is not contrarian in 2026 — it's early-consensus.

---

## 2. Cross-tool feature matrix

| Dimension | Prisma 7 / next 8 | MikroORM 7 | Drizzle 0.45/1.0rc | Kysely 0.29 |
|---|---|---|---|---|
| **Schema source of truth** | `.prisma` DSL (closed; custom LSP) / TS in v8 | TS `defineEntity` (or decorators) | TS `pgTable` | None — types only (codegen from live DB) |
| **Type-safety mechanism** | Codegen (client emission) | Inference (`InferEntity`) | Inference (`$inferSelect/$inferInsert`) | Hand-written/generated `Database` interface, `ColumnType<S,I,U>` |
| **Query API** | Fluent client, nested writes | `em.find` filters + QueryBuilder | Dual: SQL-like core + relational (RQB) | Single typed SQL builder |
| **Relation loading** | `include`/`select` narrowing, LATERAL+`json_agg` | `populate` + `Loaded<T,hint>`, 2 strategies | RQB v2: LATERAL+`json_agg`, `defineRelations` | Manual: `jsonArrayFrom`/`jsonObjectFrom` helpers |
| **Migrations** | Diff via shadow DB (needs `CREATEDB`), SQL files, no down | Own diff engine + snapshots, `migration:check` | Snapshot-JSON diff, no advisory lock, single-txn (no CIC), no down | Programmatic `Migrator`, hand-written, no diffing |
| **PG DDL coverage** | Poor (CHECK 6.7yr open, RLS no, views withdrawn) | Good operators, phantom enum diffs | No triggers/functions/domains/composites/partitions/exclusions | N/A (you write the SQL) |
| **Runtime deps** | Heavy (WASM compiler ~2.4MB, 1.32MB gzip client) | core zero-dep, but +Kysely runner (42% of install) | Zero | Zero |
| **Type decoding** | Owned in core (neutralizes driver parsers) | Driver's | Owned in core (per-driver inconsistencies remain) | Explicitly declined — driver's problem |
| **Perf vs raw driver** | ~11× avg / 27× p99 (v7); v8 next ~1.7× | Not benchmarked here | Near-raw | Near-raw |
| **Health flags** | Perf regression open; two-Prisma split | 855k dl/wk vs 18M leaders | 1.0 limbo; 1.4k issues | Bus factor 1; no 1.0 ever |

---

## 3. Convergent design signals

These are the strongest findings because multiple agents hit them independently:

1. **Inference beat codegen.** Drizzle, MikroORM v7, and Kysely all derive types from TS values; Prisma's v8 rewrite is abandoning client emission. A codegen step is now a competitive liability, not a feature. *(Caveat: inference has a compile-time cost — see risk #1.)*
2. **`LATERAL` + `json_agg` is the relation-loading answer.** Prisma, Drizzle RQB v2, and our migrations/Mikro agents all converge on single-round-trip JSON nesting over both JOIN-dedup and select-in strategies. PG-only means we can commit to it without fallbacks.
3. **Skip Unit of Work / identity map.** MikroORM agent's explicit verdict after arguing both sides: batching and FK-ordering are recoverable via explicit `insertMany` / `ON CONFLICT` upserts / an opt-in `saveGraph()`, without ambient change tracking, `RequestContext`/ALS, flush semantics, or the memory profile.
4. **The ORM must own type decoding end-to-end.** Drizzle and Prisma both neutralize the driver's parsers and decode in core; Kysely declines to and inherits driver inconsistencies. `pg` pins `pg-types@2.2.0` (2019) whose `DATE` parser shifts days across timezones. Every column type gets a codec (encode + decode + TS type) owned by us.
5. **Migrations: declare in TS → diff → emit versioned SQL → review → apply. Up-only.** Every serious tool abandoned down migrations. The diff engine diffs against `pg_catalog` via shadow/temp-schema normalization (never *require* `CREATEDB` — Prisma's #1 migration complaint). Rename ambiguity is solved annotation-first (`renamedFrom`), with interactive prompts only as a TTY convenience.
6. **Driver: thin adapter interface, `pg` as sole v1 adapter, structurally typed.** Declare our own `PgLikePool` instead of importing `pg` types → zero deps and zero peer deps; Neon/Hyperdrive duck-type in for free. Own wire client scored last (4–7 months, and the real work — the type system — is needed regardless).
7. **Pooler safety is a first-class design axis.** No ORM auto-detects transaction pooling; all use manual flags. Adopt pgx-style **explicit query-execution modes** with a pooler-safe default: unnamed extended-protocol statements, Parse+Bind+Execute+Sync in one buffer (`pg` does this in 1 RTT; postgres.js `prepare:false` costs 2).
8. **Identifier and JSON-path positions are injection surface.** Kysely shipped three high-severity CVEs because its `sql` tag's parameterization guarantee didn't extend there. Those sanitizers are security-critical code with fuzz tests from day one.

---

## 4. Consolidated PORT / ADAPT / SKIP (by subsystem)

### Schema definition — TS-first, PG-complete
- **PORT:** Drizzle's `pgTable`-style builders + `$inferSelect`/`$inferInsert` + `.$type<T>()`; MikroORM's `defineEntity`/`InferEntity` fluent shape; first-class entities for views, matviews, sequences, enums, schemas, RLS policies, roles/privileges, COMMENTs; pgvector/PostGIS helpers.
- **PORT (differentiators no one has):** triggers, functions, domains, composite types, partitions, exclusion constraints, ranges/tsvector/money/bit — the full PG DDL surface, plus a raw-`sql/` DDL escape hatch compiled into the same diff IR.
- **ADAPT:** shallower/nominal table types (Drizzle's error spew is its own top complaint); Prisma-next's codec-descriptor extension API for custom types.
- **SKIP:** custom DSL + LSP (Prisma's closed-DSL backlog is the cautionary tale); decorators + `reflect-metadata`; `EntitySchema`; codegen emission.

### Type system & query layer
- **PORT:** Kysely's `ColumnType<Select,Insert,Update>`/`Generated<T>` model and expression-builder typing techniques; Prisma's exact `select`/`include` result narrowing; MikroORM's `Loaded<T, hint>` populate-state typing; PG operator vocabulary (`$ilike/$overlap/$contains/$hasKey`, `some/every/none`); TypedSQL — types from PG's describe protocol, **cached so CI needs no DB**; version-gated type errors via export-map (Kysely's trick).
- **ADAPT:** **unify the two query APIs** — one builder where relation-nesting is a *projection option* (closes Drizzle's RQB-can't-aggregate / core-returns-flat-rows seam); `sql<T>` must carry a real codec, not be a bare cast; `sql.raw` → `unsafeRaw`; tx-vs-db misuse prevented at type level; transactions with isolation levels + savepoints + retry-on-40001; explicit `serialize()`, no implicit `toJSON`.
- **SKIP:** UoW/identity map/ALS contexts; lazy loading via proxies; 16 lifecycle hooks (4 suffice); flush modes; Spring-style tx propagation; in-memory `distinct` (Prisma); three-null JSON handling; Decimal class instances in payloads.

### Migrations — the headline feature
- **PORT:** versioned `NNNN_name.sql` + fingerprinted `.plan.json` (SHA-256 from/to, hazard list, txmode); Squawk's lint rule catalog; Atlas's hazard severity taxonomy + `txmode`/`nolint` directives; MikroORM's snapshot solution to "generate N+1 while N is pending" + `migration:check` CI gate; drizzle-kit v1's typed `missing_hints` decision protocol (never hangs in CI); advisory-lock (`pg_advisory_xact_lock`) apply; per-file transactions **with `txmode none` for `CREATE INDEX CONCURRENTLY`**; `migrate baseline` and `migrate verify` (replay → assert empty diff — no bundled migrator ships this).
- **ADAPT:** shadow-DB normalization with 4-tier fallback ending in temp-schema (never require `CREATEDB`); `renamedFrom` annotations; checkpoints instead of destructive squashing; graphile-migrate's idempotent model for functions/triggers; data migrations first-class; `push` only as a labeled dev command.
- **SKIP:** down migrations; full-state JSON snapshots per migration (drizzle's 11k-line files); shelling out to Atlas (paywall) or migra (deprecated); multi-DB; PG <15.
- **Evaluate first:** `@supabase/pg-delta` (MIT, TS, ~30 object kinds incl. RLS/triggers/functions) — prototype against it before writing our own diff engine.

### Runtime & driver
- **PORT:** thin adapter interface (~300 LOC: 4 driver + 2 connection methods), structural `PgLikePool` typing, `pg` as sole v1 adapter; array row mode (all three major ORMs use it); ORM-owned codec registry replacing driver parsers; pgx-style explicit query-exec modes, pooler-safe default.
- **ADAPT:** binary result format where it pays (via `pg`'s per-query `binary: true`); LISTEN/NOTIFY and COPY exposed but documented as session-pooling-only.
- **SKIP:** own wire-protocol client (revisit post-v1 at most); postgres.js and Bun.sql as adapters (stalled / no parser hook); bundled Redis cache; hosted proxy services.

---

## 5. Why pg-orm-ts should exist (the gap, precisely)

1. **Full-PG DDL as managed schema.** Nobody manages triggers, functions, domains, composites, partitions, or exclusion constraints; Drizzle stops at the six-dialect intersection, Prisma's DSL backlog is measured in years. Real PG apps run a second, unmanaged migration path today.
2. **A lock-safe, operations-grade migration runner.** Advisory locks, CIC support, hazard linting, `verify`, `baseline` — every bundled migrator fails at least three of these.
3. **One query API where nesting is a projection option** — with aggregates. The Drizzle seam (RQB vs core builder) is unclaimed by anyone.
4. **End-to-end owned types: schema → codec → wire → result.** Single-DB focus makes guarantees possible that dialect-neutral cores structurally can't make (`numeric`/`timestamptz` decode identically everywhere, `DATE` never shifts a day).
5. **Relation load-state in the types** (`Loaded<T>`) on top of a Kysely-grade expression type system — the two best type ideas in the ecosystem have never shipped together.

## 6. Risks & cautionary tales

1. **TS compile cost is the #1 technical risk of the inference approach.** Drizzle: 41k type instantiations per schema; their fix grew `.d.ts` output 77%. Budget for type-perf benchmarks in CI from the first table builder.
2. **1.0 limbo and bus factor are adoption killers** (Drizzle 9.5 months of RC; Kysely's bus factor 1). Scope v1 brutally small and ship it.
3. **Diff-engine correctness is a long tail** (MikroORM's phantom enum diffs, Prisma's partial-index phantom migrations, drizzle's enum ordering broken in v1 beta). `migrate verify` + a diff explainer are the mitigations; hard objects (functions/views) start as idempotent repeatable migrations, not diffed objects.
4. **Perf is a feature users measure.** Prisma v7's 11×-vs-raw regression is an open wound; near-raw-driver overhead (Drizzle/Kysely-grade) is the bar.

## 7. Open questions for the next iteration

1. **API paradigm decision** — evidence points to: TS-code-as-schema, inference not codegen, no UoW, unified query builder with relational projection. Needs your sign-off before design.
2. **`@supabase/pg-delta`**: adopt, fork, or use as reference only? (It's alpha; prototype week 1.)
3. **Runtime floor**: ESM-only + Node ≥22 (where the ecosystem landed) — acceptable?
4. **v1 cut line**: which of the differentiators (§5) are v1 vs v2? Suggested v1: schema DSL + codecs + query builder + migration engine with safety rails; defer entity generator, seeding, MCP surface.
