# 11 — Migration Kit: the v1 loop. Implementation & Test Plan

**Date:** 2026-08-28
**Status:** PLAN. Sequenced workstreams with per-workstream test contracts and exit gates. Nothing here
re-opens a decision recorded in `05`/`06`/`08`; where the as-built code and a design section disagree,
the disagreement is named here and resolved in favour of the design unless a measurement says otherwise.
**Inputs:** `06-migrations.md` (IR, pipeline, hazards, file formats, runner, CLI, exit codes), `05-schema-api.md`
§2.3 / §5.1 / §7.2 (DDL-affecting modifiers, `renamedFrom`, the node contract), `08-architecture.md` §1.1 /
§4.4 / §7 (package split, migration-engine test strategy, layout), `01-features.md` §11.3 / §11.6 (what a real
app cannot live without; `verify` on three real third-party schemas gates 1.0), `09` §1 (rules R1–R13, which
apply here unchanged).

**Starting point (verified in-repo 2026-08-28, `a5f4f9a`):**

- `@pg-prime/kit` = `src/{catalog,db,diff,ir,plan,prove,runner,sql}` + `generate.ts`, 21 files, 125 tests
  green on PG 15/16/17/18 (nightly) — extract → IR → diff → ordered DDL → prove on a shadow clone (D6) →
  `pg_dump` witness (D10) → `applySegments`. **8 fact kinds** (`schema table column constraint index type
  enumLabel sequence`), 21 ordering phases, 22 of `06` §3.4's 35 hazard codes, NOT VALID + VALIDATE split
  and CIC rewriting present, `advisoryLockKey` / `acquireSessionLock` / `detectTransactionPooler` present.
- `generate()` takes **three connections** — `admin`, `target` (current) and `desired` (a database that
  already holds the desired state). There is no path from the TypeScript schema to `desired`: the DSL's
  runtime metadata (`TableRuntime`, `ColumnDdl`, `TableExtra`, `PgEnum`) is never read by the kit, and the
  kit does not depend on `pg-prime`.
- No CLI: no `bin`, no `src/cli`, no config loader, no history table, no `status`/`baseline`/`verify`.
- The DSL (`pg-prime/schema`) has 11 column types and 8 modifiers; **no `.references()`, `.check()`,
  `.renamedFrom()`, `.comment()`**, no `pgSchema`/`pgDomain`/`pgSequence`/`pgExtension`; extras are
  `primaryKey`, `index`/`uniqueIndex`, `comment`.
- `renderSql` still writes `-- pg-orm:` directives; the shadow prefix is already `pgprime_shadow_`.

---

## 0. At a glance

| WS | Deliverable | Primary oracle | Gate to leave | Round |
|---|---|---|---|---|
| K1 | **Runner + history + CLI core**: `pgprime` history schema, reconcile, fingerprint gate, `txmode none` resume, lease heartbeat, pooler refusal; `migrate apply / status / baseline / unlock`; config loader; JSON envelope + exit codes | A real server: every runner claim is a catalog assertion after the fact; crash-resume is exercised by killing the runner mid-file | `apply` from an empty database through the fixture corpus's plans, twice (second run is a no-op, exit 0); resume proven by a killed `txmode none` run; PgBouncer transaction mode refused with exit 1 and the right sentence | 1 |
| K2a | **DSL → desired state**: `pg-prime` gains `.references()`, `.check()`, `.renamedFrom()`, `.comment()` on columns, `renamedFrom`/`foreignKey`/`check`/`unique` extras, `pgSchema`; the kit gains `schema/emit.ts` (schema → DDL text) and the **shadow ladder tiers 1–3** (`--shadow url`, `CREATE DATABASE`, **temp schema in the target database**) | PostgreSQL: the emitted DDL loads, and the extracted IR round-trips — `emit(schema)` → load → extract → emit… converges in one step; the D10 witness on the temp-schema tier | A `pgTable` schema goes to a proven plan with **no `desired` database supplied**; tier 3 works with a role that has no `CREATEDB` | 1 |
| K3 | **Object-kind coverage + the two gaps + Tier R/O/U + lint**: `convalidated` on `'n'` rows, `ChooseConstraintName` collision suffix, `EXCLUDE`, `domain`, `composite`/`typeAttribute`, `comment`, `extension` (declare-only), partitions (attach/detach, adopt-never-drop), `default` as its own fact; **Tier R repeatables** (`sql/`, hash, `pgprime.repeatables`); Tier O observation; Tier U census; the remaining 13 hazard codes; `nolint` directive; TX201 | `pg_dump` (D10) in **strict** mode on every new fixture — the witness is what catches a kind the IR is blind to | Every new kind has a corpus fixture that passes `strict`; `fixtures/diff/unmodeled` still fails as the negative control; hazard table in `06` §3.4 has no "not built" row | 1 |
| K2b | **The author-side commands**: `migrate generate` from config (K1 + K2a + K3), `check`, `verify` (replay from empty on an ephemeral database → extract → diff vs IR(desired) → empty), `lint`, `push --dev`, `doctor`, `--interactive` rename prompts that *write annotations* | `verify` itself, run on three real third-party schemas (Pagila, AdventureWorks-PG, Northwind-PG — all plain-SQL, permissive licences) committed under `fixtures/corpus/` | `01` §11.6 #5: `verify` green on the three schemas; the full loop `edit schema → generate → apply → status` runs in CI against PG 17 and through PgBouncer | 2 |
| K4 | Data migrations (`--data`, `-- pg-prime:batch` runner), seeding, checkpoints, `pull` (introspect → TS schema file, deterministic) | Replay: `pull` → `generate` against the same database → **empty diff** | `pull` on the three corpus schemas produces a schema whose `generate` is empty | 2 |

Critical path: **K1 ∥ K2a ∥ K3 → K2b → K4.** Round 1 is three agents on disjoint files (see §3); round 2
integrates. The CLI's `bin` is created in K1 with `apply/status/baseline/unlock` and grows in K2b.

---

## 1. Decisions taken here (recorded so agents do not re-derive them)

1. **Naming.** History schema **`pgprime`** (tables `migrations`, `repeatables`, `checkpoints`, `lock`,
   `data_progress` exactly as `06` §4.4, with `pgprime` substituted for `pg_orm`); directives **`-- pg-prime:`**
   (replacing `-- pg-orm:` in `renderSql` *now*, before any file exists outside the repo); config file
   **`pg-prime.config.ts`**; env **`PG_PRIME_ENV=production`** for the production tag (`06` §6.2 `push`).
   Per the rename record: `pgPrime` / `PG_PRIME_` / `pgprime_` per layer, never `pg_prime_`.
2. **`defineConfig` lives in `@pg-prime/kit`, not `pg-prime/config`** (diverges from `05` §6.1). The config
   describes the *kit's* inputs (migrations dir, shadow strategy, db url); the runtime package must not know
   the CLI's option surface. This is drizzle-kit's model (`defineConfig` from `drizzle-kit`).
3. **The kit depends on `pg-prime` as a `peerDependency`** (`"pg-prime": ">=0.0.0"` while both are `0.x`;
   same-major once released) and imports **types only** (`import type { TableRuntime, … } from 'pg-prime'`).
   The user's config imports their own `pg-prime`; the kit reads the runtime metadata structurally. No value
   import from `pg-prime` in `packages/pg-prime-kit/src` — a lint-grade grep in the kit's tests enforces it,
   and `tools/check-dts.mjs`'s external-specifier list for the kit becomes `pg, pg-prime`.
4. **Config loading uses Node's native type stripping.** `pg-prime.config.ts` is `import()`ed; on Node
   < 22.18 (where stripping is not on by default) the CLI re-executes itself once with
   `--experimental-strip-types` (guarded by an env marker), and if that also fails it prints one sentence
   naming the Node version and the `.mjs` alternative. No `jiti`/`tsx` dependency.
5. **DDL emission lives in the kit** (`src/schema/emit.ts`), not in `pg-prime`. It is an author-time concern
   and `08` §1.1's split puts every author-time byte in the kit. `pg-prime` gains only the DSL surface and
   its runtime metadata; `05` §7.2's `schema.$ir()` is **not** built — the kit derives the desired IR by
   loading the emitted DDL into the shadow and extracting, exactly as `06` §3's diagram says (`desired SQL
   text → [shadow DB] → extract → IR(desired)`). One extractor, one IR, no second modelling of PostgreSQL.
6. **Shadow tier 3 (temp schema) rewrites `search_path`, not the SQL.** The emitter always produces
   schema-qualified DDL for user objects; for tier 3 the kit emits into `pgprime_shadow_<rand>` by
   *renaming the schema identifiers at emit time* (the emitter takes a schema-map), and the extractor is
   pointed at the shadow schema with the map reversed. Cross-schema FKs and enums follow the same map.
   Objects the map cannot express (extensions with fixed schemas, roles) degrade to a Tier-O diagnostic —
   `06` §3.2's stated constraint.
7. **`.references()` is single-column and takes a thunk** — `.references(() => orgs.id, { onDelete })` —
   because the target table is usually declared later in the same file. FK *inference* for relations
   (`09` §3.5's open gap) reads the same metadata and lands in K2b, not here.
8. **`renamedFrom` fires iff old exists and new does not** (`05` §5.1), evaluated against the **current**
   IR by K2b's `generate`; the kit's existing `RenameHint[]` is the carrier, so `--hints-file` and the
   annotation are one mechanism with two spellings.
9. **Baseline writes a real migration.** `0000_baseline.sql` + `.plan.json` contain the full current schema
   as DDL (through the emitter of the *extracted* IR — `ddl.ts`'s create path against an empty IR), the
   history row is `status='baselined'`, and `verify` replays it like any other file. A baselined database
   is therefore reproducible from the repo, which is the adoption property `01` §11.3 asks for.
10. **Third-party corpus.** `fixtures/corpus/{pagila,adventureworks,northwind}/schema.sql`, fetched once,
    committed with their licence files, trimmed to schema-only DDL. These are the `verify` gate of
    `01` §11.6 #5. Fetching and trimming is K2b's first task and is scripted (`tools/corpus-fetch.mjs`) so
    the provenance is reproducible.

---

## 2. Test rules

`09` §1's R1–R13 apply verbatim. Four additions for this subsystem:

**R14 — The catalog is the oracle for the runner.** A runner test never asserts on the runner's own report
alone; it re-reads `pg_catalog` and `pgprime.migrations` after the fact and asserts both. "Applied" means
the object exists *and* the row says so, in the same test.

**R15 — Crash-resume is tested by killing, not by mocking.** The `txmode none` resume test spawns the
runner as a child process, waits for `statement_uncertain` to be non-null in `pgprime.migrations`, kills
it with SIGKILL, and re-runs `apply`. The assertion is on the catalog (the CIC's index is valid) and on
the row (`statements_applied = total`, `status = 'applied'`).

**R16 — Every new fact kind ships with a `strict` witness fixture and a mutation.** The fixture is a
`current.sql`/`desired.sql` pair in `fixtures/diff/<kind>`; the D10 witness runs in `strict`; the R10
record names the extractor/differ line that was blinded and shows the witness catching it.

**R17 — CLI tests go through `bin`, not through the command functions.** A CLI test spawns
`node dist/cli.js …` (built) or `tsx`-free `node --experimental-strip-types src/cli.ts` and asserts the
exit code and the parsed `--output json` envelope. The envelope is a golden per command
(`test/cli/golden/<command>.<case>.json`), with volatile fields (`at`, `durationMs`, hostnames) masked by
a documented list, never by a regex over the whole document.

---

## 3. Workstreams — round 1 (parallel, disjoint files)

### K1 — Runner, history, CLI core

**Owns:** `packages/pg-prime-kit/src/{runner/*,history/*,cli/*,config/*}`, `src/plan/plan.ts` `renderSql`
(directive rename only), `package.json` (`bin`, `exports` for `./config` if needed), `test/{runner,cli}/**`.
Must not touch `src/{catalog,diff,ir,prove,schema}` or `packages/pg-prime`.

**Build:**

1. `src/history/schema.ts` — `06` §4.4 DDL under `pgprime`, idempotent `ensureHistory(client)`; a
   version row so a later change to the tables is detectable (`pgprime.meta(key, value)`).
2. `src/runner/run.ts` — `06` §5.1 steps 1–9 as one function `applyPending(conn, dir, opts)`:
   dedicated connection (refuse a pool), `detectTransactionPooler` → exit 6-class error naming the direct
   port, `ensureHistory`, session lock (`advisoryLockKey`) + lease row with a 5 s heartbeat from the same
   connection, reconcile (missing file → exit 4; checksum drift → exit 4 / warn under `--dev`; live lease →
   exit 6; dead lease → resume), pre-flight sweep (INVALID indexes, NOT VALID constraints), per-file
   dispatch on `txmode` with the fingerprint gate (`from.fingerprint` vs last row's `fingerprint_to`; slow
   path re-extract with `--verify-fingerprint`), `txmode none` bookkeeping exactly as `06` §5.4
   (`statement_uncertain` before, `statements_applied` after, re-execute the uncertain one on resume),
   `55P03` retry with backoff (5 attempts), `40P01` one whole-file retry, `57014` no retry, repeatables
   pass as a stub interface K3 fills (`RepeatablesPass`), release. `--dry-run` prints the exact statement
   stream including `BEGIN`/`COMMIT` framing and `set_config` calls. `--to <id>`.
3. `src/runner/files.ts` — discover `NNNN_name.sql` + `.plan.json`, order by `(seq, name)`, duplicates
   legal, sha256 of the `.sql` bytes, parse `-- pg-prime:` directives and `-- pg-prime:stmt N` markers
   (fallback to `sql/statements.ts`'s splitter for hand-written files, with a diagnostic).
4. `src/cli/` — `bin` = `pg-prime` (name the binary after the product; `migrate` is the noun):
   `pg-prime migrate apply|status|baseline|unlock`, `--output json`, `--config <path>`, `06` §6.1 exit
   codes as a single `EXIT` table used by every command, `--help` per command. `status`: applied vs
   pending, current fingerprint (fast path), stale locks, partially-applied rows, repeatable drift (stub).
   `baseline`: refuse when `pgprime.migrations` is non-empty without `--force`; `--at <id>` marks an
   existing file applied; without `--at` extract → `0000_baseline.sql` + `.plan.json` via `ddl.ts`'s
   create path against an empty IR, proof stamped `{status:'skipped', reason:'baseline'}`, history row
   `baselined`, and the plan's `to.fingerprint` = the live fingerprint. `unlock`: inspect or `--force`.
5. `src/config/` — `defineConfig` (typed, returns the object), `loadConfig(path?)` per §1.4, URL parsing
   into `ConnInfo` (reuse `db/pg.ts`), `PG_PRIME_ENV`.

**Tests (tier 2, the kit has no other tier):** `test/runner/apply.test.ts` (R14: corpus plans applied
from empty, twice), `test/runner/resume.test.ts` (R15), `test/runner/lock.test.ts` (two runners: one wins,
one exits 0 after wait when nothing is pending; exits 6 when the winner is mid-run — use a `pg_sleep` in
a `txmode none` file), `test/runner/pooler.test.ts` (gated on `PG_PRIME_TEST_PGBOUNCER_URL`, exit-6-class
refusal through a real transaction-mode PgBouncer; CI has one), `test/runner/fingerprint.test.ts` (drift
→ exit 4, names the objects), `test/cli/*.test.ts` (R17 goldens for all four commands, incl. `--dry-run`).
R10 record with ≥ 6 mutations.

### K2a — DSL → desired state, and the shadow ladder

**Owns:** `packages/pg-prime/src/schema/**` (+ its tests, `tools/api-snapshot` regeneration, the stub),
`packages/pg-prime-kit/src/{schema/**,shadow/**}`, `test/{schema-emit,shadow}/**`, the kit's
`package.json` `peerDependencies`. Must not touch `src/{runner,cli,history,config,catalog,diff}` or
`generate.ts` (K2b wires it).

**Build:**

1. DSL additions (`05` §2.3 spellings, runtime metadata only where the type layer is untouched):
   `.references(() => col, { onDelete?, onUpdate?, name?, deferrable?, initiallyDeferred? })`,
   `.check(sql\`…\`, name?)`, `.unique(name?, { nullsNotDistinct? })` (extend the existing `.unique()`),
   `.comment(text)`, `.renamedFrom(old)`; extras `foreignKey({ columns, references: () => [cols], … })`,
   `check(name, sql)`, `unique(name).on(...)`, `renamedFrom(old)`; `pgSchema(name)` returning a
   `{ table: pgTable-bound-to-schema }` factory (`05` §3.1). Each is a `ColumnDdl` / `TableExtra` field —
   **no change to `Col<M>`'s meta parameter** (type budgets are gated; `bench:types` must not move by more
   than noise). `defineSchema` continues to accept tables only; enums are reachable through the columns
   that use them (`ColumnDdl.enumName/enumValues`) — an enum no column uses is not emitted, and that is
   documented. Regenerate `tools/api-snapshot` and the stubs; `pnpm package:check` stays green.
2. `packages/pg-prime-kit/src/schema/emit.ts` — `emitSchema(schema, { schemaMap? }) → { sql: string[],
   diagnostics }`: `CREATE SCHEMA`, `CREATE TYPE … AS ENUM`, `CREATE TABLE` with columns (type, NOT NULL,
   DEFAULT literal or `sql` fragment text, identity), single-column PK/UNIQUE/CHECK/FK inline as **named**
   constraints using the server's default names (`sql/ident.ts` already has `makeObjectName`), table-level
   PK/UNIQUE/CHECK/FK/EXCLUDE, indexes (`CREATE [UNIQUE] INDEX`), `COMMENT ON`. Emission order is
   dependency-correct (schemas → types → tables in FK order → indexes → comments); cycles use
   `ALTER TABLE … ADD CONSTRAINT` after all tables. Deterministic: sorted where order is not semantic.
3. `packages/pg-prime-kit/src/shadow/ladder.ts` — `provisionShadow(admin, target, opts) → { conn,
   schemaMap, tier, dispose }` implementing tiers 1–3 of `06` §3.2 with selection rules (`--shadow url` /
   `CREATEDB` probe / temp schema), locale copying for tier 2, the `55006` template guard, tier 3 as §1.6.
   Tier 4 (`--offline`) is a typed refusal in this round.
4. `loadDesired(schema, shadow) → SchemaIR` — emit → run → `extractCatalog` on the shadow with the map
   reversed. This is the function `generate` will call in K2b.

**Tests:** `packages/pg-prime/test/schema/*.test.ts` (each new modifier: runtime metadata + a type probe
that the meta parameter did not change; `bench:types` numbers in the result section), kit
`test/schema-emit/roundtrip.test.ts` (R1: emit → load → extract → **re-emit from the extracted IR through
`ddl.ts`** → load into a second database → both dump identically under D10 `strict`; every column
type, modifier and extra in the DSL appears in the fixture), `test/shadow/ladder.test.ts` (tier 2 with
`CREATEDB`; **tier 3 with a role created without `CREATEDB`** — the test creates that role; the schema map
round-trips names; cross-schema FK; `dispose` leaves nothing behind, asserted from `pg_namespace`).
R10 record with ≥ 6 mutations.

### K3 — Object-kind coverage, the two gaps, Tier R/O/U, lint

**Owns:** `packages/pg-prime-kit/src/{catalog,diff,ir,prove,sql}/**`, `src/repeatables/**`, `src/lint/**`,
`fixtures/diff/**`, `test/{catalog,corpus,ddl,enum,evolve,rename,roundtrip,schema,dump-oracle,
oracle-strict,plan-gates,ir,ident}.test.ts` and new `test/{kinds,repeatables,lint}/**`. Must not touch
`src/{runner,cli,history,config,schema,shadow}`, `generate.ts`, or `packages/pg-prime`.

**Build (each item = fact kind or payload field + extractor + differ + `ddl.ts` + order phase + fixture +
strict witness, R16):**

1. `convalidated` on `contype='n'` rows (PG 18; catalog-gated, not version-gated) — the AS BUILT gap in
   `06` §3.3; `NOT NULL … NOT VALID` + `VALIDATE` becomes the lock-safe path on 18 (`06` §3.5 row 4).
2. `ChooseConstraintName` collision suffix (`_1`, `_2`…) — port the server's rule so generated names match
   what PostgreSQL would pick; fixture with two same-column constraints.
3. `EXCLUDE` constraints; `domain` (+ CHECK, default, NOT NULL); composite types + `typeAttribute`;
   `comment` as its own fact on schema/table/column/type/index/constraint; `extension` declare-only
   (created if absent, never dropped, member objects projected out via `pg_depend` `e` edges);
   partitions: parents/partitions as tables with `partitionOf`/bounds, `ATTACH`/`DETACH`, undeclared
   partitions never enter the drop set; column `default` as a fact of its own so a default change is not a
   column change (`05` §7.2's `default` kind).
4. Tier R — `src/repeatables/`: scan `sql/**/*.sql` (directory-lexicographic), sha256, `-- pg-prime:`
   header directives, TX201 idempotence check per file, `RepeatablesPass` implementation (K1's interface:
   `plan(dir, appliedHashes) → [{path, sha256, statements}]`, applied in one transaction after versioned
   files), loading into the shadow during generate (K2b calls it).
5. Tier O observation (roles, memberships, ACLs, default privileges, publications, subscriptions, FDW,
   event triggers, collations, aggregates): extracted as `observed` facts that never enter the diff, and
   reported. Tier U census: the existing `unmodeled_kind` diagnostic extended to the full `06` §2.2 list
   with `--strict-unmodeled` plumbing (a flag on `diffIR`/`buildPlan`, the CLI switch is K2b's).
6. Hazards: the 13 missing codes (`DS105`, `MF102`, `MF106`, `LK103`, `LK105`, `LK106`, `LK109` with the
   `provolatile` check, `LK111`, `TX101`, `TX102`, `TX201`, `ST101–106` as opt-in), the emptiness probe for
   MF rules, `-- pg-prime:nolint CODE "reason"` (reason mandatory), `src/lint/` as a pure function over
   `Plan` + file text so K2b's `migrate lint` is a thin command. Update `06` §3.4 with an AS BUILT table.

**Tests:** one `fixtures/diff/<kind>` pair per item with the corpus sweep in `strict`; `test/kinds/*`
unit tests on extractor payloads (R3-style: catalog value + IR value); `test/repeatables/*` (hash change →
re-applied, unchanged → skipped, non-idempotent → TX201); `test/lint/*` per code with a positive and a
negative control (R4). PG 18 container `pgprime-pg18` (:54332) for the `'n'` work; PG 17 for the rest.
R10 record with ≥ 8 mutations.

---

## 4. Round 2 (after K1/K2a/K3 merge)

**K2b** wires `generate` to `loadDesired` + `provisionShadow` + repeatables + rename annotations, adds
`check`, `verify`, `lint`, `push --dev`, `doctor`, `--interactive`, fetches the third-party corpus and
makes `verify` green on it; adds the end-to-end loop test to `ci.yml`'s `pg` job (through PgBouncer for
`apply`, which must *refuse*) and to `ci-nightly.yml`'s matrix. **K4** is data migrations, seeding,
checkpoints, `pull`. Both get their own brief when round 1 lands; their file ownership is everything
round 1 did not claim.

---

## 5. Definition of done — kit v1 loop

- [ ] `pg-prime migrate generate → apply → status` runs from a `pg-prime.config.ts` against PG 15–18, with
      no `desired` database and no `CREATEDB` (tier 3), and `apply` refuses PgBouncer transaction mode.
- [ ] `baseline` adopts an existing database; `verify` replays the repo from empty and reports an empty
      diff; both are `06` §6.2-exact in flags and exit codes.
- [ ] `06` §2.2 Tier M has no unimplemented kind; Tier R applies repeatables; Tier O is observed; Tier U is
      counted; `06` §3.4 has all 35 codes; `06` §3.5's rewrite table has no "not built" row.
- [ ] `verify` green on Pagila, AdventureWorks-PG and Northwind-PG (`01` §11.6 #5).
- [ ] The crash-resume test (R15) and the concurrent-deploy test exist and pass on every PR.
- [ ] `pnpm package:check` green with the kit's `bin`, `peerDependencies` on `pg-prime`, and the api
      snapshot regenerated; `06`, `05` §2.3/§6.1 and `00-overview` carry AS BUILT notes with numbers.
- [ ] Each workstream's result section in this document has its R10 mutation record.

## 6. Risks and fallbacks

- **Type budgets.** K2a adds DSL modifiers; `bench:types` is gated. If a modifier needs a new meta slot,
  stop and measure — the fallback is runtime-only metadata with a `$`-free name and no type change.
- **Tier 3 and extensions.** A schema declaring an extension whose objects land in a fixed schema cannot be
  normalised in a temp schema; K2a degrades to a diagnostic and K2b's `generate` recommends tier 1/2.
- **Corpus licences.** Pagila (BSD), AdventureWorks (MIT, the PG port), Northwind (public domain / MIT
  ports). If a port's licence is unclear, replace it; three schemas is the gate, not those three.
- **Node type stripping.** If re-exec proves flaky, the fallback is documented: `pg-prime.config.mjs`.
