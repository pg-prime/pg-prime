# Schema Migration Tooling for PostgreSQL — Landscape Survey & Design Recommendation

> **Historical snapshot — 2026-08-14. Not maintained.**
> This is a point-in-time study of software we do not control; version numbers, APIs and bug
> reports below were accurate on that date and will drift. It is kept as the provenance for the
> decisions in [`../design/`](../design/), not as a current reference. Conclusions that survived
> review are carried into [`SUMMARY.md`](./SUMMARY.md) and cited from the design docs.

**Research date: 2026-08-14** · Target: `pg-orm-ts` (Postgres-only, TypeScript, type-safe, minimal runtime deps)
All claims below were verified against live sources in August 2026; URLs are inline. Where a claim is inferred
rather than sourced it is marked *(inference)*.

---

## 0. TL;DR

- **Neither philosophy "won" — the hybrid won.** Every serious 2026 tool (Atlas, Supabase CLI, pgschema, drizzle-kit,
  Prisma) converged on: *declare desired state → tool generates a versioned SQL/plan artifact → human reviews in PR →
  runner applies deterministically.* Pure declarative "apply live diff" is now positioned as a dev-loop convenience,
  not a production deploy mechanism.
  ([Atlas](https://atlasgo.io/concepts/declarative-vs-versioned),
  [Bytebase 2026](https://www.bytebase.com/blog/top-database-schema-change-tool-evolution/))
- **The diff engine is the hard part, and there is now a MIT-licensed TypeScript one**:
  `@supabase/pg-delta` (in [supabase/pg-toolbelt](https://github.com/supabase/pg-toolbelt)), Postgres 15+, models
  ~30 object kinds including RLS policies, triggers, functions, publications. This did not exist 12 months ago and
  materially changes the build-vs-buy calculus for us.
- **The three hardest problems**: (a) rename ambiguity, (b) correctness of the diff on "hard" objects
  (functions/views/enums/partitions/RLS), (c) lock-safety of generated DDL + the transaction-mode split
  (`CREATE INDEX CONCURRENTLY` cannot be in a txn).
- **Safety linting is a solved, stealable problem**: Squawk (40 rules, Rust, actively maintained) and Atlas's
  analyzer code taxonomy (DS/MF/BC/PG1xx/PG3xx) are effectively a specification we can implement against.

---

## 1. The Two Philosophies

### 1.1 Versioned / imperative

The user writes (or the tool generates) an ordered sequence of immutable SQL files. A state table records which have
been applied. The migration *is* the artifact; the schema is whatever the sum of migrations produces.

| Tool | Notes (2026) |
|---|---|
| **Flyway** | v12.9 as of June 2026. Versioned SQL, `flyway_schema_history` with checksums. "Flyway runs migrations, full stop. Review, approval, and audit are your problem to solve elsewhere." ([Bytebase](https://www.bytebase.com/blog/top-open-source-postgres-migration-tools/), [Redgate docs](https://documentation.red-gate.com/fd/flyway-schema-history-table-273973417.html)) |
| **Liquibase** | v5.0 shipped early 2026; XML/YAML changesets; verbose ("a paragraph of markup to add one column"). |
| **Sqitch** | Pure SQL, **dependency-graph** ordering rather than linear version ordering — deploy/revert/verify triplets. MIT, no paid tier. Underrated model. |
| **graphile-migrate** | Roll-forward only, no down migrations. Killer idea: `migrations/current.sql` is re-run on every save (sub-100ms), so it **must be idempotent** (`create or replace function`, `drop ... if exists`), then gets "committed" into a numbered immutable file. Great dev loop; forces idempotent authoring. ([repo](https://github.com/graphile/migrate), [idempotent examples](https://github.com/graphile/migrate/blob/main/docs/idempotent-examples.md)) |
| **node-pg-migrate** | v8.x, maintained by Salsita. JS/TS/SQL migration files, `up()`/`down()`, programmatic API. The default "boring" Node choice. ([npm](https://www.npmjs.com/package/node-pg-migrate)) |
| **Kysely `Migrator`** | Minimal: TS files exporting `up`/`down`, `kysely_migration` + `kysely_migration_lock` tables, `pg_advisory_xact_lock()` with a **fixed lock value regardless of schema**. No generation, no diffing — you write everything. ([docs](https://kysely.dev/docs/migrations), [Migrator API](https://kysely-org.github.io/kysely-apidoc/classes/Migrator.html)) |
| **pgmigrate** (peterldowns) | Deliberately **up-only, no down migrations**; each migration in a transaction; advisory-lock protected; allows *duplicate sequence numbers* (`00123_create_a.sql`, `00123_update_b.sql`) so parallel branches don't conflict; warns on hash drift of applied files. Good design reference. ([repo](https://github.com/peterldowns/pgmigrate)) |

**Pros**: reviewable, deterministic, replayable, offline-capable, audit trail, works when CI has no DB access.
**Cons**: authoring burden, requires DDL expertise, no guarantee the files actually produce the intended schema
(drift between "what I meant" and "what I wrote").

### 1.2 Declarative / desired-state diffing

The user maintains a schema description (SQL DDL, HCL, or ORM models). The tool introspects the live DB, diffs, and
computes DDL.

| Tool | Language | Notes (2026) |
|---|---|---|
| **Atlas** (ariga) | Go, Apache-2.0 core | The category leader. HCL *or* SQL *or* ORM-loader input; 16 ORM loaders; 50+ lint analyzers. **Important licensing catch: views, materialized views, functions, procedures, triggers, sequences, domains, extensions, roles, permissions are Atlas *Pro* — they require login and cost ~$9/seat/mo.** Free tier manages only schemas/tables/indexes/constraints. ([features matrix](https://atlasgo.io/features), [repo](https://github.com/ariga/atlas)) |
| **pgschema** (pgplex, sponsored by Bytebase) | Go, Postgres-only | New in 2025-26, ~970★. Terraform-style `dump` → edit → `plan` → `apply`. Plan is emitted as **human text + JSON with a SHA-256 schema fingerprint**; apply re-computes the fingerprint and aborts on mismatch (concurrent-change detection). Explicitly **does not support RENAME**, extensions, schemas, roles, publications, event triggers, FDW. ([pgschema.com](https://www.pgschema.com/), [unsupported](https://www.pgschema.com/syntax/unsupported.md), [plan/review/apply](https://www.pgschema.com/workflow/plan-review-apply.md)) |
| **migra** | Python | **Original `djrobstep/migra` is deprecated/archived.** Actively maintained fork: [postgresql-tools/migra](https://github.com/postgresql-tools/migra), PyPI package renamed `migradiff`, CLI still `migra`. Do not depend on the original. |
| **stripe/pg-schema-diff** | Go library | PG 14–17 only. Strong on partitions, indexes, NOT NULL. **Does not support functions, triggers, or most custom types (enums excepted); renames are always drop+add.** Best-in-class hazard model and "validate plan against a temp database" step; emits per-statement `statement_timeout`/`lock_timeout`. ([README](https://github.com/stripe/pg-schema-diff/blob/main/README.md)) |
| **sqldef / psqldef** | Go | Single SQL file = desired state, idempotent apply. Simple, no plan artifact. ([repo](https://github.com/sqldef/sqldef)) |
| **Supabase `pg-delta`** | **TypeScript, MIT** | Public alpha as of April 2026. Purpose-built PG 15+ diff engine replacing migra for Supabase branching. Ships in `supabase/pg-toolbelt` with `pg-topo` (topological DDL sort). See §2.6 — this is the most relevant artifact in the whole survey for us. ([changelog](https://supabase.com/changelog/44938-public-alpha-declarative-schema-management-with-pg-delta), [repo](https://github.com/supabase/pg-toolbelt)) |
| **Prisma Migrate** | Rust→TS (v7) | Schema = `schema.prisma`; diff computed against a **shadow database** replaying migration history; emits versioned SQL into `prisma/migrations/`. Effectively hybrid already. |
| **drizzle-kit** | TypeScript | Schema = TS files; diff computed against **JSON snapshots on disk** (no DB needed for `generate`); emits versioned `.sql`. `push` is the non-versioned declarative mode (dev-only). |

**Pros**: source of truth is readable, one place to look, rapid local iteration, no manual DDL, diff engine can be
made lock-aware.
**Cons** (per Atlas's own docs and HN sentiment): requires live DB access at plan time; plans are non-deterministic
across environments; renames are ambiguous; data migrations are inexpressible; "I'll never be comfortable with any
tool that automatically generates schema changes" is a real and common reaction.
([Atlas deep dive](https://atlasgo.io/blog/2024/10/31/declarative-migrations-deepdive))

### 1.3 The hybrid — what actually won

The canonical 2026 workflow, independently arrived at by Atlas, Supabase, pgschema, Prisma and drizzle-kit:

```
desired state (SQL/TS/HCL, in git)
      │
      ├─ diff against (shadow DB | snapshot | live DB)
      ▼
generated migration artifact (SQL file or plan JSON)   ← committed to git, reviewed in PR, linted in CI
      ▼
deterministic runner (state table + advisory lock)      ← applies exactly the reviewed artifact
```

Atlas calls this "versioned migration authoring"; Supabase calls it `declarative sync`; pgschema calls it
plan/review/apply. Bytebase's 2026 verdict: *"Neither wins outright — teams often run both. Declarative for ordinary
table/column edits, versioned scripts for the data backfills that a diff cannot express."*

**Design conclusion for us: build the hybrid. Do not ship a `push`-style live-apply as anything other than a
clearly-labelled dev command.**

### 1.4 Zero-downtime specialists (a third camp)

- **pgroll** (Xata) — ~6,500★, the de-facto standard here. JSON migration files with high-level ops; creates a
  *versioned view schema* per migration and sets client `search_path` to it, so N schema versions coexist. Backfills
  new physical columns and installs bidirectional triggers during the `start` phase; `complete` drops old
  columns/views. Ops include `create_table`, `drop_table`, `rename_table`, `add_column`, `drop_column`,
  `alter_column`, `rename_column` (v0.9+), `create_index`, `drop_index`, `create_constraint`, `drop_constraint`,
  `rename_constraint`, `set_replica_identity`, and raw `sql`. PG 14+.
  ([pgroll internals](https://xata.io/blog/pgroll-internals), [expand/contract](https://xata.io/blog/pgroll-expand-contract), [repo](https://github.com/xataio/pgroll))
- **reshape** (fabianlindfors) — pioneered the views trick; per Bytebase (July 2026) it is *"less active"* and the
  author has moved on to ReshapeDB; **pgroll is the maintained take on the same trick.**

---

## 2. The Diffing Problem, In Depth

### 2.1 Introspection: `information_schema` vs `pg_catalog`

**Use `pg_catalog`. Not close.**
- `information_schema` is SQL-standard, portable, stable — but *cannot represent PG-specific features* (RLS,
  partitions, exclusion constraints, operator classes, storage params, `NOT VALID` state, generated columns…).
- Performance: `information_schema` views are themselves views over `pg_catalog` with permission filters; they are
  *"orders of magnitude slower"* for large reflection jobs and *"do not return complete data."*
  ([sqlalchemy thread](https://groups.google.com/g/sqlalchemy/c/2buHl5_UUOc), [pg mailing list on IS perf](https://postgresql.org/message-id/1591975278775-0.post%40n3.nabble.com))

Since we're Postgres-only, portability is worth nothing. Query `pg_class`, `pg_attribute`, `pg_constraint`,
`pg_index`, `pg_type`, `pg_enum`, `pg_proc`, `pg_trigger`, `pg_policy`, `pg_namespace`, `pg_depend`,
`pg_attrdef`, `pg_description`, `pg_inherits`, `pg_partitioned_table`, `pg_extension`, `pg_rewrite`, `pg_sequence`,
`pg_publication*`, `pg_default_acl` directly, plus `pg_get_*def()` helpers (`pg_get_indexdef`,
`pg_get_constraintdef`, `pg_get_viewdef`, `pg_get_functiondef`, `pg_get_triggerdef`, `pg_get_expr`).

**PG 19 (beta June 2026, GA ~Sept/Oct 2026)** adds in-core `pg_get_database_ddl()`, `pg_get_role_ddl()`,
`pg_get_tablespace_ddl()` — global objects only, so it helps baselining more than table diffing, but it signals the
direction of travel. It also adds `REPACK ... CONCURRENTLY` (non-blocking table rewrite, no ACCESS EXCLUSIVE) and
`pg_stat_lock`. ([depesz](https://www.depesz.com/2026/04/09/waiting-for-postgresql-19-new-pg_get__ddl-functions/),
[Neon PG19](https://neon.com/postgresql/postgresql-19/schema-management),
[Bytebase PG19](https://www.bytebase.com/blog/postgres-19-features-im-excited-about/))

### 2.2 Where the "current" and "desired" states come from — three architectures

| Architecture | Who | How | Trade-off |
|---|---|---|---|
| **Shadow / dev database** | Prisma, Atlas ("dev database"), Supabase, pg-delta | Spin up a scratch DB, apply desired schema (or replay migration history), introspect **both** sides through the same code path, diff two introspected models. | ✅ Normalization is free — Postgres canonicalizes your DDL for you, so `varchar` vs `character varying`, expression reformatting, default rewriting all collapse. ✅ Validates that the desired schema is even legal. ❌ Requires a DB at plan time. ❌ Permissions pain (`CREATE DATABASE`). |
| **On-disk snapshots** | drizzle-kit | Serialize the schema model to JSON per migration; diff snapshot(N) vs schema-in-code. | ✅ No DB needed for `generate`; fast; offline. ❌ Snapshots drift from reality; ❌ every migration stores a **full** dump of the schema (users report 11k-line snapshot.json), ❌ journal/snapshot chain can corrupt. |
| **Parse-only (AST)** | sqldef, partially pgschema | Parse desired SQL with a real PG parser, compare ASTs. | ✅ No DB. ❌ Normalization hell: you must reimplement Postgres's canonicalization or you get phantom diffs. |

**Atlas's "normalization" problem statement is the key insight**, and it's worth quoting the mechanism:
schemas written by humans are in *natural form*; databases store them in *normal/canonical form*; without a dev
database *"it may appear to Atlas as if some diff exists between the desired and inspected schemas, whereas in
reality there is none."* Atlas therefore round-trips the desired schema through a real Postgres instance before
diffing. ([Dev Database](https://atlasgo.io/concepts/dev-database))

pgschema does the same thing but **embeds a Postgres binary** and cleans up after itself — no external
infrastructure. That's an attractive middle path, though it costs binary size.

**Do not use `pg_dump --schema-only` as the source of truth.** It does not guarantee stable object ordering between
runs, is sensitive to formatting/whitespace in function bodies, produces a raw text diff rather than a structured
change list, and can emit objects in an order that fails to replay on a clean DB when dependencies can't be
inferred. ([PostgresCompare](https://www.postgrescompare.com/2026/03/30/top-5-ways-to-compare-postgresql-databases.html))

### 2.3 Ordering & dependencies

Generated DDL must be **topologically sorted** — drop dependents before dependencies, create dependencies before
dependents, and handle cycles (mutually-referencing FKs, functions calling each other, views on views). Supabase
shipped this as a *separate package*, `@supabase/pg-topo` ("topological sorting for SQL DDL statements"), which tells
you it's substantial enough to deserve its own module. `pg_depend`/`pg_shdepend` is the source data.

### 2.4 The rename ambiguity problem

Renaming a column and dropping+recreating it produce **identical end states**. The diff cannot distinguish them, and
getting it wrong silently destroys data. Resolution strategies actually shipped:

1. **Interactive prompt** — Atlas (`atlas migrate diff` asks *"Did you rename 'users' column from 'first_name' to
   'name'?"*), drizzle-kit (prompts on `generate`/`push`).
   ([Atlas v0.22](https://atlasgo.io/blog/2024/05/01/atlas-v-0-22))
   Failure modes seen in the wild: prompts don't work in non-TTY/CI (drizzle
   [#4615](https://github.com/drizzle-team/drizzle-orm/issues/4615)); selecting "rename" for an enum leaves the
   snapshot un-updated (drizzle-kit-mirror [#444](https://github.com/drizzle-team/drizzle-kit-mirror/issues/444));
   rename changes missing from generated SQL entirely
   ([#3826](https://github.com/drizzle-team/drizzle-orm/issues/3826)).
2. **Declarative annotation** — Atlas shipped `renamed_from` on **2026-05-20**, explicitly motivated by AI agents
   that can't answer prompts: HCL `renamed_from = "users"` or SQL `-- atlas:renamed_from users` above the
   CREATE TABLE / column / index. *"It lives next to the renamed resource, is reviewable in pull requests, and is
   resolved without prompts."* ([changelog](https://atlasgo.io/changelog/declarative-schema-renames))
3. **Structured hints file** — drizzle-kit (2026) auto-detects non-interactive mode and emits a `missing_hints`
   envelope; you resolve renames and `confirm_data_loss` via `--hints` / `--hints-file`.
4. **Refuse** — pgschema simply does not support RENAME at all; stripe/pg-schema-diff treats every rename as
   drop+add.
5. **Heuristic** — type/position/comment similarity scoring. Nobody ships this as authoritative because a false
   positive is a data-loss bug *(inference: this is why)*.

**Recommendation: annotation-first (like Atlas `renamed_from`), prompt as a convenience in TTY, never heuristic-only.**
The annotation is the only approach that survives CI, code review, and agentic editing.

### 2.5 The "hard objects" checklist

Ranked roughly by (frequency × difficulty):

**Enums.** `ALTER TYPE ... ADD VALUE` — since PG 12 it may run inside a transaction block, **but the new value
cannot be used until that transaction commits**. So `ADD VALUE` + `UPDATE ... SET col = 'newvalue'` in one migration
fails. **There is no way to remove or reorder an enum value in any Postgres version.** The only removal path is:
rename old type → create new type → `ALTER TABLE ... ALTER COLUMN ... TYPE new USING col::text::new` (a table
rewrite, ACCESS EXCLUSIVE) → drop old type — and you must also fix every function signature, default, and cast that
referenced it. ([ALTER TYPE docs](https://www.postgresql.org/docs/current/sql-altertype.html))
Practical guidance many teams adopt: prefer a lookup table + FK, or `text` + CHECK constraint, over native enums.
Squawk even has a `require-enum-value-ordering` rule.

**Views / materialized views.** Postgres stores the *rewritten, normalized* parse tree, so `pg_get_viewdef` output
never textually matches what you wrote (schema-qualification added, `SELECT *` expanded to explicit columns, casts
made explicit, parens/whitespace normalized). Text comparison produces endless phantom diffs — you must either
normalize both sides through a real DB (shadow-DB approach) or compare parse trees. Views also can't be `ALTER`ed
structurally: adding a column mid-list requires `DROP VIEW ... CASCADE` + recreate, which cascades to dependent
views, RLS policies, and grants that then must be re-created. Materialized views additionally have data, indexes,
and a `REFRESH` cost. *(Mechanism is well-established PG behaviour; the phantom-diff consequence is inference.)*

**Functions / procedures / triggers.** `CREATE OR REPLACE FUNCTION` makes these cheap to apply but hard to diff:
the body is an opaque string, whitespace-sensitive, and `pg_get_functiondef` re-renders it. Most tools give up:
**stripe/pg-schema-diff explicitly does not support functions and triggers**; Atlas puts them behind the **Pro**
paywall. pg-delta models them. Pragmatic answer used by graphile-migrate and many teams: treat functions/triggers as
**idempotent "repeatable" migrations** re-applied whenever their file hash changes (Flyway's `R__` prefix concept),
rather than diffing them. Triggers additionally take a `SHARE ROW EXCLUSIVE` lock on creation (Atlas PG308).

**RLS policies.** `pg_policy`: name, command (`ALL`/`SELECT`/…), roles, `USING` expr, `WITH CHECK` expr, PERMISSIVE
vs RESTRICTIVE, plus the table-level `relrowsecurity` / `relforcerowsecurity` flags. Expressions have the same
normalization problem as views. `ALTER POLICY` exists so you can avoid drop+create. **Prisma has no representation
for policies at all** — users hand-write them into `--create-only` migrations
([Prisma unsupported features](https://www.prisma.io/docs/orm/prisma-migrate/workflows/unsupported-database-features),
[discussion #10486](https://github.com/prisma/prisma/discussions/10486)). Drizzle models them in TS and generates
them. pg-delta models them. Atlas: Pro.

**Partitions.** Diffing must distinguish "the partitioned parent's shape changed" (propagates to all children) from
"a partition was attached/detached" (routine, and often done by a cron job rather than a migration — so the tool
must not try to *drop* partitions it doesn't know about). `ATTACH PARTITION` takes a lock and validates the
constraint unless a matching CHECK exists; `DETACH PARTITION CONCURRENTLY` exists (Squawk has
`require-concurrent-partition-detach`). stripe/pg-schema-diff advertises partitions as a strength.

**Constraint validation states.** `pg_constraint.convalidated`. A `NOT VALID` FK/CHECK is a *different object state*
than a validated one, and the whole safe-migration pattern depends on being able to express it. As of PG 18, **named
NOT NULL constraints also support `NOT VALID` / `VALIDATE`** (`pg_attribute.attnotnull` was widened to `char` to
carry an INVALID flag) — this is a big deal because it finally makes "add NOT NULL without a full-table
ACCESS EXCLUSIVE scan" a first-class operation rather than a CHECK-constraint hack.
([pg-hackers thread](https://www.postgresql.org/message-id/202503201107.67xlajjijvkw%40alvherre.pgsql))

**Comments.** `pg_description` / `pg_shdescription`. Cheap, but easy to forget; they're part of the desired state if
your schema DSL supports `.comment()`.

**Extensions.** `CREATE EXTENSION` brings in objects the diff engine will then see as "unmanaged" and try to drop.
Every tool needs an ownership/provenance model. pgschema **excludes extensions entirely**; Prisma requires you to
install extensions *inside a migration* because the shadow DB needs them too. pg-delta explicitly has
"provenance-aware catalog completeness check" so unmodeled objects surface as diagnostics instead of being silently
ignored or dropped. Supabase's own open bug
([pg-toolbelt #269](https://github.com/supabase/pg-toolbelt/issues/269)) is exactly this: user objects referencing
managed-schema objects (`auth.jwt()`, `storage.objects`) get stuck during declarative apply.

**Grants / roles / default privileges.** `pg_default_acl` + relacl arrays. Cluster-scoped, shared across databases,
and usually managed by a different team than the one shipping the ORM schema. pgschema excludes roles;
Atlas puts roles/permissions in Pro; pg-delta models roles, role membership, and default privileges.
**Recommendation: model grants as opt-in, never diff-and-drop by default.**

**Sequences / identity.** Serial vs `GENERATED ... AS IDENTITY` (Squawk: `prefer-identity`), ownership links,
`last_value` runtime state (pg-delta explicitly excludes `last_value` — correct: it's data, not schema).

### 2.6 `@supabase/pg-delta` — the most interesting artifact for us

- **TypeScript, MIT, Postgres 15+ only.** Lives in `supabase/pg-toolbelt` next to `@supabase/pg-topo`.
- **Modeled**: schema, role, role membership, default privilege, extension, table (incl. partitioned tables,
  inheritance, replica identity), column, default, constraint (table/domain/foreign-table CHECK), index, sequence,
  view, materialized view, function, procedure, aggregate, trigger, **policy**, rewrite rule, event trigger, domain,
  enum/composite/range type, collation, publication, subscription, FDW, server, user mapping, foreign table —
  plus comments and ACLs for all applicable objects.
- **Deliberately excluded but *detected and reported***: user-defined languages, FTS configs/dicts/parsers/templates,
  operator classes/families, casts, transforms, statistics objects, parameter ACLs, large objects, extension version
  info, collation version data, sequence `last_value`.
  ([COVERAGE.md](https://github.com/supabase/pg-toolbelt/blob/main/packages/pg-delta/COVERAGE.md))
- Runs against a **shadow database**; replaced migra as the default diff engine for Supabase dashboard branching.
- Exposed as `supabase db diff --use-pg-delta` and `supabase db schema declarative sync`.
- **Status: alpha.** Supabase's own words: *"isn't battle tested yet"*, *"you'll probably run into cases where the
  diff is wrong or incomplete."*

The "catalog completeness check" idea — enumerate everything in the catalog, subtract what you model, and *surface
the remainder as diagnostics* — is the single best design idea I found in this survey and we should copy it
regardless of what else we do.

---

## 3. Safety

### 3.1 Lock hazards — the actual trap list

All ALTER TABLE variants take **ACCESS EXCLUSIVE** by default; the danger is not the lock *level*, it's the lock
*duration* (a full table scan or rewrite while holding it) — plus the **lock queue** effect, where a blocked
ACCESS EXCLUSIVE request blocks every subsequent reader behind it.
([Citus: 7 tips for dealing with Postgres locks](https://www.citusdata.com/blog/2018/02/22/seven-tips-for-dealing-with-postgres-locks/))

| Operation | Cost | Safe pattern |
|---|---|---|
| `ADD COLUMN` (no default / **immutable** default) | O(1) since PG 11 — value stored in `pg_attribute.attmissingval`, no rewrite | safe |
| `ADD COLUMN DEFAULT <volatile>` (e.g. `clock_timestamp()`, `gen_random_uuid()`) | **full table rewrite** — if `provolatile != 'i'` PG rewrites | add column nullable → backfill in batches → `SET DEFAULT` (Atlas **PG302**) |
| `SET NOT NULL` | full table scan under ACCESS EXCLUSIVE | PG ≤17: add `CHECK (col IS NOT NULL) NOT VALID` → `VALIDATE CONSTRAINT` (ShareUpdateExclusive) → `SET NOT NULL` (PG skips the scan because the CHECK proves it) → drop CHECK. **PG 18+: `ADD CONSTRAINT ... NOT NULL ... NOT VALID` + `VALIDATE`** (Atlas **PG303**) |
| `ADD FOREIGN KEY` | full scan + blocks writes on **both** tables | `NOT VALID` then `VALIDATE CONSTRAINT` (Atlas **PG306**) |
| `ADD CHECK` | full scan | `NOT VALID` + `VALIDATE` (Atlas **PG305**) |
| `ALTER COLUMN TYPE` | table **and index** rewrite | new column + backfill + swap, or use a domain/varchar→text special case (Atlas **PG301**) |
| `ADD PRIMARY KEY` / `ADD UNIQUE` | builds index under ACCESS EXCLUSIVE | `CREATE UNIQUE INDEX CONCURRENTLY` then `ADD CONSTRAINT ... USING INDEX` (Atlas **PG104/PG105**, Squawk `disallowed-unique-constraint`) |
| `CREATE INDEX` | blocks writes for build duration | `CONCURRENTLY` (Atlas **PG101**, Squawk `require-concurrent-index-creation`) |
| `DROP INDEX` | ACCESS EXCLUSIVE | `DROP INDEX CONCURRENTLY` (Atlas **PG102**) |
| `CREATE TRIGGER` | `SHARE ROW EXCLUSIVE` — blocks writes | (Atlas **PG308**) |
| `ADD ... GENERATED ALWAYS AS (...) STORED` | full rewrite | (Atlas **PG309**) |
| `ADD COLUMN ... GENERATED ... AS IDENTITY` | full rewrite | (Atlas **PG310**) |
| `SET LOGGED` / `SET UNLOGGED` | full rewrite | (Atlas **PG307**) |
| `SET ACCESS METHOD` | table + index rewrite | (Atlas **PG311**) |
| `RENAME` table/column | instant, but **breaks running app code** | expand/contract (Atlas **BC101/BC102**, Squawk `renaming-column`/`renaming-table`) |

### 3.2 `CREATE INDEX CONCURRENTLY` × transactional runners — the structural conflict

CIC **cannot run inside a transaction block** because it internally commits several transactions and waits for
concurrent snapshots to drain. But most runners wrap each migration file in `BEGIN/COMMIT` to exploit PG's
transactional DDL. These two goods are mutually exclusive, and every tool needs an escape hatch:

- **Atlas**: `-- atlas:txmode none` file header directive; the linter flags its absence as **PG103**.
  Other file-level directives: `atlas:nolint`, `atlas:checkpoint`, `atlas:delimiter`, `atlas:txtar`,
  `atlas:sensitive`. ([applying migrations](https://atlasgo.io/versioned/apply))
- **Squawk**: `ban-concurrent-index-creation-in-transaction`, `transaction-nesting`, `ban-uncommitted-transaction`.
- **goose/node-pg-migrate/Django**: per-migration `disableTransaction` / `atomic = False` flags.
- **pgschema**: "transaction-adaptive execution" — it decides per-statement.

**Second-order problem nobody handles well: a failed CIC leaves an INVALID index behind.** It is not used by the
planner but *is* still maintained on every write, consuming I/O and causing lock contention. Detect with
`SELECT * FROM pg_index WHERE NOT indisvalid`; clean with `DROP INDEX CONCURRENTLY` or `REINDEX CONCURRENTLY` (which
can itself leave `_ccnew` suffixed leftovers).
([PostgresAI: hidden cost of invalid indexes](https://postgres.ai/blog/20260106-invalid-index-overhead))
A migration runner that retries a failed CIC without first dropping the invalid index will fail forever. **We should
emit `DROP INDEX IF EXISTS ... ;` before `CREATE INDEX CONCURRENTLY` — i.e. Squawk's `prefer-robust-stmts` rule.**

### 3.3 Timeout hygiene

The universally-recommended preamble, and something we should emit automatically:

```sql
SET lock_timeout = '3s';       -- fail fast rather than queue behind/ahead of traffic
SET statement_timeout = '30s'; -- bound the damage
```

- stripe/pg-schema-diff sets session-level statement and lock timeouts **on each migration statement**.
- Squawk has `require-timeout-settings`, `require-lock-timeout`, `require-statement-timeout`.
- Critical subtlety: `statement_timeout` must be **disabled or raised** for `CREATE INDEX CONCURRENTLY` and
  `VALIDATE CONSTRAINT`, which are intentionally long-running. So it's per-statement, not per-migration.
- Retry-with-backoff on `lock_timeout` failure is the correct behaviour (fail fast, sleep, retry) rather than waiting.

### 3.4 Destructive-change detection

Atlas's analyzer taxonomy is effectively a spec ([full list](https://atlasgo.io/lint/analyzers)):

- **DS** destructive: `DS101` schema dropped, `DS102` table dropped, `DS103` non-virtual column dropped.
- **MF** data-dependent (may fail at runtime depending on existing data): `MF101` add unique index to existing
  column, `MF102` non-unique→unique index, `MF103` add non-nullable column, `MF104` nullable→non-nullable.
- **BC** backward-incompatible (breaks deployed app code): `BC101` rename table, `BC102` rename column.
- **PG1xx** concurrent index / lock-acquiring constraint creation *(Pro)*.
- **PG3xx** blocking changes requiring rewrite or full scan *(Pro)*.
- Also: non-linear changes, naming conventions (NM1xx), ownership policy (OW1xx), SQL injection (SA101),
  transaction safety (TX101/TX201), constraint deletion (CD1xx).

The MF/BC distinction is important and underappreciated: **MF = might fail during deploy; BC = will succeed and then
break your running app.** A good linter must model both.

### 3.5 Squawk — 40 rules, worth implementing wholesale

Rust, rust-analyzer-derived CST parser, actively maintained (releases as recently as June 2026), `cargo xtask
new-rule` scaffolding. Full rule list ([docs](https://squawkhq.com/docs/rules)):

`adding-field-with-default`, `adding-foreign-key-constraint`, `adding-not-nullable-field`, `adding-required-field`,
`adding-serial-primary-key-field`, `ban-char-field`, `ban-concurrent-index-creation-in-transaction`,
`ban-drop-column`, `ban-drop-database`, `ban-drop-not-null`, `ban-drop-table`, `changing-column-type`,
`constraint-missing-not-valid`, `disallowed-unique-constraint`, `prefer-bigint-over-int`,
`prefer-bigint-over-smallint`, `prefer-identity`, `prefer-robust-stmts`, `prefer-text-field`, `prefer-timestamptz`,
`renaming-column`, `renaming-table`, `require-concurrent-index-creation`, `require-concurrent-index-deletion`,
`transaction-nesting`, `ban-create-domain-with-constraint`, `ban-alter-domain-with-add-constraint`,
`ban-truncate-cascade`, `syntax-error`, `require-timeout-settings`, `require-lock-timeout`,
`require-statement-timeout`, `ban-uncommitted-transaction`, `require-enum-value-ordering`, `require-table-schema`,
`identifier-too-long`, `require-concurrent-partition-detach`, `require-concurrent-reindex`, `prefer-repack`,
`ban-duplicate-column-assignments`.

Note `prefer-repack` — presumably now points at PG 19's in-core `REPACK CONCURRENTLY` rather than `pg_repack`.

**We should ship a Squawk-compatible subset natively (so `pnpm orm migrate lint` works with zero extra installs) and
document `squawk` as the CI escalation.** Since squawk is a standalone binary, "shell out if present" is also viable.

### 3.6 Zero-downtime patterns

**Expand/contract** is the only pattern that generalizes:
1. **Expand** — add the new thing, nullable/NOT VALID, non-breaking. Deploy.
2. **Backfill** — batched, idempotent, resumable, replica-lag-aware (1,000 rows/txn is the commonly cited unit; pause
   automatically if replication lag exceeds a threshold). Dual-write via triggers or app code.
3. **Migrate reads** — deploy app version that reads new, writes both.
4. **Contract** — deploy app version that only uses new; then drop the old thing.

pgroll automates steps 1-2 and the version-coexistence problem via per-version view schemas + `search_path`. It is
the right *complement* to a diffing ORM, not a competitor: a plausible future for us is
`pg-orm-ts migrate generate --format pgroll`.

---

## 4. Operational Mechanics

### 4.1 State tracking tables

| Tool | Table | Notable columns / behaviour |
|---|---|---|
| Flyway | `flyway_schema_history` | `installed_rank, version, description, type, script, checksum, installed_by, installed_on, execution_time, success`. Validates checksums on every `migrate` by default. |
| Prisma | `_prisma_migrations` | checksum, logs, `rolled_back_at`, `applied_steps_count`. Checksum mismatch = drift → reset in dev, hard fail in `migrate deploy`. |
| Kysely | `kysely_migration` + `kysely_migration_lock` | separate lock table; fixed advisory lock id |
| drizzle | `drizzle.__drizzle_migrations` | hash + created_at; plus `meta/_journal.json` + `meta/NNNN_snapshot.json` on disk |
| Atlas | `atlas_schema_revisions` | includes partial-apply position for resumability |
| pgmigrate | `pgmigrate_migrations` | up-only; warns (doesn't fail) on hash drift |

Three decisions define runner safety: **checksum model** (how you detect an applied file was edited), **history
table shape**, and **locking strategy**. Also worth stealing: recording *partial application position* so a
half-applied non-transactional migration can be resumed rather than requiring manual repair.

### 4.2 Advisory locks & concurrent deploys

`pg_advisory_lock` / `pg_advisory_xact_lock` is the standard mechanism (Atlas, Alembic, Kysely, pgmigrate all use
it). Three real footguns:

1. **Transaction-pooling poolers break session-scoped advisory locks.** PgBouncer `pool_mode=transaction`, PgCat,
   Odyssey release the underlying connection between transactions, so a session-level `pg_advisory_lock` taken on one
   pooled connection may be *released on a different one* — the unlock silently no-ops and the original backend goes
   back in the pool still holding the lock. Reported symptoms include hangs
   ([IBM/mcp-context-forge #4051](https://github.com/IBM/mcp-context-forge/issues/4051)) and *autovacuum being
   disabled on the locked relation* ([AIOStreams #975](https://github.com/Viren070/AIOStreams/issues/975)).
   **Mitigation: migrations must use a dedicated direct connection, never the app pool, and prefer
   `pg_advisory_xact_lock` so the lock dies with the transaction.**
2. **A fixed global lock key** (Kysely) means two unrelated schemas in one database serialize against each other.
   Derive the key from the schema/database name via a hash.
3. **Crash/kill during migration** — the lock must auto-release. Transaction-scoped locks do; session-scoped ones do
   too, but only when the backend actually dies, which a pooler can delay indefinitely.

Deployment topology matters more than the lock: the survey of real OSS projects
([ardentperf, March 2026](https://ardentperf.com/2026/03/25/database-schema-migrations-in-2026-survey/)) found
**~10 projects auto-migrate on app startup** (Ghost, Grafana, Keycloak, Mattermost…), **6 use dedicated k8s Jobs**
(GitLab, Airflow, Superset, Temporal, Kong, Jaeger), 1 uses an init container (Gitea), 4 require manual operator
action. The same survey found language-framework migrators (~40 projects) and **custom in-house systems (~30
projects)** dominate; dedicated external tools like Flyway/Atlas had minimal adoption in surveyed OSS. Sobering: most
teams roll their own.

### 4.3 Transactional DDL — the Postgres superpower

Postgres can roll back `CREATE TABLE`, `ALTER TABLE`, `DROP INDEX`, `CREATE INDEX`, `ALTER TYPE`, comments, grants —
essentially all catalog operations. Exceptions: `CREATE DATABASE`, `DROP DATABASE`, tablespace ops,
`CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY`, `VACUUM`, `ALTER SYSTEM`,
`ALTER TYPE ... ADD VALUE` usability-within-txn. MySQL has *none* of this — it auto-commits per DDL statement,
which is why the MySQL ecosystem needs gh-ost/pt-osc and why MySQL-first tools are pessimistic in ways we shouldn't
copy. ([Bytebase](https://www.bytebase.com/blog/postgres-vs-mysql-ddl-transaction/))

**Exploit it aggressively**: wrap each migration file in a transaction *including the history-table insert*, so
"migration applied" and "migration recorded" are atomic — no torn state, ever. Then provide an explicit opt-out
(`-- pg-orm:txmode none`) for the CONCURRENTLY cases. Optionally offer whole-run-in-one-transaction for CI/dev.

*Caveat worth documenting:* wrapping everything in one long transaction means every ACCESS EXCLUSIVE lock taken
anywhere in the file is held until COMMIT. Long transactions + DDL is its own hazard. Per-file transactions, not
per-run, should be the default.

### 4.4 Baselining an existing database

Non-negotiable for adoption. The Flyway/Atlas pattern:
1. Introspect the live DB, emit a single "initial" migration representing current state.
2. Insert a history row marking it applied **without executing it** (`--baseline` / `baselineOnMigrate`).
3. All future migrations run normally.

Atlas additionally supports **importing existing migration directories** from Flyway/Liquibase/goose/golang-migrate.
For us, "import from drizzle-kit / Prisma migrations" is a plausible adoption lever *(inference)*.

### 4.5 Down migrations — do serious teams use them?

**Mostly no, and the trend is clearly against.** Evidence:
- Prisma officially recommends **roll forward**: apply a new migration that reverses the change, preserving a clear
  audit trail. ([discussion #29030](https://github.com/prisma/prisma/discussions/29030))
- graphile-migrate: roll-forward only, no down migrations, by design.
- pgmigrate: *"only has up migrations, no down migrations"* as an explicit design decision.
- drizzle-kit: no rollback at all — "write a reverse migration manually, restore from backup, or use PITR."
- Atlas ships [down migrations](https://atlasgo.io/versioned/down) but frames them as for cases the tool
  *cannot infer* — chiefly data migrations.
- Counter-evidence: golang-migrate's paired `.up.sql`/`.down.sql` remains the most-adopted Go pattern, and Django's
  reversible migrations are used extensively without complaint.

The killer argument: **a down migration cannot restore dropped data.** `DROP COLUMN` is not reversible, so the down
migration is a lie in exactly the case you'd most want it. Real rollback strategies in 2026 are:
expand/contract (nothing to roll back), compensating forward migrations, PITR/backups, and blue-green.

**Recommendation: up-only by default. Support an optional `down` export purely for the local dev loop
(`migrate down --dev`), refuse to run it against a production-tagged environment without `--force`.**

### 4.6 Squashing / checkpoints

Long migration directories slow CI (every test DB replays 400 files) and confuse newcomers. Two mechanisms:
- **Flyway CDRB** (Create baseline, Delete old, Rename, Baseline) — manual and error-prone.
- **Atlas `atlas:checkpoint`** — a file tagged as a checkpoint contains the full schema state; fresh databases jump
  straight to it while existing databases continue linearly. **This is the right design** and is strictly better than
  destructive squashing.

### 4.7 Data migrations & seeding

The consistent 2026 advice is **separate lanes**:
- DDL goes through the diff/generate path.
- Backfills go through hand-written migrations, run *out of band*, in batches, idempotent and resumable.
  Bytebase: *"declarative for ordinary table and column edits, versioned scripts for the data backfills that a diff
  cannot express."*
- Never inline a large `UPDATE` into a transactional DDL migration: it holds locks for the duration and can't be
  paused.
- Seeding is a third thing again — environment-scoped, re-runnable, not part of migration history.

---

## 5. What ORM-Bundled Migrators Get Wrong (recurring complaint themes)

### Prisma Migrate
- **Shadow database is the #1 pain source.** Requires `CREATE DATABASE` privilege; fails on managed platforms
  (Supabase/Neon/RDS) where the user can't create databases; P3006 "migration failed to apply cleanly to the shadow
  database"; `shadowDatabaseUrl` in `schema.prisma` is ignored by some commands; the shadow DB starts *empty* so it
  can't reproduce a pre-existing production schema.
  ([#4571](https://github.com/prisma/prisma/issues/4571), [#18623](https://github.com/prisma/prisma/issues/18623),
  [#20520](https://github.com/prisma/prisma/issues/20520), [#13459](https://github.com/prisma/prisma/discussions/13459),
  [#25359](https://github.com/prisma/prisma/discussions/25359))
- **No representation for views, RLS policies, triggers, functions, extensions.** Official answer is
  `migrate dev --create-only` then hand-edit SQL — which means the shadow DB must also be able to replay that SQL,
  which is why extensions must be installed *via a migration*.
- **No renames.** Changing a field name in `schema.prisma` produces drop+create.
- **`migrate dev` resets the database on drift** → data loss in dev, repeatedly surprising people.
- **Confusing transaction semantics** ([#22922](https://github.com/prisma/prisma/issues/22922)).
- **PgBouncer incompatibility** (prepared statements).
- **Non-interactive environments** (Docker/CI) fail without `--interactive --tty`.
- Prisma 7 (Nov 2025) went Rust-free/WASM, moved config to `prisma.config.ts`, made driver adapters mandatory and
  `output` required — a large migration cost of its own.
  ([v7 changelog](https://www.prisma.io/changelog/2025-11-19), [upgrade guide](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7))

### drizzle-kit
- **Snapshot fragility**: full-schema JSON snapshot per migration (11k+ lines reported), a `_journal.json`
  id/prevId chain that can desync, silent snapshot overwrites requiring manual git surgery to repair
  ([#5774](https://github.com/drizzle-team/drizzle-orm/issues/5774),
  [#1554](https://github.com/drizzle-team/drizzle-orm/issues/1554),
  [#5635](https://github.com/drizzle-team/drizzle-orm/issues/5635)).
- **Rename prompts**: unusable in non-TTY ([#4615](https://github.com/drizzle-team/drizzle-orm/issues/4615));
  enum rename doesn't update the snapshot ([drizzle-kit-mirror #444](https://github.com/drizzle-team/drizzle-kit-mirror/issues/444));
  rename changes missing from generated SQL ([#3826](https://github.com/drizzle-team/drizzle-orm/issues/3826)).
  *Partly fixed in 2026 via the `--hints`/`--hints-file` + `missing_hints` mechanism.*
- **`push` in production** — bypasses migration history, silently drops columns, no confirmation. Documented as
  dev-only but the footgun is heavily reported.
- **No rollback at all.**
- Silent misinterpretation of intent: renames become drop+add.

### MikroORM
- **Migrations and SchemaGenerator disagree**: *"migrations respect the snapshot file while schema generator ignores
  it"* → you must not use both ([#1623](https://github.com/mikro-orm/mikro-orm/issues/1623)).
- **Phantom migrations**: generates identical migration files repeatedly even when the schema is up to date,
  especially with `defaultRaw` columns ([#5363](https://github.com/mikro-orm/mikro-orm/issues/5363)).
- **Multi-schema bugs**: incorrect SQL when one table has a schema and another doesn't
  ([#4918](https://github.com/mikro-orm/mikro-orm/issues/4918)); no way to scope entity generation to a schema
  ([#1301](https://github.com/mikro-orm/mikro-orm/issues/1301)).
- **No dynamic/multi-tenant schema migrations** — long-standing requests
  ([#681](https://github.com/mikro-orm/mikro-orm/issues/681), [#3319](https://github.com/mikro-orm/mikro-orm/issues/3319)).

### The cross-cutting pattern

Five failure modes recur across all three:

1. **The diff model is incomplete**, so users are forced into raw-SQL escape hatches that the tool then can't
   reconcile → permanent drift.
2. **The snapshot/shadow mechanism is a second source of truth** that can desync from both the code and the DB, with
   no first-class repair command.
3. **Renames are handled by an interactive prompt**, which is exactly the wrong interface for CI, monorepos, and
   agents.
4. **No lock-safety awareness** — the generated SQL is naïvely correct and operationally dangerous.
5. **No answer for "what do I do when a migration half-applied in production"**, beyond manual psql surgery.

**These five are our product opportunity.**

---

## 6. Recommendation: the ideal migration workflow for a PG-only TS ORM in 2026

### 6.1 Source of truth

**TypeScript schema definitions in the ORM's own DSL** (that's the point of the ORM) — but with an escape hatch:
a `sql/` directory of raw DDL files (views, functions, triggers, policies, extensions, grants) that participate in
the same desired-state model. Both are compiled to one **canonical schema IR**.

Rationale: the TS DSL will never cover 100% of Postgres, and the moment it doesn't, users go to raw SQL. If raw SQL
is *outside* the model, you get permanent drift (Prisma's disease). If it's *inside*, you win.

Every object in the IR carries a **provenance/ownership tag** (`managed` | `unmanaged` | `external`). Anything in the
catalog that we don't model is reported as a diagnostic, never silently dropped. *(Steal directly from pg-delta's
"catalog completeness check".)*

### 6.2 Diff engine

**Verdict: build our own, structured as an independent package, but seed it with pg-delta's data model — and
seriously evaluate depending on `@supabase/pg-delta` for v1.**

| Option | Verdict |
|---|---|
| **Depend on `@supabase/pg-delta`** (TS, MIT, PG15+) | **Strong v1 candidate.** Same language, no subprocess, MIT, broadest object coverage of anything surveyed, backed by a company that needs it to work. Risks: alpha, PG15+ floor, Supabase-shaped priorities, its model is SQL-text-in/SQL-text-out rather than "ORM IR in". **Action: prototype against it in week 1; decide empirically.** |
| **Shell out to Atlas** | ✗ — the objects we most need (views/functions/triggers/RLS/extensions) are **Pro-gated behind a login and a per-seat fee**. A "minimal dependencies" ORM cannot require users to log into a vendor. |
| **Shell out to `migra`/`migradiff`** | ✗ — Python runtime dependency; upstream deprecated; fork is young. |
| **Shell out to `stripe/pg-schema-diff`** | ✗ as the engine (no functions/triggers/custom types, no renames), ✓✓ as a **design reference** for hazards + plan validation. |
| **Shell out to `pgschema`** | ✗ as the engine (no renames, no extensions/schemas/roles), ✓✓ as a **design reference** for the fingerprinted plan artifact. |
| **Own engine, from scratch** | The v2 destination. ~30 object kinds, per-kind diff rules, topological sort, normalization. Very large. |

**Introspection**: `pg_catalog` only, one round-trip of well-indexed catalog queries, PG 15+ floor (matches pg-delta;
PG 14 is EOL Nov 2026 anyway).

**Normalization**: use a **shadow database**, but *make it cheap and never require `CREATE DATABASE`*:
1. If `SHADOW_DATABASE_URL` is set → use it.
2. Else try `CREATE DATABASE` on the target cluster (Prisma's default).
3. Else create a **temporary schema** in the current database and diff schema-scoped. *(Avoids the #1 Prisma
   complaint on managed platforms.)*
4. Else `--offline` mode: diff IR-vs-snapshot without normalization, with a loud warning about phantom diffs.

Also support `--shadow=docker` (testcontainers) and `--shadow=pglite` for local dev. PGlite is attractive for speed
but **must be validated for catalog fidelity before we trust it for normalization** *(inference: unverified)*.

### 6.3 File format

Generated artifact = **plain `.sql` file** plus a **sidecar `.plan.json`**:

```
migrations/
  0001_init.sql
  0001_init.plan.json
  20260814T1032_add_orders_index.sql
  20260814T1032_add_orders_index.plan.json
```

- **`.sql` is the executable artifact** — reviewable in a PR by anyone who knows SQL, runnable by `psql` if our tool
  ever fails. Non-negotiable. (drizzle and Prisma both get this right; Liquibase's XML does not.)
- **`.plan.json` carries** the `from`/`to` schema fingerprints (SHA-256, à la pgschema), the structured change list
  (for linting and rendering), hazard annotations, the transaction mode, and any rename annotations that were
  resolved. **Apply refuses to run if the live fingerprint ≠ `from`.** This is the concurrency guard *and* the drift
  guard, and it's strictly better than Prisma's "checksum the schema file" approach.
- **No per-migration full snapshots** (drizzle's mistake). The fingerprint is a hash; full state lives only in
  periodic **checkpoint** files (Atlas's `atlas:checkpoint`), which double as squashing and as the fast path for
  fresh databases.
- **Filename = timestamp + slug**, and allow duplicate timestamps to merge cleanly (pgmigrate's insight). Ordering
  is by the journal, not by filename parsing alone.
- **Header directives** in SQL comments: `-- pg-orm:txmode none`, `-- pg-orm:nolint <rule>`,
  `-- pg-orm:checkpoint`, `-- pg-orm:timeout 30s`. Copy Atlas's directive vocabulary — it's proven and
  users may already know it.

### 6.4 Renames

**Annotation-first.** In the TS schema: `column('name').renamedFrom('first_name')`. In raw SQL:
`-- pg-orm:renamed_from users`. The annotation is:
- committed to git and visible in the PR diff,
- consumed by `generate`, then **removed by a codemod** once the migration is generated (or left as an inert marker;
  decide in v1 design),
- works in CI and for AI agents without a TTY.

Interactive prompt is a **convenience layer on top** that just writes the annotation for you (`--interactive`).
Never a heuristic guess. If a rename is unannotated and ambiguous, `generate` **fails** in CI mode with a
`missing_hints`-style structured report (drizzle got this part right in 2026).

### 6.5 Safety rails

1. **Built-in linter** on the generated SQL, Squawk-rule-compatible names + Atlas-style severity codes
   (destructive / data-dependent / backward-incompatible / lock-hazard). Runs automatically inside `generate` and as
   `migrate lint` in CI. Configurable severities; `-- pg-orm:nolint` escape hatch.
2. **Lock-aware generation, not just lock-aware warning.** Where an unambiguously-safer equivalent exists, *emit it*:
   - index creation → `CREATE INDEX CONCURRENTLY` + `DROP INDEX IF EXISTS` guard + `txmode none`
   - FK / CHECK → `NOT VALID` then a separate `VALIDATE CONSTRAINT` statement
   - `SET NOT NULL` → PG18+ `NOT NULL NOT VALID` + `VALIDATE`; PG15-17 → CHECK-constraint dance
   - `UNIQUE`/`PRIMARY KEY` → `CREATE UNIQUE INDEX CONCURRENTLY` + `ADD CONSTRAINT ... USING INDEX`
   - volatile-default column → split into add-nullable / backfill-stub / set-default, with a `TODO` backfill block
   This is where we differentiate from every ORM-bundled migrator.
3. **Timeout preamble** emitted per-statement: `SET lock_timeout`, `SET statement_timeout`, with automatic
   exemptions for CIC / VALIDATE / REINDEX. Retry-on-lock-timeout with backoff in the runner.
4. **Plan validation**: apply the generated plan to the shadow DB before writing it out (stripe/pg-schema-diff's
   approach) — catches "the diff generated invalid SQL" at author time, not deploy time.
5. **Invalid-index sweeper**: `migrate doctor` reports `pg_index WHERE NOT indisvalid`, `_ccnew` leftovers,
   `NOT VALID` constraints that were never validated, and history/catalog drift.
6. **Destructive ops require an explicit acknowledgement** recorded in the plan JSON
   (`"confirmed_data_loss": ["public.users.legacy_id"]`) — so the PR reviewer sees it as a diff line.

### 6.6 Review step

`generate` writes SQL + plan JSON → PR. CI runs:
1. `migrate lint` (fail on destructive without acknowledgement; warn on lock hazards),
2. `migrate verify` — replay all migrations onto an ephemeral DB (testcontainers), then diff the result against the
   TS schema and **assert an empty diff**. This is the check that catches "the file doesn't do what the schema says",
   which no ORM-bundled migrator does today,
3. optionally, `migrate plan --against=<prod-fingerprint>` to detect that prod has drifted since the plan was cut.

### 6.7 Runner

- Dedicated **direct connection** (never the app pool — poolers break advisory locks).
- `pg_advisory_xact_lock(hashtext(database||schema))` — derived key, transaction-scoped.
- Per-file transaction by default, wrapping **both** the DDL and the history-table insert.
- `-- pg-orm:txmode none` files run statement-by-statement, recording **partial-application position** in the history
  table so a crashed non-transactional migration can be resumed rather than manually repaired.
- History table `pg_orm_migrations`: `id, name, checksum, applied_at, applied_by, duration_ms, txmode,
  statements_applied, plan_fingerprint_from, plan_fingerprint_to, status`.
- Checksum drift on an applied file = hard fail in `deploy`, warning in `dev`.

### 6.8 v1 vs later

**v1 (must ship)**
- `pg_catalog` introspection → schema IR (tables, columns, types, defaults, constraints incl. validation state,
  indexes, sequences/identity, enums, comments, schemas, extensions *tracked but not managed*).
- Diff engine over that IR (evaluate `@supabase/pg-delta` as the backend first).
- Shadow-DB normalization with the 4-tier fallback (env URL → CREATE DATABASE → temp schema → offline).
- `generate` → `.sql` + `.plan.json` with from/to fingerprints.
- Rename annotations (`renamedFrom` / `-- pg-orm:renamed_from`) + non-interactive failure with structured hints.
- Runner: advisory lock, per-file transaction, `pg_orm_migrations`, `txmode none` directive.
- Linter: the ~15 highest-value Squawk rules + Atlas DS/MF/BC classification.
- Lock-safe generation for: CIC, FK NOT VALID+VALIDATE, CHECK NOT VALID+VALIDATE, NOT NULL, UNIQUE-via-index,
  volatile defaults.
- Timeout preamble.
- **Baselining** (`migrate baseline`) — adoption blocker if missing.
- `migrate verify` (replay → assert empty diff) in CI.
- Up-only. No down migrations in v1.

**v1.1 / v2**
- Views + materialized views, functions/procedures, triggers as **repeatable migrations** (hash-based re-apply)
  before attempting true diffing.
- RLS policies in the IR (high demand given Supabase/Neon userbase).
- Checkpoints (squashing).
- `migrate doctor` (invalid indexes, unvalidated constraints, drift).
- Import from drizzle-kit / Prisma migration directories.
- Data-migration lane: batched, resumable, idempotent backfill helpers with replica-lag awareness.
- Optional `down` for the dev loop only.

**v3 / speculative**
- Partitions beyond "don't touch what we didn't create".
- Grants / roles / default privileges (opt-in, never diff-and-drop).
- Publications/subscriptions (logical replication users).
- `--format pgroll` export for expand/contract zero-downtime.
- Multi-schema / multi-tenant fan-out (MikroORM's biggest unmet request).
- Postgres 19 `REPACK CONCURRENTLY` integration for type-change rewrites.

### 6.9 Explicit non-goals

- Multi-database support. Ever. Every compromise in Atlas/Liquibase/Prisma traces back to portability.
- A GUI / approval workflow / governance layer (that's Bytebase's business).
- Online schema change infrastructure (that's pgroll's; integrate, don't rebuild).
- Postgres < 15.

---

## Appendix A — Tool status snapshot (verified August 2026)

| Tool | Status | License | Notes |
|---|---|---|---|
| Atlas | Very active | Apache-2.0 core, **Pro paywall for views/functions/triggers/RLS/extensions/roles** (~$9/seat/mo) | ~8.6k★ |
| pgroll | Very active (Xata) | Apache-2.0 | ~6.5k★; the zero-downtime standard |
| reshape | **Effectively superseded** | — | author moved to ReshapeDB; ~1.8k★ |
| stripe/pg-schema-diff | Maintained | MIT | Go library; PG 14–17; no functions/triggers |
| pgschema | Early / promising | Open source, Bytebase-sponsored, "no plans to charge" | ~970★; Postgres-only Go; no renames |
| migra (djrobstep) | **Deprecated/archived** | — | use `postgresql-tools/migra` (`migradiff` on PyPI) |
| `@supabase/pg-delta` | **Public alpha** | **MIT** | **TypeScript**, PG15+, broadest object coverage found |
| sqldef / psqldef | Maintained | MIT | single-file desired state, no plan artifact |
| Squawk | Very active | GPL-3.0 *(verify before vendoring)* | Rust, 40 rules, releases as of June 2026 |
| Flyway | Active (v12.9, Jun 2026) | Apache-2.0 core + commercial | ~9.9k★ |
| Liquibase | Active (v5.0, early 2026) | Apache-2.0 core + commercial | ~5.6k★ |
| Sqitch | Maintained | MIT, no paid tier | ~3.1k★; dependency-graph model |
| graphile-migrate | Maintained | MIT | ~840★; idempotent `current.sql` dev loop |
| node-pg-migrate | Maintained (v8.x, Salsita) | MIT | the boring Node default |
| pgmigrate (peterldowns) | Maintained | MIT | up-only, dup sequence numbers, advisory locks |
| Kysely Migrator | Maintained | MIT | minimal; fixed advisory-lock key |

★ counts and version numbers per [Bytebase, updated July 2026](https://www.bytebase.com/blog/top-open-source-postgres-migration-tools/);
license fields for Squawk and a few others should be re-verified before any code is vendored.

## Appendix B — Postgres version floor considerations

| Version | Relevant to migrations |
|---|---|
| PG 11 | fast `ADD COLUMN` with non-volatile default (`attmissingval`) |
| PG 12 | `ALTER TYPE ... ADD VALUE` allowed inside a transaction (value unusable until commit); `SET NOT NULL` can use a proving CHECK constraint to skip the scan |
| PG 14 | `DETACH PARTITION CONCURRENTLY`; **EOL November 2026** |
| PG 15 | `security_invoker` views; pg-delta's floor |
| PG 16/17 | incremental |
| PG 18 (GA Sept 2025) | **named NOT NULL constraints with `NOT VALID` / `VALIDATE`** — makes safe NOT NULL a first-class operation |
| PG 19 (beta Jun 2026, GA ~Sept/Oct 2026) | `pg_get_database_ddl()` / `pg_get_role_ddl()` / `pg_get_tablespace_ddl()`; **`REPACK ... CONCURRENTLY`** (no ACCESS EXCLUSIVE table rewrite); `pg_stat_lock`; 64-bit MultiXact members; `pg_dumpall` custom/directory/tar formats |

**Recommended floor: PG 15**, with feature-detected code paths for PG 18 NOT NULL NOT VALID and PG 19 REPACK.

## Appendix C — Primary sources

- Atlas: [declarative vs versioned](https://atlasgo.io/concepts/declarative-vs-versioned) · [deep dive](https://atlasgo.io/blog/2024/10/31/declarative-migrations-deepdive) · [analyzers](https://atlasgo.io/lint/analyzers) · [dev database](https://atlasgo.io/concepts/dev-database) · [renamed_from changelog (2026-05-20)](https://atlasgo.io/changelog/declarative-schema-renames) · [feature/Pro matrix](https://atlasgo.io/features) · [import/baseline](https://atlasgo.io/versioned/import) · [down migrations](https://atlasgo.io/versioned/down) · [applying migrations / directives](https://atlasgo.io/versioned/apply)
- Supabase pg-delta: [changelog](https://supabase.com/changelog/44938-public-alpha-declarative-schema-management-with-pg-delta) · [pg-toolbelt repo](https://github.com/supabase/pg-toolbelt) · [COVERAGE.md](https://github.com/supabase/pg-toolbelt/blob/main/packages/pg-delta/COVERAGE.md) · [declarative schemas docs](https://supabase.com/docs/guides/local-development/declarative-database-schemas)
- pgschema: [site](https://www.pgschema.com/) · [unsupported](https://www.pgschema.com/syntax/unsupported.md) · [plan/review/apply](https://www.pgschema.com/workflow/plan-review-apply.md) · [HN](https://news.ycombinator.com/item?id=45224028)
- stripe/pg-schema-diff: [README](https://github.com/stripe/pg-schema-diff/blob/main/README.md)
- pgroll: [internals](https://xata.io/blog/pgroll-internals) · [expand/contract](https://xata.io/blog/pgroll-expand-contract) · [docs](https://xataio.github.io/pgroll/) · [v0.14](https://xata.io/blog/pgroll-0-14-0-update)
- Squawk: [rules](https://squawkhq.com/docs/rules) · [site](https://squawkhq.com/)
- Postgres: [ALTER TYPE](https://www.postgresql.org/docs/current/sql-altertype.html) · [CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html) · [explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html) · [PG18 release](https://www.postgresql.org/docs/release/18.0/) · [PG19 beta 1](https://www.postgresql.org/about/news/postgresql-19-beta-1-released-3313/) · [NOT NULL NOT VALID thread](https://www.postgresql.org/message-id/202503201107.67xlajjijvkw%40alvherre.pgsql)
- Surveys / landscape: [Bytebase: top open source PG migration tools (Jul 2026)](https://www.bytebase.com/blog/top-open-source-postgres-migration-tools/) · [Bytebase: tool evolution 2026](https://www.bytebase.com/blog/top-database-schema-change-tool-evolution/) · [ardentperf survey (Mar 2026)](https://ardentperf.com/2026/03/25/database-schema-migrations-in-2026-survey/)
- Ops: [Citus: 7 tips for Postgres locks](https://www.citusdata.com/blog/2018/02/22/seven-tips-for-dealing-with-postgres-locks/) · [PostgresAI: invalid index overhead (Jan 2026)](https://postgres.ai/blog/20260106-invalid-index-overhead) · [Bytebase: PG vs MySQL DDL transactions](https://www.bytebase.com/blog/postgres-vs-mysql-ddl-transaction/) · [PostgresCompare: why pg_dump isn't enough](https://www.postgrescompare.com/2026/03/30/top-5-ways-to-compare-postgresql-databases.html)
- Complaint threads: Prisma [#4571](https://github.com/prisma/prisma/issues/4571) [#18623](https://github.com/prisma/prisma/issues/18623) [#20520](https://github.com/prisma/prisma/issues/20520) [#22922](https://github.com/prisma/prisma/issues/22922) [#13459](https://github.com/prisma/prisma/discussions/13459) · drizzle [#5774](https://github.com/drizzle-team/drizzle-orm/issues/5774) [#4615](https://github.com/drizzle-team/drizzle-orm/issues/4615) [#3826](https://github.com/drizzle-team/drizzle-orm/issues/3826) [#5635](https://github.com/drizzle-team/drizzle-orm/issues/5635) · MikroORM [#5363](https://github.com/mikro-orm/mikro-orm/issues/5363) [#4918](https://github.com/mikro-orm/mikro-orm/issues/4918) [#1623](https://github.com/mikro-orm/mikro-orm/issues/1623) · pooler/advisory-lock [#4051](https://github.com/IBM/mcp-context-forge/issues/4051) [#975](https://github.com/Viren070/AIOStreams/issues/975)
