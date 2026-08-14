# Drizzle ORM + drizzle-kit — Research Dossier

**Researched:** 2026-08-14
**Subject:** `drizzle-orm` / `drizzle-kit` (drizzle-team)
**Purpose:** Decide what `pg-orm-ts` should PORT / ADAPT / SKIP, and answer "if Drizzle exists, why should pg-orm-ts exist?"

> Method note: version facts come from the npm registry metadata and from **unpacking the actual published tarballs** (`drizzle-orm@0.45.2`, `drizzle-orm@1.0.0-rc.4`, `drizzle-kit@0.31.10`, `drizzle-kit@1.0.0-rc.4`), not from docs prose. Several third-party summaries of the GitHub releases page mis-stated years (2024 vs 2026); npm `time` fields are authoritative and are what is used below.

---

## 0. Version status as of 2026-08-14 — **1.0 has NOT shipped**

| Package | `latest` dist-tag | published | `rc` dist-tag | published | license |
|---|---|---|---|---|---|
| `drizzle-orm` | **0.45.2** | 2026-03-27 | **1.0.0-rc.4** | 2026-06-27 | Apache-2.0 |
| `drizzle-kit` | **0.31.10** | 2026-03-17 | **1.0.0-rc.4** | 2026-06-27 | MIT |

Timeline (npm `time` field):

- `1.0.0-beta.1` — **2025-11-03**
- `1.0.0-beta.22` — 2026-04-16
- `1.0.0-rc.1` — 2026-04-30
- `1.0.0-rc.4` — 2026-06-27 (still the `rc` tag)
- `1.0.0-rc.5-ab785fc` / `-169397b` — 2026-08-11 / 2026-08-12 (prerelease SHAs, **not** promoted to `rc`)

**Conclusion: ~9.5 months in beta/RC with no stable 1.0.** The `latest` tag that `npm i drizzle-orm` resolves to is still the 0.4x line, meaning **the vast majority of installs today do not have RQB v2, `defineRelations`, or the rewritten drizzle-kit**. Anyone reading "Drizzle 1.0 is out" in a blog post is reading marketing about the beta announcement, not a stable release.

Repo health signals (github.com/drizzle-team/drizzle-orm, fetched 2026-08-14): **35.5k stars, 1.4k open issues, 573 open PRs**, Apache-2.0, ~2,939 commits on `main`. 573 open PRs is an unusually large contribution backlog and is a real bus-factor/maintenance signal.

- npm: https://www.npmjs.com/package/drizzle-orm · https://www.npmjs.com/package/drizzle-kit
- Releases: https://github.com/drizzle-team/drizzle-orm/releases
- v1 beta.2 notes: https://orm.drizzle.team/docs/latest-releases/drizzle-orm-v1beta2

### Licensing / open-source status
- `drizzle-orm`: **Apache-2.0**, zero runtime dependencies (confirmed: `dependencies: null` in both 0.45.2 and 1.0.0-rc.4 package.json).
- `drizzle-kit`: **MIT**, open-sourced (was closed-source pre-0.23.1). Deps in 1.0.0-rc.4: `@drizzle-team/brocli`, `@js-temporal/polyfill`, `esbuild`, `get-tsconfig`, `jiti`.
- **Drizzle Studio remains closed-source.** Meta-issue: https://github.com/drizzle-team/drizzle-orm/issues/4759

---

## 1. Schema-as-TypeScript

### 1.1 The builder shape

```ts
export const users = pgTable('users', {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  email: text().notNull().unique(),
  meta: jsonb().$type<UserMeta>().default({}),
}, (t) => [
  index('users_email_idx').on(t.email),
  pgPolicy('own_rows', { for: 'select', to: authenticatedRole, using: sql`...` }),
]);
```

Confirmed from `pg-core/table.d.ts` in `1.0.0-rc.4`:

- `pgTable(name, columns, extraConfig?)`. The 3rd param **array** form is current; the **object** form is `@deprecated` (two overloads still carry the deprecation JSDoc). Two dead overloads still shipping in the public `.d.ts` is a small but real type-perf tax on every call site.
- A second overload takes `columns` as a **callback** `(columnTypes: PgColumnsBuilders) => TColumnsMap`, so you can avoid importing every column function.
- `pgTableCreator(fn, casing?)` for global table-name prefixing/casing.
- `PgTableWithColumns<T>` is `PgTable<T> & T['columns'] & { $inferSelect, $inferInsert }` — i.e. **the table object is intersected with its own columns**, which is why `users.email` works. Intersection-heavy types like this are one of the documented TS-perf antipatterns (see §4).

### 1.2 Type inference

- `typeof users.$inferSelect` / `$inferInsert` (also `InferSelectModel<typeof users>` / `InferInsertModel<>`).
- `$inferInsert` correctly makes defaulted / generated / nullable columns optional.
- **`.$type<T>()`** on any column builder narrows the TS type without any runtime check. Works on `json`/`jsonb` (the main use), and on any column for branded types.
- `text({ enum: [...] })` / `varchar({ enum: [...] })` gives a TS union **with no runtime validation and no DB-level check constraint** — a footgun: the type says `'a'|'b'` but the DB accepts anything.

**Assessment:** `$inferSelect`/`$inferInsert` is the single best idea in Drizzle and is table stakes for us. The `.$type<T>()` escape hatch is also excellent — cheap, honest ("this is a cast"), and covers 90% of jsonb needs.

### 1.3 PG-specific surface (v1.0.0-rc.4, from `pg-core/columns/`)

**Column builders present:** `bigint bigserial boolean bytea char cidr date doublePrecision enum inet integer interval json jsonb line macaddr macaddr8 numeric point real serial smallint smallserial text time timestamp uuid varchar` + `customType` + `vector_extension` + `postgis_extension`.

**Column builders NOT present (must use `customType`):** `tsvector`, `tsquery`, `xml`, `money`, `bit`/`varbit`, `lseg`/`box`/`path`/`polygon`/`circle`, and — importantly — **all range and multirange types** (`int4range`, `tstzrange`, `daterange`, `nummultirange`, …).

This is notable because v1's new `codecs.d.ts` **does** contain a `PostgresType` literal union that names all of those (`'int4range' | 'tsrange' | 'tstzrange' | 'daterange' | 'int4multirange' | … | 'tsvector' | 'tsquery' | 'xml' | 'money' | 'oid' | 'regproc' | … | 'vector' | 'halfvec' | 'sparsevec'` plus ~70 PostGIS variants). So the codec layer knows about them but there is no first-class builder. Ranges are a genuinely common PG feature (booking systems, temporal validity) and are a real gap.

Other PG features:

| Feature | Drizzle support | Notes |
|---|---|---|
| Arrays | `integer().array()`, `.array(2)` for multi-dim | Typed as `T[]`. Multi-dim typing is weak. |
| `jsonb` typing | `.$type<T>()` | Compile-time only |
| Generated columns | `.generatedAlwaysAs(sql\`...\`)` | Added in 0.32.0 |
| Identity | `.generatedAlwaysAsIdentity()` / `.generatedByDefaultAsIdentity()` | Added in 0.32.0 |
| `pgSequence` | yes | Added in 0.32.0 |
| `pgEnum` | yes, incl. custom schema | Diffing is historically buggy — §3.4 |
| `pgSchema` | yes | |
| `pgView` / `pgMaterializedView` | yes; `.as(qb => ...)`, `.existing()`, `.with({securityInvoker:true})`, matview `using()`/`tablespace()`/`withNoData()`, `db.refreshMaterializedView(v).concurrently()` | Raw-SQL views require you to hand-declare the column schema (no inference) |
| RLS: `pgPolicy`, `pgRole`, `pgTable.withRLS()` | yes (v1 renamed `.enableRLS()` → `pgTable.withRLS()`) | `.link()` attaches a policy to a table you don't own; `drizzle-orm/neon` `crudPolicy()`; `drizzle-orm/supabase` predefined roles |
| GRANT / privileges | **new in v1** — `privilege` is a diffable entity kind with a 5-tuple identity `[grantor, grantee, schema, table, type]` | Not in 0.4x |
| `COMMENT ON` | **new in v1** (`comments` appears in the v1 PG DDL model) | |
| Extensions (pgvector) | `vector/halfvec/sparsevec/bit` columns; HNSW index ops; `l2Distance` `l1Distance` `innerProduct` `cosineDistance` `hammingDistance` `jaccardDistance` | |
| Extensions (PostGIS) | `geometry` (tuple / xy modes), GIST indexes | |
| `CREATE EXTENSION` | **NOT managed.** Docs: "There is no specific code to create an extension inside the Drizzle schema." | You install extensions out-of-band |
| Triggers, functions, procedures, domains, composite types, partitioned tables (as partitions), exclusion constraints, publications, collations | **NOT modeled at all** | Confirmed by grepping the v1 `payload-postgres.js` DDL emitter: the only `CREATE …` verbs present are TABLE, VIEW, MATERIALIZED VIEW, SEQUENCE, TYPE, SCHEMA, ROLE, POLICY. No `CREATE TRIGGER`/`FUNCTION`/`DOMAIN`/`EXTENSION`/`PUBLICATION`. |

The v1 PG DDL entity model, read off the shipped bundle, is exactly: `schemas, tables, columns, indexes, pks, fks, uniques, checks, sequences, enums, views, policies, roles, privileges, comments, extensions(filter only)`.

Sources: https://orm.drizzle.team/docs/column-types/pg · https://orm.drizzle.team/docs/rls · https://orm.drizzle.team/docs/views · https://orm.drizzle.team/docs/extensions/pg

---

## 2. Query APIs

### 2.1 Core SQL-like builder

`db.select() / .insert() / .update() / .delete()`, `.from().where().groupBy().having().orderBy().limit().offset()`, all join kinds, `.with()` CTEs, `union/unionAll/intersect/except`, subqueries via `.as()`, `.selectDistinct()` / `.selectDistinctOn()`, `db.$count()`, `.for('update')` row locking, `.$dynamic()` for conditional query building, `.prepare(name)` + `sql.placeholder()`.

**Typing quality — good:**
- Result type is derived from the select shape; `sql<T>` lets you annotate computed columns.
- Nullability from joins is modelled: with a **nested** select shape (`{ pet: { id: pets.id } }`) a `leftJoin` makes the **whole `pet` object** `| null` rather than every field individually. This is a genuinely nice touch that most builders get wrong.

**Typing failure modes:**
- `sql<T>` is a **pure cast**. Docs are explicit: "Drizzle cannot perform any type casts based on the provided type generic, because that information is not available at runtime." You need `.mapWith()` for actual runtime decoding. Every `sql<number>` over a `bigint`/`numeric` column is a latent lie (pg returns strings).
- `sql.raw()` bypasses parameterisation entirely — an injection surface sitting right next to the safe API with a nearly identical name.
- The builder types are large: `pg-core/query-builders/select.d.ts` is **31.5 KB** of `.d.ts` on its own; errors surface as `PgSelectBase<...>` spew (see §4).
- Aggregate helpers (`count()`, `sum()`, `avg()`) return `SQL<number>` etc. by convention but the runtime mapping depends on the driver's type parsers.

**Joins are NOT auto-nested into arrays.** For one-to-many, the docs show you writing a manual `reduce()` to group flat rows. That is a deliberate omission (see §6).

https://orm.drizzle.team/docs/select · https://orm.drizzle.team/docs/joins · https://orm.drizzle.team/docs/sql

### 2.2 Relational Queries — RQB v1 vs **v2 (current state: in RC, not stable)**

**v1** (what's on `latest` today): `relations(users, ({one, many}) => ({...}))` per table, `fields`/`references`, callback-style `where: (t, {eq}) => eq(t.id, 1)`. Many-to-many required explicitly traversing the junction table and mapping results by hand. No filtering on related tables. No non-nullable `one` relations.

**v2** (`1.0.0-beta.1`+, currently RC): one central `defineRelations(schema, (r) => ({...}))`.

```ts
export const relations = defineRelations(schema, (r) => ({
  users: {
    posts: r.many.posts(),
    invitee: r.one.users({ from: r.users.invitedBy, to: r.users.id }),
    groups: r.many.groups({                          // m2m via `through`
      from: r.users.id.through(r.usersToGroups.userId),
      to:   r.groups.id.through(r.usersToGroups.groupId),
    }),
    verifiedGroups: r.many.groups({ /* … */ where: { verified: true } }),  // relation-level predicate
  },
}));
const db = drizzle(url, { relations });  // note: `relations`, not `schema`
```

Query side moved from callbacks to **object literals**:

```ts
db.query.users.findMany({
  columns: { id: true, name: true },
  where:   { id: { gt: 10 }, posts: { content: { like: 'M%' } } },  // ← filter by related table (new in v2)
  orderBy: { id: 'asc' },
  extras:  { lowered: (t) => sql`lower(${t.name})` },
  with:    { posts: { limit: 5 } },                                  // limit/offset at every nesting level
  limit: 20,
});
```

- `optional: false` on a `one` relation makes it **non-nullable at the type level** — impossible in v1.
- `r.many.x()` no longer needs a matching `r.one.x()` on the other side.
- `defineRelationsPart` (beta.2) lets you split relations across files for large codebases.

**SQL generation:** `LEFT JOIN LATERAL (SELECT coalesce(json_agg(row_to_json(t.*)), '[]') …) ON TRUE` — a single round trip, no N+1, correct `limit` semantics per nesting level. This is the right architecture and is the thing most worth studying.

**Stated v2 limitations:**
- "Aggregations are not supported in `extras`; use core queries instead."
- Column refs inside `where`/`extras` must use the callback param, not the imported table object.
- `.as()` aliases inside `extras` are silently ignored.
- **RQB v2 is not available for MSSQL or CockroachDB** (irrelevant for us, but tells you the abstraction is leaky across dialects).

**Community concerns raised on the design discussion** (https://github.com/drizzle-team/drizzle-orm/discussions/2316, opened 2024-05-14, active into Dec 2025):
- Object-literal filters create a **mass-assignment surface**: if you spread untrusted JSON into `where`, a client can inject `OR`/`RAW`/relation traversals. Sequelize uses symbols specifically to avoid this. Drizzle's `where: { RAW: ... }` operator makes this concretely exploitable.
- Column names colliding with operator keywords (`OR`, `NOT`, `RAW`) — mitigated only because Drizzle maps TS keys separately from DB names.
- TypeScript compile cost of the new inferred types (this concern turned out to be correct — see §4).

https://orm.drizzle.team/docs/rqb-v2 · https://orm.drizzle.team/docs/relations-v1-v2

### 2.3 Transactions

`db.transaction(async (tx) => {...}, { isolationLevel, accessMode, deferrable })`, nested `tx.transaction()` → `SAVEPOINT`, `tx.rollback()`.

Caveats:
- You **must** use `tx` inside the callback; using the outer `db` silently runs outside the transaction. This is the single most common Drizzle footgun and there is no type-level prevention.
- **No automatic retry on `40001` serialization failure.** If you offer `isolationLevel: 'serializable'` without a retry helper you are handing users a loaded gun.
- Long-standing issue "Transactions rollback doesn't work" (#1723, open since 2023-12-28).

https://orm.drizzle.team/docs/transactions

### 2.4 Caching (0.44+)

`db.$withCache()` per-query, or `global: true` opt-out mode; `upstashCache()` built in; `db.$cache.invalidate({ tables: users })`. Table-granularity invalidation. It's a reasonable, small design — but shipping a **Redis-coupled cache in the ORM core** is scope creep for a library that markets itself on zero dependencies.

https://orm.drizzle.team/docs/cache

---

## 3. drizzle-kit — migrations

### 3.1 The v1 rewrite is the headline change

Per the beta.2 release notes, drizzle-kit was **completely rewritten** for v1:

- **DDL-based snapshots** replacing the old "database snapshot" JSON model.
- **Diff detection re-architected** from scratch.
- Introspection time "from 10 seconds to under 1 second".
- Test matrix expanded (each case run across up to six scenarios).
- New dialects: MSSQL, CockroachDB, SingleStore.

This is an admission that the 0.x diffing engine was structurally wrong, and it validates treating "the diff engine is the hard part" as the central design problem for `pg-orm-ts`.

### 3.2 v1 command surface (read off the shipped `bin.cjs`)

`generate · migrate · push · pull · check · up · export · drop · studio · **mcp** · **skills**`

Two genuinely new surfaces:
- **SDK**: `import { generate, push, pull } from 'drizzle-kit'` — real functions returning a typed envelope, no config file required.
- **MCP server** (`drizzle-kit mcp`) exposing the same verbs as `mcp__drizzle__<verb>` tools, and an embedded **agent-skills bundle** (`skills/*/SKILL.md`, 8 files, ~67 KB) that ships inside the npm package with a `drizzle-kit skills` install command and a revision-based staleness check.

Whatever you think of AI tooling, "the migration tool has a machine-readable JSON contract and a programmatic SDK" is straightforwardly good engineering and is worth copying.

### 3.3 The v1 decision protocol — this is the best idea in drizzle-kit

Every ambiguous or destructive diff returns a discriminated-union envelope instead of guessing:

```jsonc
{ "status": "missing_hints", "unresolved": [
  { "type": "rename_or_create", "kind": "column", "entity": ["public","users","email_v2"] },
  { "type": "confirm_data_loss", "kind": "column", "entity": ["public","users","legacy_id"], "reason": "non_empty" }
]}
```

The caller replies with a `Hint[]` and re-invokes:

```jsonc
[ { "type": "rename", "kind": "column", "from": ["public","users","email"], "to": ["public","users","email_v2"] },
  { "type": "confirm_data_loss", "kind": "column", "entity": ["public","users","legacy_id"] } ]
```

Statuses: `ok | no_changes | missing_hints | error`. Exit code matches status (`missing_hints` → 2). `--output json` is always non-interactive; `--output text` prompts only on a TTY and otherwise prints a report and exits 2 — **it never hangs prompting in CI**. `--explain` is a dry run returning planned statements.

Entity identity is a **tuple**, uniform arity per kind:

| kind | tuple |
|---|---|
| `schema` | `[name]` |
| `role` | `[name]` |
| `table`/`enum`/`sequence`/`view` | `[schema, name]` |
| `column`/`default`/`policy`/`check`/`index`/`unique`/`primary_key`/`foreign key` | `[schema, table, name]` |
| `privilege` | `[grantor, grantee, schema, table, type]` |

`confirm_data_loss` reasons: `non_empty` (entity has ≥1 row), `table_recreate` (SQLite only), `type_change` (carries `{from, to}`).

**PG-specific gotchas documented by drizzle-kit itself:**
- **"`confirm_data_loss` on `view` fires only for materialized views — regular views drop silently."** Dropping a view your app depends on produces no prompt.
- `serial`/`bigserial` auto-create their sequences with no `confirm_data_loss` prompt.
- Adding `NOT NULL` or `UNIQUE` on PG does **not** prompt — the `ALTER` just runs and the DB rejects violations. Defensible, but it means a failed deploy rather than a caught-at-plan-time error.
- `non_empty` detection requires a live DB connection, so `generate` is not purely offline in all codepaths (`dbCredentials` is documented as needed "for the introspect side of some `generate` codepaths").

### 3.4 Known bugs / recurring complaints (the 0.x engine — verify each against v1)

Renames & multi-property changes:
- #3826 — generate emits nothing for a renamed column's other changes
- #5499 — renaming a varchar **and** changing its length: only the rename is emitted, length change silently dropped
- #4838 — type error running `generate` after renaming a table
- #3653 — wrong column names in rename migration (SQLite)
- Answer Overflow: "Drizzle Kit Generate renames columns incorrectly" — https://www.answeroverflow.com/m/1316811195365195889

Indexes / generated columns:
- #4929 — updating a generated column drops its indexes and **does not recreate them**

Views:
- #3179 / #4731 — false "duplicated view name found across public schema" blocking matview generation
- #4520 — matview depending on another matview fails on creation order (no dependency topological sort)
- #1787 — matviews omitted by `introspect:pg`
- #2653 — relations to matviews unsupported

Enums (the single most-reported area):
- #5121 — **v1 beta.2**: `push` on a fresh DB fails, `CREATE TABLE` emitted before the enum type it references (ordering bug still present in the rewritten engine)
- #2389 — `push` doesn't detect existing enum labels; #3206 / discussion #3949 — `type "x" already exists`
- #3883 — `push` doesn't generate enum types at all
- #2723 — enums stopped being created
- kit-mirror #178 — no migration generated for enum deletion; kit-mirror #464 — `enum label already exists`

Push:
- #2369 — `push` makes no changes
- #3320 — `cannot drop sequence drizzle.__drizzle_migrations_id_seq` (the migrations table's own sequence blocks operations)

**Down/rollback migrations: not supported, at all.** Open requests: #2352, #4005, #2901; discussion #1339; and #2510 "migration does not rollback if it fails". The official answer is "write a new forward migration."

### 3.5 Snapshot format, journal, execution

- Layout in v1 RC (from the shipped skills): `drizzle/0000_init/migration.sql` (per-migration folder) alongside `drizzle/meta/0000_snapshot.json` and `drizzle/meta/_journal.json`. Note this **contradicts** the beta.2 note that claimed journal.json was eliminated and folders reorganised ("Folders v3"); the RC docs still reference `meta/_journal.json`. Treat the on-disk contract as unsettled.
- The snapshot is **regenerated wholesale on every migration**. drizzle-kit's own docs concede this is code-review noise and recommend `.gitattributes` (`linguist-generated=true` / `gitlab-generated` / `-diff`) to hide it. That is a design smell being papered over with tooling — full-state snapshots per migration are a guaranteed merge-conflict generator on any team with >1 concurrent branch, and marking them binary makes conflicts *harder* to resolve, not easier.
- `drizzle-kit up` migrates old snapshots to newer formats — i.e. the snapshot schema has been versioned repeatedly across 0.x.
- **Migration execution** (read from `pg-core/async/session.js` in 1.0.0-rc.4):
  ```js
  await db.transaction(async (tx) => {
    for (const migration of migrationsToRun) {
      for (const stmt of migration.sql) await tx.execute(sql.raw(stmt));
      await tx.execute(sql`insert into drizzle.__drizzle_migrations ...`);
    }
  });
  ```
  - **All pending migrations run in ONE transaction.** Atomic, which is nice, but it means a 40-migration backlog holds one long transaction and one set of locks.
  - **No advisory lock anywhere.** Confirmed by grepping both packages for `pg_advisory` — zero hits. Two app instances booting concurrently and both calling `migrate()` will race. For a tool whose docs recommend running migrations at app startup in serverless, this is a genuine correctness hole.
  - Because everything is in a transaction, **`CREATE INDEX CONCURRENTLY` is impossible via the migrator** — and there is no `concurrently` option on the index builder (grepped `pg-core/indexes.js`: no match). For a Postgres-only tool this is a headline omission: you cannot add an index to a large hot table without downtime.
  - Bookkeeping table: `drizzle.__drizzle_migrations (id serial pk, hash text, created_at bigint, name text, applied_at timestamptz default now())`. Hash-based, but there is no documented "checksum changed" abort.
  - `-- statement-breakpoint` comments let runners split statements for dialects that can't batch.
- `pull --init` marks the initial introspected migration as applied (adopting an existing DB).
- **Custom / data migrations:** `drizzle-kit generate --custom --name=x` writes an empty file you fill with SQL. There is no data-migration API, no typed up/down, no seeding integration in the migration pipeline (`drizzle-seed` is a separate package). A `data-migrator` branch exists in the dist-tags, so this is in flight.

https://orm.drizzle.team/docs/kit-overview · https://orm.drizzle.team/docs/drizzle-kit-generate · https://orm.drizzle.team/docs/drizzle-kit-push · https://orm.drizzle.team/docs/migrations

---

## 4. TypeScript cost — Drizzle's biggest structural liability

### 4.1 Measured

Prisma's benchmark (https://www.prisma.io/blog/why-prisma-orm-checks-types-faster-than-drizzle, 2025-09-09) using `@ark/attest` on the Northwind schema, EC2 `m7i.large`, Prisma 6.15.0 vs Drizzle 0.44.4 vs `1.0.0-beta.1`:

| Metric | Prisma | Drizzle 0.44.4 | Drizzle 1.0.0-beta.1 |
|---|---|---|---|
| Schema type instantiations | 428 | **41,150** (~95×) | 5,017 |
| Schema check time | 205 ms | 602 ms | — |
| RQB query instantiations (avg) | 785 | 1,165 | ~530 (32% *fewer* than Prisma) |
| SQL-builder query instantiations (avg) | 785 | 2,244 (+186%) | — |
| Query check time | 335 ms | 697 ms | 369 ms (still ~1.9× Prisma) |

Source is a competitor, so discount the framing — but the methodology (`@ark/attest`, same schema, published numbers) is sound, and Drizzle's own team independently confirms the direction.

### 4.2 Drizzle's own admission and fix

Alex Blokh (Drizzle co-founder), 2025-08-29 (https://x.com/_alexblokh/status/1961539841071738989):

> "When we released Drizzle Relational Queries v2 — we've had a huge positive feedback, but the bottleneck was TypeScript types performance."

They **rewrote Tables, Columns and Relations types from the ground up**, reporting **21.4× fewer type instantiations** on a 3.3k-line schema with 990 lines of relations, and "instant autocomplete." The rewrite forced rewriting all validator integrations (Zod, Valibot, ArkType, TypeBox) and updating drizzle-seed and drizzle-graphql — a good illustration of how deeply type design couples an ecosystem.

`1.0.0-rc.1` additionally added **JIT mappers** for a claimed "25–30% reduction in latency" (runtime, not type-check).

### 4.3 Long-tail reports

- #800 "Extremely slow intellisense depending on schema size and amount" — 8 s completion delays on an M2 Max with **40 tables**; 10–15 s on other machines. HN thread: https://news.ycombinator.com/item?id=36449555
- #870 "PERFORMANCE: drizzle type system is causing long delays for TypeScript to validate the types"
- 0.28.0 release notes explicitly list "improved performance and IntelliSense" — this has been a recurring firefight since 2023, not a one-off.

### 4.4 Measured `.d.ts` weight (from the tarballs)

| | `drizzle-orm@0.45.2` | `drizzle-orm@1.0.0-rc.4` |
|---|---|---|
| tarball | 2.0 MB | **3.0 MB** |
| unpacked | 16 MB | **25 MB** |
| `.d.ts` files | 444 | **720** |
| total `.d.ts` bytes | 1,108,699 | **1,959,159** (+77%) |
| `pg-core` `.d.ts` bytes | 209,019 | **323,663** (+55%) |
| `exports` map entries | — | **718** |
| peer dependencies | — | **47** |

Largest v1 `pg-core` declaration files: `codecs.d.ts` **34.3 KB**, `query-builders/select.d.ts` **31.5 KB**, `index.d.ts` 15.3 KB, `query-builders/update.d.ts` 14.8 KB, `columns/common.d.ts` 13.2 KB.

**The .d.ts surface grew 77% in the version that was supposed to fix type performance.** The new `codecs.d.ts` is the largest single file: a `PostgresType` literal union of ~150 members plus a `unionsTypeTable` — a nested const object mapping every type pair to a unified result type, used for `sql`/set-operation type unification. It is a huge amount of type-level lookup table. Fewer *instantiations* on a benchmark schema and a bigger, more complex declaration surface can coexist; the check-time numbers (still ~1.9× Prisma) suggest they do.

Also note every `.d.ts` is duplicated as `.d.cts` for dual CJS/ESM — 720 × 2 declaration files.

`drizzle-kit@1.0.0-rc.4` is **22 MB tarball / 95 MB unpacked** (vs 2.0 MB / 9.8 MB at 0.31.10) because it bundles a ~5–6 MB payload per dialect (`payload-postgres`, `payload-mysql`, `payload-sqlite`, `payload-mssql`, …) in both `.js` and `.mjs`. A Postgres-only user downloads all six dialects. **This is a direct, quantified argument for a PG-only tool.**

### 4.5 Error readability

Errors surface as `PgSelectBase<...>`/`PgTableWithColumns<{...}>` walls of text because the public types are generic-parameter-heavy and the table type is an intersection with its own columns. There is no branded/opaque façade type to keep the printed form short. This is a design choice we can beat: keep public types nominal and shallow, push the machinery into internal `unique symbol`-keyed slots.

---

## 5. Dependencies, drivers, serverless

- **Zero runtime dependencies** (verified: `dependencies: null`). README claims **~7.4 KB min+gzip** for the core. Both true and genuinely differentiating.
- **47 optional peer dependencies** and **718 export entries**. Every driver is a separate entrypoint: `drizzle-orm/node-postgres`, `/postgres-js`, `/neon-serverless`, `/neon-http`, `/vercel-postgres`, `/pglite`, `/aws-data-api/pg`, `/bun-sql`, `/pg-proxy`, plus Xata, Nile, Supabase, PlanetScale-Postgres, Prisma-Postgres, Netlify, and Effect variants. Tree-shaking works because dialect + driver are separate entrypoints, so you only pull what you import.
- `drizzle(urlOrClient, config)` — Drizzle can construct the client itself or wrap yours.
- The **driver-agnostic layer** is a `Session`/`PreparedQuery` pair per driver; the dialect (`PgDialect`) does SQL generation and is shared. Clean separation, worth copying in structure even though we only need one driver family.
- Serverless/edge: this is Drizzle's strongest real-world moat. Works on Workers/Deno/Bun/Lambda, no query engine binary, no `generate` step at install time (contrast Prisma's Rust engine and Docker-build pain). Docs recommend hoisting the connection and prepared statements out of the handler so warm serverless invocations reuse them.
- **`postgres-js` uses prepared statements by default**, which breaks under PgBouncer transaction pooling — a recurring support burden that a PG-only tool should handle explicitly (detect/flag pooler mode).
- `drizzle-orm/pg-proxy` for HTTP-proxied databases; `drizzle-orm/cache/upstash`; OpenTelemetry peer dep for tracing.

https://orm.drizzle.team/docs/get-started-postgresql · https://orm.drizzle.team/docs/perf-serverless

---

## 6. What Drizzle deliberately does NOT do — wisdom or gap?

| Omission | Verdict | Reasoning |
|---|---|---|
| No identity map / unit of work | **Wisdom** | Identity maps are the source of most ORM surprise (stale reads, hidden writes on flush). Explicit statements are correct for a SQL-first library. |
| No change tracking / dirty checking | **Wisdom** | Same. `update().set({...})` is honest. |
| No lazy loading | **Wisdom** | Lazy loading *is* the N+1 generator. Removing it removes the class of bug. |
| Thin serialization (driver values pass through) | **Mixed → GAP** | `numeric`, `bigint`, `date`, `interval`, `json` all decode differently across `pg` vs `postgres.js`. Drizzle papers over some of this with `mode:` options and (v1) codecs, but `sql<T>` gives you a type with no decode. A PG-only ORM can and should own decoding end-to-end and guarantee `numeric → string \| Decimal`, `int8 → bigint`, `timestamptz → Date`, deterministically and identically on every driver. |
| No auto-nesting of joined rows | **Wisdom for the core builder, GAP overall** | The core builder correctly stays flat. RQB v2's LATERAL + `json_agg` is the right answer for nesting. But the two are **disjoint APIs** — you cannot get RQB-style nesting on a hand-written join, and you cannot get core-builder power (aggregates, window functions, arbitrary CTEs) inside RQB (`extras` explicitly forbids aggregations). Users hit the wall and fall back to manual `reduce()`. **This seam is the single biggest product gap in Drizzle.** |
| No down migrations | **GAP** | Not "we prefer forward-only" — there's no `down` at all, no `--dry-run` revert, no plan diffing. Forward-only is a legitimate policy, but it should be a *policy*, not an absence. |
| No advisory lock on migrate | **GAP (bug-class)** | Concurrent deploys race. Cheap to fix (`pg_advisory_lock`); no excuse. |
| No `CREATE INDEX CONCURRENTLY` | **GAP** | Fatal for zero-downtime PG ops on large tables. A PG-only tool has no excuse. |
| No triggers / functions / domains / composite types / partitions / exclusion constraints in the DDL model | **GAP for a PG-only positioning** | Defensible for a multi-DB tool. Indefensible for us. |
| No runtime validation of `.$type` / `{enum}` | **Wisdom, with a caveat** | Casts should be cheap. But `text({enum:[...]})` should at minimum *offer* to emit a CHECK constraint. |
| No serialization-failure retry | **GAP** | If you ship `isolationLevel: 'serializable'`, ship the retry loop. |

---

## 7. Verdicts: PORT / ADAPT / SKIP

### Schema layer
| Item | Verdict | Rationale |
|---|---|---|
| `$inferSelect` / `$inferInsert` | **PORT** | Best-in-class ergonomic; table stakes. |
| `.$type<T>()` cast escape hatch | **PORT** | Honest, cheap, solves jsonb. |
| Column-builder chaining (`.notNull().default().primaryKey()`) | **PORT** | Proven, readable, IDE-friendly. |
| Table = intersection of `PgTable & columns` | **ADAPT** | Keep `users.email` ergonomics, but reach it via a shallower/nominal type to cut error spew and instantiation cost. |
| Extra-config **array** form `(t) => [index(...), pgPolicy(...)]` | **PORT** | Their own final answer; skip the deprecated object form entirely. |
| `pgView` / `pgMaterializedView` / `pgSequence` / `pgEnum` / `pgSchema` | **PORT** | Correct scope. |
| `pgPolicy` / `pgRole` / RLS / privileges / `COMMENT ON` | **PORT** | v1's expanded entity model is the right target. |
| pgvector + PostGIS column & index helpers | **PORT** | Cheap, high-value for a PG-only tool. |
| Range / multirange / tsvector / tsquery / xml / money / bit column builders | **PORT (as differentiator)** | Drizzle *doesn't have these*. Free win. |
| Triggers, functions, domains, composite types, partitions, exclusion constraints, `CREATE EXTENSION` | **PORT (as differentiator)** | Drizzle models none of these. Biggest PG-only surface gap. |
| `text({enum:[...]})` with no CHECK constraint | **ADAPT** | Same ergonomics, but emit a CHECK (or a real enum) so the type isn't a lie. |
| Codecs `unionsTypeTable` (150-member literal union + pairwise lookup table) | **SKIP** | 34 KB of `.d.ts` for type unification we can get with a small set of nominal codec types. This is where their type budget goes. |
| `pgTableCreator` global prefixing | **ADAPT** | Useful for multi-tenant/test isolation; make it a first-class schema/namespace concept instead. |

### Query layer
| Item | Verdict | Rationale |
|---|---|---|
| Core select/insert/update/delete + joins + CTE + set ops + `$dynamic()` | **PORT** | Solid, well-proven shape. |
| Nested-select-shape join nullability (`{pet: {...}} \| null`) | **PORT** | Genuinely better than every competitor. |
| RQB v2 LATERAL + `json_agg` execution strategy | **PORT** | The correct one-round-trip answer to N+1. Study the generated SQL closely. |
| `defineRelations` centralised relation graph, `from`/`to`, `through` for m2m, `optional: false` | **PORT** | v2 is strictly better than v1; skip v1's design entirely. |
| Object-literal `where` (`{ id: { gt: 10 } }`) | **ADAPT — with a safety fix** | Ergonomic, but it's a mass-assignment surface. Either use symbol-keyed operators, or require an explicit `unsafeFromJson()` to build a filter from untrusted input. Do **not** ship a `RAW` key inside the same object shape. |
| **Two disjoint query APIs (core vs relational)** | **ADAPT — this is the differentiator** | Unify: one builder where relation-nesting (`json_agg` over LATERAL) is a *projection option* available on any query, so aggregates, window functions and CTEs compose with nesting. Removes Drizzle's hardest wall. |
| `sql<T>` as a pure cast | **ADAPT** | Keep the template operator; make the type parameter drive an actual decoder (require a codec, not a bare generic). Silent-lie casts are unacceptable in a PG-only tool that owns type decoding. |
| `sql.raw()` | **ADAPT** | Keep it, but name it `unsafeRaw` and lint against it. |
| `.prepare()` + `sql.placeholder()` | **PORT** | Real perf win on warm serverless. |
| `.mapWith()` | **SKIP** | Symptom of `sql<T>` being a lie; unnecessary once codecs are mandatory. |
| Transactions with isolation level / access mode / savepoints | **PORT** | |
| `tx` vs `db` footgun (no type-level prevention) | **ADAPT** | Make the outer `db` handle *unusable* inside a transaction scope at the type level. Cheap, prevents the #1 Drizzle bug. |
| Serialization-failure retry | **PORT (as differentiator)** | Ship `db.transaction(fn, { retry: 3 })`. Drizzle has nothing. |
| Built-in Redis cache layer | **SKIP** | Scope creep; belongs in userland. Expose the invalidation hooks, not the cache. |

### Migration layer
| Item | Verdict | Rationale |
|---|---|---|
| `generate` / `migrate` / `push` / `pull` / `check` / `export` verb set | **PORT** | Well-chosen vocabulary; users already know it. |
| **`missing_hints` decision protocol** (`rename_or_create` + `confirm_data_loss`, typed `Hint[]` reply, tuple entity identity, exit-code-per-status, never-hang-in-CI) | **PORT — highest-value single idea in drizzle-kit** | Explicit consent beats heuristic rename detection. Copy the protocol nearly verbatim, including `--explain`. |
| Programmatic SDK returning the same envelope | **PORT** | Makes the tool testable and scriptable. |
| MCP server + agent skills bundle | **ADAPT** | The JSON envelope is the real asset; the MCP wrapper is a thin, cheap add-on once the envelope exists. |
| **Full-state snapshot JSON regenerated per migration** | **SKIP** | Guaranteed merge conflicts; drizzle-kit's own docs tell you to hide the diff. Use an append-only per-migration DDL delta plus a rebuildable derived state (or diff directly against a shadow DB). |
| `_journal.json` + `drizzle-kit up` snapshot-format upgrades | **SKIP** | Consequence of the snapshot design. Migration files + a DB ledger are sufficient. |
| One transaction wrapping **all** pending migrations | **ADAPT** | Default to per-migration transactions with an opt-in `--all-in-one`; allow `-- drizzle:no-transaction`-style escape for `CREATE INDEX CONCURRENTLY`. |
| **No advisory lock** | **PORT the fix** | `pg_advisory_lock` around the migrate run, always. Table stakes; Drizzle simply doesn't do it. |
| **No `CREATE INDEX CONCURRENTLY`** | **PORT the fix** | First-class `.concurrently()` on the index builder + non-transactional migration mode. Major PG-only differentiator. |
| Regular views dropping without a `confirm_data_loss` prompt | **PORT the fix** | Any drop of a named object should require consent. |
| Enum ordering bugs (`CREATE TABLE` before `CREATE TYPE`) — still present in v1 beta (#5121) | **PORT the fix** | Do proper topological sort over the full dependency graph (types, sequences, tables, views, matviews, policies, indexes). Matview→matview ordering (#4520) too. |
| Down / reversible migrations | **PORT (as differentiator)** | Generate a best-effort `down.sql` (mechanically invertible ops only) and be explicit when an op is irreversible. Drizzle has literally nothing here. |
| `--custom` empty migration for data migrations | **ADAPT** | Make data migrations first-class: typed, batched, resumable, separate ledger from DDL. |
| Six dialect payloads bundled (95 MB unpacked) | **SKIP** | PG-only. This is the argument for our existence in one number. |
| Closed-source Studio | **SKIP** | Don't build a Studio; if we do, MIT it. |

---

## 8. "If Drizzle exists, why should pg-orm-ts exist?"

**Drizzle is a multi-database tool wearing a Postgres-shaped costume, and it pays for that in three ways we don't have to.** Its DDL model stops at the intersection of six dialects — no triggers, functions, domains, composite types, partitions, exclusion constraints, ranges, or `CREATE EXTENSION` — so any real Postgres application ends up with a second, unmanaged migration path outside the ORM. Its migration runner ships without an advisory lock and wraps every pending migration in one transaction, which makes `CREATE INDEX CONCURRENTLY` structurally impossible and makes concurrent deploys a race; those are dialect-neutral compromises that a PG-only tool has no reason to inherit. And its type surface is priced for genericity: 1.96 MB of `.d.ts` across 720 files, a 34 KB literal-union codec table, and a 95 MB drizzle-kit that ships all six dialect engines to a Postgres user.

**The second gap is the seam between its two query APIs.** The relational builder generates exactly the right SQL (LATERAL + `json_agg`, one round trip) but forbids aggregations; the core builder has full SQL power but returns flat rows you group by hand. Nobody has built the thing where relation-shaped nesting is just a *projection option* on an ordinary query, so window functions, CTEs and aggregates compose with nested results. That is a real, unclaimed design win.

**Third, "thin" has been allowed to mean "inconsistent."** `sql<T>` is a cast with no decoder, `numeric`/`int8`/`timestamptz`/`interval` decode differently depending on whether you're on `pg` or `postgres.js`, and `text({enum:[...]})` produces a TypeScript union the database doesn't enforce. A single-database ORM can own the wire format end to end and make every one of those a guarantee. Where Drizzle is right — no identity map, no change tracking, no lazy loading, explicit SQL — we should copy it without hesitation. The opportunity isn't a different philosophy; it's the same philosophy executed without a multi-dialect tax, with a migration engine that treats Postgres's real object graph and real operational constraints as the requirement rather than the edge case.

---

## Appendix: source URLs

Docs — https://orm.drizzle.team/docs/rqb-v2 · /docs/relations-v1-v2 · /docs/column-types/pg · /docs/select · /docs/joins · /docs/sql · /docs/transactions · /docs/views · /docs/rls · /docs/extensions/pg · /docs/cache · /docs/migrations · /docs/kit-overview · /docs/drizzle-kit-generate · /docs/drizzle-kit-push · /docs/perf-serverless · /docs/get-started-postgresql · /docs/latest-releases/drizzle-orm-v1beta2

Repo & issues — https://github.com/drizzle-team/drizzle-orm · /releases · /discussions/2316 · /issues/4759 (open-source Studio) · /issues/800, /issues/870 (type perf) · /issues/1723 (tx rollback) · /issues/2352, /issues/4005, /issues/2901, /issues/2510, /discussions/1339 (rollback) · /issues/3826, /issues/5499, /issues/4838, /issues/3653 (renames) · /issues/4929 (generated column indexes) · /issues/3179, /issues/4731, /issues/4520, /issues/1787, /issues/2653 (views) · /issues/5121, /issues/2389, /issues/3206, /issues/3883, /issues/2723, /discussions/3949 (enums) · /issues/2369, /issues/3320 (push) · drizzle-kit-mirror/issues/178, /issues/464

Third-party — https://www.prisma.io/blog/why-prisma-orm-checks-types-faster-than-drizzle · https://x.com/_alexblokh/status/1961539841071738989 · https://news.ycombinator.com/item?id=36449555 · https://www.answeroverflow.com/m/1316811195365195889 · https://atlasgo.io/guides/orms/drizzle/triggers

Primary artifacts inspected — npm tarballs `drizzle-orm@0.45.2`, `drizzle-orm@1.0.0-rc.4`, `drizzle-kit@0.31.10`, `drizzle-kit@1.0.0-rc.4`; in particular `pg-core/table.d.ts`, `pg-core/codecs.d.ts`, `pg-core/async/session.js` (migrator), `pg-core/indexes.js`, and `drizzle-kit/skills/*/SKILL.md` (8 maintainer-authored agent skills, ~67 KB, shipped inside the package).
