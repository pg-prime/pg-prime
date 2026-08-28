# Design 06 — The Migration Engine

**Status:** DECIDED (round 2 design) · **Date:** 2026-08-14
**Input:** `research/migrations.md`, `research/SUMMARY.md` §3–4, migration sections of `research/{drizzle,prisma,mikroorm}.md`
**Scope:** IR · diff pipeline · file formats · runner · CLI · data migrations
**Hands-on evidence:** `@supabase/pg-delta@1.0.0-alpha.39` installed, source-read, and exercised against PostgreSQL 17.11 in Docker (extract → plan → apply → prove). All empirical claims below are from that session, not from docs.

> **AMENDMENT (2026-08-14, user sign-off):** D1 is superseded — the user chose an **in-house diff engine** as the default `DiffBackend`, with pg-delta demoted to a **dev-time differential-testing oracle** (never shipped, never a runtime/optional dependency). Everything that made D1 safe transfers to the in-house engine and shrinks its scope: D4's repeatable tier removes the hardest objects from diffing entirely, D5's annotation-first renames remove the need for rename *inference*, and D6's prove-on-shadow-clone gate catches ordering/correctness bugs regardless of whose diff produced the plan. See `00-overview.md` § Sign-off outcomes. Everything else in this document stands.

---

## 0. Decisions at a glance

| # | Decision |
|---|---|
| D1 | ~~Adopt `@supabase/pg-delta` behind a `DiffBackend` port.~~ **SUPERSEDED** by 00-overview sign-off 7: we build the differ in-house. pg-delta served as a dev-time differential oracle for one release and has since been removed from the tree entirely, replaced by the D10 `pg_dump` witness. See §1. |
| D2 | The IR is a **fact base**: a flat, content-addressed set of facts + dependency edges. Hierarchy is a view. **A fact's name lives in its id, never in its hashed payload.** |
| D3 | **Provenance is metadata, not state** — it never enters the fingerprint. |
| D4 | Object kinds split into four tiers: **Managed-diffed**, **Managed-repeatable**, **Observed-never-written**, **Unmodeled-but-diagnosed**. Functions/views/triggers/RLS ship in **v1 as repeatables**, not as diffed objects. |
| D5 | Renames: **annotation-first**, structural candidate detection as the *prompt driver*, never as authority. Non-TTY emits `missing_hints` and exits 2. |
| D6 | **No plan is written to disk until it has been proven** on a shadow clone (apply → re-extract → assert zero drift). This is the mitigation that makes D1 safe. |
| D7 | Runner uses **session advisory lock + heartbeat lease**, not `pg_advisory_xact_lock` — because `txmode none` files have no enclosing transaction. Plus active transaction-pooler detection. |
| D8 | `txmode none` ⟹ **every statement must be idempotent** (enforced by lint rule TX201). This makes crash-resume unconditionally safe and dissolves the CIC partial-application problem. |
| D9 | Up-only. No down migrations, in any tier, in v1. |
| D10 | **The shadow-clone proof is witnessed by `pg_dump`, not only by our own IR.** After apply, the clone and the desired database are dumped schema-only, canonicalized and compared as a statement multiset. Zero npm dependencies; `pg_dump` is spawned as a subprocess through an injectable argv. *(Added 2026-08-25 — see §3.9.)* |

---

## 1. Why the differ is ours (and what pg-delta taught us)

This section originally argued for adopting `@supabase/pg-delta` behind a port. That decision was
reversed (00-overview sign-off 7) and pg-delta is no longer a dependency. What follows is only the
part that still constrains the design — the evidence, not the recommendation.

**Why building our own turned out to be M/L rather than XL:**

- The Tier-R repeatable model (D4) removes functions, views, triggers and policies — the objects
  with the worst diff semantics — from the differ entirely.
- Annotation-first `renamedFrom` (D5) removes rename *inference*, which was pg-delta's main
  advantage over a naive differ.
- The prove-on-shadow-clone gate (D6) catches ordering and correctness bugs before a plan reaches
  disk, which is exactly how pg-delta's own bug was caught.

### 1.1 The enum-ordering bug — now our fixture #1

Evaluating alpha.39 on a two-database fixture produced a plan that ordered a statement **before**
the statement that makes it legal:

```
[3] ALTER TABLE "public"."orders" ALTER COLUMN "status" SET DEFAULT 'refunded'::public.order_status
[4] ALTER TYPE  "public"."order_status" ADD VALUE 'refunded' AFTER 'paid'
```

It fails reproducibly with `invalid input value for enum public.order_status: "refunded"`.

**Root cause:** `pg_depend` records a dependency on the *type*, not on an individual enum label.
The type exists on both sides, so no edge is generated and the topological sort has nothing to
order on. A structural blind spot, not a typo.

Our answer is the synthesized `evaluates` edge (§3.7, `ir/fact.ts`), and the repro is
`fixtures/diff/enum-ordering` — the first fixture in the corpus, covered by `test/enum.test.ts`.

### 1.2 Two secondary findings that shaped our hazard model

- `ADD COLUMN "name" text NOT NULL` against a non-empty table was emitted with `dataLoss: "none"`
  and no warning; it failed at apply. pg-delta has **no data-dependent-failure hazard class** —
  its safety model is lock/rewrite/data-loss, not *will this fail*. Ours has the MF class (§3.4)
  precisely because of this.
- `ADD COLUMN "country" text NOT NULL DEFAULT 'US'::text` was flagged `rewriteRisk: true`. Since
  PG 11 a non-volatile default uses `attmissingval` and does not rewrite. Over-conservative — and
  the reason our BC class distinguishes *declared* from *suspected* rewrites.

### 1.3 The mitigating fact that became a design rule

pg-delta's own `provePlan` caught pg-delta's bug: loud, at generate time, on a throwaway clone.
That is the cheapest possible place for a diff engine to be wrong, and it is why D6 is
unconditional here rather than an opt-in flag. D10 extends the same idea one step further, to a
witness that is not our code at all (§3.9).

## 2. The IR

### 2.1 Shape

```ts
type Origin     = "ts" | "sql" | "catalog" | "extension" | "baseline";
type Ownership  = "managed" | "observed" | "external";

interface Provenance {
  origin: Origin;
  ownership: Ownership;
  sourceRef?: { file: string; line: number };   // for error messages, not identity
  extension?: string;                            // set when memberOfExtension
}

interface Fact {
  id: StableId;                 // structured, discriminated by `kind`
  parent?: StableId;            // hierarchy is derived, not nested
  payload: Payload;             // IDENTITY-FREE: never contains the fact's own name
  provenance: Provenance;       // NEVER hashed
}

interface DependencyEdge { from: StableId; to: StableId; kind: EdgeKind }
type EdgeKind = "depends" | "owner" | "memberOfExtension" | "managedBy" | "evaluates";

class SchemaIR {
  facts(): Fact[];
  get(id: StableId): Fact | undefined;
  childrenOf(id): Fact[];
  outgoingEdges(id): DependencyEdge[];
  contentHashOf(id): Hash;      // sha256 of canonical payload
  rollupOf(id): Hash;           // fact + all descendants + outgoing edge targets
  get fingerprint(): Hash;      // sorted (rootId=rollup) pairs — the schema fingerprint
}
```

**Three invariants, each load-bearing:**

- **I1 — Identity-free payloads.** `rename(x → y)` ⟺ ∃ facts with equal `rollupOf` and different
  `id`. Rename detection becomes a hash join; there is no similarity scoring anywhere.
- **I2 — Provenance is never hashed.** A `users` table declared in TS and the same table read out
  of `pg_catalog` produce byte-identical hashes. Without this, every diff is a phantom diff.
- **I3 — Granularity is one.** A column is a fact; an enum label is a fact; a published table is a
  fact. Never a blob on a parent. Sub-entity grain is what lets a rename candidate exist at
  column level and what makes `pg_depend` edges land on real targets.

We add one edge kind pg-delta lacks: **`evaluates`** — from a statement-producing fact to a value
it *evaluates at DDL time*. This is the fix for the §1.3 bug: an `ALTER TYPE … ADD VALUE` fact
gains an `evaluates` edge from every default/check/index expression whose text contains the new
label, forcing a commit boundary between them. `pg_depend` will never give us this edge; we
synthesize it.

### 2.2 Object kinds — the v1 tier list

**Tier M — Managed & diffed (v1).** Full IR representation, diffed, generated into versioned SQL.

> `schema` · `table` (incl. partitioned parents & partitions) · `column` · `default` ·
> `constraint` (PK, FK, UNIQUE, CHECK, EXCLUDE — **including `convalidated` state**) · `index` ·
> `sequence` (+ `OWNED BY`, identity) · `type` (enum, domain, composite) · `typeAttribute` ·
> `comment` · `extension` *(declare-only: created if absent, **never dropped**, members projected out)*

**Tier R — Managed, repeatable, NOT diffed (v1).** Authored as `.sql` in the repo, re-applied
whenever the file hash changes, via `CREATE OR REPLACE` / `DROP … IF EXISTS` + create. This is
graphile-migrate's model and Flyway's `R__` concept.

> `function` · `procedure` · `view` · `materializedView` · `trigger` · `policy` (RLS) · `rule`

*Why repeatable rather than diffed, and why this is an upgrade on the research plan:* these are
exactly the objects whose diff is hardest (PostgreSQL stores rewritten parse trees, so
`pg_get_viewdef` never textually matches what you wrote — the phantom-diff generator). Making them
repeatable is **cheaper than deferring them**: it needs no differ at all. The research sketch put
RLS and functions in v1.1; treating them as repeatables lets them ship in **v1**, which matters
because RLS is table stakes for the Supabase/Neon userbase and no competitor manages it.

The cost is honest and documented: a repeatable's *removal* is not auto-detected. `migrate doctor`
reports orphans (objects in the catalog with no owning repeatable file), and `verify` counts them
as drift.

**Tier O — Observed, never written (v1).** Introspected into the IR, reported by `status` and
`doctor`, **excluded from the diff, never dropped.**

> `role` · `membership` · `acl` · `defaultPrivilege` · `securityLabel` · `publication` ·
> `publicationRel` · `publicationSchema` · `subscription` · `fdw` · `server` · `userMapping` ·
> `foreignTable` · `eventTrigger` · `collation` · `aggregate`

Rationale: these are cluster-scoped or owned by a different team. The research is unambiguous —
*"model grants as opt-in, never diff-and-drop by default."* Promotion to Tier M is opt-in per kind
via config in v2.

**Tier U — Unmodeled but diagnosed (v1).** Not represented; enumerated from the catalog and
surfaced as an `unmodeled_kind` diagnostic with a count.

> casts · operator classes/families · text-search configs/dicts/parsers/templates · statistics
> objects · transforms · user-defined languages · parameter ACLs · large objects

**The completeness rule (stolen verbatim in spirit from pg-delta):** enumerate everything in the
catalog, subtract Tiers M/R/O, and *report the remainder*. Silence is never an option. `verify`
prints the unmodeled census; `--strict-unmodeled` makes a non-empty census a failure.

> **AS BUILT 2026-08-28 (K3) — the four tiers.**
>
> **Tier M has no unimplemented kind.** `FactKind` is now `schema · table · column · default ·
> constraint · index · type · enumLabel · typeAttribute · sequence · comment · extension` — twelve
> where the spike had eight. Three notes on the mapping to the list above:
>
> - `enum`, `domain` and `composite` share the **`type`** kind, discriminated by `typtype`. `05`
>   §7.2 gives all three the identity tuple `[schema, name]` and `stable-id.ts` has exactly one
>   arity entry for that shape; three near-duplicate kinds would be three copies of the same id.
>   A domain's CHECKs live in `TypePayload.checks` (they are keyed by `contypid`, not `conrelid`,
>   so they cannot be `constraint` facts — that id says `[schema, table, name]`).
> - `partition` is not a kind. A partitioned parent and a partition are **tables**, carrying
>   `partitionStrategy` / `partitionKey` / `partitionOf` / `partitionBound`; `ATTACH` / `DETACH`
>   are the deltas. `05` §7.2's `partitions({ unknown: 'adopt' })` is enforced in `diffIR`, which
>   removes an undeclared partition from **both** sides of the diff — omitting only the DROP would
>   leave it as residual drift and make the D6 proof refuse every plan.
> - `extension` is keyed `[name]`, not `[schema, name]`: PostgreSQL allows one extension of a given
>   name per database, so a schema in the id would make a relocated extension a different object —
>   and since it is never dropped, that is a `CREATE … IF NOT EXISTS` that no-ops forever.
>
> Still **not** modelled, and reported as an error diagnostic rather than converged silently:
> classic table `INHERITS` (`unsupported_kind`), in-place composite attribute changes while a
> column uses the type (PostgreSQL refuses; `CASCADE` does not reach plain columns), and a
> partition-key change (PostgreSQL requires a new table).
>
> **Tier R** is `src/repeatables/` — `scanRepeatables` (directory-lexicographic over `sql/**/*.sql`,
> sha256, `-- pg-prime:` header directives, statements via the real lexer), `checkIdempotence`
> (TX201), `planRepeatables` (hash diff + orphan report), `applyRepeatables` (all files in ONE
> transaction) and `loadRepeatables` (the shadow load during `generate`, §3.8).
>
> **Tier O** is `ExtractResult.observed` — 16 families, each behind its own `SAVEPOINT` so a
> `permission denied` on `pg_subscription` degrades to a diagnostic instead of aborting the
> snapshot transaction. Deliberately **not** facts: a fact is diffed and a fact is hashed into the
> fingerprint, so one `GRANT SELECT` would read as drift and refuse every pending migration through
> §4.3's gate.
>
> **Tier U** is the census, now `06` §2.2's list in full: casts, operator classes/families, the
> five text-search catalogs, statistics objects, transforms, user-defined languages, parameter ACLs
> and large objects, alongside the Tier-R kinds (which are counted too, and say "Tier R" in their
> message so a caller can tell them apart). `diffIR`'s `strictUnmodeled` escalates the Tier-U half
> — and only that half — to `error`; escalating an authored view would make the flag unusable.

> **AS BUILT 2026-08-28 (K2b) — three Tier-M corrections the third-party corpus found.**
>
> `01` §11.6 #5's gate is worth its cost the first time it runs: replaying a `baseline` of
> Pagila and AdventureWorks into an empty database, and comparing both with `pg_dump`,
> turned up three things no fixture had.
>
> 1. **`pg_index.indisclustered` was not modelled at all.** AdventureWorks clusters all 68
>    of its tables on their primary keys; `pg_dump` writes that as
>    `ALTER TABLE … CLUSTER ON …`, and a baseline reproduced none of it while our own proof
>    reported convergence — the exact blind spot D10 exists to catch. It is now
>    `TablePayload.clusterOn`, on the **table** rather than on the index, because the
>    clustered index is usually a constraint's backing index and those are not facts of
>    their own; an `IndexPayload.clustered` would have been blind to the common case.
>    Emitted after the table's indexes and constraints, and `SET WITHOUT CLUSTER` for the
>    reverse. Fixture `fixtures/diff/cluster`, run in both directions.
> 2. **An index on a materialized view entered the IR as an orphan.** `Q_TABLES` is
>    `relkind IN ('r','p')` — a matview is Tier R — but `Q_INDEXES` had no such filter, so
>    Pagila's `rental_by_category` matview contributed a unique index whose parent table did
>    not exist. It was reported as an `orphan_fact` warning and then planned as
>    `CREATE INDEX … ON <matview>` against a database with no matview: an apply-time failure
>    of the baseline. Same filter now, in `Q_INDEXES` and in `Q_COMMENTS`.
> 3. **An extension-owned composite type's attributes entered the IR without their type.**
>    `Q_TYPES` excludes `pg_depend deptype = 'e'`; `Q_TYPE_ATTRIBUTES` and `Q_DOMAIN_CHECKS`
>    did not. AdventureWorks installs `tablefunc`, so `tablefunc_crosstab_2..4` produced
>    twelve orphan `typeAttribute` facts and a plan that ran `ALTER TYPE … ADD ATTRIBUTE` on
>    a composite the extension had already created. This is the failure mode this file's own
>    header warns about for relations ("a family-level filter that is not applied uniformly")
>    reaching the type family.
>
> All three are Tier M, so all three were fixed rather than recorded. What the corpus does
> **not** reproduce is Tier R — views, matviews, functions, triggers, aggregates — and that
> is by design (§8: views stay in Tier R for v1). `test/corpus-thirdparty.test.ts` asserts
> it as a property rather than skipping it: every statement `pg_dump` finds in the source and
> not in the replay must be classifiable as Tier R, and the `extra` set must be **empty**. A
> missing statement that is not Tier R fails the test.

### 2.3 Serialization

The IR serializes to a **checkpoint file** (`migrations/checkpoints/0000.ir.json`) — never
per-migration. Drizzle's per-migration full snapshot is explicitly rejected (§9). Format:

```jsonc
{ "formatVersion": 1,
  "pgMajor": 17,
  "fingerprint": "sha256:…",
  "facts": [ { "id": "column:public.users.email", "parent": "table:public.users",
               "payload": { "type":"text", "notNull":false, "position":3 } } ],
  "edges": [ { "from":"constraint:public.orders.orders_user_id_fkey",
               "to":"table:public.users", "kind":"depends" } ] }
```

Provenance is deliberately absent from the serialized form — it is a property of *how this run
loaded the schema*, not of the schema.

---

## 3. The diff pipeline

```
  TS schema (@pg-orm/schema)  ─┐
                               ├─► desired SQL text ─► [shadow DB] ─► extract ─► IR(desired)
  sql/  raw DDL ──────────────┘                                                      │
                                                                                     ▼
  target DB ──────────────────────────────────► extract ─────► IR(current) ───►  diff
                                                                                     │
                                        renames (annotation → candidates → hints)    ▼
                                                                                   Delta[]
                                                                                     ▼
                                        order (topological + evaluates edges)  ─►  Action[]
                                                                                     ▼
                                        lock-safe rewriting  +  hazard analysis      ▼
                                                                                   Plan
                                                                                     ▼
                                        PROVE on shadow clone  ──► fail ⇒ no files written
                                                                                     ▼
                                                        NNNN_name.sql + NNNN_name.plan.json
```

### 3.1 Introspection

`pg_catalog` only. `information_schema` is never queried — it cannot represent RLS, partitions,
exclusion constraints, `NOT VALID` state, or generated columns, and it is materially slower.

One snapshot-bound transaction:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL search_path = pg_catalog;
SET LOCAL statement_timeout = '30s';
-- ~20 catalog queries, one per fact family
COMMIT;
```

`REPEATABLE READ` is not optional: without it a concurrent DDL produces an IR describing a schema
that never existed. Families: `pg_namespace`, `pg_class`+`pg_attribute`+`pg_attrdef`,
`pg_constraint`, `pg_index`, `pg_type`+`pg_enum`, `pg_proc`, `pg_trigger`, `pg_policy`,
`pg_rewrite`, `pg_sequence`, `pg_inherits`+`pg_partitioned_table`, `pg_extension`, `pg_depend`,
`pg_description`, `pg_default_acl`, `pg_publication*`. Definition text comes from
`pg_get_indexdef` / `pg_get_constraintdef` / `pg_get_viewdef` / `pg_get_functiondef` /
`pg_get_triggerdef` / `pg_get_expr` — never reconstructed by us.

**Floor: PostgreSQL 15**, with feature-detected paths for PG 18 (`NOT NULL … NOT VALID`) and
PG 19 (`REPACK CONCURRENTLY`). Measured cost on the probe schema: **109 ms, 73 facts.**

### 3.2 Normalization — the 4-tier shadow ladder

Human-written DDL is in *natural form*; PostgreSQL stores *canonical form*. Diffing the two
produces endless phantom diffs. So the desired state is always round-tripped through a real
PostgreSQL before it is compared. The ladder never *requires* `CREATEDB` — that is Prisma's
single most-reported migration failure.

| Tier | Mechanism | Selected when |
|---|---|---|
| **1** | `SHADOW_DATABASE_URL` / `--shadow=<url>` | env var or flag present |
| **2** | `CREATE DATABASE <target>_shadow_<rand>` on the same cluster, dropped after | role has `CREATEDB` |
| **3** | **Temp schema in the current database** — `CREATE SCHEMA pg_orm_shadow_<rand>`, load with rewritten `search_path`, extract schema-scoped, `DROP … CASCADE` | no `CREATEDB` (managed PG: Supabase, Neon, RDS restricted roles) |
| **4** | `--offline` — diff IR-vs-checkpoint with **no normalization** | no DB reachable |

Tier 3 is the tier that matters, and it is the one Prisma lacks. Constraint: it cannot normalize
cluster-scoped objects (roles, extensions with fixed schemas, event triggers) — those degrade to
Tier-O observation with a diagnostic. `--shadow=docker` (testcontainers) is available for local
dev and is what `verify` uses in CI.

Tier 4 prints a loud, non-suppressible banner and stamps `"normalized": false` in the plan;
`apply` refuses an un-normalized plan against a production-tagged environment.

Two operational notes learned the hard way in the probe session: `CREATE DATABASE … TEMPLATE x`
fails with SQLSTATE `55006` if *any* session is connected to the template, so Tier 2/clone
provisioning must close its own extraction pool first; and the shadow must be created with the
same `LC_COLLATE`/`LC_CTYPE`/ICU locale as the target or index and constraint definitions
normalize differently.

> **AS BUILT 2026-08-28 (design/11 §3 K2a) — `@pg-prime/kit/src/shadow/ladder.ts`.**
>
> ```ts
> provisionShadow(admin: ConnInfo, target: ConnInfo, {
>   shadow?: 'auto' | 'temp-schema' | 'createdb' | 'offline' | { url: string }
>   schemas: readonly string[]
>   token?: string          // test-only: makes the shadow's name predictable
> }): Promise<{
>   conn: ConnInfo
>   schemaMap: ReadonlyMap<string, string>   // user schema → the schema the DDL is written into
>   tier: 1 | 2 | 3
>   reason: string
>   diagnostics: readonly Diagnostic[]
>   dispose(): Promise<void>
> }>
> ```
>
> | tier | as built |
> |---|---|
> | **1** | `{ url }` parsed into a `ConnInfo`. The managed schemas are **reset** (`DROP SCHEMA … CASCADE` + `CREATE SCHEMA`) before the load and again on `dispose`, with a `shadow_url_reset` warning diagnostic — Prisma's `SHADOW_DATABASE_URL` contract, said out loud. `schemaMap` is the identity. |
> | **2** | `CREATE DATABASE pgprime_shadow_<8 hex> TEMPLATE template0` carrying the target's `encoding`/`datcollate`/`datctype` and, when the provider is ICU or builtin, `LOCALE_PROVIDER` + `ICU_LOCALE`/`BUILTIN_LOCALE`. The locale row is read as `to_jsonb(pg_database)` so that `daticulocale` (PG 15/16) and `datlocale` (PG 17+) are both found without a version table. `TEMPLATE template0` is both required when the locale is stated and the least likely to hit `55006`; if it fires anyway, `auto` **demotes to tier 3** rather than terminating anyone's session. `schemaMap` is the identity; `dispose` drops the database (`db/pg.ts`'s prefix gate is what authorises the force-drop). |
> | **3** | One `CREATE SCHEMA pgprime_shadow_<8 hex>_<name>` per managed schema, **in the target database**. The mapped name keeps the original in it when 63 UTF-8 bytes allow and falls back to a positional `_s<i>` when they do not — never a truncation, because a truncated name is a map that cannot be reversed. `dispose` drops each with `CASCADE` and then **asserts from `pg_namespace` that nothing survived**. Emits a `shadow_temp_schema` info diagnostic naming the constraint §3.2 states: objects with a fixed schema (extensions, event triggers, roles) cannot be renamed into it. |
> | **4** | `shadow: 'offline'` throws a typed `OfflineShadowError` whose message names the three alternatives. |
>
> Selection for `'auto'`: a url → 1; `rolcreatedb OR rolsuper` on `current_user` → 2 (demoting to 3
> on `55006`); otherwise 3. **§1.6's decision holds: tier 3 rewrites schema identifiers, not
> `search_path`** — the emitter is always schema-qualified, so the map is applied at emit time and
> reversed on the extracted IR (`src/schema/remap.ts`), covering fact ids, edge endpoints, and the
> four payload fields that embed server-produced qualified text (`column.type`, `column.default`,
> `constraint.definition`, `index.definition`) plus the encoded id in `sequence.ownedBy`. A missed
> one is not cosmetic: those fields are hashed.
>
> **Proof it works where it has to.** `test/shadow/ladder.test.ts` creates
> `CREATE ROLE pgprime_k2_nocreatedb WITH LOGIN NOCREATEDB NOSUPERUSER`, asserts that role really
> gets `permission denied to create database`, and runs the whole `provisionShadow` →
> `loadDesired` → `dispose` path as it. The tier-3 IR and the tier-2 IR of the same schema have the
> **same fingerprint**, which is the property the map exists to preserve.
>
> **Integration note (K3 × K2a, 2026-08-28).** Once `comment` became a fact kind, the tiers stopped
> agreeing on one object: a fresh tier-2 database's `public` carries initdb's
> `'standard public schema'` comment, a tier-3 shadow schema carries none, and a real target carries
> whatever it carries. The DSL declares no schema comments, so the desired state must not assert one:
> `Shadow.target` records the diffed-against database and `loadDesired` copies the target's comment
> for every managed schema onto its shadow counterpart after the load (`NULL` when the target has
> none). Tier-2 and tier-3 fingerprints are byte-identical again, and a target whose `public` comment
> was customised does not get a phantom `COMMENT ON SCHEMA` reset. When `pgSchema(...).comment()`
> lands, the emitter's value wins by running after this mirror.

> **AS BUILT 2026-08-29 (design/12 K4) — tier 4 stays refused, and why.**
>
> `--offline` / `--shadow none` reaches the ladder and gets `OfflineShadowError`'s sentence
> (exit 1). This is the release's answer, not an omission, and design/12 decision 14 records
> it: **without a database there is no desired IR to diff a checkpoint against.**
>
> The reasoning is design/11 §1.5's, followed to its conclusion. `05` §7.2's `schema.$ir()`
> is deliberately not built — the desired IR is a *function of a database*: emit the DSL as
> DDL, load it into a shadow, extract. That is the whole point of the shadow ladder (§3.2's
> opening paragraph: "the desired state is always round-tripped through a real PostgreSQL
> before it is compared"), and it is what makes the differ immune to phantom diffs. Tier 4
> would have to obtain IR(desired) some other way, and the only other way is a second model
> of PostgreSQL's canonicalization — the thing §9's "Parse-only / AST diffing (no shadow DB)"
> row rejects by name, with the observation that "every tool that tried has phantom diffs".
>
> Checkpoints do NOT change this, which is the part worth stating now that they exist. A
> checkpoint gives us an IR of a *past* state, so `--offline` could diff *current-as-recorded*
> against *checkpoint*; it still cannot produce IR(**desired**) from TypeScript, and a
> `generate` that cannot see the desired state is not a `generate`. What the checkpoint IR
> does buy is the thing K1 could not do — naming the drifted objects on a fingerprint
> mismatch — and that is built (`apply`, `status --verify-fingerprint`, decision 16).
>
> The three tiers that do exist cover the case tier 4 was for: a managed PostgreSQL with no
> `CREATEDB` is **tier 3**, in the target database, and design/11 §3 K2a's own test runs the
> whole path as a `NOCREATEDB NOSUPERUSER` role. Tier 4 is for "no database reachable at
> all", and every command in §6.2 except `lint` needs one anyway.

### 3.3 Rename resolution

**Annotation is the only authority.** Three inputs, strictly ordered:

1. **Annotation (authoritative).** TS: `column("name").renamedFrom("first_name")`.
   Raw SQL: `-- pg-orm:renamed_from users` above the object. Committed to git, visible in the PR
   diff, works for agents, survives CI. Consumed by `generate`, then left as an inert marker that
   `generate` strips once the migration containing it has been applied (tracked by
   `pg_orm.migrations.id`, so the strip is idempotent).
2. **Structural candidates (advisory).** The backend's `unambiguous | ambiguous | nearMiss`
   verdicts. These **never** apply themselves. They exist to make the prompt good.
3. **TTY prompt (convenience).** `--interactive` shows candidates and, on confirmation,
   **writes the annotation into the source file** and re-runs `generate`. The prompt's output is
   an edit to your repo, not a hidden decision. This is the fix for drizzle's failure mode where a
   confirmed rename never reaches the snapshot.

**Non-TTY / CI:** never prompt, never guess. Emit `missing_hints` and exit **2**:

```jsonc
{ "status": "missing_hints",
  "unresolved": [
    { "type": "rename_or_recreate", "kind": "column",
      "from": "column:public.users.first_name", "to": "column:public.users.name",
      "confidence": "unambiguous",
      "fix": "add .renamedFrom(\"first_name\") in src/schema/users.ts:14" },
    { "type": "confirm_data_loss", "kind": "column",
      "entity": "column:public.users.legacy_id", "reason": "non_empty", "rows": 41203 }
  ] }
```

Resolve by re-invoking with `--hints-file hints.json` (a `Hint[]`) or by editing the schema. Both
paths are scriptable; neither hangs.

> **AS BUILT 2026-08-27 — the rename cascade, and what PostgreSQL 18 added to it.**
>
> A rename never *recreates* a dependent: `applyRenameHints` rewrites the current IR as if the
> rename had already happened, and `cascadeRenames` turns each auto-named dependent PostgreSQL
> declined to rename into an `ALTER … RENAME`. Those entries appear in `diff.renames` with
> `source: "cascade"` — not inference: annotation is still the only authority (D5), and a
> cascade only ever lands on a table an annotation already touched.
>
> **What 18 changed.** PostgreSQL 18 catalogues NOT NULL as a real `pg_constraint` row
> (`contype = 'n'`, `conkey = {attnum}`, auto-named `<table>_<column>_not_null`). It is the only
> 18 change that reaches the differ, and it broke the two rename fixtures on 18 while 15/16/17
> stayed green. Neither `RENAME COLUMN` nor `RENAME TO` carries the name along — the same rule
> that already forced the PK and index cascades — and `pg_dump` 18 prints
> `CONSTRAINT <name> NOT NULL` inline whenever the name is not the default for the column. So a
> renamed database dumped differently from a fresh create, and D6's oracle correctly refused the
> plan. The observed diff, `pg_dump` 18.6, `rename-column` after the plan applied:
>
> ```diff
> -    name text NOT NULL,
> +    name text CONSTRAINT users_first_name_not_null NOT NULL,
> ```
>
> **The cascade now covers it.** `cascadeNotNullRenames` (`src/diff/rename.ts`) emits
> `ALTER TABLE … RENAME CONSTRAINT "<old>" TO "<new>"` for every column of a renamed table or
> column whose NOT NULL constraint carried a *generated* name on both sides. Unlike
> `cascadeRenames` it is not a hash join and cannot drift into inference: both endpoints are
> **computed** from identity — the old name is the server's default for the id the column had
> before the rename, the new one is its default for the id it has after. A NOT NULL the user
> named keeps that name; a rename is not permission to regenerate it.
>
> **The IR on < 18.** `ColumnPayload.notNullConstraint` is tri-state: `null` when the server does
> not catalogue the constraint (15/16/17) or the column is nullable; `"%GENERATED%"` when it
> carries the server's own default; the name itself when the user chose one. Storing the
> *generated* name would violate I1 — it is a function of the id, so every column of a renamed
> table would change hash and the rename would become a phantom alter. Storing nothing would let
> the stale name survive. The sentinel is the same device as `%ID%` in an index definition.
>
> Two things are gated on the **catalog**, not on `server_version_num`: the extractor's
> `LEFT JOIN pg_constraint … contype = 'n'` (no rows on < 18, so the same fixture yields no
> spurious diff there) and the tests' `catalogsNotNullConstraints()` probe. A server that
> back-ports the feature therefore needs no version table.
>
> `defaultNotNullName` is a port of the server's `makeObjectName`, truncation included: when the
> two pieces do not fit in `NAMEDATALEN`, PostgreSQL shortens the **longer** one byte at a time,
> so a 30+30 pair becomes 27+26 — not a right-cut of the concatenation. `pg_dump` 18 compares
> against a plain `%s_%s_not_null` and so prints a truncated default as if it were a user name;
> that is harmless, because both sides of the oracle print it identically.
>
> **The oracle was not relaxed.** Constraint names are compared verbatim; normalising them away
> would hide exactly this class of drift (R10 M5 below). The one thing that *is* stripped from an
> 18 dump is `\restrict` / `\unrestrict`, whose token is random per invocation — verified by
> diffing two dumps of the same database — and which is a psql meta-command rather than SQL. That
> was already handled in `sql/statements.ts` for 17.6+.
>
> ~~Still not modelled: `convalidated` on a `contype = 'n'` row.~~ **Closed 2026-08-28 (K3)** —
> see the addendum below.
>
> **R10 — five mutations, five caught** (PG 18 unless stated; `pgprime-pg18`, and the 17 run kept
> green where that is the point):
>
> | # | Mutation | Caught by |
> |---|---|---|
> | M1 | drop the `cascadeNotNullRenames` call | `rename.ts` — *a column rename renames the auto-named NOT NULL constraint*, *a table rename renames every column's…*, *the cascade computes the TRUNCATED name…*, and both original rename tests (5 failures) |
> | M2 | `defaultNotNullName` becomes a plain `` `${table}_${column}_not_null` `` (no truncation) | `ident.ts` — *shortens the LONGER piece…*, *only shortens the piece that is too long*, *never splits a multi-byte character…*; `catalog.ts` — *records THAT it is generated…*. The end-to-end rename still converged: `alterColumn`'s name-change path is a second line of defence, so a truncated default is repaired as an alter instead of a cascade |
> | M3 | drop `contype = 'n'` from the extractor join, so a name is read on 17 too (it picks up the PK) | **on 17**: *table rename: the FK on ANOTHER table follows…* and corpus *acceptance* — the "no spurious diff on < 18" requirement; on 18, 14 tests |
> | M4 | store the generated name raw instead of `%GENERATED%` (I1 violation) | `catalog.ts` — *records THAT it is generated, never the generated name itself*; `rename.ts` — *column rename: the index is RENAMED…* |
> | M5 | `normalizeDump` strips `CONSTRAINT <name> NOT NULL` (combined with M1, so there is real drift to hide) | `dump-oracle.ts` — *never normalises a NOT NULL constraint name away*; and the five rename tests still failed on their `pg_constraint` assertions, so the oracle is not the only witness |

> **AS BUILT 2026-08-28 (K3) — the two gaps this section left open are closed.**
>
> **1. `convalidated` on a `contype = 'n'` row.** `ColumnPayload.notNullValidated` is the third
> state: `null` when the server does not catalogue NOT NULL constraints *or* the column is
> nullable, `true` for a validated one, `false` for a `NOT VALID` one. Same catalog gate as
> `notNullConstraint` — the `LEFT JOIN pg_constraint … contype = 'n'` yields no row on 15/16/17, so
> the field is `null` there and the same fixture still diffs clean across the matrix.
>
> Two things follow. `columnClause` appends `NOT VALID` after an inline `NOT NULL` when the desired
> state wants one, so a fresh replay of the repo does not produce a schema that is *stricter* than
> the one it describes. And `notNullTransition` (`diff/ddl.ts`) treats validity as an orthogonal
> axis: `false → true` is a bare `VALIDATE CONSTRAINT` (SHARE UPDATE EXCLUSIVE, no rewrite),
> `true → false` is a `DROP CONSTRAINT` + `ADD … NOT VALID`, because PostgreSQL cannot un-validate.
> Before the field, an unvalidated NOT NULL and a validated one were byte-identical facts, so the
> plan silently claimed a guarantee the data did not have. `test/kinds/not-null-validity.test.ts`.
>
> **2. `ChooseConstraintName`'s uniquifying suffix.** `sql/ident.ts` gains `chooseConstraintName`,
> a port of the server's loop: `makeObjectName` with a pass number appended to the **label**
> (`t_a_not_null1`, not `t_a_not_null_1`) so the suffix lands inside the truncation window, retried
> against a caller-supplied `taken` predicate — `pg_constraint` in the namespace for
> `ChooseConstraintName`, plus `pg_class` for `ChooseRelationName`.
>
> The consumer that makes it load-bearing is the §3.5 row-5 rewrite, which INVENTS a temporary
> CHECK constraint on PG 15–17. A schema that already has a `<table>_<column>_not_null` — which is
> exactly what `fixtures/diff/name-collision` has — turns a blind `makeObjectName` into
> `constraint "t_a_not_null" for relation "t" already exists` at apply time.
>
> What did **not** change is the extractor's classification, and that is deliberate. A NOT NULL
> whose name carries a suffix is still recorded as a USER name, because PostgreSQL picks the suffix
> from the catalog state at the moment the constraint is created, and for a plan that moment is the
> middle of an apply rather than the end of it. Widening the `%GENERATED%` test to accept
> `t_a_not_null1` would make the emitter write a bare `NOT NULL`, the server would name it
> `t_a_not_null`, and the squatting CHECK in the same plan would then fail to be added. We never
> invent a name we cannot also spell out.

> **AS BUILT 2026-08-28 (K2b) — resolution, end to end, and the one divergence.**
>
> All three inputs are wired, in this order, inside `generate` (`src/generate.ts`):
>
> 1. **Annotation.** `annotationHints(schema)` reads `ColumnDdl.renamedFrom` and the
>    `renamedFrom(old)` table extra off the DSL's runtime metadata and turns each into a
>    `RenameHint`. `acceptHints(hints, current, desired)` then applies design/05 §5.1's
>    firing rule — **old exists in the current IR and new does not** — so an annotation left
>    in the source after its migration shipped is inert rather than an error, and a chain
>    `a → b → c` works across two migrations. Table hints are resolved before column hints,
>    because a `renamedFrom` on a column of a renamed table describes the state before both.
>    `--hints-file` entries join the same list, which is design/11 §1.8's "one mechanism,
>    two spellings". The two spellings §5.1 lists that the DSL does not carry —
>    `pgEnum(..., { renamedFrom })` and `pgSchema(..., { renamedFrom })` — are still not
>    reachable from `SchemaLike`, so those two objects can only be renamed with a hints file.
> 2. **Structural candidates.** `src/diff/candidates.ts`. §3.3's three verdicts, and no
>    fourth: `unambiguous` when a dropped and a created fact in the same container have the
>    same *shape hash* and each is the other's only such partner; `ambiguous` when several
>    are; `nearMiss` when nothing matches by content but the names are within 0.6 similarity
>    or one contains the other. The shape hash is `contentHashOf` for a column (identity-free
>    by I1, so equal payloads mean "identical except the name") and content-plus-children for
>    a table, a type and a schema — deliberately **not** `rollupOf`, which folds in the
>    table's constraint and index names, and those are derived from the table's name, so a
>    real rename never matches under it. Nothing here applies itself.
> 3. **Non-TTY.** `missing_hints`, exit **2**, with the §3.3 envelope: one
>    `rename_or_recreate` entry per unresolved candidate and one `confirm_data_loss` entry
>    per unacknowledged DS-class hazard, each with a `fix` naming the exact annotation or
>    the `--hints-file` line. Nothing is written.
>
> **Divergence — `--interactive` prints a patch instead of editing your file.** §3.3 says
> the prompt "writes the annotation into the source file". The DSL records **no source
> location**: `ColumnDdl` carries `renamedFrom`, `dbName`, a type and its modifiers, and
> there is no `sourceRef` anywhere in `TableRuntime`. Editing in place would therefore mean
> *finding* the declaration by grepping the schema module for an identifier and rewriting
> somebody's source on the strength of that guess — which is the class of hidden decision
> this whole section exists to abolish. So on confirmation the CLI writes a **unified diff
> to stdout** (`src/cli/interactive.ts`, `patch -p0`-applyable, one hunk per accepted
> rename, and an explicit `# could not locate …` line when the search fails) and exits 2.
> The annotation still has to reach the repository before `generate` writes anything, which
> keeps CI and the human on exactly the same rule. When the DSL grows a source location this
> becomes an in-place edit and the exit code becomes 0.
>
> `--interactive` is TTY-only: with `process.stdin.isTTY` false it never prompts and behaves
> exactly like the non-interactive path.

### 3.4 Hazard taxonomy — the concrete v1 rule list

Codes are ours; the DS/MF/BC families and severities follow Atlas, and rule *semantics* follow
Squawk so users can map their existing knowledge. **35 rules in v1.**

**DS — destructive (default `error`; requires recorded acknowledgement)**

| Code | Rule |
|---|---|
| DS101 | Drop schema |
| DS102 | Drop table |
| DS103 | Drop non-generated column |
| DS104 | Enum value removal/reorder ⇒ type replacement + table rewrite |
| DS105 | Drop materialized view holding data |
| DS106 | Drop the only uniqueness guarantee on a column |

**MF — may fail on existing data (default `error` unless the table is proven empty).**
*This entire family is absent from pg-delta and is the first thing our layer adds.*

| Code | Rule | Squawk analogue |
|---|---|---|
| MF101 | Add UNIQUE index/constraint to a populated column | `disallowed-unique-constraint` |
| MF102 | Non-unique → unique index | — |
| MF103 | Add `NOT NULL` column with no default | `adding-not-nullable-field` |
| MF104 | Nullable → `NOT NULL` | `adding-required-field` |
| MF105 | Narrowing type change (`varchar(n)` shrink, numeric precision drop, `int8→int4`) | `changing-column-type` |
| MF106 | Add validated CHECK/FK to a populated table | `constraint-missing-not-valid` |

Emptiness is established by a `SELECT EXISTS(SELECT 1 FROM t LIMIT 1)` probe against the target
when one is reachable; offline, MF rules stay at `error` and must be acknowledged.

**BC — backward-incompatible with running app code (default `warn`)**

| Code | Rule |
|---|---|
| BC101 | Rename table (`renaming-table`) |
| BC102 | Rename column (`renaming-column`) |
| BC103 | In-place column type change visible to clients |
| BC104 | Rename an index/constraint referenced by name in app code or hints |

**LK — lock hazards (default `warn`; auto-rewritten when a safe form exists, see §3.5)**

| Code | Rule | Atlas |
|---|---|---|
| LK101 | `CREATE INDEX` without `CONCURRENTLY` | PG101 |
| LK102 | `DROP INDEX` without `CONCURRENTLY` | PG102 |
| LK103 | `CONCURRENTLY` inside a transaction block | PG103 |
| LK104 | `ADD PRIMARY KEY`/`UNIQUE` builds its index under ACCESS EXCLUSIVE | PG104/105 |
| LK105 | `ADD FOREIGN KEY` without `NOT VALID` | PG306 |
| LK106 | `ADD CHECK` without `NOT VALID` | PG305 |
| LK107 | `SET NOT NULL` full scan | PG303 |
| LK108 | `ALTER COLUMN TYPE` rewrite | PG301 |
| LK109 | `ADD COLUMN` with **volatile** default ⇒ rewrite | PG302 |
| LK110 | `ADD … GENERATED … STORED` / `AS IDENTITY` ⇒ rewrite | PG309/310 |
| LK111 | `CREATE TRIGGER` takes SHARE ROW EXCLUSIVE | PG308 |
| LK112 | `SET LOGGED`/`UNLOGGED` ⇒ rewrite | PG307 |

LK109 checks `pg_proc.provolatile != 'i'` — a constant default is *not* a rewrite. (pg-delta gets
this wrong in the conservative direction; we do not inherit that.)

**TX — transaction & robustness (default `error`)**

| Code | Rule |
|---|---|
| TX101 | Non-transactional statement in a file without `txmode none` |
| TX201 | **Non-idempotent statement inside a `txmode none` file** — see §5.4 |
| TX102 | Transactional and non-transactional statements mixed without a segment boundary |

**EN — enum (default `error`)**

| Code | Rule |
|---|---|
| EN101 | **A new enum label is used before its `ADD VALUE` has committed** — the exact §1.3 bug |
| EN102 | Enum removal/reorder attempted (⇒ DS104 replacement path) |

**ST — style (default `off`, opt-in)**

`ST101` prefer identity over serial · `ST102` prefer `text` over `char(n)` · `ST103` prefer
`timestamptz` · `ST104` prefer `bigint` for PKs · `ST105` identifier >63 bytes will be silently
truncated · `ST106` unqualified table reference.

Escape hatch: `-- pg-orm:nolint LK101 "index is on a 200-row lookup table"` — the reason string is
**mandatory**, so the suppression is reviewable.

> **AS BUILT 2026-08-28 (K3) — all 35 codes, and where each one lives.**
>
> Two producers, and the split is not arbitrary. **`diff/ddl.ts`** attaches a hazard when it knows
> something the catalog told it: this constraint is validated, that column is populated, this
> default calls a volatile function. **`lint/rules.ts`** computes the rest from the assembled
> `Plan`, because they are properties of the FILE — whether a `CONCURRENTLY` ended up inside a
> transaction, whether a `txmode none` file is re-runnable, whether a trigger or a materialised
> view (Tier R, never diffed) appears in hand-written SQL at all. `lintPlan(plan, sqlText, opts)`
> unions the two, re-derives severity through `hazardSeverity` rather than trusting the `.plan.json`
> on disk, and applies `-- pg-prime:nolint CODE "reason"`.
>
> | Code | Built | Where |
> |---|---|---|
> | DS101 drop schema | ✅ | `ddl.ts` drop `schema` |
> | DS102 drop table | ✅ | `ddl.ts` drop `table` |
> | DS103 drop non-generated column | ✅ | `ddl.ts` drop `column`, drop `typeAttribute` |
> | DS104 enum value removal/reorder | ✅ | `ddl.ts` drop `type`; `diff.ts` raises EN102 first |
> | DS105 drop materialized view | ✅ | `lint/rules.ts` (Tier R: never a delta, always possible in a `.sql`) |
> | DS106 drop the only uniqueness guarantee | ✅ | `ddl.ts` `dropConstraint` on `p`/`u` |
> | MF101 add UNIQUE to a populated column | ✅ | `ddl.ts` `addConstraint`, suppressed `onFreshTable` |
> | MF102 non-unique → unique index | ✅ | `ddl.ts` alter `index`, only when uniqueness actually changes |
> | MF103 add NOT NULL column with no default | ✅ | `ddl.ts` create `column` |
> | MF104 nullable → NOT NULL | ✅ | `ddl.ts` `notNullTransition`, on the ADD half of both §3.5 rewrites |
> | MF105 narrowing type change | ✅ | `ddl.ts` `alterColumn` type branch |
> | MF106 add validated CHECK/FK to a populated table | ✅ | `ddl.ts` `addConstraint`, on the `NOT VALID` ADD and on the literal form |
> | BC101 rename table | ✅ | `ddl.ts` rename `table` |
> | BC102 rename column | ✅ | `ddl.ts` rename `column` |
> | BC103 in-place column type change | ✅ | `ddl.ts` `alterColumn`; also composite `ALTER ATTRIBUTE` |
> | BC104 rename an index/constraint | ✅ | `ddl.ts` rename `constraint`/`index`, and the NOT NULL name repair |
> | LK101 `CREATE INDEX` without CONCURRENTLY | ✅ | `ddl.ts` `createIndex` |
> | LK102 `DROP INDEX` without CONCURRENTLY | ✅ | `ddl.ts` `dropIndex` |
> | LK103 CONCURRENTLY inside a transaction | ✅ | `lint/rules.ts`, from `plan.segments` |
> | LK104 `ADD PRIMARY KEY`/`UNIQUE` builds under ACCESS EXCLUSIVE | ✅ | `ddl.ts` `addConstraint` (`p`/`u`/`x`) |
> | LK105 `ADD FOREIGN KEY` without NOT VALID | ✅ | `ddl.ts` `addConstraint`; reachable only under `--no-safe-rewrite`, because the default path removes the hazard rather than reporting it |
> | LK106 `ADD CHECK` without NOT VALID | ✅ | as LK105 |
> | LK107 `SET NOT NULL` full scan | ✅ | `ddl.ts` — domain `SET NOT NULL` and `ATTACH PARTITION` (the bound scan). The column case no longer emits it: §3.5 row 4/5 removed the scan |
> | LK108 `ALTER COLUMN TYPE` rewrite | ✅ | `ddl.ts` `alterColumn` |
> | LK109 `ADD COLUMN` with a volatile default | ✅ | `ddl.ts` create `column`. The `provolatile <> 'i'` question is asked of the catalog by `Q_VOLATILE_DEFAULTS` and travels as a `volatile_default` diagnostic; `mentionsVolatileFunction` is the fallback when a caller does not thread it in |
> | LK110 `ADD … IDENTITY`/`GENERATED STORED` | ✅ | `ddl.ts` `alterColumn` identity branch |
> | LK111 `CREATE TRIGGER` takes SHARE ROW EXCLUSIVE | ✅ | `lint/rules.ts` (Tier R) |
> | LK112 `SET LOGGED`/`UNLOGGED` | ✅ | `ddl.ts` alter `table` persistence |
> | TX101 non-transactional statement without `txmode none` | ✅ | `lint/rules.ts` |
> | TX102 mixed transactionality without a segment boundary | ✅ | `lint/rules.ts`, from `plan.segments` |
> | TX201 non-idempotent statement in a `txmode none` file | ✅ | `lint/rules.ts` over a plan; `repeatables/idempotence.ts` over a `sql/` file's statements |
> | EN101 new enum label used before its `ADD VALUE` committed | ✅ | `diff/order.ts` |
> | EN102 enum removal/reorder | ✅ | `diff/diff.ts` |
> | ST101–ST106 style | ✅ | `lint/rules.ts`, **opt-in** (`{ style: true }`, or naming one in `--rules`). Their severities live there and not in `plan/plan.ts`'s table: `hazardSeverity` answers `error` for an unknown code, which is right for a hazard and wrong for advice, and a plan that carried them would put opt-in style into every `.plan.json` in the repo |
>
> **The emptiness probe.** `06` above says MF rules stay at `error` unless the table is proven
> empty. Built as `probeEmptiness(client, tables)` in `diff/ddl.ts`'s caller contract: a
> `SELECT EXISTS (SELECT 1 FROM t LIMIT 1)` per subject table against the TARGET, folded into
> `BuildOptions.emptyTables`. Offline — no client — the set is empty and every MF rule stays
> `error`, which is the documented behaviour and the safe direction.
>
> **`nolint`.** `-- pg-prime:nolint CODE "reason"` (both the `pg-prime:` and legacy `pg-orm:`
> spellings are parsed, since `renderSql`'s rename is K1's file this round). A directive under a
> `-- pg-prime:stmt N` marker scopes to statement N; one in the header block is file-wide. The
> reason is **mandatory**: a `nolint` without a quoted, non-empty one is a `DirectiveError` and
> forces exit 3 on its own, because an unreviewable suppression that silently succeeds is worse
> than no escape hatch. Suppression is recorded on the finding as `suppressedBy`, never removed
> from the report. Directives are found through the SQL **lexer**, so a `nolint` inside a string
> literal or a `$$ … $$` body is data, not a suppression.

### 3.5 Lock-safe rewriting (not just warning)

Where an unambiguously safer equivalent exists, **emit it**. This is where we differentiate from
every ORM-bundled migrator, and it is the layer pg-delta explicitly does not provide.

| Desired | Generated |
|---|---|
| `CREATE INDEX` | `DROP INDEX CONCURRENTLY IF EXISTS x;` + `CREATE INDEX CONCURRENTLY x …` in a `txmode none` file |
| `ADD FOREIGN KEY` | `ADD CONSTRAINT … NOT VALID;` then a separate `VALIDATE CONSTRAINT` statement |
| `ADD CHECK` | same `NOT VALID` + `VALIDATE` split |
| `SET NOT NULL` (PG ≥18) | `ADD CONSTRAINT … NOT NULL … NOT VALID;` + `VALIDATE CONSTRAINT` |
| `SET NOT NULL` (PG 15–17) | `ADD CHECK (c IS NOT NULL) NOT VALID` → `VALIDATE` → `SET NOT NULL` (PostgreSQL skips the scan, the CHECK proves it) → `DROP CONSTRAINT` |
| `ADD PRIMARY KEY` / `UNIQUE` | `CREATE UNIQUE INDEX CONCURRENTLY` + `ADD CONSTRAINT … USING INDEX` |
| `ADD COLUMN` w/ volatile default | split: add nullable → **generated backfill stub with a `TODO`** → `SET DEFAULT` → (separate migration) `SET NOT NULL` |

The `DROP INDEX CONCURRENTLY IF EXISTS` prefix is Squawk's `prefer-robust-stmts` and is what makes
a failed CIC retryable instead of permanently wedged. Disable the whole layer with
`--no-safe-rewrite` for a literal diff.

> **AS BUILT 2026-08-28 (K3 · rows 2–5, K2b · rows 1, 6, 7) — the rewrite table, row by row.**
>
> | Desired | Built | Where |
> |---|---|---|
> | `CREATE INDEX` → `DROP INDEX CONCURRENTLY IF EXISTS` + CIC in a `txmode none` file | ✅ | `ddl.ts` `createIndex(…, concurrent)`, `BuildOptions.multiFile`. Both statements carry `stage: "concurrent"` and `generate` writes them to `NNNN_name_concurrently.sql` |
> | `ADD FOREIGN KEY` → `ADD … NOT VALID` + `VALIDATE CONSTRAINT` | ✅ | `ddl.ts` `addConstraint`, `contype = 'f'` |
> | `ADD CHECK` → same split | ✅ | `ddl.ts` `addConstraint`, `contype = 'c'` |
> | `SET NOT NULL` (PG ≥ 18) → `ADD CONSTRAINT … NOT NULL … NOT VALID` + `VALIDATE` | ✅ | `ddl.ts` `notNullTransition`, taken when the DESIRED column's `notNullConstraint` is non-null — a catalog gate, not a version gate |
> | `SET NOT NULL` (PG 15–17) → `ADD CHECK (c IS NOT NULL) NOT VALID` → `VALIDATE` → `SET NOT NULL` → `DROP CONSTRAINT` | ✅ | same function, the other branch. The temporary constraint is named through `chooseConstraintName`, so a schema that already holds `<table>_<column>_not_null` gets `…_not_null1` instead of a duplicate-name error |
> | `ADD PRIMARY KEY` / `UNIQUE` → `CREATE UNIQUE INDEX CONCURRENTLY` + `ADD CONSTRAINT … USING INDEX` | ✅ | `ddl.ts` `addConstraint`, `contype ∈ {p,u}`, four statements (see below) |
> | `ADD COLUMN` w/ volatile default → split + backfill stub | ✅ (nullable) / ⛔ (NOT NULL — see below) | `ddl.ts` `addColumn`'s `splitVolatile` branch + `generate.ts`'s `dataMigrationSql` |
>
> **What unblocked rows 1, 6 and 7 is `generate` emitting more than one file.** `Statement`
> gains a `stage` (`main` | `concurrent` | `data`), `diff/order.ts` gains `splitStages`, and
> one `generate` run writes `NNNN_name.sql` (transactional) plus
> `NNNN_name_concurrently.sql` (`txmode none`) at the **same `seq`**, which §4.1's
> `(seq, name)` ordering applies in that order because `name` sorts before
> `name_concurrently`. Each file gets its own `.plan.json`; the second file's
> `from.fingerprint` is the *measured* state between them, `Proof.stageFingerprints[0]`,
> which is why `--no-prove` is refused for a two-file plan.
>
> **Row 6 is four statements, in this order:**
>
> ```sql
> ALTER TABLE t DROP CONSTRAINT IF EXISTS c;        -- robust prefix (§5.4 replays from 0)
> DROP INDEX CONCURRENTLY IF EXISTS c;              -- robust prefix
> CREATE UNIQUE INDEX CONCURRENTLY c ON t (…);      -- SHARE UPDATE EXCLUSIVE, not AE
> ALTER TABLE t ADD CONSTRAINT c UNIQUE USING INDEX c;
> ```
>
> PostgreSQL names a constraint's backing index after the constraint, so index and
> constraint share one name and the catalog state is identical to the literal form — which
> is what the D10 witness checks in `test/generate/rewrites.test.ts`. The two `IF EXISTS`
> prefixes are why all four are marked `idempotent`: §5.4 restarts a `txmode none` file at
> statement 0, and from the top the group is replayable. Their order matters and is pinned
> by a phase of its own (`PHASE.dropIndexConcurrently = 21`): dropping the constraint first
> takes its index with it, so the `DROP INDEX` after it can never hit "cannot drop index …
> because constraint … requires it". The rewrite is refused — falling back to the literal
> form and LK104 — for a definition `rebuildableUnique` will not reconstruct (`DEFERRABLE`,
> `WITH (…)`, a tablespace, an expression with parentheses).
>
> **Row 7 splits only when the split can converge.** A nullable column with a volatile
> default becomes `ADD COLUMN c <type>` (no default, no rewrite) + `ALTER COLUMN c SET
> DEFAULT …` (catalog only), and a `-- pg-prime:data` stub is written beside the migration
> for the existing rows. When the desired column is **NOT NULL** the split is refused and
> the literal `ADD COLUMN … NOT NULL DEFAULT …` plus LK109 stays: a NOT NULL column with a
> per-row distinct value cannot exist without writing every row, so no ordering of
> statements avoids the rewrite, and §3.5's own row puts `SET NOT NULL` in a *separate
> migration* — which this plan cannot contain and still converge on IR(desired). A
> `volatile_default_not_null` warning diagnostic names the three-migration shape.
>
> **The stub fails loudly if applied unedited.** Its one live statement is a
> `DO $$ … RAISE EXCEPTION … $$` naming the file, and the `UPDATE … SET c = DEFAULT` is
> commented out below it. A stub that applied silently would be recorded `applied` in
> `pgprime.migrations` while the rows it exists to fix stayed NULL, and the next `generate`
> would see a converged schema and never mention it again. It has **no `.plan.json`**: there
> is no diff behind a file a human still has to write, so there is no fingerprint to gate on.
>
> **When the two-file layout cannot express the plan's order** — a transactional statement
> that must follow a concurrent one — `splitStages` reports `declined`, `generate` rebuilds
> with `multiFile: false` and emits the single-file literal plan with its LK hazards, plus a
> `concurrent_rewrite_declined` warning. A plan whose files apply in an impossible order
> would be the worse answer by a distance.
>
> Callers that cannot carry a second file leave `BuildOptions.multiFile` off and get the
> literal form: `generateFromDatabases` (the three-connection entry point the fixture corpus
> uses), `migrate check` and `migrate push --dev`.
>
> `--no-safe-rewrite` is `BuildOptions.noSafeRewrite`. Under it every row above collapses
> back to the literal single-file form, and LK101 / LK104 / LK105 / LK106 / LK109 — which
> exist to describe exactly those forms — become reachable.

### 3.6 Destructive-change gating

A destructive action cannot be generated silently. `generate` requires either `--allow-data-loss`
(interactive/dev) or a hints-file acknowledgement, and records it **in the plan**:

```jsonc
"acknowledged": { "dataLoss": ["column:public.users.legacy_id"], "by": "yohocx",
                  "reason": "removed from API in v3", "at": "2026-08-14T10:32:11Z" }
```

Because it lands in `.plan.json`, it shows up as a **diff line in the pull request**. That is the
review interface: a reviewer sees `+ "dataLoss": ["column:public.users.legacy_id"]`.
`migrate lint` fails on any DS-class hazard whose subject is not in `acknowledged.dataLoss`.

### 3.7 Enum strategy

- **Add a label** — `ALTER TYPE … ADD VALUE 'x' [BEFORE|AFTER 'y']`, marked
  `transactionality: commitBoundaryAfter`. Any statement carrying an `evaluates` edge to that
  label is forced into the **next** segment. Violations are hazard EN101.
- **Remove or reorder** — impossible in any PostgreSQL version. We generate the full replacement
  path (rename old type → create new → `ALTER COLUMN … TYPE new USING col::text::new` → fix
  dependent function signatures, defaults and casts → drop old) as **DS104, always requiring
  acknowledgement**, and we flag the table rewrite.
- **Documented guidance:** prefer a lookup table + FK, or `text` + CHECK. The schema DSL makes the
  lookup-table form as ergonomic as the native enum so the advice is actionable rather than smug.

### 3.8 Repeatables (Tier R) — the pipeline for functions/views/triggers/RLS

Not diffed. Live in `sql/` with a declared apply order:

```
sql/
  010_types/…            020_functions/bump.sql
  030_views/active_users.sql                     040_triggers/users_bump.sql
  050_policies/users_self.sql
```

Each file must be idempotent (`CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` + `CREATE`,
`DROP POLICY IF EXISTS` + `CREATE`); `lint` enforces this with TX201. The runner hashes each file
and re-applies **only changed files**, after all versioned migrations, in one transaction, then
updates `pg_orm.repeatables`. Ordering within the pass is directory-lexicographic, then
`@supabase/pg-topo`-style topological refinement over the IR edges derived from the shadow load.

Repeatables *are* loaded into the shadow during `generate` — so a view that references a
to-be-dropped column makes the plan fail proof, at author time. That is the whole point of having
one IR for both lanes.

---

### 3.9 The `pg_dump` witness (D10)

D6's proof is **self-referential**: it extracts with our extractor, diffs with our differ and
hashes with our canonicalizer. If `catalog/extract.ts` does not model an attribute, then the
differ never plans for it *and the proof cannot notice*, because both sides of the equality are
blind in the same way. That is silent semantic loss passing a green gate — precisely the class
of bug the pg-delta oracle was hired to catch, and it is catchable for free.

`pg_dump` is PostgreSQL's own serializer. It models the entire DDL surface by definition and
shares no code with us. After the clone converges on our IR, both databases are dumped
(`--schema-only --no-owner --no-privileges`, restricted to the managed schemas) and compared.

Three implementation facts, each learned the hard way:

1. **Line-diffing a dump is wrong.** A `;` inside a dollar-quoted function body is not a
   statement boundary and a `--` inside a string literal is not a comment. `sql/statements.ts`
   is a real lexer; canonicalization collapses whitespace in CODE only, because PostgreSQL
   stores a function body verbatim.
2. **pg_dump ≥ 17.6 emits `\restrict <random-token>`.** Left in, the oracle reports a
   difference on every single run. They are psql meta-commands, not SQL, and are stripped.
3. **Column order is unrepairable.** `ADD COLUMN` can only append, so a column declared in the
   middle of a table always lands last. Reporting that as drift would demand something no
   engine can deliver, so `tableReorderKey` classifies "same columns, different order" into its
   own `reordered` bucket: recorded in the plan, never blocking.

Comparison is an order-independent **multiset** — the dump's emission order encodes dependency
order, which is a property of the plan, and ordering is already gated by the apply step.

Modes: `off` / `warn` / `strict`, default **`warn`**. Strict blocks the plan from disk. The
default is not strict because Tier-R objects (D4) are not diffed yet, so a desired database
carrying a view or trigger legitimately differs from the clone; flipping the default to
`strict` is the natural gate to close once repeatables land.

Unavailability — no `pg_dump` on PATH, or one older than the server — is `skipped`, never
`failed`: that is an environment gap, not evidence about the plan. The launcher argv is
injectable (`PG_PRIME_PG_DUMP`, `PG_PRIME_PG_DUMP_URI`) so a containerized server can be reached
without `src/` knowing that Docker exists.

**Status on the fixture corpus (2026-08-25):** acceptance, enum-ordering, multi-schema up and
down all pass `strict`. `evolve` passes with one classified reordering (`public.customers`,
from `full_name`). `fixtures/diff/unmodeled` is the negative control: two databases differing
only by `WITH (fillfactor=70)` — a `TablePayload` blind spot — where the differ emits zero
statements, the IR proof reports zero drift, and the witness catches it.

## 4. File formats

### 4.1 Directory layout

```
migrations/
  0000_baseline.sql            0000_baseline.plan.json
  0001_add_orders.sql          0001_add_orders.plan.json
  0007_backfill_country.sql    0007_backfill_country.plan.json   # data migration
  checkpoints/0006.ir.json     checkpoints/0006.plan.json
sql/                           # repeatables (Tier R)
seeds/                         # not in migration history
```

`NNNN` is a zero-padded monotonic counter. **Duplicate numbers are legal** (pgmigrate's insight):
`0007_a.sql` and `0007_b.sql` from two branches both apply, ordered by `(number, name)`. Ordering
is resolved from the files on disk, not from a mutable journal — there is no `_journal.json` to
desync (drizzle's documented failure mode).

### 4.2 Migration `.sql`

```sql
-- pg-orm:migration 0007_add_orders_status_index
-- pg-orm:plan      0007_add_orders_status_index.plan.json
-- pg-orm:from      sha256:1cea92fe9b3ba17309a5…
-- pg-orm:to        sha256:1f2cbc1a18cb45dc7508…
-- pg-orm:txmode    none
-- pg-orm:timeout   lock=3s statement=0
-- pg-orm:requires-pg 150000

-- pg-orm:stmt 0 lock=shareUpdateExclusive idempotent hazards=LK101
DROP INDEX CONCURRENTLY IF EXISTS public.orders_status_idx;

-- pg-orm:stmt 1 lock=shareUpdateExclusive idempotent
CREATE INDEX CONCURRENTLY orders_status_idx ON public.orders USING btree (status);
```

**Directives** (Atlas's proven vocabulary, our namespace): `txmode none|transactional|segmented` ·
`timeout lock=… statement=…` · `nolint <CODE> "<reason>"` · `checkpoint` · `data` · `batch` ·
`requires-pg <num>` · `renamed_from <name>`.

**Why the `-- pg-orm:stmt N` markers matter:** partial-application resume records a *statement
index*. Deriving that index by re-splitting the file at resume time makes correctness depend on
splitter determinism across versions. An explicit marker makes the index part of the reviewed
artifact. The splitter (dollar-quote-, comment- and string-aware — required for `plpgsql` bodies
regardless) is only the fallback for hand-written files.

The `.sql` is the executable artifact and is runnable by `psql` if our tooling ever fails. That is
non-negotiable.

### 4.3 `.plan.json` — the schema

```jsonc
{
  "formatVersion": 1,
  "planId": "sha256:9f2c…",           // over every field below EXCEPT `generated` and `proof`
  "engine": { "name": "pg-orm-ts", "version": "1.0.0",
              "backend": "pg-delta@1.0.0-alpha.39", "irVersion": 1 },
  "generated": { "at": "2026-08-14T10:32:11Z", "by": "yohocx", "interactive": false },

  "migration": { "id": "0007", "name": "add_orders_status_index",
                 "file": "0007_add_orders_status_index.sql", "sha256": "sha256:aa17…" },

  "from": { "fingerprint": "sha256:1cea92fe…", "checkpoint": "0006" },
  "to":   { "fingerprint": "sha256:1f2cbc1a…" },

  "pg": { "minVersion": 150000, "generatedAgainst": 170011 },
  "normalized": true,
  "shadowTier": 2,

  "txmode": "none",
  "segments": [ { "index": 0, "transactional": false, "statements": [0] },
                { "index": 1, "transactional": false, "statements": [1] } ],

  "statements": [
    { "index": 0,
      "sql": "DROP INDEX CONCURRENTLY IF EXISTS public.orders_status_idx",
      "verb": "drop", "kind": "index",
      "produces": [], "consumes": ["table:public.orders"],
      "destroys": [], "releases": [],
      "transactionality": "nonTransactional",
      "lockClass": "shareUpdateExclusive",
      "idempotent": true,
      "timeouts": { "lock": "3s", "statement": null },
      "dataLoss": "none", "rewrite": false,
      "hazards": ["LK101"] }
  ],

  "renames": [ { "kind": "column",
                 "from": "column:public.users.first_name",
                 "to":   "column:public.users.name",
                 "source": "annotation",
                 "confidence": "unambiguous" } ],

  "hazards": [ { "code": "DS103", "severity": "error", "statement": 3,
                 "subject": "column:public.users.legacy_id",
                 "message": "column public.users.legacy_id is dropped; 41203 rows affected",
                 "acknowledged": true, "suppressedBy": null } ],

  "acknowledged": { "dataLoss": ["column:public.users.legacy_id"],
                    "by": "yohocx", "reason": "removed from API in v3",
                    "at": "2026-08-14T10:32:11Z" },

  "repeatables": [ { "path": "sql/030_views/active_users.sql", "sha256": "sha256:71bd…" } ],

  "unmodeled": [ { "kind": "operatorClass", "count": 2 },
                 { "kind": "textSearchConfig", "count": 1 } ],

  "proof": { "status": "passed", "at": "2026-08-14T10:32:19Z",
             "shadow": "createdb", "driftDeltas": 0,
             "dataViolations": [], "undeclaredRewrites": [],
             "tablesChecked": 4, "durationMs": 3810 }
}
```

`planId` deliberately excludes `generated` and `proof` so the same logical plan re-proven by a
different person on a different day has a stable id. `apply` refuses when the live fingerprint
≠ `from.fingerprint` — this is simultaneously the **drift guard** and the **concurrent-deploy
guard**, and it is strictly stronger than Prisma's checksum-the-file approach.

**No per-migration full snapshot.** State lives only in checkpoints. This is a direct rejection of
drizzle's 11k-line `NNNN_snapshot.json` per migration.

### 4.4 History tables

```sql
CREATE SCHEMA IF NOT EXISTS pg_orm;

CREATE TABLE IF NOT EXISTS pg_orm.migrations (
  id                  text PRIMARY KEY,            -- '0007_add_orders_status_index'
  seq                 integer     NOT NULL,
  name                text        NOT NULL,
  checksum            text        NOT NULL,        -- sha256 of the .sql bytes
  plan_id             text,
  fingerprint_from    text,
  fingerprint_to      text,
  txmode              text        NOT NULL,
  statements_total    integer     NOT NULL,
  statements_applied  integer     NOT NULL DEFAULT 0,   -- partial-application position
  statement_uncertain integer,                          -- see §5.4
  segment_applied     integer     NOT NULL DEFAULT 0,
  status              text        NOT NULL,        -- running|applied|failed|baselined|superseded
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  duration_ms         integer,
  applied_by          text        NOT NULL DEFAULT current_user,
  applied_from        text,                        -- hostname / CI run id
  error               jsonb,
  engine_version      text        NOT NULL
);

CREATE TABLE IF NOT EXISTS pg_orm.repeatables (
  path        text PRIMARY KEY,
  checksum    text        NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms integer
);

CREATE TABLE IF NOT EXISTS pg_orm.checkpoints (
  id text PRIMARY KEY, fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- lease, for txmode-none runs that cannot hold a transaction-scoped lock (§5.2)
CREATE TABLE IF NOT EXISTS pg_orm.lock (
  singleton   boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  run_id      uuid        NOT NULL,
  holder      text        NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);

-- data-migration watermarks (§7)
CREATE TABLE IF NOT EXISTS pg_orm.data_progress (
  migration_id text PRIMARY KEY,
  watermark    jsonb       NOT NULL,
  rows_done    bigint      NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
```

`fingerprint_to` on the last applied row is the **current schema fingerprint of record**, which is
what makes `status` and `check` cheap (no introspection needed for the fast path).

**AS BUILT · 2026-08-28 (design/11 K1).** `packages/pg-prime-kit/src/history/schema.ts`. The five
tables above exist verbatim under **`pgprime`** (design/11 §1.1's rename), plus one addition:

```sql
CREATE TABLE IF NOT EXISTS pgprime.meta (key text PRIMARY KEY, value text NOT NULL);
INSERT INTO pgprime.meta (key, value) VALUES ('history_version', '1') ON CONFLICT DO NOTHING;
```

A later change to these tables has to be detectable *before* anything else is read, and inferring
it from `information_schema.columns` is guesswork. `ensureHistory(client)` runs all seven statements
in **one transaction of its own** — half-created history is worse than none — and retries once on
`23505`/`42P06`/`42P07`/`42710`, because `CREATE … IF NOT EXISTS` checks for existence *before* it
inserts the catalog row and two replicas starting together is the normal case (§5.5), not the
exceptional one. `test/runner/history.test.ts` runs three `ensureHistory` calls concurrently and
then reads the whole shape back out of `information_schema.columns` and compares it to this
section's column list, transcribed into the test.

Two columns are written differently from what the naive reading suggests, both to keep a client
clock out of the history table: `started_at`/`duration_ms` on the transactional path come from
`transaction_timestamp()` and `clock_timestamp()` inside the migration's own transaction, and
`heartbeat_at`'s age is computed server-side (`EXTRACT(EPOCH FROM (now() - heartbeat_at))`) so a
skewed client cannot invent a stale lease.

### 4.5 Checkpoints

A checkpoint is a normal migration file tagged `-- pg-orm:checkpoint` containing the **full schema
DDL** at that point, plus `checkpoints/NNNN.ir.json`. A **fresh** database applies the newest
checkpoint and then everything after it; an **existing** database ignores checkpoints entirely and
continues linearly. Nothing is deleted. This is Atlas's model and it is strictly better than
destructive squashing — a 400-file directory stops costing CI 400 replays without losing history.

**AS BUILT · 2026-08-29 (design/12 K4).** `src/checkpoint/checkpoint.ts` and
`src/cli/commands/checkpoint.ts`. Everything above is built, plus a third artifact and four
decisions the section leaves open.

`migrate checkpoint` writes **three** files: `NNNN_checkpoint.sql` (the `-- pg-prime:checkpoint`
directive in its header, so the RUNNER sees it — the directive is a property of the file, not of
the plan), `NNNN_checkpoint.plan.json`, and `checkpoints/NNNN.ir.json`. All three with `wx`: a
checkpoint is history like any other migration, and silently overwriting one rewrites a file
another developer's fresh database may already have jumped to.

The DDL comes from **`baseline`'s emitter path** — `diffIR(freshDatabaseIR, current)` →
`buildStatements` → `orderStatements` — because a checkpoint and a baseline are the same artifact
asked for at two different times, and one code path means a checkpoint cannot replay differently
from the baseline of the same schema. The "from" IR is §6.3 AS BUILT's fresh-database IR (the
schemas whose OID `initdb` assigned, their comments, and the extensions it installed), not the
null IR, for the same reason: a full-schema file whose `from.fingerprint` was the null hash could
never pass its own gate on replay. The plan is stamped `proof: { status: "skipped", reason:
"checkpoint" }` — the DDL describes a database that already exists and this command never
executes it; `verify --from-checkpoint` is what proves it replays.

`checkpoints/NNNN.ir.json` is `SchemaIR.toCheckpoint()` (§2.3), read back by `irFromCheckpoint`.
§2.3 deliberately drops provenance, which is right: a checkpoint is a statement about *shape*.

**"Ignores" is recorded, as `superseded`** — see §6.5 for why. **The jump condition is
`pgprime.migrations` being empty**, which is the only definition of "fresh" available before
anything has run and the only one that cannot be wrong: a database with one recorded migration
has a history to continue, whatever its catalog looks like.

**`pgprime.checkpoints` is written by `apply`**, when a fresh database actually jumps to one, and
holds the fingerprint of record after the jump.

**The drifted objects are now NAMED**, which closes design/11 K1's open item (a) — "a fingerprint
mismatch cannot name the drifted objects: naming them needs an IR of the expected state, and §4.3
deliberately rejects a per-migration snapshot". A checkpoint IS that IR, for the position it was
taken at, so `describeDrift` diffs the live catalog against the newest checkpoint at or before
the last applied migration. When the checkpoint IS that position the list is exact; when
migrations were applied after it their changes are in the list too, and the message says so and
names them rather than presenting a superset as if it were exact. `apply`'s
`fingerprint_mismatch` and `status --verify-fingerprint` both carry it, and a repository with no
checkpoint gets a sentence telling it to take one.

---

## 5. The runner

### 5.1 Apply algorithm

```
 1. Open a DEDICATED direct connection. Refuse the app pool. (§5.2)
 2. Detect transaction pooling. Abort with a specific error if detected. (§5.2)
 3. Ensure pg_orm schema + tables exist (idempotent, own transaction).
 4. Acquire the advisory lock + lease. (§5.2)
 5. Reconcile: read pg_orm.migrations; diff against files on disk.
       - applied file missing from disk        → error   (exit 4)
       - checksum drift on an applied file     → error in `apply`, warn in `--dev` (exit 4)
       - a `running` row with a live lease      → exit 6 (concurrent deploy)
       - a `running` row with a dead lease      → RESUME it (§5.4)
 6. Pre-flight sweep: report INVALID indexes and unvalidated constraints touched by pending plans.
 7. FOR EACH pending migration, in (seq, name) order:
      a. Verify the file's sha256 == plan.migration.sha256.
      b. Verify live fingerprint == plan.from.fingerprint.
           - Fast path: last applied row's fingerprint_to.
           - Slow path (--verify-fingerprint, or fast path unavailable): re-extract.
           - Mismatch → exit 4.
      c. Dispatch on txmode:
           transactional →  §5.3
           none          →  §5.4
           segmented     →  per-segment, transactional segments in a txn, others bare
      d. On failure: record error, release lock, exit 1 (or 7 if a proof gate failed).
 8. Repeatables pass: re-apply changed sql/ files in one transaction, update pg_orm.repeatables.
 9. Release lock and lease. Report.
```

### 5.2 Locking, and the pooler problem

The research recommends `pg_advisory_xact_lock` so the lock dies with its transaction. **That is
unusable for us**: a `txmode none` migration has no enclosing transaction, so there is nothing for
the lock to be scoped to. Resolution — two mechanisms, deliberately:

1. **Session-scoped `pg_advisory_lock(key)`** on the dedicated migration connection, held for the
   whole run. `key = hashtext(current_database() || ':' || <managed-schema-set>)` — **derived, not
   fixed**, so two unrelated schemas in one database do not serialize against each other (Kysely's
   fixed key is a bug we do not copy).
2. **A heartbeat lease row** (`pg_orm.lock`, updated every 5 s from the same connection). A
   session lock stranded behind a pooler cannot be detected by `pg_locks` alone; a stale
   `heartbeat_at` can. After `--stale-lock-after` (default 60 s) `migrate apply` reports the
   stale holder and `migrate unlock --force` can break it.

**Active transaction-pooler detection.** No ORM does this; all use manual flags. It is cheap:

```sql
BEGIN; SELECT pg_backend_pid(); COMMIT;
BEGIN; SELECT pg_backend_pid(); COMMIT;
```

Different pids ⟹ the connection is behind a transaction-mode pooler (PgBouncer
`pool_mode=transaction`, PgCat, Odyssey, Supabase port 6543). Session advisory locks are then
**silently broken** — the unlock no-ops on the wrong backend and the original backend returns to
the pool still holding the lock (the documented cause of hangs and of autovacuum being disabled on
the locked relation). We hard-error with the direct-connection port to use. This turns a class of
silent production corruption into a startup error.

### 5.3 `txmode transactional`

```sql
BEGIN;
  SET LOCAL lock_timeout = '3s';
  SET LOCAL statement_timeout = '30s';
  SET LOCAL search_path = pg_catalog;
  <statement 0> … <statement N>
  INSERT INTO pg_orm.migrations (…) VALUES (…);   -- inside the SAME transaction
COMMIT;
```

The history insert is in the same transaction as the DDL, so "applied" and "recorded" are atomic —
there is no torn state, ever. This is PostgreSQL's transactional-DDL superpower and it is the main
reason a PG-only tool can be safer than a portable one. Verified empirically: the failing probe
plan reported `status: failed, appliedActions: 0` with every action `unapplied` and the database
byte-identical afterwards.

**Per-file, never per-run.** A whole-run transaction holds every ACCESS EXCLUSIVE lock taken
anywhere until the final COMMIT. Drizzle wraps all pending migrations in one transaction; a
40-migration backlog then holds one lock set for the duration. We reject that.

**Retry on `lock_timeout` (SQLSTATE 55P03):** the correct behaviour is fail-fast-then-retry, not
wait. Default 5 attempts with exponential backoff + jitter. `statement_timeout` failures are
**not** retried — they indicate the operation is genuinely too slow.

### 5.4 `txmode none`, CIC, and the resume problem — the hard edge

A non-transactional file cannot record its progress atomically with its work. `CREATE INDEX
CONCURRENTLY` makes this worse: a failed CIC leaves an **INVALID index** behind that is not used
by the planner but *is* maintained on every write, and a runner that retries the CIC without first
dropping it fails forever.

**Execution:**

```
for i in statements:
    BEGIN; UPDATE pg_orm.migrations SET statement_uncertain = i WHERE id = …; COMMIT;
    execute statement i                          -- bare, no transaction
    BEGIN; UPDATE pg_orm.migrations
              SET statements_applied = i + 1, statement_uncertain = NULL
            WHERE id = …; COMMIT;
```

`statement_timeout` is set to **0** for statements whose `lockClass` is `shareUpdateExclusive` and
whose verb is a CONCURRENTLY build, `VALIDATE CONSTRAINT`, or `REINDEX` — these are intentionally
long-running, and the research is explicit that the timeout must therefore be **per-statement, not
per-file**. `lock_timeout` still applies to all of them.

**The irreducible window.** After a crash, statements `0 .. statements_applied-1` definitely
committed. Statement `statement_uncertain` is genuinely unknown: the process could have died
before it ran, during it, or after PostgreSQL committed it but before our bookkeeping transaction
committed. No amount of bookkeeping closes this window, because the DDL and the bookkeeping cannot
share a transaction — that is the definition of `txmode none`.

**The resolution is to make the question not matter.** Invariant **TX201**:

> Every statement in a `txmode none` file MUST be idempotent.

Enforced at generate time by lint, not by hope. Our lock-safe rewriter already produces idempotent
forms — `DROP INDEX CONCURRENTLY IF EXISTS x` before every `CREATE INDEX CONCURRENTLY x`,
`IF EXISTS` on every drop, `IF NOT EXISTS` where PostgreSQL supports it. `VALIDATE CONSTRAINT` is
naturally idempotent. A hand-written `txmode none` file containing a non-idempotent statement
**fails `migrate lint` with TX201** and never reaches production.

Given the invariant, resume is trivial and unconditionally safe: **re-execute
`statement_uncertain`, then continue.** The `DROP INDEX CONCURRENTLY IF EXISTS` prefix
simultaneously cleans up the INVALID index left by the crashed CIC. The permanently-wedged-retry
failure mode is structurally eliminated rather than handled.

`migrate doctor` independently reports `pg_index WHERE NOT indisvalid`, `_ccnew%` leftovers from
interrupted `REINDEX CONCURRENTLY`, and constraints still `NOT VALID`.

### 5.5 Concurrent deploys

Two replicas starting simultaneously: one wins the advisory lock; the other blocks on it (bounded
by `--lock-wait`, default 30 s) and then re-reads history — finding nothing pending, it exits **0**
and starts serving. This is the correct behaviour for the k8s-Job and init-container topologies
that dominate real deployments. It is not correct to exit non-zero merely because someone else did
the work.

If the winner is mid-run when the loser's wait expires, the loser exits **6** and the orchestrator
retries. If the winner crashes, its session lock dies with the backend and its lease goes stale;
the next runner resumes the `running` row per §5.4.

### 5.6 Failure taxonomy

| Failure | Behaviour |
|---|---|
| Fingerprint mismatch | Refuse before executing anything. Exit 4. Message names the drifted objects. |
| Checksum drift on an applied file | Exit 4 in `apply`; warn in `--dev` |
| `lock_timeout` (55P03) | Retry with backoff, then exit 1 |
| `statement_timeout` (57014) | No retry. Exit 1 |
| Transactional failure | Automatic rollback; nothing recorded as applied |
| `txmode none` failure | Position recorded; row left `running`; resume on next apply |
| Deadlock (40P01) | Retry the whole file once, then exit 1 |
| Serialization failure (40001) | Retry the whole file |

---

### 5.7 AS BUILT · 2026-08-28 (design/11 K1)

`src/runner/{run,files,status}.ts` implement §5.1 steps 1–9 as `applyPending(conn, dir, options)`.
Everything above is built. Six things are built **differently**, each for a reason that was measured
rather than preferred.

**1. §5.2's two-pid pooler probe does not fire on an idle pool. Measured.** Against PgBouncer 1.25
in `pool_mode=transaction` with one client, `BEGIN; SELECT pg_backend_pid(); COMMIT;` twice returns
the *same* pid: the pooler hands the one idle server connection straight back for the second
transaction. `detectTransactionPooler` is kept (it is decisive on a busy pool and costs two round
trips) and `detectTransactionPoolerStrict` is added: read the pid, then open a **second** client and
leave a transaction open on it so the pooler's most-recently-used idle server is taken, then read the
pid again. Under transaction pooling we are moved and the pid changes; on a direct connection the pid
is a property of the socket and cannot change, so there is no false positive. A pool of size 1 cannot
move us — it makes us wait — so a probe that does not answer within 3 s is also a pooler. Both
directions are asserted against a real PgBouncer in `test/runner/pooler.test.ts`, including the
negative control, and the "the cheap probe says no" measurement is asserted too rather than described,
so a future PgBouncer that behaves differently shows up as a failing test.

**2. The refusal exits 1, not 6.** §3 K1 of design/11 says "exit 6-class"; §0's gate row for the same
workstream says "exit 1 and the right sentence", and §6.1 reserves 6 for "a concurrent deploy holds
it". Nothing holds the lock here — the connection is unusable — so it is the `1` of §6.2's
`0 · 1 · 4 · 6`. The message names `pg_backend_pid`, the port the server behind the pooler reports,
and the usual 6432/5432 and 6543/5432 pairs.

**3. The lease heartbeat runs on a second connection, not "from the same connection".** §5.2's
wording cannot work: the migration connection spends the whole of a `CREATE INDEX CONCURRENTLY`
inside one statement, `pg.Client` serialises, and issuing a second `query()` while one is in flight
is deprecated in `pg@8` and removed in `pg@9`. Queuing the beats behind the build means **no beat
for the entire build** — exactly when the lease is the only evidence the runner is alive — and the
next deploy would report a healthy run as stale and offer to break it. `applyPending` therefore opens
one extra connection for the heartbeat and closes it with the run. What §5.2 is protecting is
unharmed: the advisory lock still lives on the dedicated connection, and both connections die with
the process. `test/runner/lock.test.ts` watches `heartbeat_at` advance four times while a
`pg_sleep(3)` is in flight; putting the beat back on the migration connection makes that test red.

**4. Resume restarts a `txmode none` file at statement 0 when `statement_uncertain` is set.** §5.4
says "re-execute `statement_uncertain`, then continue" and, in the same paragraph, that "the
`DROP INDEX CONCURRENTLY IF EXISTS` prefix simultaneously cleans up the INVALID index left by the
crashed CIC". Those two sentences contradict each other: the prefix is an *earlier* statement, already
counted in `statements_applied`, so re-executing only the uncertain one re-runs
`CREATE INDEX CONCURRENTLY x` against the invalid `x` the crash left behind and fails with 42P07 —
forever. TX201 ("every statement in a `txmode none` file MUST be idempotent") is exactly the licence
to replay the file, so:

- `statement_uncertain IS NULL` → resume at `statements_applied`. The crash landed on a clean
  boundary; nothing is dirty.
- `statement_uncertain = i` → restart at 0. A statement was in flight and its residue is unknown;
  only a replay of the (idempotent) file is guaranteed to clean it up.

The cost is re-running the completed statements of the file, which for the CIC shape the rewriter
emits is one `DROP INDEX CONCURRENTLY IF EXISTS`. `test/runner/resume.test.ts` SIGKILLs a spawned
runner mid-build, terminates the orphaned backend, **asserts the INVALID index is really there**, and
then resumes; reverting to the literal reading makes it red.

**5. The history INSERT is a statement of the migration's own transaction.** §5.3 draws it inside the
`BEGIN`/`COMMIT`, and `applySegments` owns that framing, so the row is rendered as one literal
`INSERT … ON CONFLICT DO UPDATE` (values through `quoteLiteral`) and appended to the last
transactional segment as statement `n` — every real statement keeps its index. "Applied" and
"recorded" therefore commit together, and a transactional failure leaves neither. Because that also
means a failure leaves *no row at all*, `markFailed` writes one afterwards in its own statement with
the `error` jsonb, which is what makes the failure visible. `--dry-run`'s golden shows the INSERT
before the `COMMIT`; moving it out makes that golden red.

**6. Retries are scoped to the unit that rolled back.** §5.3 and §5.6 give per-SQLSTATE budgets but
not a unit. A transactional file is retried whole (the transaction rolled back); a bare statement in a
`txmode none` file is retried alone (nothing else did). Budgets, counting the first try:
`55P03` 5 · `40001` 5 · `40P01` 2 · `57014` 1 · everything else 1. Backoff is exponential from 100 ms
with ±50% jitter, capped at 5 s. The SQLSTATE comes off the error object — `ApplyError` gained a
`sqlState` field for it — never off the message text (design/09 R13).

**Two things §5 asks for that are NOT built.** (a) A fingerprint mismatch **cannot name the drifted
objects**: naming them needs an IR of the expected state, and §4.3 deliberately rejects a per-migration
snapshot. The message names the migration, the expected fingerprint, the live one, the managed schema
set and how to re-extract; naming objects arrives with checkpoints (K4). (b) The **managed schema set
is configuration**, not plan data — `Plan` has no `schemas` field, and it scopes the diff, the
fingerprint *and* the advisory lock key, so `apply --schema` (or `schemas` in `pg-prime.config.ts`)
has to match what `generate` used. A mismatch surfaces as a fingerprint refusal, which is the right
failure but not the clearest sentence; putting the set in the plan is a K2b change to `plan.ts`.

`--dry-run` is implemented by running the real code path against a client that records instead of
executing, so there is no second implementation of the statement stream to drift from the first.
`test/runner/dry-run.test.ts` records the real run through a forwarding proxy and asserts the two
streams are equal query for query and bind for bind.

---

## 6. CLI — exact semantics and exit codes

### 6.1 Exit codes (uniform across every command)

| Code | Meaning |
|---|---|
| **0** | Success, or nothing to do |
| **1** | Error — bad config, connection failure, SQL error, internal |
| **2** | `missing_hints` — an unresolved rename or unacknowledged data loss needs a human decision |
| **3** | Lint failure at `error` severity |
| **4** | Drift — non-empty diff, fingerprint mismatch, or checksum drift |
| **5** | Pending migrations exist (CI gate) |
| **6** | Lock unavailable — a concurrent deploy holds it |
| **7** | Proof failed — the plan does not converge on a clone |

`--output json` is always non-interactive and always emits `{ status, exitCode, … }`. Adopted from
drizzle-kit v1, which is the one thing in this space that reliably never hangs in CI.

### 6.2 Commands

**`migrate generate [--name <slug>]`**
Build IR(desired) from TS + `sql/`, normalize via the shadow ladder, extract IR(current), diff,
resolve renames, order, apply lock-safe rewriting, run hazard analysis, **prove on a clone**, and
only then write `NNNN_name.sql` + `.plan.json`.
Flags: `--interactive` (TTY; prompts *write annotations into your source*) · `--hints-file <p>` ·
`--allow-data-loss` · `--shadow <url|docker|temp-schema|none>` · `--offline` · `--no-safe-rewrite` ·
`--no-prove` (dev only; stamps `"proof": {"status":"skipped"}`) · `--empty` (blank file for a hand-
written migration) · `--data` (data-migration template, §7) · `--output json`.
Exit: 0 · 2 unresolved · 3 lint · 7 proof failed. **Writes nothing on a non-zero exit.**

**`migrate apply` (alias `deploy`)**
Apply pending migrations per §5. Never generates. Never introspects the desired state. Never needs
the TS schema — it needs only the `migrations/` directory and a connection, so the production image
does not ship your schema code.
Flags: `--to <id>` · `--dry-run` (print the exact statement stream incl. transaction framing) ·
`--lock-timeout` · `--statement-timeout` · `--lock-wait` · `--verify-fingerprint` (force re-extract
rather than trusting the recorded `fingerprint_to`) · `--stale-lock-after` · `--yes`.
Exit: 0 · 1 · 4 · 6.

**`migrate status`**
Applied vs pending, current fingerprint, stale locks, partially-applied rows, repeatable drift.
Read-only. Exit: 0 (up to date) · 5 (pending) · 4 (drift).

**`migrate check`** — *the default CI gate.*
Composite, no DB writes: (a) is the migrations directory consistent with the TS schema — i.e. would
`generate` produce a non-empty diff? (b) do all checksums match? (c) are there pending migrations?
Runs `generate --dry-run` against a throwaway shadow.
Exit: 0 · 2 · 3 · 4 (schema changed but no migration was generated — the "you forgot to run
generate" case) · 5.

**`migrate verify`** — *the differentiator no bundled migrator ships.*
Provision an ephemeral database (testcontainers by default), **replay every migration from empty**
(or from the newest checkpoint with `--from-checkpoint`), apply repeatables, extract the result,
diff against IR(desired), and **assert the diff is empty**. This catches "the committed file does
not do what the schema says", which is a different failure from drift and which nothing in the
JS ecosystem checks today. Also replays with `--to <id>` for bisecting.
Exit: 0 · 4 (non-empty diff; prints the deltas) · 1.

**`migrate lint [<file>…]`**
Run the §3.4 rules over generated or hand-written SQL. Defaults to unapplied migrations.
Flags: `--fail-on error|warn|off` (default `error`) · `--rules <codes>` · `--format text|json|sarif`
(SARIF for GitHub code scanning annotations).
Exit: 0 · 3.

**`migrate baseline [--at <id>]`** — *adoption blocker if missing.*
Introspect the live database, write `0000_baseline.sql` + `.plan.json` containing the full current
schema, and insert a history row marked `status='baselined'` **without executing it**. With
`--at <id>` it instead marks an existing file applied (Prisma's `migrate resolve --applied`, for
adopting a database that was migrated by another tool). Refuses if `pg_orm.migrations` is non-empty
without `--force`.
Exit: 0 · 1.

**`migrate checkpoint`**
Write a `-- pg-orm:checkpoint` migration containing the full schema plus `checkpoints/NNNN.ir.json`.
Fresh databases jump to it; existing ones ignore it. Nothing is deleted.
Exit: 0 · 1.

**`migrate push --dev`** — *dev loop only, and loudly labelled.*
Compute the diff and apply it **directly**, writing no files and no history rows. Requires the
literal `--dev` flag (not a default, not a config key). **Refuses** when
`PG_ORM_ENV=production`, when the connection string matches `--prod-pattern`, or when
`pg_orm.migrations` contains any row not marked `baselined` — i.e. it will not run against a
database under versioned management. Prints a red banner naming the target database. Destructive
changes require `--allow-data-loss` every single time; the acknowledgement is never remembered.
Exit: 0 · 1 · 2.

**`migrate doctor`**
Read-only health report: INVALID indexes, `_ccnew%` leftovers, unvalidated constraints, catalog vs
history drift, stale locks, orphaned Tier-R objects, unmodeled-kind census.
Exit: 0 · 4 (findings).

**`migrate unlock [--force]`** — inspect or break a stale lease.

**`db seed [--set <name>]`** — §7.

---

### 6.3 AS BUILT · 2026-08-28 (design/11 K1)

The binary is **`pg-prime`** (`"bin": { "pg-prime": "./dist/cli.js" }` in `@pg-prime/kit`), named
after the product, with `migrate` as the noun. Four of §6.2's commands ship — `apply` (alias
`deploy`), `status`, `baseline`, `unlock` — and `pg-prime --help` lists the other seven under
"Not in this release" with the workstream that owns them, rather than pretending they do not exist.
There is no CLI framework: `src/cli/args.ts` is ~150 lines and the kit's runtime dependencies are
still exactly `pg` + `@types/pg`.

§6.1's table is `src/cli/exit.ts`'s `EXIT`, one object, imported by every command **and by the
runner** — "uniform across every command" only means something if there is one table. `--output json`
always writes one envelope to **stdout**, including for a usage error, an unknown command and an
unexpected throw; text output goes to stdout on success and stderr on failure. Envelope keys are
written in a fixed order and goldened per command under `test/cli/golden/`, with volatile fields
masked by the documented list in `test/cli/_mask.ts` (never by a regex over the document).

Flags built, beyond §6.2's list, both because a test needed a deterministic value and both useful:
`apply --applied-from <id>` (what §4.4's `applied_from` column is for — a CI run id) and
`apply --heartbeat <duration>` (the lease refresh interval, which must stay well under
`--stale-lock-after`). `--yes` is accepted and ignored: `apply` never prompts.

Two semantics §6.2 left open, decided here:

- **`unlock` exits 6 when a LIVE lease is held** and 0 when the lock is free, when the lease is stale,
  or after `--force` released it. An orchestrator shelling out to `unlock` to decide whether to retry
  needs "somebody is deploying" to be non-zero. `--force` deletes the lease row and says so; it cannot
  release the winner's *session* advisory lock, and the envelope's `note` says that too when the lease
  it broke was not stale.
- **`baseline --at <id>` marks every file up to and including `<id>`**, not only that one. "The
  database is at 0003" means 0000–0003 all ran, by whatever tool; marking one would leave its
  predecessors pending and `apply` would run them. All of them get `status='baselined'`, because none
  of them was executed by us.

`baseline` without `--at` writes `0000_baseline.sql` + `.plan.json` through the ordinary create path
and stamps `proof: { status: 'skipped', reason: 'baseline' }` — `Proof` gained the optional `reason`
field, additively, so `{status:'skipped'}` from `generate --no-prove` still parses. One correction to
design/11 §1.9's "`ddl.ts`'s create path against an **empty** IR": the null IR is not what a fresh
database looks like — a fresh one already has `public` — so a baseline whose `from.fingerprint` was
the null hash could never pass its own fingerprint gate, and `verify`'s replay-from-empty would fail
on the very first file. The "from" IR is therefore the current IR restricted to the schemas whose OID
`initdb` assigned (`pg_namespace.oid < 16384`), which is `public` and is asked of the server rather
than hard-coded. `test/runner/baseline.test.ts` proves the property design/11 §1.9 actually wants:
baseline an adopted database, apply the written file to a *different, empty* one, and the two
fingerprints are equal.

### 6.4 AS BUILT · 2026-08-28 (design/11 K2b) — the author-side commands

> **Superseded in part on 2026-08-29 by §6.5 (design/12 K4): it is now TWELVE of twelve.**
> The flag table below is still current for the ten commands it covers, except `verify
> --from-checkpoint`, which is built.

Ten of §6.2's twelve commands ship. `pg-prime migrate --help` lists all ten; `checkpoint`
and `db seed` are still under "Not in this release" with K4 named beside them.

**Flags, per command. `built` means the flag does what §6.2 says it does.**

| Command | §6.2 flags built | Not built, and why |
|---|---|---|
| `generate` | `--name` `--interactive` `--hints-file` `--allow-data-loss` `--shadow <url\|createdb\|temp-schema\|none>` `--offline` `--no-safe-rewrite` `--no-prove` `--empty` `--data` `--output json` | `--shadow docker` — a typed refusal naming the alternatives; testcontainers is a dependency design/08 §1.1's budget does not have. `--offline` / `--shadow none` reach the ladder and get `OfflineShadowError`'s sentence (exit 1), which is tier 4's documented state |
| `apply` | all of §6.2's, plus K1's `--applied-from` and `--heartbeat` | — |
| `status` | `--verify-fingerprint` `--stale-lock-after` | — |
| `check` | `--shadow` `--strict-unmodeled` `--no-schema` | — |
| `verify` | `--to` `--shadow <url>` `--keep` `--against schema\|target` | `--from-checkpoint` — **refused with a sentence**, not ignored: `migrate checkpoint` does not exist, so there is no checkpoint to replay from and a flag that silently dropped its argument would report a partial replay as a full one |
| `lint` | `[<file>…]` `--fail-on error\|warn\|off` `--rules` `--format text\|json` `--style` `--all` | `--format sarif` — refused with a sentence. §8 puts SARIF in v1.1; emitting JSON under the `sarif` name would break the GitHub code-scanning upload it exists for, at the point where nobody is looking |
| `baseline` | `--at` `--force` `--by` | — |
| `push` | `--dev` `--allow-data-loss` `--prod-pattern` `--dry-run` `--shadow` | — |
| `doctor` | `--stale-lock-after` | — |
| `unlock` | `--force` `--stale-lock-after` | — |

**Statuses and exit codes, as the envelope reports them.**

| Command | `status` values | Exit |
|---|---|---|
| `generate` | `generated` · `up_to_date` · `dry_run` · `missing_hints` · `hazards` · `proof_failed` · `refused` | 0 · 0 · 0 · **2** · **3** · **7** · 1 |
| `check` | `ok` · `missing_hints` · `lint` · `drift` · `pending` · `error` | 0 · 2 · 3 · 4 · 5 · 1 |
| `verify` | `verified` · `replayed` · `drift` · `replay_failed` · `unavailable` · `refused` | 0 · 0 · 4 · 1 · 1 · 1 |
| `lint` | `clean` · `failed` · `refused` | 0 · 3 · 1 |
| `push` | `pushed` · `up_to_date` · `dry_run` · `refused` · `failed` | 0 · 0 · 0 · 1 (2 when a decision is missing) · 1 |
| `doctor` | `healthy` · `findings` | 0 · 4 |

**`generate`'s split of 2 versus 3** is worth stating, because §6.2 lists both without
saying which is which. An unresolved **rename** or an unacknowledged **data loss** is
exit 2: a human has to record a decision in the repository. Any other error-severity
hazard (MF, TX, EN, a strict Tier-U census) is exit 3, the lint gate. Both write nothing.

**Four decisions §6.2 left open, taken here.**

- **`check`'s "would `generate` produce a non-empty diff?" is asked of the *pending files*,
  not of the database.** Immediately after `generate` and before `apply` the diff against
  the database is non-empty by construction, and reporting that as exit 4 ("you forgot to
  run generate") would make `check` fail in exactly the commit that added a migration. So
  the diff is only drift when it is **not** accounted for: when nothing is pending, or when
  the last pending file's `to.fingerprint` is not IR(desired)'s. With everything applied a
  non-empty diff means the database moved or the schema moved, and both are exit 4.
- **`check` is "no DB writes" in the history sense.** It never calls `ensureHistory`, never
  takes the lock and never records a row. It does provision a shadow, and on tier 3 that is
  a temp schema created and dropped inside the target — unavoidable, because normalising the
  desired state *is* the question. `--shadow <url>` keeps even that out of the target.
- **`verify --to <id>` exits 0, not 4, on a non-empty diff.** A `--to` replay stops early on
  purpose (§6.2: "for bisecting"), so its diff is expected to be non-empty and exiting 4 on
  it would make the flag useless. The deltas are printed either way; the envelope's `status`
  is `replayed` rather than `verified`, so the two questions are distinguishable.
- **`verify --against target`.** §6.2 compares the replay to IR(desired), which needs a
  TypeScript schema. A repository that has only `baseline`d an existing database has none,
  and design/11 §1.9's claim — "a baselined database is reproducible from the repo" — is
  precisely the comparison against the live target. `--against` selects; it defaults to
  `schema`, or to `target` when the config names no `schema`. This is what the third-party
  corpus gate (`01` §11.6 #5) runs.

**`verify` needs a real ephemeral database and says so.** §10.2: it fails rather than
skipping. Tier 2 (`CREATE DATABASE`) by default, `--shadow <url>` otherwise; a temp schema
is explicitly refused, because the replayed migrations name their own schemas and would
collide with the live ones. IR(desired) is then normalised in temp schemas *inside* that
ephemeral database, so the command needs exactly one database however restricted the role.

**`push --dev`'s four refusals** are all evaluated before a statement is issued: no `--dev`;
`PG_PRIME_ENV=production` or `production: true`; `--prod-pattern` (default
`prod|production|live`, matched case-insensitively against `host:port/database`); and any
row in `pgprime.migrations` that is not `baselined`. The banner is ANSI red on a TTY and
`!!! … !!!` otherwise — a CI log full of escape codes helps nobody. `--allow-data-loss` is
a flag and only a flag: nothing about the acknowledgement is written down, so nothing can
remember it.

**Tier R is wired into `apply` and `status`** (design/11 K1's open item b):
`createRepeatablesPass()` replaces `NO_REPEATABLES`, so `status.repeatables.drift` is the
real answer and `passImplemented` is true. `generate` loads every `sql/` file into the
shadow beside the desired schema (§3.8), which is how a view over a to-be-dropped column
becomes an author-time refusal (`repeatable_failed`) instead of an apply-time failure.

**`Plan` gained two fields** (design/11 K1's open item a, and §4.3's `repeatables`):
`schemas` — the managed set — and `repeatables`. `apply` refuses a set it was not generated
for and names both sides, instead of failing the fingerprint gate with a message about
hashes for what is really a `--schema` flag.

**`status` reports catalog drift only under `--verify-fingerprint`.** The fast path reads
`fingerprint_to` off the last applied row, which is a statement about what the runner did
rather than about what the database now contains; drift is only visible when `status`
actually re-extracts. It then exits 4, with `fingerprintDrift: true` and both values in the
envelope.

---

### 6.5 AS BUILT · 2026-08-29 (design/12 K4) — twelve of twelve, plus `pull`

`pg-prime --help` lists every command in §6.2 and there is no "Not in this release" section
left. **Thirteen rows**, and the arithmetic is worth stating because design/12 §3 K4 gets it
slightly wrong: §6.2's twelve are the ten design/11 K2b shipped plus `checkpoint` and
`db seed`, so §6.2's *twelfth* is `db seed`, not `pull`. `pull` is a thirteenth command that
§6.2 never listed — it is specified by `00` decision 5 ("`pull` annotates legacy views with
their real `securityInvoker`") and by design/12 §3 K4 item 4, and it is built here.

The three that landed:

| Command | Spelling | `status` values | Exit |
|---|---|---|---|
| `migrate checkpoint` | `migrate checkpoint [--seq n] [--by name] [--dry-run]` | `written` · `dry_run` · `refused` | 0 · 0 · 1 |
| `db seed` | `db seed [--set name]… [--force] [--prod-pattern re] [--seeds dir] [--list]` | `seeded` · `nothing_to_do` · `listed` · `refused` · `failed` | 0 · 0 · 0 · 1 · 1 |
| `pull` | `pull [--out file] [--sql-dir dir] [--no-sql-dir] [--dry-run]` | `written` · `dry_run` · `refused` · `error` | 0 · 0 · 1 · 1 |

**`db seed` and `pull` are their own verbs, not `migrate` ones.** §6.2 already spells the
first `db seed`; `pull` joins it on the same rule. Neither writes a migration — `db seed`
records nothing at all and `pull` reads a database and writes TypeScript — so hanging them
off the `migrate` noun would say something untrue about both. `src/cli/main.ts` grew a noun
table (`migrate`, `db`, and bare commands) and routes one token deep.

**`verify --from-checkpoint` is built** and replaces the refusal K2b recorded. It defaults
**off** (`ApplyPendingOptions.checkpoints: "ignore"`), which is a decision rather than a
detail: §6.2 defines `verify` as "replay every migration from empty", and `verify` always
replays into a *fresh* ephemeral database — precisely the condition §4.5's jump fires on. On
`auto` every `verify` in a repository that had ever taken a checkpoint would silently become
a partial replay reported as a full one, which is the exact failure the old blanket refusal
existed to prevent. The flag turns the jump on and the envelope carries `fromCheckpoint`.
`--from-checkpoint` with no `NNNN_checkpoint.sql` on disk is still refused, for the same
reason: a flag that silently did nothing would report a full replay as a checkpoint one.

**`checkpoints: "ignore"` is the EXISTING-database rule applied unconditionally**, not
"pretend the files are not there". A checkpoint's `from.fingerprint` is a fresh database's,
so running one after the history it stands in for has already been applied fails its own
gate; ignoring a checkpoint therefore means recording it `superseded`, always. A linear
replay of `0000 → 0001 → 0002_checkpoint → 0003` is `0000 → 0001 → 0003`.

**`superseded` is a SETTLED status.** §4.4 reserves the value and §4.5 says an existing
database "ignores checkpoints entirely"; ignoring them is *recorded*, because a file left
"pending" would make `status` exit 5 for ever on a fully-applied repository and `check` — the
CI gate — fail on every commit after a checkpoint landed, and a file left *absent* would make
§5.1 step 5's "applied file missing from disk" check unable to tell a jumped file from a
deleted one. The rows carry `statements_applied = 0`, which is the truth. The same value
covers both directions: the files a fresh database jumped over, and the checkpoint an
existing database skipped.

**Two flags beyond §6.2's list**, both because a test needed a deterministic value and both
useful: `db seed --list` (print what would run, run nothing) and `pull --no-sql-dir` (report
every Tier-R object as unsupported instead of writing it). `migrate checkpoint --dry-run`
prints the `.sql` and writes nothing.

**`migrate checkpoint` is read-only against the database.** It introspects, writes three
files, and records nothing: the `pgprime.checkpoints` row is written by `apply`, when a fresh
database actually jumps to one. A checkpoint that was written but never applied anywhere has
no business claiming a row.

---

## 7. Data migrations and seeding — the v1 story

**Three lanes, deliberately separate.** Bytebase's 2026 verdict, which every source in the research
corroborates: *declarative for ordinary table and column edits, versioned scripts for the backfills
a diff cannot express.*

### Lane 1 — DDL (generated). §3.

### Lane 2 — Data migrations (hand-written, in the same ordered history)

`migrate generate --data --name backfill_country` scaffolds:

```sql
-- pg-orm:migration 0008_backfill_country
-- pg-orm:data
-- pg-orm:txmode none
-- pg-orm:batch  size=1000 pause=100ms max-replica-lag=10s

-- pg-orm:stmt 0 idempotent
UPDATE users SET country = 'US'
WHERE id IN (SELECT id FROM users WHERE country IS NULL ORDER BY id LIMIT 1000);
```

The `-- pg-orm:batch` directive is **interpreted by the runner**, and this is the one place we add
real machinery rather than a template:

- Re-execute the statement until it reports **0 rows affected**.
- `pause` between iterations.
- Before each iteration, check `pg_last_wal_replay_lsn()` lag against `max-replica-lag` on
  configured replicas and **pause automatically** while lag exceeds the threshold.
- Persist `{ rows_done, watermark }` to `pg_orm.data_progress` after each batch, so a killed
  backfill resumes where it stopped rather than restarting.
- Each batch is its own transaction — never one long-running `UPDATE` holding locks for an hour.

This makes the single most common production migration task (batched, resumable, lag-aware
backfill) a **first-class, ~120-line runner feature** rather than a documentation page. Prisma,
Drizzle, and MikroORM all have literally nothing here; Prisma has three open issues asking for it.

Data migrations are ordered with DDL migrations in one history, so `0007` (add nullable column) →
`0008` (backfill) → `0009` (`SET NOT NULL`) is expressible and reviewable — which is exactly the
expand/contract shape.

**Never inlined into a DDL migration.** The lock-safe rewriter emits a `TODO` backfill *stub* and
tells you to generate a data migration; it does not silently put a large `UPDATE` inside a
transactional DDL file.

### Lane 3 — Seeding (not in migration history)

`seeds/*.sql` and `seeds/*.ts`, environment-scoped (`db seed --set demo`), re-runnable, expected to
be idempotent (`ON CONFLICT DO NOTHING`). Never recorded in `pg_orm.migrations`. Refuses on a
production-tagged environment without `--force`. `.ts` seeds get the typed query builder, because
that is the whole point of having one.

---

### 7.1 AS BUILT · 2026-08-29 (design/12 K4)

Both lanes ship. `src/data/{batch,lag}.ts` is the runner; `src/seed/{run,db}.ts` is lane 3.

**Lane 2 — the batch runner.** `-- pg-prime:batch size=<n> pause=<dur> max-replica-lag=<dur>`
is parsed in `runner/files.ts` and refused outside `txmode none` (a batch is one transaction
*per iteration*, which `transactional` cannot express and which inverts the "never one long
UPDATE holding locks for an hour" property the lane exists for). A malformed value is an error
diagnostic, never a silent default. Every statement of the file is re-executed until it reports
zero rows; a statement whose command tag carries no row count runs exactly once.

Five things §7 states as behaviour and leaves open as mechanism, decided here.

1. **The batch state reaches the statement as two GUCs, not as bind parameters.** §4.2 says the
   `.sql` is the executable artifact and "runnable by `psql` if our tooling ever fails", and a
   file full of `$1`s is not. `current_setting('pgprime.batch_size')` and
   `current_setting('pgprime.watermark', true)` are ordinary SQL; they are written with
   `set_config($1,$2,true)` so nothing is interpolated into DDL, and under `psql` they simply
   default — `current_setting(…, true)` is NULL for an unset name, which the template's
   `nullif(…, '')` guard reads as "start at the beginning".
2. **The statement reports its own progress, in its own result.** A batch statement may end
   `SELECT count(*) AS rows_done, max(id)::text AS watermark FROM updated`, and the runner reads
   those two columns. When it does not, the **command tag's row count** is used — exactly §7's
   shape — and the watermark stays null. The runner never parses the SQL to guess a key column:
   the key is a property of the author's table, and a tool that guessed would guess wrong on the
   first composite one.
3. **`pgprime.data_progress` is written INSIDE the batch's transaction.** §7 says "persist …
   after each batch"; doing it in the same transaction is strictly stronger and, unlike §5.4's
   DDL, actually available here, because a data migration's work is ordinary DML. A SIGKILL
   therefore cannot lose a committed batch's watermark and cannot record one whose rows rolled
   back — which is what makes "resumes from its watermark, never restarts" an invariant rather
   than a likelihood. The `watermark` jsonb holds `{ formatVersion, statement, iterations,
   values, done }`, where `values` is keyed by statement index and holds the **text the
   statement itself reported**: the runner cannot know whether the key is a `bigint`, a `uuid`
   or a `(tenant, created_at)` pair, so it carries the token opaquely and hands it back through
   the GUC.
4. **A statement that reports rows without moving its watermark for three consecutive batches
   is a FAILURE**, named with the stuck watermark. An unbounded loop is the one way a batch
   runner can wedge a deploy with nothing to act on, and a watermark that does not move while
   rows keep coming back is the signature of a predicate that does not narrow.
   `max-iterations=<n>` on the directive bounds the statements that report no watermark.
5. **The lag wait is unbounded.** §7 says "pause automatically while lag exceeds the threshold".
   A ceiling that gave up after N minutes and ran the batch anyway would be a ceiling that does
   not hold; one that failed the migration would turn a temporary replica hiccup into a failed
   deploy needing a manual resume — while the resume is already free, because the watermark is
   committed. An operator who wants it to stop kills the process.

**The lag reading is design/12 decision 13.** Primary-side by default:
`pg_stat_replication.replay_lag` on the connection the migration already holds — no replica
URLs, no second credential, and the number an operator already watches. `replicas: [url]` in the
config is the explicit opt-in that queries `pg_last_wal_replay_lsn()` on each, which is §7's
literal shape; a replica that cannot be reached contributes infinite lag rather than zero,
because silently proceeding past a replica we cannot see is the failure the ceiling exists to
prevent. **No visible replica is a no-op plus exactly one `info` line** — said once per run, not
once per batch, and it names both `pg_monitor` and the `replicas` key.

**The stub `generate` writes is now a working template.** §3.5 row 7's backfill file carries two
statements: `stmt 0` is the `RAISE EXCEPTION` guard, marked `non-idempotent` so `migrate lint`
reports TX201 on it and `apply` stops; `stmt 1` is the real **keyset** batch. Deleting the guard
and renumbering is the whole edit, and forgetting the renumber is a `stmt_marker_out_of_order`
error rather than a silent misordering. The template picks keyset over §7's own `WHERE id IN
(SELECT … LIMIT n)` example deliberately: that form has no watermark, so every iteration
re-scans from the start of the table, N rows in batches of n cost O(N²/n) row reads, each batch
is slower than the last, and after a crash there is nothing to resume from. Both forms run; the
template writes the better one.

**`status` shows a running backfill.** Every `pgprime.data_progress` row is reported with the
state of the migration it belongs to, and `apply` reports `rowsDone` / `iterations` / `resumed`
per file.

**Lane 3 — seeding.** `db seed` is a top-level verb. Four decisions §7 leaves open:

- **A set is a subdirectory.** `seeds/*.{sql,ts}` is the base set and runs on every `db seed`;
  `seeds/<name>/**` runs only when `--set <name>` asks for it, and `--set` is repeatable.
  Subdirectories rather than a filename suffix, because the walk is then the one
  `scanRepeatables` already uses — directory-lexicographic, files and directories in ONE sort.
  A `--set` naming a directory that does not exist is an **error** listing the sets on disk: a
  typo that silently seeded nothing is the worst possible outcome for a command whose entire job
  is side effects.
- **Nothing is recorded, and the history schema is never created.** Stronger than "no row": a
  seeded dev database that has never been migrated must not acquire a `pgprime` schema as a side
  effect, or `migrate baseline` refuses it afterwards.
- **One transaction per FILE**, not one per run. A run that half-applies is bad; a run that
  rolls back nine good seeds because the tenth has a typo is worse, because seeds are
  re-runnable by construction. The report names the file that failed and the ones after it.
- **The production refusal is `push --dev`'s, verbatim** — `PG_PRIME_ENV=production`,
  `production: true`, or `--prod-pattern` (default `prod|production|live`, matched
  case-insensitively against `host:port/database`) — evaluated before a statement is issued.

**A `.ts` seed gets a real `Db`** (design/12 decision 12): `export default async ({ db, set, env
}) => …`, where `db` is the transaction handle, so `db.insertInto(db.h.users)` is the typed
builder and the file's writes are atomic by the same mechanism the user's own code would use. It
is built through **one dynamic `import("pg-prime")`** in `src/seed/db.ts` — the only runtime use
of the peer anywhere in the kit, allowed because it is dynamic (the package still loads with no
peer installed), on the `db seed` path only, and resolved from the project, so the seed gets the
user's own copy of the DSL rather than a second one with different `Symbol.for` slots.
design/11 §1.3's grep guard is amended to budget exactly that site, by file and by form: a
static import there still fails the test.

---

## 8. v1 cut line

**v1 (ships):** IR + fact base · Tier M diffing · Tier R repeatables (functions, views, matviews,
triggers, **RLS policies**) · Tier O observation · Tier U diagnostics · 4-tier shadow ladder ·
`renamedFrom` + structural candidates + `missing_hints` · 35 lint rules · lock-safe rewriting ·
per-statement timeouts with CIC/VALIDATE exemption · `.sql` + `.plan.json` · fingerprint gate ·
runner with session lock + lease + pooler detection · `txmode none` with resume · TX201 idempotence
invariant · **mandatory proof-before-write** · `generate` `apply` `status` `check` `verify` `lint`
`baseline` `checkpoint` `push --dev` `doctor` `unlock` · batched/resumable data migrations · seeding
· up-only.

**v1.1:** promote views/functions/triggers/policies from Tier R to Tier M (diffed) once the native
backend proves out · import from drizzle-kit and Prisma migration directories · `--format sarif`
everywhere · optional `down` for the dev loop only.

**v2:** native `DiffBackend` at parity, pg-delta demoted to test oracle · Tier O promotion opt-in
per kind (grants, roles, publications) · partitions beyond "don't touch what we didn't create" ·
`--format pgroll` export for expand/contract · PG 19 `REPACK CONCURRENTLY` for type changes ·
multi-schema / multi-tenant fan-out.

**Non-goals, permanently:** multi-database support · a GUI/approval/governance layer · online
schema-change infrastructure (integrate pgroll, don't rebuild it) · PostgreSQL < 15 ·
down migrations as a production mechanism.

---

## 9. Alternatives rejected

| Rejected | Reason |
|---|---|
| **Write our own diff engine for v1** | 33 object kinds of introspection + rendering + topological ordering is 6–12 months, and it is the least differentiating part of the product. Deferred to v2 behind the same port, grown incrementally, validated by differential testing. |
| **Fork pg-delta** | A fork of a package that had a total clean-room API rewrite five days ago and ships ~5 releases a week inherits every upstream fix as a manual merge. The port costs ~400 LOC; the fork costs a permanent maintenance lane. |
| **Vendor pg-delta's source** | 61,896 LOC of someone else's alpha in our repo, with their `debug`/`pg` deps anyway, and no upstream fixes. Worst of both. |
| **Reference-only (read it, write our own)** | This was the tempting answer, and it is wrong for v1 for the reason above. We *do* take the ideas (fact base, identity-free payloads, three-valued transactionality, catalog completeness, proof loop) — but taking the ideas and the code costs less than taking only the ideas. |
| **Shell out to Atlas** | Views, matviews, functions, procedures, triggers, sequences, domains, extensions, roles and permissions are **Atlas Pro** — a login and ~$9/seat/month. A minimal-dependency OSS ORM cannot require users to authenticate to a vendor to manage a trigger. |
| **Shell out to migra / migradiff** | Upstream `djrobstep/migra` is archived; the fork is young; it is a **Python runtime dependency** for a TypeScript ORM. |
| **Shell out to stripe/pg-schema-diff** | No functions, no triggers, no most custom types, renames are always drop+add. Excellent hazard model and plan-validation idea — both taken as design references. Go binary. |
| **Shell out to pgschema** | Explicitly does not support RENAME, extensions, schemas, roles, publications. Its fingerprinted-plan artifact is taken as a design reference. Go binary. |
| **`pg_dump --schema-only` as source of truth** | No stable object ordering between runs, whitespace-sensitive in function bodies, produces a text diff rather than a structured change list, and can emit an order that fails to replay on a clean database. |
| **`information_schema` for introspection** | Cannot represent RLS, partitions, exclusion constraints, `NOT VALID` state, or generated columns; materially slower; incomplete. Portability is worth exactly nothing to a PG-only tool. |
| **Parse-only / AST diffing (no shadow DB)** | Requires reimplementing PostgreSQL's canonicalization. Every tool that tried has phantom diffs. The shadow DB gets normalization for free *and* proves the desired schema is legal. |
| **Per-migration full JSON snapshots (drizzle)** | 11k-line files, guaranteed merge conflicts on any team with concurrent branches, a `_journal.json` id chain that desyncs and needs manual git surgery. Replaced by fingerprints + periodic checkpoints. |
| **A mutable `_journal.json` ordering file** | Same desync failure mode. Ordering is derived from filenames on disk; duplicate sequence numbers are legal and merge cleanly. |
| **`pg_advisory_xact_lock`** | Cannot cover `txmode none` files, which have no enclosing transaction. Replaced by session lock + heartbeat lease + active pooler detection. |
| **A fixed advisory-lock key (Kysely)** | Two unrelated schemas in one database serialize against each other. Key is derived from database + managed schema set. |
| **All pending migrations in one transaction (drizzle)** | Holds every ACCESS EXCLUSIVE lock taken anywhere until the final COMMIT, and makes `CREATE INDEX CONCURRENTLY` impossible. Per-file transactions. |
| **Down migrations** | A down migration cannot restore dropped data, so it is a lie in exactly the case you would most want it. Prisma, graphile-migrate, pgmigrate and drizzle all landed on roll-forward. Real rollback is expand/contract, compensating migrations, PITR, or blue-green. |
| **Interactive prompts as the rename mechanism** | Wrong interface for CI, monorepos and agents; drizzle's bug list is the evidence. Prompts exist only to *write the annotation*. |
| **Heuristic rename detection** | A false positive is a silent data-loss bug. Structural candidates are advisory input to a human decision, never authority. |
| **`push` as a production path** | Bypasses history, silently drops columns. Dev-only, requires an explicit `--dev` flag, and refuses against any database under versioned management. |
| **Auto-migrate on app startup** | ~10 surveyed OSS projects do it and it is why advisory-lock bugs are endemic. We support it (the lock is correct) but document the dedicated-Job topology as the recommendation. |

---

## 10. Resolutions

1. **Pin policy for pg-delta** — moot. pg-delta is no longer a dependency in any form (removed
   2026-08-25); the corpus is now checked by the D10 `pg_dump` witness, which is versioned with
   PostgreSQL itself rather than with an alpha on a five-releases-a-week cadence.
2. **Does `verify` require Docker in CI?** Docker-preferred with an explicit `SHADOW_DATABASE_URL`
   fallback, and `verify` **fails** rather than silently skipping when neither is available. The
   same rule now governs the D10 witness, with one deliberate exception: an unavailable `pg_dump`
   reports `skipped`, because a missing client binary is an environment gap rather than evidence
   about the plan.
3. **Tier R vs Tier M for views.** Views stay in **Tier R** for v1. The shadow load catches a view
   referencing a dropped column either way; moving views to Tier M buys better error attribution,
   not correctness, and it costs the differ its cheapest simplification. Revisit when Tier R ships
   and we can measure how often the apply-time error is the confusing one.
