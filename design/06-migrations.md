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
injectable (`PGORM_PG_DUMP`, `PGORM_PG_DUMP_URI`) so a containerized server can be reached
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

### 4.5 Checkpoints

A checkpoint is a normal migration file tagged `-- pg-orm:checkpoint` containing the **full schema
DDL** at that point, plus `checkpoints/NNNN.ir.json`. A **fresh** database applies the newest
checkpoint and then everything after it; an **existing** database ignores checkpoints entirely and
continues linearly. Nothing is deleted. This is Atlas's model and it is strictly better than
destructive squashing — a 400-file directory stops costing CI 400 replays without losing history.

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
