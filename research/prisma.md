# Prisma ORM — Research Dossier for `pg-orm-ts`

> **Historical snapshot — 2026-08-14. Not maintained.**
> This is a point-in-time study of software we do not control; version numbers, APIs and bug
> reports below were accurate on that date and will drift. It is kept as the provenance for the
> decisions in [`../design/`](../design/), not as a current reference. Conclusions that survived
> review are carried into [`SUMMARY.md`](./SUMMARY.md) and cited from the design docs.

**Date of research: 2026-08-14**
**Versions verified against npm registry on 2026-08-14.**

| Package | Version | Unpacked size | Notes |
|---|---|---|---|
| `prisma` (CLI) | **7.9.1** (`latest`) | 43.8 MB | deps: `@prisma/engines`, `@prisma/config`, `@prisma/dev`, `@prisma/studio-core`, **`mysql2`**, **`postgres`** |
| `@prisma/client` | **7.9.1** | 78.4 MB | dep: `@prisma/client-runtime-utils` only |
| `@prisma/adapter-pg` | **7.9.1** | 70.8 KB | deps: `pg`, `@types/pg`, `postgres-array`, `@prisma/driver-adapter-utils` |
| `prisma-next` (CLI) | **8.0.0-rc.1** (published 2026-08-07) | 15.7 KB | dep: `@prisma/orm-toolchain@8.0.0-rc.1` |
| `@prisma-next/*` (runtime packages) | **0.16.0** | — | ~40 packages, separate repo `prisma/prisma-next` |
| `prisma` `dev` tag | 7.10.0-dev.49 | — | |
| `prisma` `prev` tag | 6.19.2 | — | v6 LTS-ish line |

npm weekly downloads, week of 2026-08-03 → 2026-08-09 (from `api.npmjs.org`):

| Package | Downloads/week |
|---|---|
| `drizzle-orm` | **18,171,638** |
| `prisma` | 16,009,816 |
| `@prisma/client` | 15,046,090 |
| `kysely` | 12,542,505 |
| `prisma-next` | 7,448 |

> **Headline:** Drizzle has overtaken Prisma on raw npm downloads. Prisma's response is *Prisma Next* — a full TypeScript rewrite that is, in most respects, converging on the exact design thesis behind `pg-orm-ts`: PostgreSQL-first, no engines, extension-based DB feature support, schema-as-artifact, SQL builder as a first-class escape hatch. We should read Prisma Next as our closest competitor and our best source of validated design decisions, and read Prisma 7 as the archive of mistakes to avoid.
>
> **Second headline, and the one that surprised me most:** by Prisma's own published benchmarks, **Prisma 7 is ~11× the average latency and ~27× the p99 of raw `pg`, and materially *slower* than Prisma 6** — a regression Prisma's own engineer reproduced and acknowledged within a week ([#28845](https://github.com/prisma/prisma/issues/28845), still open). The "3× faster, Rust-free" launch story does not survive contact with the numbers. See §5.3 — it is the most decision-relevant section in this document.

**Conventions used below.** 👍 = the GitHub `reactions["+1"]` count, fetched live from `api.github.com` on 2026-08-14. Where a "total reactions" figure is also quoted it is labelled as such — several widely-circulated counts for these issues are the larger `total_count`, so numbers here may read lower than in other write-ups.

---

## 0. Executive summary — the two Prismas

There are **two distinct products** wearing the Prisma name right now, and any research that conflates them is wrong.

### Prisma 7 (`prisma@7.9.1`) — current stable, production-recommended
- Released 7.0.0 on **2025-11-19** ([changelog](https://www.prisma.io/changelog/2025-11-19), [announcement](https://www.prisma.io/blog/announcing-prisma-orm-7-0-0)).
- The Rust **query engine** is gone; queries are compiled to SQL by a TypeScript/WASM **Query Compiler**.
- **Driver adapters are now mandatory** — `@prisma/adapter-pg` etc. Prisma no longer owns the socket.
- Ships as **ESM only**. Requires Node ≥ 20.19.0, TypeScript ≥ 5.4.
- Generator renamed `prisma-client-js` → `prisma-client`; `output` path is now **required** and defaults out of `node_modules` into your source tree.
- New `prisma.config.ts` replaces datasource config in the schema.
- Client middleware (`$use`) **removed**; only `$extends` remains.
- Still multi-database: PostgreSQL, MySQL, MariaDB, SQL Server, SQLite, MongoDB, CockroachDB.
- Still uses a **Rust `schema-engine` binary** for `migrate`/`db pull` (the `prisma` CLI still depends on `@prisma/engines` → `@prisma/fetch-engine`). "Rust-free" applies to the *client*, not the *migration tooling*.

### Prisma Next / Prisma 8 (`prisma-next@8.0.0-rc.1`) — RC as of Aug 2026
- Announced 2026-03-04 ([The Next Evolution of Prisma ORM](https://www.prisma.io/blog/the-next-evolution-of-prisma-orm)); roadmap in [Prisma Next Roadmap](https://www.prisma.io/blog/prisma-next-roadmap).
- **Full TypeScript rewrite**, separate repo (`github.com/prisma/prisma-next`), separate npm scope (`@prisma-next/*`), separate docs tree (`/docs/orm/next`, `/docs/next`).
- **PostgreSQL is the primary target and is GA**; MongoDB early access; SQLite PoC; MySQL later.
- **Minimal core + extension packs.** Database support itself is an extension. Real published packs today: `@prisma-next/extension-pgvector`, `@prisma-next/extension-postgis`, `@prisma-next/extension-paradedb` (full-text), `@prisma-next/extension-supabase`, `@prisma-next/extension-arktype-json`, `@prisma-next/extension-cipherstash` (encrypted columns).
- Schema authored in **PSL *or* TypeScript**, compiled to a **"contract"**: `contract.json` (deterministic machine-readable IR) + `contract.d.ts` (types). The contract is the artifact everything else reads.
- Query API is **method-chaining** (`.where().select().take().all()`) rather than nested object literals.
- Results are **both a Promise and an async iterator** — `await` to buffer, `for await` to stream.
- A **typed SQL builder** (`db.sql.*`) sits beside the ORM (`db.orm.*`), with `innerJoin`/`outerLeftJoin`/`lateralJoin`, `groupBy`/`having`, subqueries-as-joins, and `fns.raw` fragments.
- **Graph-based migrations** keyed by schema-state hashes rather than a linear timestamp list; migrations authored in TypeScript (`migration.ts`) and compiled to `ops.json`; every op has precheck/execute/postcheck.
- Prisma 8 (2026-08-02 changelog) added **expression indexes, partial (`WHERE`) indexes, and unique indexes in the schema**, and `contract infer` reads back expression/partial/unique indexes **and RLS policies**. It also **removed `@db.*` native-type attributes** in favour of putting native types in type position (`String @db.Uuid` → `Uuid`).

**Implication for us:** Prisma has publicly conceded most of the multi-DB-abstraction critique. Our differentiation cannot be "PG-only + TypeScript + no engines" alone — Prisma Next is that. It has to be execution: smaller, simpler, no vendor cloud pull, no contract-signing ceremony, and a migration story that people can reason about.

---

## 1. Schema definition — the `schema.prisma` DSL

### 1.1 What PSL expresses well

PSL is genuinely the best-in-class *declarative relational data model DSL* in the JS ecosystem, and this is Prisma's single strongest asset:

- **Terse, readable, reviewable.** A model block reads like a table definition; a PR diff of a schema change is legible to a non-author. This is a real, underrated advantage over TypeScript builder DSLs (Drizzle), where a column-type change is buried in method chains.
- **Relations are declared once, bidirectionally, at the model level** — `@relation(fields:, references:, onDelete:, onUpdate:)`. Implicit many-to-many (`Post[]` ↔ `Category[]`) auto-manages a join table.
- **Referential actions** map cleanly to PG (`Cascade`, `Restrict`, `NoAction`, `SetNull`, `SetDefault`), on both `onDelete` and `onUpdate`.
- **First-class formatter and language server.** `prisma format`, `prisma validate`, and the VS Code extension give inline errors, autocompletion, and jump-to-model. This is a major DX moat.
- **Composite keys/uniques** (`@@id`, `@@unique`), **named constraints** (`map:`), **enums**, **native arrays** (`String[]`), **multi-schema** (`@@schema`, GA since 6.13.0).
- **`@@map` / `@map`** decouple DB naming (snake_case) from client naming (camelCase) — essential for adopting existing databases.
- **Schema folders** (`prismaSchemaFolder`, GA 6.7.0) — split a large schema across multiple `.prisma` files.

### 1.2 What PSL cannot express (PostgreSQL gaps)

Source: [Database features matrix](https://www.prisma.io/docs/orm/reference/database-features), [Indexes](https://www.prisma.io/docs/orm/prisma-schema/data-model/indexes), [Unsupported database features](https://www.prisma.io/docs/orm/prisma-schema/data-model/unsupported-database-features).

| PG feature | Prisma 7 schema | Prisma 7 Migrate | Prisma 8 / Next | Notes |
|---|---|---|---|---|
| `PRIMARY KEY`, `FOREIGN KEY`, `UNIQUE`, `NOT NULL`, `DEFAULT` | ✅ | ✅ | ✅ | |
| Referential actions | ✅ | ✅ | ✅ | |
| B-tree / Hash / GiST / GIN / SP-GiST / BRIN via `type:` | ✅ | ✅ | ✅ | |
| Operator classes (GIN/GiST/SP-GiST/BRIN), `ops:` + `raw("...")` escape | ✅ | ✅ | ✅ | Good design: enumerated common opclasses, `raw()` fallback |
| **Partial indexes** (`WHERE`) | ⚠️ preview `partialIndexes` (7.4.0) | ⚠️ | ✅ GA in v8 | ~7 years after first request |
| **Expression / functional indexes** (`lower(email)`, `to_tsvector(...)`) | ❌ | ❌ | ✅ new in v8 (`@@index(expression: "lower(email)")`) | Was the #1 PG index gap |
| `INCLUDE` (covering) indexes | ❌ | ❌ | ❌ (unverified in v8) | |
| **`CHECK` constraints** | ❌ | ❌ | ❌ (unverified in v8) | [#3388](https://github.com/prisma/prisma/issues/3388), **294 👍**, open since 2020. Introspection-tolerant only; must be added via raw SQL in a migration |
| **`EXCLUDE` constraints** | ❌ | ❌ | ❌ | Docs explicitly: *"Prisma does not introspect exclusion constraints as GiST indexes"* |
| **Generated / computed columns** | ❌ | ❌ | ❌ | [#3394 "Virtual computed fields"](https://github.com/prisma/prisma/issues/3394) is a top-10 issue by reactions |
| **Triggers / functions** | ❌ | ❌ | ❌ | Raw SQL in migrations only; invisible to the model |
| **Views** | ⚠️ preview `views` since **4.9.0 (Jan 2023)** | ❌ (must hand-write DDL) | — | *Still preview after 3.5 years.* All writes disabled. [#678](https://github.com/prisma/prisma/issues/678) (closed after **6.2 yrs**), [#17335 preview feedback](https://github.com/prisma/prisma/issues/17335) (89 👍, **95 comments**). **Relations to views were added in 6.14.0 and then taken away** — see below |
| Materialized views | ❌ | ❌ | ❌ | |
| **RLS policies** | ❌ | ❌ | ⚠️ v8 `contract infer` *reads* RLS policies | [#12735](https://github.com/prisma/prisma/issues/12735), **166 👍**. Community solves via `$extends` + `SET LOCAL` (`yates`, `prisma-rls`) |
| **Extensions** (`pgvector`, PostGIS, …) | ⚠️ `postgresqlExtensions` preview: `extensions = [vector]` creates the extension; the *type* is `Unsupported("vector(3)")` | partial | ✅ Next has real extension packs | v7 pgvector columns are unreadable by the client and break Prisma Studio |
| Partitioning, deferrable constraints, sequences with custom params, stored procedures | ❌ | ❌ | ❌ | |
| Domains, composite types | ❌ | ❌ | ❌ | |

**Preview-feature backlog as a signal of DSL debt** ([preview features reference](https://www.prisma.io/docs/orm/reference/preview-features/client-preview-features)):

| Feature | In preview since | Still preview in 7.9.1? |
|---|---|---|
| `views` | 4.9.0 (Jan 2023) | yes (~3.5 yr) |
| `relationJoins` | 5.7.0 (Dec 2023) | yes (~2.7 yr) |
| `nativeDistinct` | 5.7.0 | yes |
| `typedSql` | 5.19.0 (Sep 2024) | yes (~2 yr) |
| `strictUndefinedChecks` | 5.20.0 | yes |
| `fullTextSearchPostgres` | 6.0.0 | yes |
| `shardKeys` | 6.10.0 | yes |
| `partialIndexes` | 7.4.0 (2026) | yes |

GA'd recently: `driverAdapters` (5.4.0 → 6.16.0), `multiSchema` (4.3.0 → 6.13.0), `prismaSchemaFolder` (5.15.0 → 6.7.0), `omitApi` (5.13.0 → 6.2.0), `tracing` (4.2.0 → 6.1.0).

**Two cautionary tales about shipping a schema feature late and half-built:**

- **Views relations were added, then removed.** Prisma 6.14.0 announced [Relationships for SQL Views](https://www.prisma.io/blog/prisma-orm-v6-14-0-relationships-for-sql-views-more-robust-management-api-and-more); the capability was then withdrawn, producing [#27768 "Return the relationship to VIEW"](https://github.com/prisma/prisma/issues/27768) (54 👍, opened 2025-07-29, **still open**) — *"Now my .prisma file has errors everywhere: The field `bonus` is part of a relation that references a view. Relations currently cannot be used with views."* Companions: [#27806](https://github.com/prisma/prisma/issues/27806), [#27839](https://github.com/prisma/prisma/issues/27839), [#27782](https://github.com/prisma/prisma/issues/27782), [#27821](https://github.com/prisma/prisma/issues/27821) (*"each view must have at least one unique criteria"* — a modelling constraint views don't actually have), [#18758](https://github.com/prisma/prisma/issues/18758) (materialized views, 33 👍). **A regression on a preview feature that had already been in preview for 2.5 years.**
- **Partial indexes shipped in 7.4.0 and were immediately buggy.** After [#6974](https://github.com/prisma/prisma/issues/6974) (471 total reactions) closed in Feb 2026 following a **4.8-year** wait: [#29263 "Prisma 7.4 Partial Indexes are bugged during migrations"](https://github.com/prisma/prisma/issues/29263), then [#29446 "**Prisma 7.7 Unique Partial Indexes still bugged**"](https://github.com/prisma/prisma/issues/29446) (open) — *"still causes infinite prisma migrate schema regeneration"* — plus [#29289](https://github.com/prisma/prisma/issues/29289) / [#29220](https://github.com/prisma/prisma/issues/29220) (migrations drop manually-created partial indexes) and [#13417](https://github.com/prisma/prisma/issues/13417) (partial unique indexes recreated on every migration, open since 2022).

> **The pattern to avoid: a schema feature that lands in the DSL before the migration differ can round-trip it produces *infinite phantom migrations*, which is worse than not having the feature.** Whatever we put in the schema language must be introspectable and diff-stable on day one, or it doesn't ship.

> **Lesson:** a closed DSL creates a *permanent* feature backlog. Every PG capability becomes a Prisma roadmap item, and the queue never drains. `partialIndexes` — a two-token `WHERE` clause — took until 2026. This is the single most important structural failure to avoid.

### 1.3 The `Unsupported` escape hatch

```prisma
model Item {
  id        Int                       @id @default(autoincrement())
  embedding Unsupported("vector(3)")?
}
```

Semantics:
- Prisma Migrate **will emit the DDL** for the column (`vector(3)`), so `migrate dev` / `db push` won't drop it.
- The field is **entirely absent from the generated client** — you cannot select it, filter it, or write it. All access is via `$queryRaw` / `$executeRaw`.
- If the column is `NOT NULL` without a default, `create()` becomes impossible via the client — you're forced into raw SQL for inserts.
- **Prisma Studio breaks** on tables containing `Unsupported` extension types (deserialization error).
- Introspection (`db pull`) emits `Unsupported(...)` for anything it can't map, so it's also the "I saw this but I don't understand it" marker.

Adjacent escape hatches:
- **`@@ignore` / `@ignore`** — model/field is kept in the schema for round-tripping but excluded from the client entirely.
- **`externalTables` / `enums.external`** (experimental, `prisma.config.ts`) — declare tables/enums as *managed outside Prisma Migrate*; queryable but ignored by diffing. This is a genuinely good idea for coexisting with DBA-owned or extension-owned objects.
- **`migrations.initShadowDb`** (`prisma.config.ts`) — SQL run against the shadow DB before diffing, the standard workaround for `CREATE EXTENSION` and other objects Prisma can't recreate.

> **Assessment:** the *existence* of a typed escape hatch is right. The *shape* is wrong: `Unsupported` is binary — it drops you from full type safety straight to raw strings, with no middle tier. A PG-only ORM should offer a **codec/type-extension API** so that `vector`, `tsvector`, `ltree`, `citext`, `inet`, ranges, `hstore`, domains and composite types are *user-registrable first-class types* with an encoder/decoder pair, not an opaque hole. Prisma Next has essentially conceded this: `codecRef: { codecId: 'pg/text@1' }` appears in its migration ops, and extension packs (`extension-pgvector`, `extension-postgis`) register real types.

### 1.4 Prisma Next: PSL *and* TypeScript authoring

Prisma Next keeps PSL and adds a TypeScript authoring surface (`@prisma-next/sql-contract-ts`):

```ts
import { defineContract, field, model } from '@prisma-next/sql-contract-ts/contract-builder';

export default defineContract({
  models: {
    User: model({
      id:    field.column(int4Column()).id(),
      email: field.column(textColumn()),
      name:  field.column(textColumn()).optional(),
    }),
  },
  // families, targets, extension packs...
});
```

Both compile to the same `contract.json` + `contract.d.ts`. Prisma 8 also introduced `constraints.index({ expression: "lower(email)", name: "...", type: "btree" })` as the TS equivalent of `@@index(expression: ...)`.

> **This dual-authoring bet is the interesting one.** It concedes that (a) a DSL is better for reviewability and (b) TypeScript is better for composition/extensibility — and resolves it by making *neither* canonical, with an IR (`contract.json`) as the true source of truth. For `pg-orm-ts`, the IR-as-canonical-artifact idea is worth stealing even if we pick only one authoring surface.

---

## 2. Type safety mechanism

### 2.1 The codegen pipeline

1. Parse `schema.prisma` → internal DMMF (Data Model Meta Format) JSON.
2. `prisma generate` runs each `generator` block. The `prisma-client` generator (v7) emits **many small `.ts` files** into a user-specified `output` directory (v6 and earlier emitted one giant `index.d.ts` into `node_modules/.prisma/client`).
3. The emitted types are heavily **conditional/mapped types**: for every model there is `UserSelect`, `UserInclude`, `UserWhereInput`, `UserWhereUniqueInput`, `UserOrderByWithRelationInput`, `UserCreateInput`, `UserUncheckedCreateInput`, `UserUpdateInput`, `UserCreateNestedManyWithout…Input`, `UserGetPayload<T>`, `UserAggregateArgs`, `UserGroupByArgs`, … roughly O(n_models × n_relations) type surface.
4. `GetResult` / `GetPayload` machinery narrows the return type from the literal `select`/`include` argument. This is the core magic: `prisma.user.findMany({ select: { id: true, posts: { select: { title: true } } } })` returns exactly `{ id: number; posts: { title: string }[] }[]`.

**Cost of the codegen step:**
- Must be run after **every** schema change, and after `npm install` (a `postinstall` hook is conventional). Forgetting it is the single most common newbie failure.
- In v7 the output lives **in your source tree** — this fixed HMR/watcher staleness but means generated code is now either committed (noisy diffs) or gitignored (CI must generate before typecheck; every CI job needs a `prisma generate` step).
- Monorepos: generated client path resolution has historically been a recurring source of bug reports; v7's mandatory explicit `output` makes it more predictable but more verbose.
- The generated tree is large. For big schemas this is measured in tens of thousands of lines.

**TypeScript performance.** Prisma's own [troubleshooting page](https://www.prisma.io/docs/orm/more/troubleshooting/typescript-performance) exists specifically for this. Long-running issue [#4807 "Large schemas generate huge `index.d.ts` causing slow autocomplete and type-checking"](https://github.com/prisma/prisma/issues/4807). Prisma 7 claims a substantial fix (with David Blass of ArkType): **~98% fewer types to evaluate a schema, ~45% fewer types for query evaluation, ~70% faster type-checking** ([v7 announcement](https://www.prisma.io/blog/announcing-prisma-orm-7-0-0)), and a marketing post claiming [Prisma checks types 72% faster than Drizzle](https://www.prisma.io/blog/why-prisma-orm-checks-types-faster-than-drizzle). **The counter-signal is severe, and its resolution date matters: `7.9.0`, two months ago.** [#29011 "Prisma 7 much worse on typescript compilation"](https://github.com/prisma/prisma/issues/29011) (opened 2026-01-08) reported, on a real 406-model / ~9,300-line schema, v6 → v7.2.0: tsc **60.2 s → 63.0 s**, memory **5,531 MB → 7,298 MB (+32%)**, total types **1.59 M → 5.09 M (+221%)**, instantiations **11.4 M → 30.2 M (+164%)**.

It was fixed by [**PR #29592**](https://github.com/prisma/prisma/pull/29592), merged **2026-06-01** and shipped in **7.9.0**. The PR's own numbers show how bad the intervening period was: instantiations **32,823,262 → 2,650,891 (12.4×)**, check time **16.97 s → 2.47 s**, memory **4,610 MB → 2,193 MB**; full-project `tsc 5.9.2` went from **OOM / >2 min → 9.0 s**.

The root cause is worth internalising. In [#28375](https://github.com/prisma/prisma/pull/28375) (the PR that removed the library engine), a single generic default changed:

```diff
-  in out OmitOpts extends Prisma.PrismaClientOptions['omit'] = Prisma.PrismaClientOptions['omit'],
+  in out OmitOpts extends Prisma.PrismaClientOptions['omit'] = undefined,
```

Because `undefined` is structurally distinct from the constraint type, **TypeScript could no longer reuse cached instantiations** and re-evaluated the full generic chain for every model. *One incidental token in an unrelated PR made large-schema Prisma 7 uncompilable for roughly six months* (Nov 2025 → Jun 2026).

> **This is the single best argument in this document against getting your type safety from a large emitted generic graph.** The failure was invisible in review, unattributable to any feature, and only diagnosable by someone willing to bisect TypeScript's instantiation cache. A design whose types come from inference over a small schema value has a far smaller blast radius for this class of accident.

Related, still open: [#28581 "[Prisma 7.0.0] TypeScript TS2742 errors with pnpm monorepo"](https://github.com/prisma/prisma/issues/28581) (68 👍, 41 comments, opened on release day, active 2026-07-30) — *"The inferred type of 'DbNull' cannot be named without a reference to '.pnpm/@prisma+client-runtime-utils@7.0.0/…'. This is likely not portable."* Worked on 6.19.0. Also [#23369 "Client Extensions Destroy TypeScript Compilation Performance"](https://github.com/prisma/prisma/issues/23369) — **closed as not planned**, reporting ~15× check-time growth (0.12 s → 1.79 s) from adding trivial extensions — [#26697 `TS2589` from too many `$extends`](https://github.com/prisma/prisma/issues/26697), [#16536](https://github.com/prisma/prisma/issues/16536) (`$extends` + `declaration: true` → *"Inferred type of this node exceeds the maximum length the compiler will serialize"*, which breaks library authors), and [#28967](https://github.com/prisma/prisma/issues/28967) (inference collapses when `PrismaClient` is unioned with `TransactionClient` — i.e. any shared repository function). Field reports of generated output: [#17562](https://github.com/prisma/prisma/issues/17562) at **191,835 lines / 7.3 MB**; [prisma-client-js#524](https://github.com/prisma/prisma-client-js/issues/524) at 350 models → **27 MB / ~500,000 lines**, 20 s JS startup, 45 s tsc.

Prisma's docs concede the threshold explicitly: at *"50+ tables"*, expect *"compilation times exceeding several minutes"*, *"IDE responsiveness degrading significantly"*, *"CI/CD pipelines timing out on type checks."*

**A live type-safety hole in v7's new generator:** [#29519 "[v7 prisma-client] Non-existent fields in `select` do not produce a TypeScript error"](https://github.com/prisma/prisma/issues/29519). The v7 type rewrite that made checking faster also loosened excess-property checking on `select`, so typos in a `select` silently do nothing. This is exactly the trade-off to be aware of when optimising a codegen type graph for speed: **narrowing precision and error precision are different properties, and Prisma traded the second for tsc time.**

> **Takeaway:** the *result* (exact narrowing from a literal argument) is worth having; the *cost model* (giant generated conditional-type graph) is the thing that makes it painful. Any design that gets exact narrowing from **inference over a small schema object** rather than **emitted per-model type permutations** wins on tsc time.

### 2.2 Where types lie or degrade

| Site | Problem |
|---|---|
| **`Json` fields** | Typed as `Prisma.JsonValue` = `string \| number \| boolean \| null \| JsonObject \| JsonArray`. There is **no way to declare the shape** of a JSON column in PSL. Top-10 issue by reactions: [#3219 "Define type of content of `Json` field"](https://github.com/prisma/prisma/issues/3219); also [#13446 "Strongly typed `Json` fields"](https://github.com/prisma/prisma/issues/13446). Community workaround: `prisma-json-types-generator` (post-processes generated types). Additional footgun: three distinct nulls — `Prisma.JsonNull` (JSON `null`), `Prisma.DbNull` (SQL `NULL`), `Prisma.AnyNull` (filter matching either). Also [#6416](https://github.com/prisma/prisma/issues/6416): `Prisma.JsonValue` is incompatible with `JSON.parse`'s declared return type. **Prisma Next's answer is `@prisma-next/extension-arktype-json`** — a JSON-with-schema column factory built on ArkType. |
| **`Decimal`** | Returned as a `Prisma.Decimal` (decimal.js) instance, **not** a `number` or `string`. Breaks `JSON.stringify` ([#9170 `"[object Decimal]" cannot be serialized as JSON`](https://github.com/prisma/prisma/issues/9170)), breaks Next.js server→client serialization, breaks equality checks, and requires importing Prisma's namespace anywhere you touch money. Serialization boundary pain is inherent to *any* arbitrary-precision choice, but Prisma's is unusually invasive because the type leaks into every payload. |
| **`BigInt`** | Native `bigint`; `JSON.stringify` throws without a custom replacer. Same class of problem. |
| **`Bytes`** | `Uint8Array` (changed from `Buffer` in v6) — a silent breaking change for many codebases. |
| **`DateTime`** | Long-standing [#9516](https://github.com/prisma/prisma/issues/9516): cannot pass ISO strings where `Date` is expected. No `DATE`-vs-`TIMESTAMPTZ` distinction at the TS level — both become `Date`. |
| **Raw queries** | `$queryRaw<T>` returns `T` with **no verification whatsoever** — a pure type assertion. `$queryRawUnsafe` is worse. Field types come back with PG-driver-level coercions that don't match the model's mapped types (e.g. `BigInt` from `COUNT(*)`, `Decimal` from `NUMERIC`, `Date` handling). This is where Prisma's type safety fully evaporates. |
| **`$extends` result fields** | Computed fields added via a `result` extension are typed, but composing several extensions degrades inference and inflates tsc time. Nested read/write operations are **not supported** in `query` extensions. |
| **`distinct`** | **Not `SELECT DISTINCT`** — Prisma post-processes in memory. Correct-looking types, wrong performance semantics, and wrong interaction with `take` (you can silently get fewer rows than requested). `nativeDistinct` has been in preview since 5.7.0. |
| **`Unsupported(...)`** | Field vanishes from the client entirely. |

### 2.3 TypedSQL (`prisma generate --sql` + `$queryRawTyped`)

Prisma's answer to the raw-query type hole, in preview since **5.19.0 (Sep 2024)** — still preview in 7.9.1. Source: [TypedSQL docs](https://www.prisma.io/docs/orm/prisma-client/using-raw-sql/typedsql).

**How it works:**
1. `previewFeatures = ["typedSql"]`.
2. Put `.sql` files in `prisma/sql/` (path configurable via `prisma.config.ts` → `typedSql.path` since 6.12.0). Filenames must be valid JS identifiers.
3. `prisma generate --sql` (`--watch` supported). **It connects to a live database** and uses PostgreSQL's `PREPARE`/describe protocol to learn parameter and result types.
4. Import the generated function and run `prisma.$queryRawTyped(getUsersByAge(18))`.

```sql
-- prisma/sql/getUsersByAge.sql
-- @param {Int} $1:minAge The minimum age
SELECT id, name, age FROM "User" WHERE age >= $1;
```

**Strengths:**
- Explicitly modelled on **PgTyped** and **SQLx** — types derived from the *database*, not from a hand-written assertion. This is the correct architecture.
- `.sql` files are real SQL: they run in psql, TablePlus, DataGrip. Reviewable, greppable, lintable.
- Handles PG array params via `= ANY($1)`.

**Limitations:**
- **Requires a live DB connection at codegen time.** CI needs a database. This is the biggest adoption blocker and the thing that keeps it in preview.
- **No dynamic SQL** — you cannot vary the column list or add optional `WHERE` fragments at runtime. Fall back to `$queryRawUnsafe`.
- Parameter type inference is best on PostgreSQL; MySQL < 8.0 and SQLite need manual `-- @param` annotations (multi-DB tax again).
- Nullability inference from PG's describe output is approximate — PG will often report a column as nullable when a join guarantees it isn't, and vice versa.
- No composability: you cannot build a query from typed fragments.

> **Verdict preview: this is the single best idea in Prisma's type-safety story and we should port it — with the connection requirement solved.** A PG-only tool can afford to (a) cache the describe results in a committed artifact so CI doesn't need a DB, and (b) offer an offline mode that type-checks against the schema IR for the subset of SQL it can parse.

---

## 3. Query API

### 3.1 The fluent client (Prisma 7)

```ts
const users = await prisma.user.findMany({
  where: { email: { endsWith: "@prisma.io" }, posts: { some: { published: true } } },
  select: { id: true, email: true, posts: { select: { title: true }, take: 3 } },
  orderBy: { createdAt: "desc" },
  skip: 20, take: 10,
});
```

**What's genuinely excellent:**
- **Exact return-type narrowing** from the literal `select`/`include` argument. Best-in-class; the thing everyone actually stays for.
- **Nested writes are transactional by construction.** `create`, `createMany`, `connect`, `connectOrCreate`, `disconnect`, `set`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany` — expressed declaratively inside a parent write, executed atomically. Writing the equivalent by hand is genuinely tedious.
- **Relation filters** read like English: `some` / `every` / `none` for to-many, `is` / `isNot` for to-one. `none: {}` = "has no related rows".
- **`_count` on relations**, filterable (`_count: { select: { posts: { where: { published: true } } } }` since 4.3.0).
- **`omit`** (GA 6.2.0) — the inverse of `select`, so you can say "everything except `passwordHash`" without enumerating 40 columns. Big ergonomic win.
- **`relationLoadStrategy`** (`relationJoins` preview, PG/CockroachDB/MySQL): `"join"` (single query, PG `LATERAL` + `json_agg`) vs `"query"` (n+1 queries merged in app). Once the flag is on, `join` is the per-query default. **This is Prisma's answer to the N+1 criticism, and it works** — but it's still a preview flag 2.7 years in, and the generated SQL is famously unreadable ([#23565](https://github.com/prisma/prisma/issues/23565)).

**What's weak:**
- **`select` and `include` cannot be used at the same level.** A constant papercut; you nest `select` inside `include` to work around it.
- **`groupBy` cannot use `select`** — only the `by` fields plus aggregates come back. Cannot select-and-group. [#24816](https://github.com/prisma/prisma/issues/24816).
- **`distinct` is in-memory, not SQL.** See §2.2.
- **No `upsertMany`** — top-10 issue [#4134](https://github.com/prisma/prisma/issues/4134). PG has `INSERT ... ON CONFLICT DO UPDATE` natively; Prisma's `upsert` is single-row and (for a long time) was emulated with SELECT-then-write rather than `ON CONFLICT`.
- **No `UNION`** — [#2505](https://github.com/prisma/prisma/issues/2505), top-10 by reactions.
- **No CTEs, no window functions, no recursive queries.** Not expressible at all; drop to raw.
- **No polymorphic associations** — [#1644](https://github.com/prisma/prisma/issues/1644), one of the oldest top-voted issues.
- **No computed/virtual fields in the schema** — [#3394](https://github.com/prisma/prisma/issues/3394). `$extends`'s `result` component is the workaround, but it computes in JS, not SQL, so you can't filter or sort by it.
- **`createMany` cannot create nested relations** — [#5455](https://github.com/prisma/prisma/issues/5455).
- **Aggregates only on numeric fields**; `having` restricted to aggregates + `by` fields; `skip`/`take` with `groupBy` require `orderBy`.
- **No `RETURNING` control**; `createManyAndReturn`/`updateManyAndReturn` were bolted on later and don't cover all cases.
- The nested-object API **does not compose**. You cannot build a `where` from fragments in a type-safe way without wrestling `Prisma.UserWhereInput` by hand, and conditional filters devolve into spread-with-`undefined` (hence the `strictUndefinedChecks` preview flag, added because passing `undefined` silently *removed* a filter — a genuine data-leak class of bug).

### 3.2 `$extends` client extensions

Replaced the removed `$use` middleware. Four component types ([docs](https://www.prisma.io/docs/orm/prisma-client/client-extensions)):

| Component | Purpose |
|---|---|
| `model` | custom methods on a model (`prisma.user.signUp(...)`) |
| `client` | top-level client methods (`prisma.$log(...)`) |
| `query` | intercept/wrap queries — the middleware replacement; **does not support nested read/write operations** |
| `result` | add computed fields to results (computed in JS) |

`$extends` returns a **new client instance** with a new type; extensions compose FIFO, last declaration wins on conflict. Type helpers `Prisma.Result<...>`, `Prisma.Args<...>`, `Prisma.Payload<...>` let you recover the extended shapes.

Real-world uses: RLS session variables (`SET LOCAL app.tenant_id`), soft deletes, read replicas (`@prisma/extension-read-replicas`), pagination (`prisma-extension-pagination`), field encryption, Accelerate.

**Problems:** each `$extends` call re-instantiates types, so stacking 4–5 extensions is a well-known tsc cost; `client`-level methods aren't statically guaranteed to exist on an extended client (docs literally say "check for existence before using"); no nested-operation interception means soft-delete extensions are famously incomplete.

### 3.3 Transactions

Source: [Transactions docs](https://www.prisma.io/docs/orm/prisma-client/queries/transactions).

Three mechanisms:
1. **Nested writes** — implicit transaction around a parent write and its nested relation ops.
2. **Sequential `$transaction([q1, q2, ...])`** — array of queries, executed in order in one transaction. Cannot pass generated IDs between steps.
3. **Interactive `$transaction(async (tx) => { ... })`** — full control, automatic rollback on throw.

Options: `isolationLevel` (PG: `ReadUncommitted`, `ReadCommitted` (default), `RepeatableRead`, `Serializable`), `maxWait` (default **2000 ms** — time to acquire a connection), `timeout` (default **5000 ms** — max transaction runtime).

**Caveats:**
- The **5-second default timeout** is a recurring production surprise; long backfills inside `$transaction` fail with `P2028`.
- `Promise.all` inside `$transaction` executes **serially** (one connection), so it looks parallel and isn't.
- No `SAVEPOINT` / nested-transaction support; no `SET LOCAL` without an extension; no advisory-lock helpers.
- No retry-on-serialization-failure helper despite offering `Serializable`, which in PG *requires* retry logic (40001). Users must build this themselves.

### 3.4 Prisma Next's query API

```ts
// ORM lane
const posts = await db.orm.public.Post.where({ published: true }).all();
const user  = await db.orm.public.User.where({ email: "alice@prisma.io" }).first();
const page  = await db.orm.public.User.select("id","email").orderBy(...).cursor(...).take(20).all();

// streaming — the result is a Promise AND an AsyncIterable
for await (const row of db.orm.public.Post.where(...).all()) { ... }

// SQL lane
const plan = db.sql.public.user
  .select("id", "email")
  .innerJoin(db.sql.public.post, (f) => f.post.userId.eq(f.user.id))
  .groupBy(...).having(...)
  .limit(2)
  .build();
const rows = await db.runtime().execute(plan);
```

Notable design decisions worth studying:
- `findMany`/`findFirst` → `.all()`/`.first()`; `.first()` compiles to `LIMIT 1`.
- Lambda-based filter operators (`.eq`, `.neq`, `.lt`, `.gt`, `.like`, `.ilike`, `.in()`), plus `or`/`and`/`not` combinators imported from `@prisma-next/sql-orm-client` — i.e. **composable predicates**, fixing the biggest structural flaw of the v7 object API.
- **Every query compiles to an inspectable "plan"** before execution; middleware can lint/budget/reject plans.
- SQL lane has `innerJoin` / `outerLeftJoin` / `outerRightJoin` / `outerFullJoin` / **`lateralJoin`**, aliased subqueries as join sources, `groupBy`/`having`, and `fns.raw` tagged-template fragments with parameterised interpolation. (CTEs and window functions not documented as of Aug 2026.)
- Streaming is built into every read — a flat memory footprint by default. Caveat: a streamed result can only be consumed once.
- Namespace-qualified field accessors (`f.post.id`, `f.user.email`) solve join ambiguity at the type level.

> **This is a strong design and it validates a two-lane architecture: an ergonomic model API and a typed SQL builder sharing one schema IR, not two disconnected tools.**

---

## 4. Migrations

### 4.1 Prisma 7 (`prisma migrate`)

**Artifact format** — `prisma/migrations/<timestamp>_<name>/migration.sql`: plain, hand-editable SQL. Applied migrations tracked in `_prisma_migrations` (checksum, `applied_steps_count`, `logs`, `finished_at`, `rolled_back_at`).

**Commands** ([CLI reference](https://www.prisma.io/docs/orm/reference/prisma-cli-reference)):

| Command | Purpose |
|---|---|
| `migrate dev` | dev only. Detect drift via shadow DB → apply pending → diff schema → generate new `migration.sql` → apply → run generators. `--create-only` to author without applying. |
| `migrate deploy` | prod/CI. Apply pending migrations only. No shadow DB, no drift detection, no codegen. Warns if checksums changed. |
| `migrate reset` | dev only. Drop + recreate + reapply + seed. |
| `migrate status` | compare `_prisma_migrations` to the migrations directory. |
| `migrate resolve --applied \| --rolled-back` | manual failure recovery. |
| `migrate diff --from-* --to-* [--script]` | diff any two of: empty, schema file, migrations dir, live datasource, local D1. The genuinely great primitive. |
| `db push` | prototype: force schema state onto DB, **no migration file**. `--accept-data-loss`, `--force-reset`. |
| `db pull` | introspect DB → rewrite schema. `--force` to discard manual edits. |
| `db execute --file \| --stdin` | run arbitrary SQL without touching `_prisma_migrations`. |
| `db seed` | run the seed script (no longer automatic in v7). |

**The shadow database** ([docs](https://www.prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate/shadow-database)):
- A second, temporary DB created and dropped on every `migrate dev`.
- Two jobs: (1) **drift detection** — replay migration history from empty, compare result to the dev DB; (2) **data-loss detection** — dry-run the new migration.
- Requires **`CREATEDB` or superuser** on PostgreSQL. Cloud PG (Neon, Supabase, RDS with restricted roles, Heroku) frequently can't do this → you must provision a second DB manually and set `shadowDatabaseUrl`.
- Not used by `migrate deploy`.
- `migrations.initShadowDb` in `prisma.config.ts` lets you seed the shadow DB with SQL (the `CREATE EXTENSION` workaround).

**Drift detection** compares *replayed migration history* vs *actual DB*, so it flags any object created outside Prisma — including things Prisma cannot express (triggers, RLS policies, extension types, DBA-created indexes). This is the root of the `Drift detected` → `migrate dev` → "reset your database?" horror story. Mitigations: `externalTables`/`enums.external` (experimental) and `@@ignore`.

**Failure recovery** ([patching & hotfixing](https://www.prisma.io/docs/orm/prisma-migrate/workflows/patching-and-hotfixing)):
- **There are no down migrations.** Prisma's position: roll forward. `migrate diff` + `db execute` is the "advanced" downgrade path.
- A migration that fails mid-way leaves the DB in a **partially applied state** — `migration.sql` is not wrapped so as to be idempotent, and PG DDL in one file is transactional only if the whole file runs in one implicit transaction (which multi-statement migrations with `CREATE INDEX CONCURRENTLY` explicitly cannot be).
- Recovery is manual: either finish the migration by hand then `migrate resolve --applied <name>`, or undo by hand then `migrate resolve --rolled-back <name>` and redeploy.
- Hotfix drift is reconciled by writing the matching schema change locally, generating a migration, and `migrate resolve --applied` on the already-patched DB — a five-step manual ritual.
- **Baselining** an existing DB: `migrate diff --from-empty --to-schema-datamodel ... --script > 0_init/migration.sql` then `migrate resolve --applied 0_init`.
- Advisory lock with a **10-second timeout** serialises concurrent `migrate` runs; timeouts must be retried (a common CI flake with multiple deploy replicas).

**Introspection (`db pull`)** is genuinely good — it round-trips names via `@map`/`@@map`, preserves manual model renames on re-introspection, emits `Unsupported(...)` and `@@ignore` for things it can't model. It is the main reason people can adopt Prisma on an existing database at all.

**What users complain about (migrations)** — issue numbers and 👍 counts from the GitHub API, 2026-08-14:

1. **Shadow database on managed PG.** [#10575](https://github.com/prisma/prisma/issues/10575) (Supabase can't create it), [#18623 Better Shadow Database URL support](https://github.com/prisma/prisma/issues/18623), [#20520 Configuration option to specify initial SQL for shadow database](https://github.com/prisma/prisma/issues/20520) (the `CREATE EXTENSION` problem — partially addressed by `migrations.initShadowDb`), [#8888](https://github.com/prisma/prisma/issues/8888) / [#24175](https://github.com/prisma/prisma/issues/24175) / [#25812](https://github.com/prisma/prisma/issues/25812) "migration failed to apply cleanly to the shadow database", [#19614 `migrate diff` breaks database when the shadow DB is the same database](https://github.com/prisma/prisma/issues/19614).
2. **Phantom drift.** [#19100 "Drift detected … every time"](https://github.com/prisma/prisma/issues/19100), [#23058 Drift detected: "Changed the `vector` extension" without any change](https://github.com/prisma/prisma/issues/23058) — an extension you *did* declare producing permanent false-positive drift, the perfect illustration of §6.A, [#11412 Postgres interval shorthand in `dbgenerated` defaults causes drift](https://github.com/prisma/prisma/issues/11412), [#11242 drift on foreign keys](https://github.com/prisma/prisma/issues/11242), [#27737 drift with no real change](https://github.com/prisma/prisma/issues/27737), [#6579 `--create-only` on an existing DB detects drift](https://github.com/prisma/prisma/issues/6579).
3. **`migrate dev` offering to reset the database** when it detects drift — [#8079](https://github.com/prisma/prisma/issues/8079). Data loss behind a prompt.
4. **No programmatic API / no down migrations.** [#13549 Run migrations by code](https://github.com/prisma/prisma/issues/13549) (324 👍), [#4703 Programmatic access to Migrate CLI](https://github.com/prisma/prisma/issues/4703) (408 👍), [#4688 Imperative Migrations with a TypeScript DSL](https://github.com/prisma/prisma/issues/4688) (214 👍). Note that **Prisma Next's `migration.ts` is #4688 shipped**, seven years later.
5. **No data-migration story.** [#20628 JS support for migrations](https://github.com/prisma/prisma/issues/20628) (61 👍), [#19513 JS execution before and after migrations for easier data migrations](https://github.com/prisma/prisma/issues/19513) (59 👍), [#6345 point-in-time seeds and migrations](https://github.com/prisma/prisma/issues/6345) (54 👍). Backfills live in hand-run scripts outside the migration.
6. **Poor failure diagnostics.** [#15295 Migration with transaction fails without good error message](https://github.com/prisma/prisma/issues/15295), [#11184 `migrate dev --create-only` actually applies previous non-deployed migrations](https://github.com/prisma/prisma/issues/11184).
7. Enum value changes and column-type narrowing generate destructive SQL that must be hand-edited (`--create-only`, then rewrite).
8. `db push` vs `migrate dev` confusion; teams prototype with `push` and then can't produce a coherent history.
9. `CREATE INDEX CONCURRENTLY` can't live in a normal migration (transaction block).
10. No way to express "this index/trigger/policy is managed elsewhere" without the experimental `externalTables` flag.
11. [#22184 Support Migrations, Introspection, Studio for driver-adapter-only databases](https://github.com/prisma/prisma/issues/22184) — the Rust schema-engine still gates which databases can migrate at all.

### 4.2 Prisma Next migrations — the redesign

Sources: [How migrations work](https://www.prisma.io/docs/orm/next/migrations/how-migrations-work), [Generating a migration](https://www.prisma.io/docs/orm/next/migrations/generating-a-migration), [TypeScript Migrations in Prisma Next](https://www.prisma.io/blog/typescript-migrations-in-prisma-next).

Workflow: edit contract → `prisma-next contract emit` → `prisma-next migration plan` → review/edit → `prisma-next migrate`.

Directory:
```
migrations/app/20260707T1005_init/
├── migration.ts        # human-authored TypeScript (editable)
├── ops.json            # compiled operations (what actually runs)
├── migration.json      # from-hash / to-hash metadata
└── end-contract.json   # contract snapshot at the end state
```

```ts
export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;
  override get operations() {
    return [
      this.createSchema({ schema: 'public' }),
      this.createTable({
        schema: 'public', table: 'user',
        columns: [
          col('email', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id',    'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
    ];
  }
}
```

Key ideas:
- **`migration.ts` : `ops.json` :: `package.json` : `package-lock.json`.** You author intent; the system executes the lockfile. Both committed.
- **Every op runs precheck → execute → postcheck.** Postchecks make re-running a partially-failed migration **idempotent** — the runner skips completed steps. This directly fixes Prisma 7's worst failure mode.
- Ops are classified **Additive / Destructive / Data**.
- **Graph history, not a linear list.** Each migration records the schema hash it moves `from` and `to`. Branch merges resolve by hash rather than by timestamp ordering. The DB stores a **marker** naming the contract state it currently matches (replacing `_prisma_migrations`' linear ledger).
- **Data migrations are first-class**: the planner scaffolds a `dataTransform` section with `placeholder(...)` calls when it needs a backfill (e.g. adding a `NOT NULL` column), which you fill in and recompile.
- `rawSql()` escape hatch is available inside migrations.
- Renames are planned as drop+add (flagged Destructive); you hand-edit to `rawSql('ALTER TABLE ... RENAME COLUMN ...')`. **A rename-detection gap that we should not replicate.**
- **Not yet built (documented gap):** no squash, no baseline command, **no shadow-database dry run**.
- `prisma-next contract infer` is the new introspection; `prisma-next db sign` marks a database as matching a contract (baselining by another name).

> **The precheck/execute/postcheck + idempotent-retry model and the from-hash/to-hash graph are the two best migration ideas in the JS ecosystem right now.** Both are worth porting. The TypeScript-authored + JSON-compiled dual file is more debatable — it doubles the artifacts and makes the migration less directly reviewable as SQL.

---

## 5. Architecture & dependencies

### 5.1 Engine history

| Era | Architecture |
|---|---|
| Prisma 1 (2018–2020) | Standalone Rust/Scala "Prisma server" in front of the DB, GraphQL protocol. Abandoned. |
| Prisma 2–5 | **Rust `query-engine` binary** shipped per-platform (`libquery_engine-*.node` or a sidecar process), downloaded at install. Plus a Rust `migration-engine` (renamed `schema-engine`, [#19321](https://github.com/prisma/prisma/issues/19321)). Node ↔ Rust JSON serialisation on every query. |
| Prisma 5.4+ | `driverAdapters` preview — let a JS driver own the socket, Rust engine still compiles queries. |
| Prisma 6.x | `queryCompiler` preview — TypeScript/WASM query compiler. `driverAdapters` GA in 6.16.0. |
| **Prisma 7.0.0 (2025-11-19)** | **TS/WASM Query Compiler is the default.** Rust query engine removed from the default path (deprecated but reachable for an interim window). Driver adapters **mandatory**. |
| **Prisma Next / 8** | Pure TypeScript end to end, no WASM in the query path, extension-pack architecture. |

**Still Rust in 7.9.1 — verified, not inferred.** I unpacked `@prisma/engines@7.9.1` and grepped its `dist/`: the only engine binary it knows how to download is `BinaryType.SchemaEngineBinary`. There is **no** `query-engine` / `libquery` reference anywhere in the package.

```
$ npm pack @prisma/engines@7.9.1 && tar xzf ...
$ grep -o 'BinaryType\.\w*' package/dist/index.js | sort -u
BinaryType.SchemaEngineBinary
```

So: the Rust **query** engine binary really is gone from v7, but `prisma migrate` / `db pull` / `db push` still shell out to a downloaded Rust **schema-engine** binary. This also explains [#22184](https://github.com/prisma/prisma/issues/22184) — databases reachable only through a driver adapter still can't be migrated or introspected, because the schema engine opens its own connection. **A PG-only ORM whose migration tooling is also plain TypeScript over the user's own `pg` connection avoids this entire class of problem.**

**"Rust-free" is doubly misleading, and the second sense is the load-bearing one.** The v7 query compiler is *itself Rust, compiled to WebAssembly* — the shipped artifact `query_compiler_bg.postgresql.wasm-base64.mjs` is ~2,410 KB ([Prisma@7 Is Neither "No Rust" Nor "Rust Free"](https://zenn.dev/sora_kumo/articles/prisma-7-rust-free?locale=en)). What v7 actually removed is *native binaries*, not Rust. That distinction is exactly why §5.3's regression happened: the WASM boundary and per-query compilation replaced the native-process boundary rather than eliminating cross-boundary cost. **Prisma Next is the first version that is genuinely TypeScript end-to-end — and it is ~9× smaller and ~5× faster than v7 as a direct result.**

**The install-time download is itself a liability.** [#27700 "403 when trying to download prisma engine"](https://github.com/prisma/prisma/issues/27700) collected **277 👍 and 401 comments in a single day** (2025-07-18): a CDN misconfiguration broke `prisma generate` — and therefore every CI pipeline and Docker build — globally. **An ORM that downloads nothing at install time cannot have this outage.** Worth stating as an explicit design goal.

### 5.2 Install size

Measured from the npm registry metadata, 2026-08-14:
- `prisma@7.9.1` → **43.8 MB unpacked**, plus the downloaded `schema-engine` binary (tens of MB, platform-specific).
- `@prisma/client@7.9.1` → **78.4 MB unpacked**. This is the *published package* (generator + runtime + all DB support); the *generated, bundled* client is what got 90% smaller.
- `@prisma/adapter-pg@7.9.1` → **70.8 KB** (+ `pg`).
- The CLI transitively pulls **`mysql2` and `postgres`** as hard dependencies — a PostgreSQL-only user installs a MySQL driver. This is multi-DB tax made concrete and weighable.
- Compare: `prisma@6.16.2` → 51.9 MB; `@prisma/client@6.16.2` → 76.9 MB. The published-package size barely moved between v6 and v7.

Prisma's own benchmark ([Prisma ORM without Rust: Latest Performance Benchmarks](https://www.prisma.io/blog/prisma-orm-without-rust-latest-performance-benchmarks)) reports the **bundled application artifact** dropping from **~14 MB → 1.6 MB (−90%)**.

### 5.3 Query performance — the marketing number and the real one

**Prisma's launch claim** ([Rust-free benchmarks](https://www.prisma.io/blog/prisma-orm-without-rust-latest-performance-benchmarks), PostgreSQL + `pg`):

| Query | Rust engine | Rust-free | Speedup |
|---|---|---|---|
| `findMany` (25k rows) | 163 ms | 77 ms | 2.12× |
| `findMany` + m2m include, take 2k | 1539 ms | 136 ms | **11.32×** |
| `findMany` + where + include, take 2k | 82 ms | 38 ms | 2.16× |

These measure **large-payload throughput**, where deleting Node↔Rust JSON marshalling is a genuine win. Prisma's own caveat: for small queries the difference is 1–2 ms.

**⚠️ This is not the whole story, and the correction matters more than the claim.**

[**#28845 "Prisma 7 performance is actually worse than Prisma 6"**](https://github.com/prisma/prisma/issues/28845) — 72 👍 (114 total reactions), 43 comments, opened 2025-12-04, **still open as of 2026-08-14**. k6 against PostgreSQL, pool 10, 50 VUs ([repro](https://github.com/MikaelEdebro/prisma7-benchmarks)):

| Metric | Prisma 6 | Prisma 7 | Change |
|---|---|---|---|
| reads/sec | 5,278 | 3,356 | **−36%** |
| list posts, avg | 6.14 ms | 10.23 ms | −40% |
| get by id, avg | 4.68 ms | 7.39 ms | −37% |
| list with join, avg | 29.56 ms | 50.47 ms | −41% |

**A Prisma engineer reproduced it seven days after filing** (@jacek-prisma, 2025-12-11): *"I've run it along with other benchmarks and **I can reproduce similar results**. I've investigated these performance issues and they're primarily caused by a query compilation step that happens before queries get executed in Prisma 7 … implemented in order to get rid of the Rust runtime."* Prisma conceded again in the [v7.4 release post](https://www.prisma.io/blog/prisma-orm-v7-4-query-caching-partial-indexes-and-major-performance-improvements): *"One of the main pieces of feedback we've received about Prisma 7 is that performance has not met the expectations we initially set."* Independently reproduced by the author of the joist-orm benchmarks (*"prisma v6 runs the benchmark in 985ms, prisma v7 1498ms"*). Duplicates: [#29099](https://github.com/prisma/prisma/issues/29099), [#28794](https://github.com/prisma/prisma/issues/28794), [#28525](https://github.com/prisma/prisma/issues/28525) (event-loop blocking).

**The sharpest criticism of Prisma 7 is Prisma's own benchmark site.** [benchmarks.prisma.io](https://benchmarks.prisma.io/), fetched 2026-08-14 — the open-source Drizzle benchmark suite, identical PG workload, same hardware:

| | raw `pg` | Prisma Next | **Prisma 7** |
|---|---|---|---|
| avg latency | 0.7 ms | 1.2 ms | **8.1 ms** |
| p95 | 1.9 ms | 4.4 ms | **41.8 ms** |
| p99 | 4.3 ms | 8.9 ms | **116.7 ms** |
| peak throughput | ~9,000 req/s | ~7,830 req/s (87%) | **~5,150 req/s** |
| bundle, gzipped | — | **~146 KB** | **~1.32 MB** (9×) |

**Prisma 7 costs ~11× the average latency and ~27× the p99 of the raw driver** — and Prisma Next is ~9× smaller and ~5× faster than the version Prisma currently tells you to run in production. Note also that the 1.32 MB gzipped figure sits awkwardly beside the "1.6 MB / 600 KB gzipped" claim in §5.2.

> **Three lessons for `pg-orm-ts`:**
> 1. **The cross-language boundary was a real cost.** A pure-TS ORM gets the large-payload win for free; that part of Prisma's story holds.
> 2. **But per-query compilation overhead is what shows up in p99.** Prisma swapped a marshalling cost for a compilation cost and net-regressed on small, frequent queries — the shape of essentially all OLTP traffic. **Our compile-to-SQL step must be cached by query shape, and the benchmark that matters is p99 on a small indexed lookup, not throughput on a 25k-row scan.** Serverless makes this strictly worse, since every cold isolate re-pays compilation — raised in the thread by @patricksuo and still unresolved.
> 3. **Benchmark against raw `pg`, publish p99, never claim a multiplier without the baseline.** "3× faster" was true on the axis Prisma chose and badly false on the axis users felt — and that gap is now the most-cited complaint about the release.

### 5.4 Driver adapters

| Adapter | Driver |
|---|---|
| `@prisma/adapter-pg` | `pg` (node-postgres) |
| `@prisma/adapter-neon` | Neon serverless (WebSocket + HTTP) |
| `@prisma/adapter-ppg` | Prisma Postgres |
| `@prisma/adapter-planetscale` | PlanetScale |
| `@prisma/adapter-d1` | Cloudflare D1 |
| `@prisma/adapter-libsql` / `-better-sqlite3` | SQLite / Turso |
| `@prisma/adapter-mssql`, `@prisma/adapter-mariadb` | SQL Server, MariaDB |
| community | TiDB Cloud, PGlite |

Since 6.6.0, you pass driver options directly to the adapter instead of pre-instantiating the driver. **In v7 the connection string moves out of `schema.prisma`/`prisma.config.ts` and into application code** where the adapter is constructed — a real ergonomic improvement (env handling is now ordinary TS) but a migration nuisance. Connection-pool behaviour now comes from the underlying driver's defaults, which differ from v6's URL params — a documented v7 upgrade gotcha.

**Note the concession:** adopting driver adapters is Prisma admitting it should never have owned the connection layer. `pg-orm-ts` should treat "bring your own `pg` Pool / `postgres.js` / PGlite" as the baseline, never the escape hatch.

### 5.5 Prisma Next's extension-pack architecture — verified from the published package

I unpacked `@prisma-next/extension-pgvector@0.16.0` from npm. This is the most important artifact in the whole dossier, because it is a **working reference implementation of the exact "user-registrable PG type" API we should build**.

An extension pack's declared responsibilities:
- **Codec** — maps a type ID (`pg/vector@1`) to a runtime representation (`number[]`) and to an emitted TS type.
- **Parameterised codecs** — `vector(1536)` is a *higher-order* codec: a `CodecDescriptor<{ length: number }>` with an ArkType `paramsSchema` validating the dimension at the contract boundary, a `renderOutputType: ({ length }) => 'Vector<' + length + '>'` that emits the branded TS type into `contract.d.ts`, and a curried `factory` that materialises the runtime codec.
- **Operations** — registers `cosineDistance` / `cosineSimilarity` as typed column methods compiling to the pgvector `<=>` operator.
- **Baseline migration** — the pack ships its own on-disk migration that runs `CREATE EXTENSION IF NOT EXISTS vector`, applied automatically by `db init` / `db update`. **This is the clean answer to Prisma 7's `initShadowDb` / extension-drift mess** ([#23058](https://github.com/prisma/prisma/issues/23058)).
- **Capability declaration** — `pgvector.cosine`, so the planner knows what the target supports.
- Split entrypoints: `/pack` (pure, for contract authoring, no filesystem), `/control` (CLI/config), `/runtime`, `/column-types`, `/codec-types`, `/operation-types`.

Contract authoring:
```ts
import { vector } from '@prisma-next/extension-pgvector/column-types';
import pgvector from '@prisma-next/extension-pgvector/pack';

export const contract = defineContract({
  family: sqlFamily, target: postgres,
  extensionPacks: { pgvector },
  models: {
    Post: model('Post', { fields: {
      id: field.column(int4Column).id(),
      embedding: field.column(vector(1536)).optional(),   // → Vector<1536>
    }}).sql({ table: 'post' }),
  },
});
```

Query:
```ts
const plan = sql.from(tables.post)
  .select({
    id: tables.post.columns.id,
    distance: tables.post.columns.embedding.cosineDistance(param('queryVector')),
  })
  .orderBy(tables.post.columns.embedding.cosineDistance(param('queryVector')).asc())
  .limit(10)
  .build({ params: { queryVector } });

type Row = ResultType<typeof plan>;
```

**Compare to Prisma 7**, where the same column is `Unsupported("vector(1536)")`: invisible to the client, unqueryable except via `$queryRaw`, and it crashes Prisma Studio.

> **Two lessons, in tension.**
> **(a) Steal the design.** A codec descriptor with `{ typeId, paramsSchema, renderOutputType, factory, operations, capabilities, baselineMigration }` is precisely the right shape for `pg-orm-ts`. It turns "does the ORM support pgvector/PostGIS/ltree/citext/tstzrange?" from a maintainer roadmap item into a 200-line community package. This is the single highest-leverage architectural idea in this document.
> **(b) Don't inherit the ceremony.** Look at the runtime wiring: `family` + `target` + `adapter` + `extensionPacks` + `createSqlExecutionStack` + `createExecutionContext` + `instantiateExecutionStack`, spread over ~40 `@prisma-next/*` packages, with an ADR-numbered internal architecture leaking into the README. The `family`/`target` split exists **only because MongoDB is still in scope** — a PostgreSQL-only tool collapses two of those layers to nothing. Our version of this should be: `definePgType({...})`, one package, `db.extend(pgvector)`.

### 5.6 Edge / serverless / cold start

- Pre-v7, the Rust binary made Cloudflare Workers essentially impossible and Lambda bundles large; the workaround was **Prisma Accelerate / Data Proxy** — a *paid, hosted* connection pooler + cache reached over HTTP. This was widely read as commercial pressure applied to an architectural weakness. See [#19551 "Provide Option to Self-Host Data Proxy / Accelerate"](https://github.com/prisma/prisma/issues/19551) and [Accelerate billing discussion #23942](https://github.com/prisma/prisma/discussions/23942). Accelerate/Pulse start at $29/mo each.
- v7 removes the binary; edge deployment works with the WASM compiler + an HTTP-capable adapter (Neon, D1, PPg).
- Cold start is dominated by (a) module parse of the generated client and (b) WASM instantiation. Prisma has published no cold-start numbers in the Rust-free benchmark post.
- Prisma Next drops WASM entirely for PG, which should be the best cold-start story of any of these.

---

## 6. Pain points: multi-DB abstraction vs. codegen/DSL design

This is the section the team asked for. Sorting the complaints by root cause is the whole point.

### 6.A Directly caused by multi-database abstraction

1. **The closed DSL can only contain the intersection of supported databases** — or must special-case per provider, which the team clearly resists. Result: partial indexes took until 7.4.0 (2026); expression indexes until Prisma 8; `CHECK` and `EXCLUDE` constraints still absent. PG users pay for MySQL/SQLite/MongoDB compatibility with a permanently incomplete schema language.
2. **`Unsupported` exists at all.** In a PG-only tool, `vector`, `tsvector`, `ltree`, `citext`, `inet`, ranges, `hstore`, domains and composite types are *known* types with known wire formats. There is no principled reason for them to be opaque.
3. **`postgresqlExtensions` is a preview flag rather than a core concept.** Prisma Next fixes this properly with extension packs — which is exactly a PG-first design.
4. **`distinct` is in-memory** because not every provider supports `DISTINCT ON`. PG has `SELECT DISTINCT ON (...)`; a PG-only ORM just uses it.
5. **`upsert` semantics.** PG has `INSERT ... ON CONFLICT DO UPDATE`. Prisma's cross-DB `upsert` couldn't rely on it, so it was long emulated, and `upsertMany` was never shipped ([#4134](https://github.com/prisma/prisma/issues/4134)).
6. **`relationJoins` had to be built per-provider** (PG: `LATERAL` + `json_agg`; MySQL: correlated subqueries; MariaDB: neither, so unsupported [#23346](https://github.com/prisma/prisma/issues/23346); SQL Server [#23347](https://github.com/prisma/prisma/issues/23347); SQLite [#23348](https://github.com/prisma/prisma/issues/23348)). Being blocked on the worst database is why the *best* database's users waited 2.7 years and still have a preview flag.
7. **TypedSQL's inference is uneven** (great on PG, requires manual annotations on MySQL <8 and SQLite) — a preview feature partly held back by its weakest target.
8. **Top-of-backlog issues are DB expansion requests**, not PG depth. Live 👍 counts from the GitHub API, 2026-08-14, `repo:prisma/prisma is:issue is:open sort:reactions-+1-desc`:

   | 👍 | Issue | Root cause |
   |---:|---|---|
   | **1059** | [#1676 Support DynamoDB](https://github.com/prisma/prisma/issues/1676) | multi-DB |
   | 799 | [#3219 Define type of content of `Json` field](https://github.com/prisma/prisma/issues/3219) | DSL |
   | 694 | [#3394 Virtual computed fields](https://github.com/prisma/prisma/issues/3394) | DSL |
   | 664 | [#2789 PostGIS/GIS support](https://github.com/prisma/prisma/issues/2789) | multi-DB (PG type system) |
   | 512 | [#4134 `upsertMany()` / `upsertFirst()`](https://github.com/prisma/prisma/issues/4134) | multi-DB (no `ON CONFLICT`) |
   | 462 | [#2505 Support for a Union type](https://github.com/prisma/prisma/issues/2505) | API design |
   | 414 | [#2443 Multiple Connections / Databases / Datasources](https://github.com/prisma/prisma/issues/2443) | multi-DB |
   | 408 | [#4703 Programmatic access to Migrate CLI](https://github.com/prisma/prisma/issues/4703) | tooling |
   | 381 | [#1798 Geolocation/Spatial types](https://github.com/prisma/prisma/issues/1798) | multi-DB (PG type system) |
   | 373 | [#1644 Polymorphic Associations](https://github.com/prisma/prisma/issues/1644) | DSL |
   | 366 | [#5455 Nested relations in `createMany()`](https://github.com/prisma/prisma/issues/5455) | API design |
   | 365 | [#15346 Support SurrealDB](https://github.com/prisma/prisma/issues/15346) | multi-DB |
   | 361 | [#6653 `groupBy()` / aggregate over date ranges](https://github.com/prisma/prisma/issues/6653) | API design |
   | 344 | [#7550 `findManyAndCount()`](https://github.com/prisma/prisma/issues/7550) | API design |
   | 324 | [#13549 Run migrations by code](https://github.com/prisma/prisma/issues/13549) | tooling |
   | 319 | [#5560 `whereRaw` model query option](https://github.com/prisma/prisma/issues/5560) | escape-hatch cliff |
   | 312 | [#4228 Support `distinct` in `count()`](https://github.com/prisma/prisma/issues/4228) | multi-DB (in-memory distinct) |
   | 311 | [#3528 Runtime validation on models](https://github.com/prisma/prisma/issues/3528) | DSL |
   | 307 | [#13310 Support Cloudflare D1](https://github.com/prisma/prisma/issues/13310) | multi-DB |
   | **294** | [#3388 Support SQL `CHECK` constraints](https://github.com/prisma/prisma/issues/3388) | multi-DB |
   | 274 | [#3725 Support recursive relationships](https://github.com/prisma/prisma/issues/3725) | API design (no `WITH RECURSIVE`) |
   | 241 | [#18442 Support for `pg_vector`](https://github.com/prisma/prisma/issues/18442) | multi-DB |
   | 238 | [#8703 Table/column comments in the schema](https://github.com/prisma/prisma/issues/8703) | DSL |
   | 231 | [#2371 Reuse collections of fields inside models](https://github.com/prisma/prisma/issues/2371) | DSL (no composition) |
   | 221 | [#1964 AWS Aurora Serverless Data API](https://github.com/prisma/prisma/issues/1964) | multi-DB |
   | **214** | [#4688 Imperative Migrations with a TypeScript DSL](https://github.com/prisma/prisma/issues/4688) | migrations — *delivered by Prisma Next* |
   | 205 | [#15423 Multiple named aggregations per field](https://github.com/prisma/prisma/issues/15423) | API design |
   | 199 | [#3398 Soft deletes (`deleted_at`)](https://github.com/prisma/prisma/issues/3398) | API design |
   | 199 | [#3387 `@unique` on nullable fields where the DB supports it](https://github.com/prisma/prisma/issues/3387) | **explicitly** multi-DB |
   | 194 | [#5055 Streams](https://github.com/prisma/prisma/issues/5055) | API design — *delivered by Prisma Next* |
   | 166 | [#12735 Support for row-level security (RLS)](https://github.com/prisma/prisma/issues/12735) | multi-DB |

   **Roughly 40% of the top-30 by reactions is the multi-DB promise eating the roadmap** (DynamoDB, SurrealDB, D1, Aurora Data API, multiple datasources, PostGIS, spatial types, pgvector, CHECK constraints, RLS, `ON CONFLICT`-based upsert, native `distinct`, `@unique` on nullable). A PostgreSQL-only ORM starts with those items either free or trivially in scope.
9. **`mysql2` and `postgres` are hard dependencies of the CLI** — install-size tax paid by every user regardless of database.
10. **No RLS, triggers, or policies in the schema** — these have no MySQL/SQLite/Mongo analogue, so they never got modelled. PG shops must run a parallel Atlas/sqldef/hand-SQL pipeline for security-critical objects. RLS in practice is blocked less by the policy syntax than by [#5128 "session-dependent queries"](https://github.com/prisma/prisma/issues/5128) (**78 comments**) — there is no supported way to `SET LOCAL` for the duration of a request.
11. **Prisma has admitted the tradeoff on the record.** On the design: *"Prisma currently doesn't do JOINs for relational queries. Instead, it sends individual queries and joins the data on the application level"* ([discussions#19748](https://github.com/prisma/prisma/discussions/19748)). On the cost, from a Prisma team member on Hacker News: *"As for performance, you are right. **We do take a hit when trying to support as many DBs as possible.**"* ([HN 42297049](https://news.ycombinator.com/item?id=42297049)). **This is the thesis of `pg-orm-ts`, stated by the incumbent.**
12. **Other PG features gated behind "not every DB has it":** `SELECT … FOR UPDATE` ([#8580](https://github.com/prisma/prisma/issues/8580) 143 👍, [#17136](https://github.com/prisma/prisma/issues/17136) 71 👍, both open, active 2026-07); composite types ([#22807](https://github.com/prisma/prisma/issues/22807) 74 👍, [#4263](https://github.com/prisma/prisma/issues/4263) 71 👍); range types (cited by a Kysely adopter as the deciding factor); table partitioning ([#1708](https://github.com/prisma/prisma/issues/1708)); and PG full-text search that exists but doesn't use the index ([#8950](https://github.com/prisma/prisma/issues/8950), 224 👍, 79 comments; [#23627](https://github.com/prisma/prisma/issues/23627) — *"very slow with `search` API but fast with raw SQL"*). Also [#4246](https://github.com/prisma/prisma/issues/4246) (208 👍): Prisma issues an **extra `SELECT` round-trip after every `create()`** rather than using `RETURNING`.

### 6.B Inherent to codegen + a closed DSL (would hurt us too)

1. **The generate step is a permanent tax.** Every schema edit, every `npm ci`, every CI job. Stale-client bugs. Monorepo path resolution. In v7 the output moved into the source tree, which trades one class of problem (watchers/HMR) for another (commit-vs-gitignore).
2. **TypeScript performance.** The `Select`/`Include`/`WhereInput`/`GetPayload` conditional-type graph is O(models × relations). See [#4807](https://github.com/prisma/prisma/issues/4807), the dedicated [TypeScript performance troubleshooting page](https://www.prisma.io/docs/orm/more/troubleshooting/typescript-performance), and [#29011 "Prisma 7 much worse on typescript compilation"](https://github.com/prisma/prisma/issues/29011). v7's ArkType-informed rewrite (~98% fewer types for schema eval, ~70% faster checks) helps but does not eliminate the class of problem.
3. **The nested-object query API does not compose.** Conditional filters require `undefined`-spreading; the `strictUndefinedChecks` preview flag exists because a stray `undefined` silently *dropped* a filter (an authorization-bypass shape of bug). Prisma Next's move to chained/lambda predicates is an admission.
4. **`Json` fields are untyped** ([#3219](https://github.com/prisma/prisma/issues/3219), [#13446](https://github.com/prisma/prisma/issues/13446)) because the DSL has no type-expression sublanguage. A TypeScript-authored schema doesn't have this problem at all — you just write the type.
5. **`Decimal`/`BigInt` serialization** ([#9170](https://github.com/prisma/prisma/issues/9170)). Choosing a rich runtime representation without a serialization contract leaks into every API boundary.
6. **No computed fields / no expression-valued columns** ([#3394](https://github.com/prisma/prisma/issues/3394)) — a DSL can't hold expressions without becoming a programming language.
7. **No polymorphic relations** ([#1644](https://github.com/prisma/prisma/issues/1644)) — the DSL's relation model is fixed and can't be extended by users.
8. **`select`/`include` can't coexist at a level; `groupBy` can't `select`** ([#24816](https://github.com/prisma/prisma/issues/24816)) — arbitrary restrictions falling out of how the argument types are generated.
9. **Escape-hatch cliff.** `$queryRaw<T>` is an unchecked assertion. TypedSQL fixes it but needs a live DB at generate time. There is no *composable* typed middle ground in v7 — hence [#5560 `whereRaw` model query option](https://github.com/prisma/prisma/issues/5560) (319 👍), people asking for a way to inject one SQL predicate into an otherwise-typed query. Prisma Next fills this with `db.sql.*`.
10. **The DSL has no composition primitives.** [#2371 "Reuse collections of fields inside models"](https://github.com/prisma/prisma/issues/2371) (231 👍) — you cannot factor out `id`/`createdAt`/`updatedAt`/`tenantId` into a reusable mixin. A TypeScript-authored schema gets this for free from ordinary object spread. This is one of the cleanest arguments for TS-over-DSL.
11. **The migration file is SQL but the model is not**, so data migrations, renames, and anything expression-shaped fall outside the abstraction. Prisma Next's `dataTransform` placeholders are the fix.
12. **Optimising the generated type graph can silently reduce error precision.** [#29519](https://github.com/prisma/prisma/issues/29519): after v7's type rewrite, misspelled fields in `select` stopped producing a TypeScript error. When correctness lives in emitted conditional types, performance work is a correctness risk.

### 6.C Commercial / trust

- Prisma 1's abandonment, the Data Proxy → Accelerate pivot, and the fact that the serverless story was for years solved by a **paid hosted service** left durable suspicion. Prisma Next explicitly ships Prisma Compute / Prisma Postgres alongside, and `prisma-next init` writes agent-skill files for Claude/Cursor into your repo — a level of vendor surface some teams will not want.
- Prisma Next's "sign the database" / contract-marker model is powerful but also a new proprietary-feeling ceremony.

### 6.D Sentiment, Aug 2026 — and it is genuinely two-sided

**Against:**
- `drizzle-orm` (18.2M/wk) has passed `prisma` (16.0M/wk) on npm; `kysely` at 12.5M/wk. Prisma no longer leads on adoption velocity.
- Prisma is **no longer the default recommendation in r/node**. Top-voted answer in a 2026-07 "Which ORM?" thread: *"Drizzle if you absolutely need an ORM, Kysely if a query builder is enough."*
- **v7 upgrade friction is the live 2026 complaint**, not the old Rust gripes: *"with their new v7, it's all over engineered. I was never able to set it up all by myself even with gpt and claude"*; *"it just took me 10x longer than before to configure the app"*; *"all generated input types are gone… why isn't this clearly documented as a breaking change?"*
- Prisma 7's GA submission on Hacker News got **10 points and zero comments** — a striking silence for a project of this size.
- Documented production migrations away: [Motion](https://engineering.usemotion.com/migrating-to-postgres-3c93dff9c65d) (*"the SQL monstrosity that Prisma generates"*, including `AND 1=1` predicates that defeat the planner; migrations timing out and needing one-by-one application), [codedamn](https://codedamn.com/news/product/dont-use-prisma) (*"we had to ship a 12-13MB query engine"* against Lambda's 50 MB limit).
- Measured N+1 cost: [#12582](https://github.com/prisma/prisma/issues/12582) (`bug/2-confirmed`, open) — shallow queries 103–215 ms vs 10-level-deep 1,040–1,753 ms, purely round-trip multiplication.

**For — and this is real, citable, and should temper our positioning:**
- *"The only deployment issues I ever saw with Prisma were related to its old rust layer, and that is no longer the default. **I've had zero deployment issues since then.**"* The thread's OP, who had opened with "Prisma is all fun until you have to deploy it", reversed position.
- *"Prisma 7 solved two problems for me: the code-generation step… now outside `node_modules`. Prisma was almost a no-go for any type of serverless environment. **That's also addressed now.**"*
- At least one **documented reverse migration**: *"Drizzle was a headache with several limitations… whereas Prisma (which we went to after) has been an excellent experience."*
- r/node now actively downvotes low-effort Prisma hate — two 2026 rant posts sat at 0 with *"This screams skill issue"* as the top reply.
- The sharpest framing of the lag, from a 2026-06 thread: *"**What has happened to community's take on Prisma?** … it seemed like most of the problems/feature requests were solved in the last few years… Just to go out of fashion?"*

**Synthesis for us.** The anti-Prisma consensus is partly *stale* — v7 fixed the deployment and bundle complaints that drove most of the 2023–24 exodus. What has **not** been fixed, and is structural, is: PG feature coverage in the schema language, escape-hatch composability, p99 latency, and the codegen type graph. **Those four are the honest basis for a new tool; "Prisma is bloated and needs a Rust binary" is no longer true and we should not lean on it.** Note too that "Prisma for schema + migrations, Kysely for reads" recurs independently in 2023, 2024, 2025 *and* 2026 threads — a standing, unmet demand for exactly the two-lane design in §3.4.

---

## 7. Verdicts — PORT / ADAPT / SKIP

### Schema

| Feature | Verdict | Rationale |
|---|---|---|
| Declarative, reviewable schema as the single source of truth | **PORT** | The best thing about Prisma; a schema diff readable by a non-author is worth a lot. |
| Custom `.prisma` DSL with its own parser + LSP | **SKIP** | The tooling cost is enormous and it structurally *creates* the feature backlog. Author in TypeScript. |
| Compile schema to a deterministic IR artifact (`contract.json`-style) | **PORT** | Decouples authoring surface from codegen, migrations, introspection, and tooling. Prisma Next's best structural idea. |
| Bidirectional relation declaration with `onDelete`/`onUpdate` at the model | **PORT** | Concise, correct, and the thing Drizzle handles worst. |
| `@map` / `@@map` name decoupling (snake_case DB ↔ camelCase TS) | **PORT** | Non-negotiable for existing databases. |
| `Unsupported("...")` opaque-type hatch | **ADAPT** | Replace with a **registerable codec API** (encode/decode/typeName) so `vector`, `tsvector`, `citext`, `ltree`, `inet`, ranges, domains and composites are first-class. Keep a genuinely-opaque fallback for the last 1%. |
| `postgresqlExtensions` as a preview flag | **ADAPT** | Ship extension support as a *core* concept, à la `@prisma-next/extension-pgvector`. PG-only is the whole point. |
| Partial (`WHERE`) + expression indexes in the schema | **PORT (day one)** | Prisma took 7 years. This must be in v0.1 or we have the same disease. |
| `CHECK` and `EXCLUDE` constraints in the schema | **PORT (day one)** | Prisma still lacks both. Immediate, cheap differentiation. |
| Generated columns (`GENERATED ALWAYS AS ... STORED`) | **PORT** | Prisma's #3394 has been open for years; PG has had it since 12. |
| Views + materialized views as first-class read models | **PORT** | `views` has been preview since Jan 2023. Model a view as a read-only entity with typed columns and no write API. |
| RLS policies in the schema | **PORT** | Nobody in the TS ecosystem does this. It is the highest-value PG-only feature we can own. Pair with a `SET LOCAL`-scoped connection API. |
| Triggers / functions in the schema | **ADAPT** | Don't try to model trigger *bodies*. Model *ownership*: a declared, named SQL object whose body is a file we diff verbatim. |
| `externalTables` / `@@ignore` "not managed by us" markers | **PORT** | Essential for coexisting with DBAs, extensions, and other migration tools. Should be core, not experimental. |
| Preview-feature flags as a release mechanism | **SKIP** | Eight preview flags, several 2–3 years old, is a broken promise machine. Ship or don't. |

### Type safety

| Feature | Verdict | Rationale |
|---|---|---|
| Exact result narrowing from a literal `select`/`include` | **PORT** | The single feature that keeps people on Prisma. Non-negotiable. |
| Achieving it via emitted per-model conditional types | **ADAPT** | Get the same narrowing by *inferring* over a schema value, not by emitting O(models × relations) type permutations. This is the tsc-time fight. |
| Mandatory `prisma generate` step | **ADAPT** | Aim for zero codegen for the ORM types (pure inference). Reserve codegen for the two places it's genuinely needed: typed-SQL describe results and migration planning. |
| TypedSQL / `$queryRawTyped` (types from PG's describe protocol) | **PORT — top priority** | Best idea Prisma has. `.sql` files that run in psql, with types derived from the database. |
| TypedSQL requiring a live DB at generate time | **ADAPT** | Commit a describe-result cache artifact so CI needs no database; refresh it via an explicit command; fail loudly on drift. |
| TypedSQL's no-dynamic-SQL limitation | **ADAPT** | Provide a **composable typed SQL builder** for the dynamic cases (Prisma Next's `db.sql.*` lane), so there is no cliff to `$queryRawUnsafe`. |
| `Decimal` as a decimal.js instance in every payload | **SKIP as default** | Default to `string` for `numeric` with an opt-in codec for a bignum type. Never make `JSON.stringify` throw. |
| `BigInt` → native `bigint` by default | **ADAPT** | Same reasoning; make the representation a per-column codec choice. |
| Untyped `Json` (`JsonValue`) | **SKIP** | Let the user supply the TS type (and optionally a StandardSchema validator) per column. This is free in a TS-authored schema. |
| Three-null JSON (`JsonNull`/`DbNull`/`AnyNull`) | **SKIP** | Model `NULL` vs JSON `null` at the type level (`T \| null` on a nullable column), not with sentinel values. |
| `strictUndefinedChecks` as an opt-in flag | **ADAPT** | Make "`undefined` in a filter is an error" the **only** behaviour, unflagged. It's a security bug class. |
| `omit` (inverse of select) | **PORT** | Cheap; large ergonomic win. |

### Query API

| Feature | Verdict | Rationale |
|---|---|---|
| Nested writes (`create`/`connect`/`connectOrCreate`/… in one atomic call) | **PORT** | Genuinely hard to hand-roll; a real productivity feature. |
| Relation filters `some` / `every` / `none` / `is` / `isNot` | **PORT** | Compile to `EXISTS` / `NOT EXISTS`; readable and correct. |
| Nested-object-literal argument API | **ADAPT** | Keep the *shape* for simple reads (it's familiar and reviewable) but make predicates **composable values** (Prisma Next's `and`/`or`/`not` + lambda operators), so conditional filters aren't `undefined`-spreading. |
| `select`/`include` mutually exclusive at a level | **SKIP** | Arbitrary restriction. Allow both. |
| Relation loading via `LATERAL` + `json_agg` (the `join` strategy) | **PORT** | Correct default for PG. Make it the only strategy unless we find a reason otherwise; do not ship it behind a flag. |
| `relationLoadStrategy` as a user-facing toggle | **ADAPT** | Keep an escape hatch for the pathological cases, but pick a good default rather than making users choose. |
| `_count` on relations, with filters | **PORT** | Widely used, well designed. |
| `groupBy` that cannot `select` | **SKIP** | Fix it: allow grouped selection. |
| In-memory `distinct` | **SKIP** | Use `SELECT DISTINCT ON`. |
| `upsert` (single-row, non-`ON CONFLICT`) | **ADAPT** | Implement on `INSERT ... ON CONFLICT DO UPDATE`, expose the conflict target, and ship `upsertMany` from day one. |
| CTEs, window functions, `UNION`, recursive queries in the model API | **SKIP for the model API / PORT into the SQL builder** | Don't contort the ORM; make the typed SQL lane cover them so there's no raw-string cliff. |
| Streaming results (result is Promise **and** AsyncIterable) | **PORT** | Prisma Next's design. Flat memory on big scans, zero API cost. Watch the "consumable once" caveat. |
| Cursor pagination with composite keys | **PORT** | Offset pagination alone is a production trap. |
| `$extends` (model / client / query / result components) | **ADAPT** | Keep query interception and computed fields; make computed fields expressible **in SQL** so they're filterable/sortable. Fix the nested-operation hole. Avoid the "each extend re-instantiates the whole client type" cost. |
| Interactive transactions with isolation levels | **PORT** | Table stakes. |
| 5s default transaction timeout | **SKIP** | Wrong default; make it explicit/unbounded-by-default with a warning, and document it loudly. |
| Serializable isolation with no retry helper | **ADAPT** | Ship a `withRetry` / `serializable()` helper that retries on `40001`/`40P01`. PG demands it. |
| `SAVEPOINT` / nested transactions | **PORT** | Prisma lacks it; PG has it; it's easy. |
| Query "plan" object inspectable before execution | **PORT** | Prisma Next's idea. Enables linting, budgets, tests that assert SQL, and great error messages. |

### Migrations

| Feature | Verdict | Rationale |
|---|---|---|
| Plain, hand-editable SQL migration files | **PORT** | The reason Prisma Migrate is trusted at all. Reviewable in a PR by a DBA. |
| `migrate diff --from-* --to-*` as a general primitive | **PORT** | The most quietly excellent thing in the CLI. Diff any two of: empty / schema / migrations-dir / live DB. |
| `migrate dev` / `migrate deploy` split (dev authors, prod applies) | **PORT** | Correct separation. Never let production author a migration. |
| Shadow database for drift + data-loss detection | **ADAPT** | The *technique* is right; the *requirement* is hostile on managed PG. Prefer a temporary schema in the same database, or PGlite/embedded PG locally, and make an external shadow URL optional rather than the norm. |
| `_prisma_migrations` ledger with checksums | **PORT** | Checksum-on-applied catches edited-after-apply, which is a real incident class. |
| Drift detection that flags everything Prisma can't express | **ADAPT** | Only viable if the schema language covers PG properly *and* ownership markers (`external`) are core. Otherwise drift detection becomes a nuisance alarm people disable. |
| `migrate dev` offering to **reset the database** on drift | **SKIP** | Data loss behind a prompt. Never offer this by default. |
| No down migrations (roll forward only) | **ADAPT** | Roll-forward is the right *default philosophy*, but generate a best-effort `down.sql` alongside each migration for local iteration and emergency use. Prisma's total absence of one is over-corrected. |
| Precheck / execute / postcheck per operation, idempotent retry | **PORT — high value** | Prisma Next's best migration idea. Directly fixes "migration failed halfway and now the DB is in an unknown state". |
| Additive / Destructive / Data operation classification | **PORT** | Cheap, and enables CI policy ("no destructive ops without an approval label"). |
| Graph history keyed by from-hash → to-hash (branch-mergeable) | **PORT** | Solves the real, daily pain of two branches each adding a timestamped migration. |
| `migration.ts` + compiled `ops.json` dual artifact | **ADAPT** | Take the *idea* (declarative op list, verifiable), but emit **SQL** as the compiled artifact rather than JSON, so it stays reviewable and runnable outside our tooling. |
| First-class data migrations / backfill placeholders | **PORT** | Prisma 7's biggest omission; Prisma Next's `dataTransform` scaffolding is the right shape. |
| Rename detection (Prisma Next plans renames as drop+add) | **SKIP their approach; build real rename support** | Interactive "did you rename X to Y?" prompts, or explicit `@renamedFrom`. Drop+add on a production column is unacceptable. |
| `CREATE INDEX CONCURRENTLY` outside a transaction | **PORT (as a feature Prisma lacks)** | Mark specific operations as non-transactional and run them outside the migration txn. Zero-downtime PG work demands it. |
| Baselining an existing DB (`diff --from-empty` + `resolve --applied`) | **ADAPT** | Correct capability, terrible ergonomics. Make it one command. |
| `migrate resolve --applied / --rolled-back` recovery | **PORT** | You always need a manual override. Keep it, but with idempotent retry it should be rare. |
| Introspection (`db pull`) with rename-preserving re-introspection | **PORT** | The main adoption on-ramp for existing databases. Must round-trip `@map`, CHECK/EXCLUDE constraints, partial/expression indexes, RLS policies, triggers, extensions. |
| 10s advisory-lock timeout | **ADAPT** | Keep the lock, make the timeout configurable, and give a clear error rather than a CI flake. |
| `db push` (schema-state sync, no migration file) | **PORT, but rename and fence it** | Great for prototyping; make it obviously dev-only and refuse to run against a DB with an applied migration history. |

### Architecture

| Feature | Verdict | Rationale |
|---|---|---|
| No native binaries / no Rust / no WASM in the query path | **PORT** | Non-negotiable. Prisma's 11× m2m speedup was mostly deleting a language boundary. |
| Driver adapters (BYO `pg` / `postgres.js` / PGlite / Neon) | **PORT** | Prisma reached this after 5 years. Start here. Never own the socket. |
| Multi-database support | **SKIP** | The premise of the project. |
| Extension-pack architecture (pgvector, PostGIS, full-text, encryption as installable packs) | **PORT** | Prisma Next's answer, and it's the right one. Makes PG's surface area the *community's* problem, not the maintainer's. |
| `prisma.config.ts` (TS config, env handled in userland, no magic dotenv) | **PORT** | Boring and correct. |
| Generated client emitted into the source tree | **ADAPT** | Only emit what must be emitted; whatever is emitted should be gitignorable *and* CI-reproducible without a database. |
| Shipping MySQL/Postgres drivers as hard CLI deps | **SKIP** | Obvious, and a concrete talking point: our CLI should be a few hundred KB. |
| A paid hosted proxy as the answer to serverless | **SKIP** | Solve it with pooling guidance + adapter support. Do not build the architecture around a monetisation hook. |
| Prisma Studio-style GUI | **SKIP (for now)** | Large surface, low differentiation, and it's the component that breaks first on custom types. |
| Shipping agent-skill files into the user's repo on `init` | **SKIP** | Invasive. If we support agents, do it via docs and a machine-readable schema IR, not by writing into `.claude/`. |
| Machine-readable error codes with suggested fixes | **PORT** | Prisma's `P####` codes are genuinely useful; Prisma Next extends them with suggested fixes. Cheap, high-leverage, and agent-friendly. |

---

## 8. Concrete recommendations for `pg-orm-ts`

1. **Schema in TypeScript, IR as canonical.** Author in TS (no custom parser, no LSP to build, JSON column types are free), compile to a stable JSON IR that migrations, introspection, the SQL builder, and any future tooling all read. Prisma Next reached this after 8 years and two rewrites.
2. **Day-one PG completeness is the differentiator.** Partial indexes, expression indexes, `CHECK`, `EXCLUDE`, generated columns, views, RLS policies, `CREATE INDEX CONCURRENTLY`. Prisma still doesn't have most of these in stable, and several are 300–700 👍 issues open since 2020. Ship them in v0.1 and the comparison table writes itself.
2b. **Build the codec/extension API before you need it, and copy Prisma Next's descriptor shape** (§5.5): `{ typeId, paramsSchema, renderOutputType, factory, operations, capabilities, baselineMigration }`. It converts every "does it support X?" question from a roadmap item into a community package, and it's the difference between `vector(1536) → Vector<1536>` and Prisma 7's `Unsupported("vector(1536)")`. But ship it as **one** package with a `definePgType({...})` + `db.extend(pgvector)` surface — not 40 packages and a `family`/`target`/`adapter`/`stack` composition ritual that only exists because MongoDB is still in scope.
3. **Two lanes, one IR.** An ergonomic model API for CRUD/nested writes, and a composable typed SQL builder for everything else (joins, CTEs, window functions, `DISTINCT ON`, `ON CONFLICT`). No `$queryRawUnsafe` cliff.
4. **Types by inference, not by emission.** Prisma's tsc cost is the direct consequence of emitting O(models × relations) conditional types. If we can get exact `select` narrowing purely from inference over a schema object, that's a benchmark we win on and a whole failure class we skip.
5. **Steal TypedSQL, fix the DB-at-build-time problem.** `.sql` files + PG describe protocol + a **committed cache artifact** so CI needs no database.
6. **Steal precheck/execute/postcheck + hash-graph migrations, emit SQL not JSON.** Idempotent retry after partial failure is the highest-value migration idea in the ecosystem; keeping the compiled artifact as reviewable SQL is where we beat Prisma Next.
7. **Shadow-database technique, without the shadow-database requirement.** Temporary schema in the same DB, or PGlite locally.
8. **No preview flags.** Prisma has eight, several 2–3 years old. Version, ship, and deprecate honestly.
9. **Serialisation contracts up front.** `numeric` → `string` by default, `bigint` opt-in, `timestamptz` vs `date` distinguished, JSON typed by the user. Never make `JSON.stringify` throw on a query result.
10. **`undefined` in a filter is a type error, always.** Not a flag.
11. **Cache compiled SQL by query shape, and make p99 on a small indexed lookup the headline benchmark.** Prisma 7's regression (§5.3) came from paying query-compilation cost per call; the axis they optimised (throughput on 25k-row scans) is not the axis production feels. Publish against raw `pg` with the baseline visible.
12. **Download nothing at install time.** [#27700](https://github.com/prisma/prisma/issues/27700) — a CDN 403 broke `prisma generate` worldwide and drew 401 comments in a day. "No postinstall network access" is a cheap, defensible guarantee.
13. **Nothing enters the schema language until the differ can round-trip it.** Prisma shipped partial indexes after 4.8 years and they immediately caused *infinite phantom migrations* ([#29446](https://github.com/prisma/prisma/issues/29446), open); relations-to-views were shipped and then withdrawn ([#27768](https://github.com/prisma/prisma/issues/27768), open). Introspect-and-diff stability is part of the feature, not a follow-up.
14. **Don't lean on "Prisma is bloated / needs a Rust binary" in positioning — it's stale (§6.D).** The durable, structural critiques are: PG feature coverage, escape-hatch composability, p99 latency, and the codegen type graph.

---

## 9. Sources

**Versions & metrics (verified 2026-08-14):** npm registry (`npm view prisma`, `@prisma/client`, `@prisma/adapter-pg`, `@prisma/engines`, `prisma-next`, `@prisma-next/*`), `api.npmjs.org/downloads/point/last-week/*`.

**Prisma 7 / current stable**
- https://www.prisma.io/changelog/2025-11-19 — v7.0.0 release
- https://www.prisma.io/blog/announcing-prisma-orm-7-0-0
- https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7 — breaking changes
- https://www.prisma.io/blog/from-rust-to-typescript-a-new-chapter-for-prisma-orm
- https://www.prisma.io/blog/prisma-orm-without-rust-latest-performance-benchmarks
- https://github.com/prisma/query-compiler-benchmarks
- https://www.prisma.io/changelog/2026-02-27 — v7.4.2
- https://www.prisma.io/docs/orm/v6/more/internals/engines — engine history

**Prisma Next / Prisma 8**
- https://www.prisma.io/blog/the-next-evolution-of-prisma-orm
- https://www.prisma.io/blog/prisma-next-roadmap
- https://www.prisma.io/docs/orm/next
- https://www.prisma.io/docs/next/getting-started
- https://www.prisma.io/docs/next/add-to-existing-project/postgresql
- https://www.prisma.io/docs/orm/next/fundamentals/reading-data
- https://www.prisma.io/docs/orm/next/reference/sql-query-builder
- https://www.prisma.io/docs/orm/next/migrations/how-migrations-work
- https://www.prisma.io/docs/orm/next/migrations/generating-a-migration
- https://www.prisma.io/blog/typescript-migrations-in-prisma-next
- https://www.prisma.io/changelog/2026-08-02 — Prisma 8: expression/partial/unique indexes, RLS in `contract infer`, `@db.*` removal
- https://github.com/prisma/prisma-next
- https://www.npmjs.com/package/@prisma-next/extension-pgvector

**Schema / PG features**
- https://www.prisma.io/docs/orm/reference/database-features
- https://www.prisma.io/docs/orm/prisma-schema/data-model/indexes
- https://www.prisma.io/docs/orm/prisma-schema/data-model/unsupported-database-features
- https://www.prisma.io/docs/orm/prisma-schema/data-model/views
- https://www.prisma.io/docs/orm/core-concepts/supported-databases/postgresql
- https://www.prisma.io/docs/postgres/database/postgres-extensions
- https://www.prisma.io/docs/orm/reference/preview-features/client-preview-features
- https://www.prisma.io/docs/orm/reference/prisma-config-reference

**Client / types**
- https://www.prisma.io/docs/orm/prisma-client/using-raw-sql/typedsql
- https://www.prisma.io/docs/orm/prisma-client/client-extensions
- https://www.prisma.io/docs/orm/prisma-client/queries/transactions
- https://www.prisma.io/docs/orm/prisma-client/queries/relation-queries
- https://www.prisma.io/docs/orm/prisma-client/queries/aggregation-grouping-summarizing
- https://www.prisma.io/docs/orm/prisma-client/special-fields-and-types
- https://www.prisma.io/docs/orm/more/troubleshooting/typescript-performance
- https://www.prisma.io/blog/prisma-orm-now-lets-you-choose-the-best-join-strategy-preview
- https://www.prisma.io/blog/why-prisma-orm-checks-types-faster-than-drizzle

**Migrations**
- https://www.prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate/shadow-database
- https://www.prisma.io/docs/orm/prisma-migrate/workflows/development-and-production
- https://www.prisma.io/docs/orm/prisma-migrate/workflows/patching-and-hotfixing
- https://www.prisma.io/docs/orm/reference/prisma-cli-reference

**Issues cited** (👍 counts fetched live from `api.github.com/search/issues`, 2026-08-14)
- https://github.com/prisma/prisma/issues/678 — database views
- https://github.com/prisma/prisma/issues/1644 — polymorphic associations
- https://github.com/prisma/prisma/issues/1676 — DynamoDB
- https://github.com/prisma/prisma/issues/1798 — geolocation/spatial types
- https://github.com/prisma/prisma/issues/2443 — multiple datasources
- https://github.com/prisma/prisma/issues/2505 — UNION type
- https://github.com/prisma/prisma/issues/2789 — PostGIS
- https://github.com/prisma/prisma/issues/3219 — typed `Json` content
- https://github.com/prisma/prisma/issues/3394 — virtual computed fields
- https://github.com/prisma/prisma/issues/4134 — `upsertMany`
- https://github.com/prisma/prisma/issues/4703 — programmatic Migrate API
- https://github.com/prisma/prisma/issues/4807 — huge `index.d.ts`, slow IDE
- https://github.com/prisma/prisma/issues/5455 — nested relations in `createMany`
- https://github.com/prisma/prisma/issues/6416 — `JsonValue` vs `JSON.parse`
- https://github.com/prisma/prisma/issues/9170 — Decimal not JSON-serializable
- https://github.com/prisma/prisma/issues/9516 — DateTime as string
- https://github.com/prisma/prisma/issues/13446 — strongly typed Json fields
- https://github.com/prisma/prisma/issues/15346 — SurrealDB
- https://github.com/prisma/prisma/issues/17335 — views preview feedback
- https://github.com/prisma/prisma/issues/18442 — pgvector support
- https://github.com/prisma/prisma/issues/19321 — migration-engine → schema-engine
- https://github.com/prisma/prisma/issues/19551 — self-host Data Proxy/Accelerate
- https://github.com/prisma/prisma/issues/22759 — per-relation load strategy
- https://github.com/prisma/prisma/issues/23346 / 23347 / 23348 — relationJoins for MariaDB / SQL Server / SQLite
- https://github.com/prisma/prisma/issues/23565 — unreadable `relationLoadStrategy: join` SQL
- https://github.com/prisma/prisma/issues/24816 — `groupBy` select
- https://github.com/prisma/prisma/issues/26231 — `extensions` schema missing in shadow DB
- https://github.com/prisma/prisma/issues/29011 — Prisma 7 worse TS compilation
- https://github.com/prisma/prisma/issues/28581 — v7 TS2742 in pnpm monorepos
- https://github.com/prisma/prisma/issues/29519 — v7: non-existent `select` fields don't error
- https://github.com/prisma/prisma/issues/3388 — SQL CHECK constraints (294 👍)
- https://github.com/prisma/prisma/issues/12735 — row-level security (166 👍)
- https://github.com/prisma/prisma/issues/3725 — recursive relationships
- https://github.com/prisma/prisma/issues/4228 — `distinct` in `count()`
- https://github.com/prisma/prisma/issues/5560 — `whereRaw`
- https://github.com/prisma/prisma/issues/6653 — groupBy/aggregate over date ranges
- https://github.com/prisma/prisma/issues/7550 — `findManyAndCount()`
- https://github.com/prisma/prisma/issues/8703 — table/column comments
- https://github.com/prisma/prisma/issues/2371 — reusable field groups in models
- https://github.com/prisma/prisma/issues/3387 — `@unique` on nullable fields
- https://github.com/prisma/prisma/issues/3398 — soft deletes
- https://github.com/prisma/prisma/issues/3528 — runtime model validation
- https://github.com/prisma/prisma/issues/5055 — streams
- https://github.com/prisma/prisma/issues/15423 — multiple named aggregations
- https://github.com/prisma/prisma/issues/13310 — Cloudflare D1
- https://github.com/prisma/prisma/issues/1964 — AWS Aurora Data API
- https://github.com/prisma/prisma/issues/4688 — imperative migrations with a TypeScript DSL (214 👍; shipped in Prisma Next)
- https://github.com/prisma/prisma/issues/13549 — run migrations by code
- https://github.com/prisma/prisma/issues/20628 — JS support for migrations
- https://github.com/prisma/prisma/issues/19513 — JS hooks around migrations for data migrations
- https://github.com/prisma/prisma/issues/6345 — point-in-time seeds and migrations
- https://github.com/prisma/prisma/issues/11184 — `--create-only` applies previous migrations
- https://github.com/prisma/prisma/issues/15295 — migration transaction failure, poor error
- https://github.com/prisma/prisma/issues/22184 — migrate/introspect for driver-adapter-only DBs
- https://github.com/prisma/prisma/issues/10575, /18623, /20520, /8888, /19614, /24175, /25812 — shadow database problems
- https://github.com/prisma/prisma/issues/19100, /23058, /11412, /11242, /27737, /6579, /8079 — drift-detection false positives and the reset prompt
- https://github.com/prisma/prisma/discussions/23942 — Accelerate billing
- https://github.com/prisma/prisma/discussions/25789 — relationJoins default
- https://github.com/prisma/prisma/discussions/26136 — 2025 preview features update

**Performance regression & independent critique**
- https://benchmarks.prisma.io/ — Prisma's own suite: raw `pg` 0.7/4.3 ms vs Prisma Next 1.2/8.9 vs **Prisma 7 8.1/116.7**; bundles 146 KB vs 1.32 MB gzipped
- https://github.com/prisma/prisma/issues/28845 — Prisma 7 slower than Prisma 6 (open; reproduced by Prisma staff)
- https://github.com/MikaelEdebro/prisma7-benchmarks — repro repo
- https://github.com/prisma/prisma/issues/29099, /28794, /28525 — duplicate regression reports
- https://www.prisma.io/blog/prisma-7-performance-benchmarks — Prisma: *"In those tests, Prisma 7 fall behind"*
- https://www.prisma.io/blog/prisma-orm-v7-4-query-caching-partial-indexes-and-major-performance-improvements — *"performance has not met the expectations we initially set"*
- https://zenn.dev/sora_kumo/articles/prisma-7-rust-free?locale=en — the query compiler is still Rust-via-WASM (~2,410 KB)
- https://zenn.dev/sora_kumo/articles/2c90f28ba494e7?locale=en — why Prisma 7 got slower (param→SQL on the main event loop)
- https://github.com/prisma/prisma/pull/29592 — the `OmitOpts` one-line TS-perf fix (merged 2026-06-01, shipped 7.9.0)
- https://github.com/prisma/prisma/pull/28375 — the PR that incidentally caused it
- https://github.com/prisma/prisma/issues/23369, /26697, /16536, /28967, /17562 — `$extends` and generated-type blowups
- https://github.com/prisma/prisma-client-js/issues/524 — 27 MB / 500k-line generated client
- https://github.com/prisma/prisma/issues/27700 — engine-download 403 outage (401 comments in one day)
- https://github.com/prisma/prisma/issues/12582 — measured N+1 depth cost
- https://engineering.usemotion.com/migrating-to-postgres-3c93dff9c65d — Motion's migration off Prisma
- https://codedamn.com/news/product/dont-use-prisma — Lambda size limit
- https://github.com/prisma/prisma/discussions/19748 — Prisma: "doesn't do JOINs… joins on the application level"
- https://news.ycombinator.com/item?id=42297049 — Prisma: *"We do take a hit when trying to support as many DBs as possible"*
- https://news.ycombinator.com/item?id=41984184 — self-hosting Accelerate "isn't currently on the agenda"
- https://github.com/prisma/prisma/issues/27768, /27806, /27839, /27782, /27821, /18758 — the views-relations regression
- https://github.com/prisma/prisma/issues/29263, /29446, /29289, /29220, /13417 — partial-index migration bugs
- https://github.com/prisma/prisma/issues/5128 — session-scoped `SET` (blocks RLS)
- https://github.com/prisma/prisma/issues/8580, /17136 — `SELECT … FOR UPDATE`
- https://github.com/prisma/prisma/issues/8950, /23627 — PG full-text search not using the index
- https://github.com/prisma/prisma/issues/4246 — extra `SELECT` after every `create()`
- https://github.com/prisma/prisma/issues/22807, /4263 — composite types
- https://github.com/prisma/prisma/issues/25124 — TypedSQL requires a live database
- https://github.com/prisma/prisma/issues/4571, /17160 — shadow database on managed PG
- https://github.com/prisma/prisma/issues/9869, /14916 — no down migrations
- https://github.com/prisma/prisma/issues/5290, /7251, /8424, /23569 — PG enum migration failures
- https://github.com/prisma/prisma/issues/8864 — let Migrate ignore specified tables (74 comments)
- https://github.com/prisma/prisma/issues/19358, /10724, /11266 — pre-v7 Lambda bundle & cold start
- https://www.prisma.io/blog/why-prisma-orm-generates-code-into-node-modules-and-why-it-ll-change — Prisma's own retrospective on codegen location
- https://github.com/vercel/turborepo/discussions/5581 — `prisma generate` is uncacheable in the task graph

**Ecosystem / RLS workarounds**
- https://github.com/prisma/prisma-client-extensions/tree/main/row-level-security
- https://github.com/cerebruminc/yates
- https://github.com/s1owjke/prisma-rls
- https://www.npmjs.com/package/prisma-json-types-generator
- https://atlasgo.io/guides/orms/prisma/row-level-security
- https://atlasgo.io/guides/orms/prisma/vector-index
