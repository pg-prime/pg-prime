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

**K1 RESULT — 2026-08-28 · DONE.**

**Shipped.** 17 new source files, 3 512 lines (`src/history/{schema,store}.ts`,
`src/runner/{files,run,status}.ts`, `src/cli.ts`, `src/cli/{args,exit,main,output}.ts`,
`src/cli/commands/{apply,status,baseline,unlock}.ts`, `src/config/{define,load,index}.ts`), and
13 test files + 5 support files, 2 425 lines, under `test/{runner,cli}/`. Three existing files were
edited: `src/plan/plan.ts` (the `-- pg-orm:` → `-- pg-prime:` directive rename, and one additive
field — `Proof.reason`), `src/runner/apply.ts` (`ApplyError.sqlState`, the strict pooler probe, and
`setConfig`/`resetSessionGucs` exported for the `txmode none` path), and `src/index.ts` (the barrel:
**76 values / 64 types → 109 / 104**). Outside the kit: `tools/build-package.mjs` chmods `bin`
targets and asserts their shebang; `tools/pack-smoke.mjs` runs `pg-prime --help` out of the installed
tarball. Kit suite **125 → 202 tests, 28 files, 29.6 s** (tier 2, PG 17 + PgBouncer 1.25); the
built package is 153 files / 689.5 KB.

**Divergences, all recorded in `06` with the measurement that forced them:**

| # | Design says | Built | Why |
|---|---|---|---|
| 1 | §5.2's two-pid probe detects a transaction pooler | it does **not** on an idle pool; `detectTransactionPoolerStrict` pins a second server connection and forces the move | measured against PgBouncer 1.25 `pool_mode=transaction`: same pid twice |
| 2 | §3 K1 "exit 6-class" pooler refusal | exit **1** | §0's own gate row for K1 says exit 1, and §6.1 reserves 6 for a held lock |
| 3 | §5.2 heartbeat "from the same connection" | a second connection | `pg.Client` serialises; the beat would queue behind a whole `CREATE INDEX CONCURRENTLY`, and concurrent `query()` is removed in `pg@9` |
| 4 | §5.4 "re-execute `statement_uncertain`, then continue" | restart the file at 0 when `statement_uncertain` is set; resume at `statements_applied` when it is null | the `DROP INDEX CONCURRENTLY IF EXISTS` prefix §5.4 relies on is an *earlier* statement; TX201 makes the replay safe |
| 5 | §1.9 baseline diffs "against an empty IR" | against the IR of a *fresh database* (schemas with `pg_namespace.oid < 16384`) | the null IR matches no real database, so the baseline could never pass its own fingerprint gate on replay |
| 6 | §5.6 "message names the drifted objects" | names the migration, both fingerprints and the schema set | naming objects needs an expected-state IR; `06` §4.3 rejects a per-migration snapshot. Arrives with checkpoints (K4) |
| 7 | §6.2 `baseline --at <id>` "marks an existing file applied" | marks every file up to **and including** `<id>` | otherwise the predecessors stay pending and `apply` runs them, which is the opposite of adoption |

**Two flags added** beyond `06` §6.2: `apply --applied-from <id>` (fills §4.4's `applied_from`
column, and makes the CLI goldens machine-independent) and `apply --heartbeat <duration>`.

**R10 — the mutation record.** Ten mutations, each applied to the file K1 owns, the suite run, the
file restored. Nine were caught first time; M5 needed a *faithful* mutation (the first attempt did
not actually reproduce a naive line scanner) and was then caught.

| # | Mutation | Verdict | Caught by |
|---|---|---|---|
| M1 | `resumeFrom` returns `statementsApplied` even when `statement_uncertain` is set (the design's literal reading) | RED | `runner/resume.test.ts` — "SIGKILL during the concurrent build…" (42P07 on the invalid index) |
| M2 | the fingerprint gate never refuses | RED | `runner/fingerprint.test.ts` ×2 — the non-empty-database case and the `--verify-fingerprint` case |
| M3 | `57014` retried five times like a lock timeout | RED | `runner/failure.test.ts` — "57014 (statement_timeout) is never retried" |
| M4 | the strict pooler probe's verdict is thrown away | RED | `runner/pooler.test.ts` ×3 — the probe, the refusal, and the refusal through the binary |
| M5 | a naive line scanner replaces the SQL lexer in `findDirectives` | RED | `runner/resume.test.ts` — "the dollar-quoted body's `-- pg-prime:stmt 99` was not read as a marker" |
| M6 | the history INSERT moves out of the migration's transaction | RED | `cli/envelope.test.ts` — the `apply.dry-run` golden puts it before `COMMIT` |
| M7 | the lease heartbeat goes back on the migration connection | RED | `runner/lock.test.ts` — "the lease keeps beating DURING a long statement" (1 beat, not 4) |
| M8 | `EXIT.pending` becomes 0 | RED | `cli/envelope.test.ts` — "status with two pending migrations: exit 5" |
| M9 | checksum drift is only ever a warning | RED | `runner/fingerprint.test.ts` — "an edited migration file is checksum drift" |
| M10 | an unknown CLI option becomes a positional | RED | `cli/usage.test.ts` ×3 — including "an unknown flag exits 1 and never reaches the database" |

**Gate.** `apply` from empty through the corpus's generated plans, twice, on four chains
(acceptance, evolve ×2 steps, enum-ordering ×2 steps, multi-schema) — second run `up_to_date`,
exit 0, catalog fingerprint equal to the last plan's `to`, every row `applied` with
`statements_applied = statements_total`. Resume proven by SIGKILLing a spawned runner mid-CIC
(5/5 runs, ~6 s each). PgBouncer transaction mode refused with exit 1 and the sentence that names
the direct port. The two-runner lock test is 5/5 (~11 s each). `pnpm package:check` green with the
new `bin`, the regenerated api snapshot and the regenerated `types@<5.9` stub.

**Interfaces round 2 depends on.**

```ts
applyPending(conn: ConnInfo, migrationsDir: string, options?: ApplyPendingOptions): Promise<ApplyPendingResult>
applyPendingOn(client: CatalogClient, migrationsDir: string, options?): Promise<ApplyPendingResult>   // caller owns the connection
migrationStatus(conn: ConnInfo, migrationsDir: string, options?: StatusOptions): Promise<StatusReport>

interface RepeatablesPass {            // K3 implements; NO_REPEATABLES is the stub
  plan(dir: string, appliedHashes: ReadonlyMap<string, string>): Promise<readonly RepeatableFile[]>
}
interface RepeatableFile { readonly path: string; readonly sha256: string; readonly statements: readonly string[] }

defineConfig(config: PgPrimeConfig): PgPrimeConfig    // url | connection | migrations | repeatables
loadConfig(path?: string, cwd?: string): Promise<LoadedConfig>   // schemas | shadow | schema | timeouts | production
resolveConfig(input: ResolveInput): ResolvedConfig
EXIT / RUNNER_EXIT                     // design/06 §6.1, one table
```

`ApplyPendingResult` always carries `status` + `exitCode` and never throws for an expected failure;
`RunnerFailure.code` is one of `transaction_pooler | pool_connection | missing_file |
checksum_drift | fingerprint_mismatch | unknown_target | plan_invalid | lock_unavailable |
sql_error`. Adding a command is: an `OptionSpec[]`, a `run(config, argv) => CommandOutput`, and one
row in `COMMANDS` in `src/cli/main.ts`.

**Open for K2b.** (a) The managed schema set is config-only; putting `schemas` in `Plan` would let
`apply` detect a mismatched set directly instead of through a fingerprint refusal. (b) `status`'s
repeatable drift is a stub until K3's `RepeatablesPass` lands (`passImplemented: false` in the
envelope says so). (c) `baseline` refuses when extraction produces error-severity diagnostics —
`writePlan`'s hazard gate — which is right, but the message is `writePlan`'s rather than baseline's.

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

#### K2a — RESULT (2026-08-28)

**Built.**

| # | deliverable | file(s) |
|---|---|---|
| 1 | DSL: `.references()` `.check()` `.unique(name?, opts)` `.comment()` `.renamedFrom()`; extras `foreignKey` `check` `unique` `renamedFrom`; `pgSchema`; `pgEnum(..., { schema })` | `packages/pg-prime/src/schema/{ddl.ts,column.ts,extras.ts,table.ts,ref.ts,index.ts}`, `src/index.ts` |
| 2 | `emitSchema(schema, { schemaMap?, defaultSchema? })` | `packages/pg-prime-kit/src/schema/{emit.ts,types.ts}` |
| 3 | `provisionShadow(admin, target, opts)`, tiers 1–3 + a typed tier-4 refusal | `packages/pg-prime-kit/src/shadow/ladder.ts` |
| 4 | `loadDesired(schema, shadow)` and the IR schema-map reversal | `packages/pg-prime-kit/src/schema/{load.ts,remap.ts}` |
| 5 | AS BUILT notes | `05` §2.3 §2.4 §3.1 §5.1 §7.2, `06` §3.2, here |

**Signatures K2b wires to.**

```ts
// @pg-prime/kit
interface SchemaLike { readonly tables: Readonly<Record<string, { readonly $: TableRuntime }>> }

function emitSchema(schema: SchemaLike, options?: {
  schemaMap?: ReadonlyMap<string, string>
  defaultSchema?: string                      // 'public'
}): { sql: readonly string[]; diagnostics: readonly Diagnostic[]; schemas: readonly string[] }

function provisionShadow(admin: ConnInfo, target: ConnInfo, options: {
  shadow?: 'auto' | 'temp-schema' | 'createdb' | 'offline' | { url: string }
  schemas: readonly string[]
  token?: string
}): Promise<Shadow>          // { conn, schemaMap, tier, reason, diagnostics, dispose }

function loadDesired(schema: SchemaLike, shadow: Shadow, options?: {
  defaultSchema?: string
  statementTimeout?: string
}): Promise<ExtractResult>   // { ir, pgVersionNum, diagnostics }, in the USER's schema names

function desiredSql(schema: SchemaLike, shadow: Shadow, options?): readonly string[]
```

**Divergences from the brief, and why.**

1. **`Table` gained a `cols` property.** `.references(() => orgs.cols.id)` has to name a column of
   another table, and the only spelling that existed was `orgs[REFS].id` — importing a phantom slot
   symbol whose sole reason for being exported is TS2527. `cols` is the *identical instantiation*
   `[REFS]` already holds, so the instantiation cache serves both. Measured, A/B, on the 100-table
   headline: **+63 instantiations on TS 5.9.3, +19 on TS 7.0.2** (0.08% / 0.01%). This is not the
   `Table & Columns` intersection `04` §1.3 rejects: one property, no intersection, no per-column
   cost, and a column keyed `cols` cannot collide with it because columns never live on the table.
2. **A self-referencing FK cannot be written with `.references()`** — `() => nodes.cols.id` inside
   `nodes`'s own initializer is a TS7022 circularity (the thunk's *body* needs the type still being
   inferred; the thunk only defers the *value*). The spelling is the `foreignKey` extra, whose
   callback parameter is that table's own refs. A **mutual** pair needs the thunk's return type
   annotated once, `(): RefLike => orgs.cols.id`, exactly as Drizzle needs `AnyPgColumn`. Both are
   documented on the methods and pinned by tests that `pnpm typecheck` compiles.
3. **`pgEnum` gained `{ schema }` and `ColumnDdl` gained `enumSchema`.** Without it a cross-schema
   enum has no home: `enumColumn` records only the bare type name, and "put it in the schema of
   whichever table uses it" makes the emitted DDL depend on registry iteration order.
4. **`foreignKey({ references })`, not `{ foreignColumns }`** (`05` §2.4 spells it the second way).
   Renamed to match the column method, and because the thunk — not the array — is the load-bearing
   part.
5. **`check(name, sql)` requires the name**, unlike `.check(sql, name?)` on a column. PostgreSQL's
   own default for a multi-column check is the bare `<table>_check`, which collides on the second
   one, and inventing `ChooseConstraintName`'s uniquifying suffix is K3's item 2.
6. **The kit's `tsconfig.json` maps `pg-prime` to its source; `tsconfig.build.json` maps it to
   nothing.** CI runs `pnpm typecheck` with no build in front of it, so a bare `pg-prime` specifier
   would need `packages/pg-prime/dist` to exist. The typecheck project resolves through `paths` and
   drops `rootDir` (which moved to the build project, or every pg-prime source file is a TS6059);
   the build project sets `paths: {}`, so the publish emit reads the peer's real `.d.ts`. The
   emitted declarations name `pg-prime` either way — `check:dts` now reports the kit's external
   specifiers as **`pg, pg-prime`**, which is §1.3's line.
7. **The treeshake budgets were re-baselined upward** by the same rule that set them
   (`budget = min(design, ceil(measured/1024)*1024)`): connect-one-select 46 291 → 47 212 B min+gz
   (+921), full-crud-tx 46 660 → 47 571 (+911), root-import-all 50 004 → 51 660 (+1 656). Two of
   the three are still below `08` §1.2's design number. The module-set goldens gained exactly one
   entry, `dist/schema/ddl.js`. Reasons recorded in `tools/budgets.json`.
8. **Comments are emitted but are not a fact kind**, so the D10 witness sees them in database A and
   not in database B. Rather than dropping them from the fixture, the round-trip test asserts that
   the dumps differ by **exactly the five `COMMENT ON` statements and nothing else** — a stronger
   statement than equality, and one that starts failing the moment K3's `comment` fact makes it
   stale.

**`bench:types` — before / after.** All budgets green both times; nothing gated moved.

| metric | before (6e25685) | after | budget |
|---|---|---|---|
| instantiations / column (declaration), 5.9.3 / 7.0.2 | 3 / 3.08 | **3 / 3.08** | 8 |
| instantiations / table (declaration), 5.9.3 / 7.0.2 | 36 / 37 | **36 / 37** | 50 |
| instantiations / table, all 3 row shapes, 5.9.3 / 7.0.2 | 342 / 387 | **342 / 387** | 500 |
| instantiations / declared relation | 32.5 | **32.5** | 50 |
| marginal instantiations / usage (100t) | 40 | **40** | 1000 |
| schema-size independence ratio 300t/25t | 1.000 | **1.000** | 1.15 |
| headline instantiations, 5.9.3 | 74 507 | **80 485** (+8.0%) | 200 000 |
| headline instantiations, 7.0.2 | 124 322 | **131 388** (+5.7%) | 200 000 |
| headline check time s, 5.9.3 / 7.0.2 | 0.32 / 0.046 | **0.38 / 0.045** | 2 / 0.5 |
| headline peak memory MB, 5.9.3 / 7.0.2 | 117 / 50 | **120 / 59** | 250 |
| package `.d.ts` bytes | 364 406 | **377 261** (+3.5%) | 409 600 |

The headline rise is the new *surface* (five methods on `Col<M>`, four extras builders, `pgSchema`,
`ddl.ts`'s types, 18 new root exports), not a new per-column or per-table cost — the three
per-declaration rows are unchanged to the digit, which is the claim `11` §3 K2a asked to be proved.
`cols` accounts for 63 of the 5 978 (measured by removing it and re-running).

**R10 mutation record.** Ten mutations, ten caught; the suites run were
`packages/pg-prime-kit/test/{schema-emit,shadow}` and `packages/pg-prime/test/schema`.

| mutation | caught by |
|---|---|
| a UNIQUE constraint is named `_uniq` instead of the server's `_key` | `emit.test.ts` "pkey / key / check / fkey, exactly as the server would choose them" **and** `roundtrip.test.ts` "names its constraints exactly as PostgreSQL would have" |
| `fkClause` drops `ON DELETE` | `roundtrip.test.ts` "carries the modifiers PostgreSQL can only have learned from the emitted DDL" (`pg_get_constraintdef` on the live catalog) |
| the DEFAULT renderer dispatches on the JS value instead of on `ColumnDdl.pgType` | `emit.test.ts` "renders each one the way PostgreSQL parses it back" (`jsonb().default('x')` becomes `'x'`, not `'"x"'`) **and** `ladder.test.ts`'s tier-3 load fails |
| the cycle breaker is removed, every FK is emitted inline | `emit.test.ts` "breaks a cycle with ALTER TABLE … ADD CONSTRAINT" and the statement-order test, **and** both tier-3 loads (`relation "users" does not exist`) |
| the schema map is reversed on ids but not on payload TEXT | `ladder.test.ts` "reverses the map on the IR" (the checkpoint still contains `pgprime_shadow_`) and both fingerprint-equality tests |
| the schema map is not reversed on dependency EDGES | the same three, via the cross-schema FK edge assertion and the fingerprints |
| tier-3 `dispose` leaves its temp schemas behind | `ladder.test.ts`'s `pg_namespace` assertion — *and* the next test in the file, because the leftovers collide |
| an enum column type is emitted unqualified | `emit.test.ts` ×2 and both tier-3 loads (`type "member_role" does not exist`) |
| `.check()` accepts a bind parameter | `packages/pg-prime/test/schema/ddl.test.ts` "rejects a bind parameter with a sentence naming the reason" and the table-level twin |
| the ladder ignores `rolcreatedb` and always takes tier 2 | `ladder.test.ts` "auto demotes to tier 3" (the NOCREATEDB role gets `permission denied to create database`) |

**Acceptance.** `pnpm test` 46 files / 778 tests, **4.66 s** (tier-0 gate: 5 s) · `pnpm test:live`
79 files / 1507 passed, 2 skipped · `pnpm --filter @pg-prime/kit test` 19 files / **169 tests**
(was 125) · `pnpm typecheck` clean · `pnpm bench:types` all budgets PASS · `pnpm type-errors:check`
no drift · `pnpm build` clean · `pnpm api-snapshot` `pg-prime` 227v/221t root, 44v/67t `./schema`;
`@pg-prime/kit` 88v/81t · `pnpm package:check` green (8/8 size gates, emit parity 0 FAIL,
`check:dts` clean on 5.9.3 and 7.0.2 with the kit's externals now `pg, pg-prime`, tree-shake gates
ok, publint/attw clean, pack-smoke OK).

**Not done / uncertain.**

- `notValid()` on `.references()` / `.check()` / `foreignKey` / `check` — the two-phase add is a
  `generate`-time rewrite (`06` §3.5), not a declaration, so it has no home in the DSL yet.
- Index expressiveness: `index()` is a plain b-tree column list. `.using()`, `.where()`,
  `.include()`, `.desc()`, `.opclass()`, `.with()`, `.concurrently()` and expression indexes are
  not built; `.concurrently()`'s tri-state (`05` D15) is a `generate` decision anyway.
- A **column-level** `.check()` has no ref to interpolate — the columns callback's parameter is the
  `ColumnKit`, not the refs — so the column's DB name has to be written by hand in the fragment.
  The extras-level `check('c', sql`${t.unitPrice} > 0`)` does not have this problem. Worth
  revisiting if the casing strategy bites someone.
- `emitSchema` reports a duplicate constraint name as an `error` diagnostic rather than appending
  PostgreSQL's uniquifying suffix — that suffix is K3's item 2, and inventing a different one would
  be worse than refusing.
- Tier 1 **resets** the schemas it is pointed at. That is the documented `SHADOW_DATABASE_URL`
  contract and it emits a warning diagnostic, but it is a loaded gun in a way tiers 2 and 3 are not.
- `pnpm --filter @pg-prime/kit test` was run against PG 17 only (`pgprime-pg17-b`, :54333). The
  15/16/18 matrix is CI's.


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

#### K3 — result (2026-08-28)

**Done.** 125 → **217 tests** green on PG 17 (`:54334`, 26.3 s) and PG 18 (`:54332`, 26.9 s); 15 → 27
test files. `pnpm --filter @pg-prime/kit typecheck`, root `pnpm typecheck`, `pnpm build` and
`pnpm package:check` (after `pnpm api-snapshot`; the kit barrel went 66 → 102 values) all clean.

- **`convalidated` on `contype = 'n'`** — `ColumnPayload.notNullValidated`, catalog-gated, with the
  §3.5 row-4/row-5 rewrite behind the same gate. `06` §3.3's AS BUILT note is amended in place.
- **`ChooseConstraintName`** — `sql/ident.ts` `chooseConstraintName`, suffix on the label, `taken`
  supplied by the caller. Its consumer is the row-5 temporary CHECK; the extractor's `%GENERATED%`
  test deliberately did **not** widen (see `06` §3.3 AS BUILT for why that would break convergence).
- **Tier M complete** — `FactKind` gains `default`, `typeAttribute`, `comment`, `extension`; `type`
  covers enum + domain + composite; partitioning is modelled on `table`. `06` §2.2 AS BUILT has the
  mapping and the three things still refused.
- **Tier R** `src/repeatables/`, **Tier O** `ExtractResult.observed` (16 families), **Tier U** the
  full §2.2 census + `diffIR({ strictUnmodeled })`.
- **Hazards** — all 35 codes emit; `06` §3.4 has the AS BUILT table naming the file for each, the
  emptiness probe (`probeEmptiness`) and the `nolint` grammar. `src/lint/` is `lintPlan(plan,
  sqlText, opts) → { findings, directives, directiveErrors, exitCode }`.

**Divergences from the brief, with reasons.**

1. `DS105`, `LK103`, `LK111`, `TX101`, `TX102`, `TX201` and `ST101–106` are emitted by
   **`src/lint/rules.ts`**, not by `ddl.ts`. Every one of them is a property of the assembled file
   (segment framing, `txmode`, idempotence) or of a Tier-R object the differ never sees. Putting
   them on a delta would mean inventing a delta for a trigger.
2. The ST family's severities live in `lint/rules.ts` rather than in `plan/plan.ts`'s
   `HAZARD_SEVERITY`, because `plan.ts` is K1's file this round *and* because `hazardSeverity`
   answers `error` for an unknown code — right for a hazard, wrong for opt-in advice.
3. `LK109`'s `pg_proc.provolatile` check runs in the **extractor** (`Q_VOLATILE_DEFAULTS`) and
   travels as a `volatile_default` diagnostic, with a built-in list as the fallback. It is not a
   `DefaultPayload` field: volatility belongs to the function, and hashing it would turn "somebody
   redefined `bump()`" into a delta with no DDL — a plan that can never converge.
4. `fixtures/diff/partitioned` covers *declared* partitions only. The adopt case is
   `test/kinds/partition.test.ts`: the D10 witness would correctly report the surviving partition as
   a dump difference, and a `strict` corpus fixture is by definition one that dumps identically.
   Same for the retained extension (`test/kinds/extension.test.ts`).
5. `buildStatements` grew an optional third parameter (`BuildOptions`: `volatileDefaults`,
   `emptyTables`, `noSafeRewrite`). `generate.ts` is K2b's file, so it does not pass one yet — the
   fallbacks are the documented offline behaviour (MF stays `error`, LK109 uses the built-in list).
   **K2b: thread `desired.diagnostics` and `probeEmptiness(target, …)` through.**
6. `prove.ts` waives the whole-IR **fingerprint** equality — and only that; the delta check stays
   exact — when the residual diff reported `adopted_partition` or `extension_retained`. Those are
   facts the clone keeps on purpose, and demanding fingerprint equality there demands a DROP the
   design forbids.

**R10 — eleven mutations, eleven caught** (PG 17 `:54334` unless stated; the full suite each time):

| # | Mutation (line blinded) | Caught by |
|---|---|---|
| M1 | `extract.ts` `Q_COLUMNS`: `nn.convalidated` → `true`, so every NOT NULL reads validated | **PG 18**, 2: `kinds/not-null-validity.ts` — *an unvalidated NOT NULL is a different fact…*, *a desired state that WANTS NOT VALID gets it…*. Green on 17, which is the catalog gate working |
| M2 | `ddl.ts` `notNullTransition`: return a bare `SET NOT NULL`, skipping both §3.5 rewrites | `evolve.ts` — *covers the M-subset alter paths and converges*, on **both** 17 and 18 (the two branches of the gate) |
| M3 | `ident.ts` `chooseConstraintName`: drop the pass loop, always `makeObjectName(name1, name2, label)` | corpus *name-collision* — the plan applies `ADD CONSTRAINT "t_a_not_null" CHECK …` onto a relation that already has that name. **17 only**: on 18 the CHECK detour is not taken, which is itself the point |
| M4 | `extract.ts` `Q_TYPES`: drop `relkind = 'c'`, so every table's row type becomes a composite | 18 tests: corpus *acceptance*, *multi-schema/up*, *serial*, *dollar-names*, *partitioned*; `catalog.ts`, `ddl.ts`, `dump-oracle.ts`, `oracle-strict.ts`, `provisioning.ts`, `rename.ts`, `roundtrip.ts` |
| M5 | `extract.ts` `templatizeIndexDef`: keep `ON ONLY` on a partitioned index | corpus *partitioned* — the parent index is created with no children and PostgreSQL marks it `indisvalid = false`, so the plan applies and then fails its own proof |
| M6 | `diff.ts`: stop removing adopted partitions from the current side | `kinds/partition.ts` — *plans no DROP for a partition the desired state never mentions* |
| M7 | `diff.ts`: stop removing a retained extension from the current side | `kinds/extension.ts` — *an undeclared extension yields no DROP, no delta, and one info diagnostic* |
| M8 | `extract.ts`: emit no `comment` facts at all | corpus *comment* (the D10 witness — `pg_dump` prints `COMMENT ON` and we did not) and `kinds/payloads.ts` — *comment: keyed by the target's id* |
| M9 | `extract.ts`: emit no `default` facts | 19 tests: corpus *acceptance*, *enum-ordering*, *multi-schema/up*, *serial*, *enum-quoted*, *evolve*, *exclude*, *column-default*; `ddl.ts`, `dump-oracle.ts` ×2, `enum.ts` |
| M10 | `lint/rules.ts`: drop the TX201 clause | `lint/rules.ts` — *fires on a non-idempotent statement in a bare segment* |
| M11 | `ddl.ts` `columnClause`: stop emitting `NOT VALID` after an inline `NOT NULL` | **PG 18**: `kinds/not-null-validity.ts` — *a desired state that WANTS NOT VALID gets it — inline on a fresh table* |

The negative control still fails as designed: `fixtures/diff/unmodeled` (two databases differing only
by `WITH (fillfactor = 70)`) produces zero deltas, `proof.driftDeltas === 0`, and
`dumpOracle.status === "failed"` with `missingCount === 1` naming `fillfactor` — `strict` propagates
that to `proof.status === "failed"`, `warn` records it and lets the plan through
(`test/dump-oracle.test.ts`, *the differ sees nothing, the IR proof converges, and the oracle still
catches it*).

---

### Round-1 integration — K3 over K2a · 2026-08-28

K2a merged first (`31639c6`), K3 was cherry-picked on top (`caf3848`). Three things broke at the seam,
all in K2a's code against K3's new facts, all fixed in the integration commit that follows K3's:

1. **`extension` ids have no `schema`** (`05` §7.2's `[name]`), and `plpgsql` is in every database —
   so the remapper's `id()` and two tests that read `f.id.schema` off every fact were wrong the
   moment the extractor emitted its first extension fact. `id()` now leaves schema-less ids alone.
2. **`comment` ids carry their target's *encoded* id** (`comment:column:pgprime_shadow_…`) — a schema
   one level down, which neither `id()` nor the payload rewrite reached. `id()` now parses, remaps
   and re-encodes the target. The payload rewrite itself moved from an enumerated field list to a
   recursive walk over every string: K3 added `default.expression`, `typeAttribute.type`,
   `type.checks[]` and `table.partition*` in one workstream, and a list would have been stale again
   by K4. Rewriting blindly is safe by construction — the only text replaced is a shadow name
   minted after the schema was written, matched as a whole identifier.
3. **A fresh database's `public` schema carries initdb's `'standard public schema'` comment.** With
   `comment` a fact, tier 2 (a fresh database) saw it and tier 3 (a bare shadow schema) did not, and
   the two tiers' fingerprints diverged by exactly that fact — found by diffing the two IRs
   fact-by-fact, not by guessing. Neither tier was right: a real target has *its own* comment, and
   the DSL declares none (`pgSchema` has no `.comment()` yet). `Shadow` now carries `target`, and
   `loadDesired` **mirrors the target's schema comments onto the shadow after the load**, so the
   desired state asserts nothing about a comment the DSL never wrote. Recorded under `06` §3.2.

Also: K2a's witness test (`roundtrip.test.ts`) went red as designed — the five `COMMENT ON` statements
it allowed to be missing now round-trip — and its assertion is now `missing === []`.

### Round-1 integration — K1 over K2a + K3 · 2026-08-28

K1 was cherry-picked last (`25a9737`). Three seams, none of them a bug in K1's own scope:

1. **`RepeatablesPass` / `RepeatableFile` existed twice** — K1 declared the runner's contract
   (`plan(dir, hashes) → RepeatableFile[]`) as a seam for K3 to fill; K3 shipped its own richer pair
   (`plan() → { toApply, unchanged, orphaned }`, `apply()`). Unified on K3's: the runner now imports
   them from `src/repeatables/`, reads `plan.toApply` / `plan.unchanged`, and `status` reports
   `toApply` as the repeatable drift. `NO_REPEATABLES` is still the CLI's binding —
   `createRepeatablesPass(config.repeatables)` is K2b's one-line wire plus its runner tests.
2. **`ShadowStrategy` existed twice** — K1's config carried a `string` placeholder, K2a the real
   union. The config now imports K2a's, so `pg-prime.config.ts` type-checks `shadow: { url }`.
3. **`freshDatabaseIR` (baseline) had to learn K3's two new facts.** K1 derived "what a fresh
   database already has" from `pg_namespace.oid < 16384`; with `comment` and `extension` as fact
   kinds, an empty database now also yields `'standard public schema'` and `initdb`'s extensions,
   so a baseline's `from` fingerprint stopped matching an empty database's live fingerprint and its
   first statement became `COMMENT ON SCHEMA public …`. The same rule extended: comments whose
   target is a built-in schema, and extensions with `pg_extension.oid < 16384`, are part of the
   fresh IR.

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
