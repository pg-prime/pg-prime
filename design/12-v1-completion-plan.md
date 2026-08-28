# 12 — v1 completion: session layer, K4, builder gaps, docs, release engineering, perf. Implementation & Test Plan

**Date:** 2026-08-29
**Status:** PLAN. Sequenced workstreams with per-workstream test contracts and exit gates, in the format of
`09` and `11`. Nothing here re-opens a decision recorded in `03`/`04`/`05`/`06`/`07`/`08`; where the
as-built code and a design section disagree, the disagreement is named here and resolved in favour of the
design unless a measurement says otherwise. Each workstream appends a **RESULT** section here with its
numbers, deviations and an R10 mutation record.
**Inputs:** `07-runtime.md` (the whole document — the session layer has never had a workstream),
`03-query-builder.md` §2.2 / §2.3 / §2.7 / §4 / §5, `09` §3.4–§3.7's "deferred, each with its owner" lists,
`06-migrations.md` §4.1 / §4.4 / §4.5 / §6.2 / §7 (K4), `11` §4 (K4's placeholder), `08-architecture.md`
§1.1 / §3.4 / §4.6 / §5 / §6.3 / §6.4 / §7, `01-features.md` §11, `09` §1 (rules R1–R13) and `11` §2
(R14–R17), which apply here unchanged.

**Starting point (verified in-repo 2026-08-29, `fb723f4`):**

- `pg-prime`: tier 0 **778** tests / 5.05 s (**at** the 5 s ceiling), tier 1 **1507 + 2**, tier 2 green on
  PG 15–18 + PgBouncer. `pgPrime({ driver, schema, registry? })` returns `Db` = the executor plus a
  `transaction(f)` that is `begin`/`commit`/`rollback` over one acquired connection and nothing else.
  **None of `07` exists**: no `Tx`/`Session` handles, no `TxOptions`, no savepoints, no retry, no
  `setLocal`, no `rollbackWith`, no error hierarchy beyond the 12 classes in `sql/errors.ts` (a server
  error surfaces as the driver's `PgDriverError` data), no pooler profiles, no `diagnose*`, no hooks,
  no `listen`/`notify`, no COPY, no `streamBatches`, no per-query timeout. The driver seam already has
  the optional capabilities (`copyIn`, `copyOut`, `cancel`, `on('notification')`, `route: 'direct'`)
  and the pg adapter implements `cancel` (protocol or `pg_cancel_backend`) and `on`, with `copyIn`/
  `copyOut` capabilities `false`.
- Builder gaps, each recorded as deferred in `09`: no `...u.$all`; no `avg`/`min`/`max` over a relation;
  `RelConfig.where`/`orderBy` typed `unknown`; no FK inference for relations (now possible: the DSL has
  `.references()` since `11` K2a); `right`/`full`/`cross` joins and `innerJoinLateral`/`leftJoinLateral`
  absent from `Query` (the emitter has all of them); no recursive CTE spelling; `withRaw`/`fromRaw`
  (`03` §5's own v1 workarounds) do not exist.
- `@pg-prime/kit`: **379** tests, ten of `06` §6.2's twelve commands. Not built: the `-- pg-prime:batch`
  runner (the backfill stub `generate` writes is a `RAISE EXCEPTION`), `generate --data` / `--empty`,
  seeding, `migrate checkpoint` (+ `verify --from-checkpoint`, `status` naming drifted objects),
  `pull`. `pgEnum`/`pgSchema` have no `renamedFrom` spelling. `index()` is plain b-tree only — no
  `using`/`where`/`include`/opclass/per-column direction.
- CI: `ci.yml` jobs `unit`/`types`/`package`/`live`/`pg`/`perf`; nightly `pg-matrix`/`fuzz`/`bench`/
  `budgets`. **No `lint` job**, no oxlint config, no formatter, no `sherif`/`knip`, no `.changeset/`, no
  `release.yml`. `docs/` is an empty directory; `08` §6.4's site and `tools/docs-typecheck.mjs` do not
  exist. `bench/runtime/budget.json` carries seven `_overDesign` waivers; the comparison run against
  drizzle/kysely/prisma and the regression issue automation (`08` §5) are not built.

---

## 0. At a glance

| WS | Deliverable | Primary oracle | Gate to leave | Round |
|---|---|---|---|---|
| **C** | **Release engineering**: `lint` job (oxlint + `oxlint-tsgolint` type-aware rules on TS 7, `tsgo --noEmit -b`, `sherif`, `knip`), formatter config, Changesets with the fixed version group + `changeset status` on PRs, `release.yml` (changesets/action → Version Packages PR → `pnpm publish -r` via npm trusted publishing/OIDC + provenance), `RELEASING.md` runbook | The CI runner: every job green on the PR that adds it; `pnpm publish --dry-run` from the release workflow's exact steps | `lint` job green in < 60 s with the type-aware rules on; `changeset status` fails a `packages/` PR that carries no changeset; `release.yml` dry-run path green | A |
| **K4** | **Kit, the last of `06`**: `-- pg-prime:batch` runner (resumable, lag-aware, one tx per batch), `generate --data`/`--empty`, seeding (`db seed --set`, `.sql` + `.ts`), `migrate checkpoint` + fresh-database jump + `verify --from-checkpoint` + drift naming, `pull` (introspect → TS schema file); DSL: index options + `pgEnum`/`pgSchema` `renamedFrom` | Replay: `pull` on the four corpus schemas → load the emitted TS → `generate` → **empty diff**; batch runner killed mid-backfill resumes from its watermark (R15) | `pull` round-trips all four corpus schemas; a killed backfill resumes; a fresh database applies checkpoint + tail and matches a linear apply's fingerprint | A |
| **S** | **The session layer, `07` end to end**: `pgPrime(config)` = `07` §1.1, `Db`/`Tx`/`Session` handles, `TxOptions`, savepoints, `40001` retry, `setLocal`, advisory locks, `rollbackWith`, the §4 error hierarchy + constraint→object mapping, `POOLER_PROFILES` + `diagnosePooler()`/`diagnose()`, `AbortSignal` end to end + per-query timeouts, `streamBatches`, `listen`/`notify`, `copyFrom`/`copyTo`, hooks + `spanAttributes` + slow-query log + call-site capture, dev guard | A real server and a real transaction-mode PgBouncer: every claim about connections is asserted on `pg_stat_activity`/`pg_locks`/`pg_prepared_statements` (R18) and on the driver's statement log | `07` §0's snippet runs unchanged on a direct connection and through PgBouncer transaction mode; a forced `40001` is retried and an `IndeterminateCommitError` is not; `listen` survives a killed backend and emits `gap`; tier 0 stays ≤ 5 s | A |
| **B** | **Builder gaps**: `$all`, relation `avg`/`min`/`max`, typed `RelConfig.where`/`orderBy`, FK inference from `.references()`, `rightJoin`/`fullJoin`/`crossJoin`, `innerJoinLateral`/`leftJoinLateral`, `withRecursive` (base-fixed row type) or `withRaw` if the budget says no, `fromRaw` | The type budgets (`bench:types` ≤ +2 % per fixture) and the OID differential: every new spelling's SQL is a golden AND its decoded row is compared with a hand-written query on PG 17 | Every item on `09`'s deferred lists is either built or re-recorded with a measurement; fuzz 50k clean on PGlite + PG 17 | A |
| **D** | **Docs site** (`08` §6.4): Astro Starlight in `docs/`, `tools/docs-typecheck.mjs` (every fenced `ts` block type-checks on TS 5.9.3 against the built packages), `title=` blocks executed against PGlite, `tools/docs-coverage.mjs` (every name in the api-snapshot goldens has a reference entry), generated pooler matrix, `docs` CI job + Pages deploy workflow | CI: the blocks compile and run; coverage is mechanical | `08` §6.2 #10's four artefacts exist and are green: getting-started, migrations guide, operations guide, comparison page; coverage 100 % of the goldens | B |
| **P** | **Perf residue** (`08` §5): budgets sized from the nightly runner's distribution (≥ 5 runs), the batch-insert encode path, `bench/compare` against drizzle-orm / kysely (prisma if it fits), nightly comparison + job summary + the > 25 % regression issue | The nightly runner, not a laptop (R21) | Every `_overDesign` entry is re-sized from runner data or closed; the comparison table exists in the nightly summary | B |

Critical path: **C ∥ K4 ∥ S ∥ B → integration + one formatting commit → D ∥ P.** Round A is four agents on
disjoint files (§3 names the boundaries); D documents the API as it is *after* round A, which is why it
waits. P runs after S because both touch `executor.ts`.

---

## 1. Decisions taken here (recorded so agents do not re-derive them)

1. **`pgPrime(config)` is `07` §1.1's `createDb`.** The rename record fixes the per-layer spelling
   (`pgPrime` / `PG_PRIME_` / `pgprime_`), so the constructor keeps its name and *grows* `07`'s config:
   `connection | pool | driver` (exactly one), `directConnection`, `poolerMode`, `execMode`/`prepared`
   (already `ExecOptions`), `poolOptions`, `session`, `transaction`, `hooks`, `log`, `errors`, `devGuard`,
   `signal`. The `driver` form is what every existing test uses and stays.
2. **`connection: string` needs `pg`, and `pg` becomes an *optional* peer** (`peerDependenciesMeta`).
   `08` §6.2 #7 says zero peer deps; an optional peer that is only resolved by a lazy `import('pg')` on
   the first connect, with a `ConfigError` naming the package when it is absent, is the Drizzle shape and
   the honest one — `07` §1.1 has always said "we build the pool via the bundled `pg` adapter". `pool:`
   (a structural `PgLikePool`) and `driver:` remain the zero-dependency paths. Size and tree-shake goldens
   must show `pg` is never in the hello-world graph.
3. **Handles are `07` §1.3 verbatim**: `Db`, `Tx`, `Session` with a `kind` discriminant, mutually
   non-assignable, sharing `Queryable`. The existing `SchemaExecutor<Sc>` *is* `Queryable<Sc>` (renamed,
   old name kept as a deprecated alias for one release). `Db.transaction` gains the two overloads and
   `TxOptions`; `Tx.transaction`/`savepoint` take `SavepointOptions` with no `isolation`/`accessMode`/
   `deferrable`/`retry` **by type**. Docs and examples name the callback parameter `db`.
4. **The error hierarchy is `07` §4.2 as classes in `src/errors/`**, mapped once at the executor boundary
   from `PgDriverError`'s data; `PgPrimeError` (already in `sql/errors.ts`) stays the root; every listed
   SQLSTATE has a class, anything else is `UnknownQueryError`; the redaction policy is §4.3; the
   constraint-name → table/column mapping (§4.4) reads the schema's runtime metadata. `IndeterminateCommitError`
   is a sibling of `ConnectionError`, never a subclass — that is the point of it.
5. **Retry is `07` §3.4 verbatim**: on by default for `40001` at repeatable read / serializable only,
   never for `40P01`, never after an `IndeterminateCommitError`, an aborted signal, a partially-consumed
   stream, or a non-`PgPrimeError` throw. Full jitter. `tx.attempt` on the handle.
6. **Pooler profiles are data.** `POOLER_PROFILES: Record<PoolerMode, PoolerProfile>` is exported from
   `pg-prime`, and D generates `docs/…/pooler-compatibility` from it. A profile only ever restricts.
   `diagnosePooler()` reports and never reconfigures.
7. **Session-level GUCs (`07` §3.6) are applied once per physical connection** through the adapter's
   connect hook, not per statement, and **not at all** under a transaction profile — one `info` line
   names the settings that were skipped and the `ALTER ROLE` fix. `pgPrime` therefore needs a per-connection
   setup seam on the driver: `PgDriver.onConnect?` or the adapter's config; S chooses and records.
8. **LISTEN uses a dedicated, non-pooled connection**, acquired through a new optional seam
   `PgDriver.connect?(route)` (a connection the pool does not own), because `07` §6.5 forbids pinning a
   pool client. Under a transaction profile it is opened from `directConnection`; absent that, the error
   names the config key. `notify` is `pg_notify($1,$2)` on any handle.
9. **COPY goes through `pg`'s own connection-level messages** (`copyInResponse`/`copyData`/`copyDone`,
   `sendCopyFromChunk`/`endCopyFrom` — the API `pg-copy-streams` itself uses), implemented in the pg
   adapter behind the seam's existing `copyIn`/`copyOut`, so `07` §6.6's optional peer is not needed. If
   that path proves unstable across pg 8.x, the fallback is the optional peer; the public API does not
   change either way. Typed `copyFrom(table, rows)` encodes rows in COPY text format through the codecs.
10. **`streamBatches` is one `FETCH` per batch** (`batchSize` rows, the last one shorter) — the chunk the
    driver already yields — not a re-batching layer. It is the decision `09` §3.6 said needed making.
11. **Tier 0 stays ≤ 5 s.** New session-layer and builder tests that need a server are tier 1 (PGlite) or
    tier 2 (server); tier-0 additions use the recording mock driver. A workstream that pushes `pnpm test`
    over 5.0 s on a quiet design machine records the number and moves tests down a tier; the ceiling is
    not raised in this plan.
12. **K4's `.ts` seeds get a real `Db`** built by the kit through the *user's* `pg-prime` via one
    dynamic `await import('pg-prime')` in `src/seed/` — the only runtime use of the peer, allowed because
    it is dynamic, on the `db seed` path only, and resolved from the project. `11` §1.3's static
    types-only rule stands; its grep guard is amended to allow exactly that one site.
13. **Replica lag is read primary-side by default** (`pg_stat_replication.replay_lag`, PG ≥ 10, needs
    `pg_monitor`), with no replica URLs; `max-replica-lag` with no visible replica is a no-op with one
    `info` line. `replicas: [url]` in the config is the explicit opt-in that queries
    `pg_last_wal_replay_lsn()` on each, which is `06` §7's literal shape.
14. **Shadow tier 4 (`--offline`) stays refused with a sentence.** `11` §1.5 made the desired IR a
    function of a database (emit → load → extract); without a database there is no desired IR to diff a
    checkpoint against. Recorded in `06` §3.2 AS BUILT by K4. `--from-checkpoint` on `verify` is built.
15. **`pull` emits the DSL's spelling only**, and the round-trip gate (`generate` empty) is what decides
    the DSL is big enough. What the corpus needs and the DSL lacks is `index()` options — `using`,
    `where`, `include`, per-column `desc`/`nulls first|last`, `opclass` — and K4 owns those DSL additions
    (`packages/pg-prime/src/schema/`) plus their emitter half. Tier-R objects are emitted as `sql/`
    repeatables; anything else `pull` cannot express goes into a `-- pull: unsupported` header block and
    a `pull.report.json`, and the round-trip test asserts that block is **empty** on all four corpora.
16. **Checkpoints are `06` §4.5 verbatim**: a `-- pg-prime:checkpoint` migration holding the full DDL
    (through `baseline`'s emitter path) plus `checkpoints/NNNN.ir.json` and `.plan.json`; a fresh database
    applies the newest checkpoint and the files after it; an existing database ignores checkpoints;
    `status`/`apply` name drifted objects by diffing the live IR against the newest checkpoint's IR at or
    before the recorded position.
17. **B's recursive CTE is `withRecursive(name, base, step, opts?)`** where the row type is fixed by
    `base` and `step` receives the CTE's own handle typed by it — that is not the self-referential typing
    `03` §5 punted, so it is allowed to exist *if* `bench:types` moves ≤ 2 % on every fixture. If it does
    not fit, B ships `withRaw(name, sql, shape)` instead (the `03` §5 workaround) and records the number.
    `fromRaw(sql, shape)` ships regardless.
18. **FK inference** (`03` §4.1's open ask): a relation declared without `from`/`to` resolves when exactly
    one `.references()`/`foreignKey` path joins the two tables in the stated direction; zero or more than
    one throws at `defineSchema` naming the candidates and the explicit spelling. Explicit `from`/`to`
    always wins.
19. **Formatting lands once, between rounds.** C adds the formatter config and a `format:check` script
    but does **not** reformat the repo — that would conflict with every other round-A branch. After round
    A merges, the integrator runs the formatter once on a quiet `main` and turns `format:check` on in the
    `lint` job. Round B branches from the formatted tree.
20. **The npm side of trusted publishing is an operator step, not CI.** npm requires the *first* publish
    of a package to be manual and the trusted publisher to be configured per package on npmjs.com; C
    writes `RELEASING.md` with those steps and makes `release.yml` fail with a sentence if `id-token`
    is unavailable. Nothing in this plan publishes anything.

---

## 2. Test rules

`09` §1's R1–R13 and `11` §2's R14–R17 apply verbatim. Four additions:

**R18 — The server is the oracle for the session layer.** A claim about connections, transactions, locks
or prepared statements is asserted on `pg_stat_activity` / `pg_locks` / `pg_prepared_statements` /
`pg_backend_pid()` after the fact *and* on the driver's statement log, never on the wrapper's own report
alone. "Rolled back" means the row is absent and the log shows `ROLLBACK`, in the same test.

**R19 — Pooler-profile claims run through a real transaction-mode pooler.** `ci.yml`'s `pg` job has one
(`PG_PRIME_TEST_PGBOUNCER_URL`); a test that needs it is gated on that variable and skips *loudly* without
it, naming the recipe. A profile claim that has only been tested against a direct connection is not tested.

**R20 — Every docs code block compiles in CI; every `title=` block executes.** A page whose blocks do not
type-check on TypeScript 5.9.3 against the built packages, or whose examples fail on PGlite, does not
merge. Prose that names a public export the goldens do not contain fails `docs-coverage`.

**R21 — Budgets move by measurement, from the runner.** A perf budget is sized from ≥ 5 nightly runs'
distribution on the fixed runner and printed three-way (design · budget · measured). A number guessed from
a laptop is not a gate (R9 restated, because it is the rule most easily broken with good intentions).

---

## 3. Workstreams — round A (parallel, disjoint files)

### C — Release engineering

**Owns:** `.oxlintrc.json`, `.editorconfig`, formatter config, `.changeset/**`, `.github/workflows/{ci.yml
(lint job only),release.yml}`, `RELEASING.md`, root `package.json` scripts/devDeps, `knip.json`/`sherif`
config, and **the mechanical lint fixes** across `packages/*/src` and `packages/*/test` that the enabled
rules demand. Must not change behaviour while fixing a finding (a `void` prefix, an `await`, a removed
unused import — not a refactor); anything larger is recorded, not fixed, and the rule stays on with a
line-level `// oxlint-disable-next-line <rule> -- <reason>`.

**Build:**

1. **oxlint** (`oxlint@1.80`) + **`oxlint-tsgolint`** (`7.0.2001`, type-aware rules on the TS 7 install —
   verify it runs against this repo's project references; if it cannot, run oxlint without the type-aware
   set and record exactly which rules were lost and why). Rules per `08` §3.4: `no-floating-promises`,
   `no-misused-promises`, `await-thenable`, `require-await`, `no-unnecessary-condition`,
   `no-default-export`, and a restricted-import rule enforcing `08` §2.1's boundaries (no value import from
   `pg-prime` in the kit's `src` except decision 12's site; no `../schema` value import from `src/query`
   and `src/compile`; nothing outside `src/driver` imports `pg`). Root `pnpm lint` = oxlint + `tsgo
   --noEmit -b` (the existing `pnpm typecheck`) + `sherif` + `knip` (unused exports/files/deps, and
   export-map entries pointing at nothing).
2. **Formatter.** `oxfmt` if it is stable enough to format this repo idempotently (measure: two runs
   produce no diff); else `prettier` with zero config beyond `.editorconfig`. Ship the config and
   `pnpm format` / `pnpm format:check`; **do not run it over the tree** (decision 19).
3. **Changesets** (`@changesets/cli@3`): `.changeset/config.json` with `fixed: [["pg-prime",
   "@pg-prime/kit"]]`, `@pg-prime/testing` / `@pg-prime/create` independent, `changelog:
   @changesets/changelog-github`, `access: public`, `baseBranch: main`. A `changeset` step in the `lint`
   job runs `changeset status --since=origin/main` on PRs that touch `packages/` (and is a no-op
   otherwise). One initial changeset describing the current state.
4. **`release.yml`**: on push to `main`, `changesets/action` opens/updates the "Version Packages" PR; when
   that PR merges, the same job runs `pnpm build && pnpm package:check` then `pnpm changeset publish`
   under `permissions: id-token: write` with `NPM_CONFIG_PROVENANCE=true` and **no `NPM_TOKEN`** (trusted
   publishing). A `workflow_dispatch` input `dry_run` runs the identical steps with `pnpm publish -r
   --dry-run --no-git-checks` so the path is exercised in CI before anything is real. `RELEASING.md`
   carries the operator steps (npm trusted-publisher config per package, the first manual publish, the
   `pgormjs` deprecation, who holds publish rights).
5. **`ci.yml` `lint` job**: ubuntu × Node 24, `pnpm lint` + the changeset step, budget < 60 s. Update
   `08` §4.6's AS BUILT table row. `08` §3.4 AS BUILT note.

**Tests:** the lint job on the branch is the test. Plus: a deliberately introduced floating promise in a
scratch file fails `pnpm lint` (recorded in the RESULT, then removed); `changeset status` fails on a
`packages/` change without a changeset; the dry-run release path is green on the runner.

**Gate:** `lint` green on the PR in < 60 s with the type-aware rules on; every other job unchanged;
`release.yml` dry-run green; zero behaviour change (`pnpm test`, `test:live`, kit suite counts identical).

### K4 — Data migrations, seeding, checkpoints, `pull`, and the DSL it needs

**Owns:** `packages/pg-prime-kit/src/{data,seed,checkpoint,pull}/**` (new), `src/runner/*` (batch
dispatch, checkpoint jump), `src/cli/commands/{generate,apply,status,verify,checkpoint,seed,pull}.ts`,
`src/cli/main.ts` (new rows), `src/generate.ts` (`--data`/`--empty` templates, `annotationHints` for
enum/schema renames), `src/schema/emit.ts` (index options, enum/schema `renamedFrom`), `src/history/*`
(`data_progress` use), `packages/pg-prime/src/schema/{index*,enum*,schema*}.ts` (**only** the index
options and the two `renamedFrom` spellings), kit tests, `06` AS BUILT notes. Must not touch
`packages/pg-prime/src/{query,driver,compile,codec,sql,errors}` or the root/CI files.

**Build:**

1. **`-- pg-prime:batch` runner** (`06` §7, lane 2). Directive `batch size=<n> pause=<dur>
   max-replica-lag=<dur>`; the file's statements run **each in its own transaction**, re-executed until
   the command tag reports 0 rows; `pause` between iterations; lag check before each iteration per
   decision 13; `pgprime.data_progress` `{ rows_done, watermark }` written after every batch and read on
   resume (a killed backfill continues, never restarts — R15); `status` shows a running backfill's
   `rows_done`. The stub `generate` already writes for `06` §3.5 row 7 becomes a *working* backfill
   template (the `RAISE EXCEPTION` guard stays until the user edits the `TODO`). `generate --data
   --name <slug>` scaffolds the lane-2 file; `generate --empty` a blank transactional one.
2. **Seeding** (`06` §7, lane 3). `seeds/*.sql` and `seeds/*.ts`, `db seed [--set <name>] [--force]`;
   never recorded in `pgprime.migrations`; refuses when `PG_PRIME_ENV=production` or the URL matches
   `--prod-pattern` without `--force`; `.ts` seeds `export default async ({ db, set, env }) => …` with
   `db` per decision 12; ordering by filename; each seed file its own transaction; envelope + goldens.
3. **Checkpoints** (`06` §4.5, decision 16). `migrate checkpoint` writes `NNNN_checkpoint.sql`
   (`-- pg-prime:checkpoint`, full DDL) + `checkpoints/NNNN.ir.json` + `.plan.json` and a
   `pgprime.checkpoints` row on apply; the runner's fresh-database rule; `verify --from-checkpoint`;
   `apply`/`status` fingerprint mismatch names the drifted objects. `06` §3.2 AS BUILT: tier 4 refused
   (decision 14).
4. **`pull`** (`06` §6.2's missing twelfth command, `00` decision 5). `pg-prime pull --out schema.ts
   [--schema …]`: extract → IR → a deterministic TypeScript schema file in the DSL's spelling, tables in
   dependency order, enums/domains/composites/sequences/extensions/comments/indexes/constraints/partitions
   included, legacy views annotated with their real `securityInvoker`, Tier-R objects written to `sql/`
   as repeatables, unsupported residue per decision 15. A second `pull` over the result is byte-identical.
5. **DSL**: `index(cols, { using, where, include, nullsNotDistinct })` with per-column
   `{ column, desc?, nulls?, opclass? }` items; `pgEnum(name, values, { renamedFrom })`,
   `pgSchema(name, { renamedFrom })`; the emitter and `annotationHints` read them; `05` §2.3/§5.1
   AS BUILT lines. Measure `bench:types` before/after (runtime-metadata-only additions must not move it).

**Tests (tier 2):** `test/data/batch.test.ts` (R14 + R15: a 50k-row backfill through the binary, killed
with SIGKILL after ≥ 2 batches, resumed, `data_progress` and the table both asserted), `test/seed/*`
(through the binary, production refusal, `.ts` seed uses the builder and inserts), `test/checkpoint/*`
(fresh DB via checkpoint = linear apply fingerprint; existing DB ignores; `verify --from-checkpoint`;
drift naming), `test/pull/roundtrip.test.ts` (**the gate**: all four corpora, `pull` → write → load through
`loadConfig` → `generate` → `statements.length === 0` and D10 strict, plus `pull` idempotence), DSL
tests in `packages/pg-prime/test/schema` (tier 0) for the new options. R10 record with ≥ 8 mutations.

**Gate:** the four round-trips are empty; a killed backfill resumes from its watermark; checkpoint jump
matches linear apply; kit suite green on PG 15/16/17/18; `06` §6.4's table shows twelve of twelve.

### S — The session layer (`07`)

**Owns:** `packages/pg-prime/src/{session,errors,pooler,observe}/**` (new), `src/query/{run,executor,
terminals,prepared,raw}.ts`, the `Db`/`Tx`/`Session`/`Queryable` interfaces in `src/query/types.ts`
(**only** those; B owns the `Query`/scope/relation types in the same file), `src/driver/**`,
`src/index.ts` (session names), `package.json` (`peerDependenciesMeta`), `test/{session,pg,live}/**`,
`tools/budgets.json` and the treeshake goldens if the graph changes, `07` AS BUILT notes. Must not touch
`src/query/{select,relations,cte,scope,projection,window,ops*}.ts`, `src/schema/**`, `src/compile/**`
(except `decode.ts`'s public seam if a hook needs it), the kit, or CI.

**Build:**

1. **Config + handles** (`07` §1): decisions 1–3; `pgPrime` synchronous and lazy; pool policy (`07`
   §1.2's overrides of `pg-pool` defaults when we build the pool); presets; `Db.end()` /
   `[Symbol.asyncDispose]`; `session()`; `Tx` fields `attempt`/`depth`/`isolation`/`accessMode`/`status`;
   `NoHandleEscape<T>` (shallow); dev guard via `AsyncLocalStorage` (`HandleMisuseError`, opt-out
   `.outsideTransaction()`), the concurrent-statements `warn`.
2. **Transactions** (`07` §3): `BEGIN ISOLATION LEVEL … [READ ONLY] [DEFERRABLE]` as one statement,
   `TxOptions` union with `deferrable` gated by type; savepoints with deterministic quoted names;
   `setLocal` via `set_config($1,$2,true)` (batched in one round trip); `localSettings`; `advisoryLock`
   (`pg_advisory_xact_lock` family; session variant only on `Session`); `rollback()`/`rollbackWith(v)` +
   `TransactionAbandonedError`; retry per decision 5 with `onRetry` into hooks; the `finally` that destroys
   a connection whose `transactionStatus` is not `'I'`; `IndeterminateCommitError` on a connection loss
   after `COMMIT` was written.
3. **Errors** (`07` §4, decision 4): the classes, the mapping, `context`, redaction (`includeSql`,
   `includeParams`), `callSite` capture (§7.4, on when `NODE_ENV !== 'production'`), `InFailedTransactionError`
   carrying the poisoning error, constraint→object mapping.
4. **Pooler** (`07` §5, decisions 6–7): `PoolerMode`, `POOLER_PROFILES`, what each toggles (`execMode`
   restriction, `Session` refusal, `listen` routing, GUC skipping), `diagnosePooler()` with the six
   probes (the session-state one opt-in), `diagnose()` (pool stats, effective GUCs, `max_connections`
   arithmetic, server version, downgrade state), the dev-mode startup `warn` when `agrees === false`.
5. **Cancellation, timeouts, streaming** (`07` §6.1–6.3): `signal` on `pgPrime`, `transaction`, every
   terminal (`.signal(s)`), `run`, `stream`, `copy*`, `listen`; the four abort timings; destroy after
   cancel; `.timeout(ms)` = `SET LOCAL` inside a transaction, client timer + cancel outside, `{ strategy:
   'transaction' }` opt-in; `QueryCanceledError` vs `QueryTimeoutError`; `streamBatches` (decision 10);
   `statementTimeoutMs` on streams.
6. **LISTEN / NOTIFY / COPY** (`07` §6.5–6.6, decisions 8–9): `Subscription` with `reconnect`/`gap`/
   `error`, one multiplexed dedicated connection per `Db`, full-jitter reconnect + re-`LISTEN`, the 8000-byte
   check, `notify` everywhere; `copyFrom(table, rows, opts)`, `copyFrom.raw`, `copyTo`; the adapter's
   `copyIn`/`copyOut` become real and their capabilities `true`.
7. **Observability** (`07` §7.1–7.4): `QueryHooks` (sync, wrapped, a throwing hook disables itself via
   `onInternal`), `observe()`, `serverMs`/`decodeMs`/`waitedForConnectionMs`, `SEMCONV` +
   `spanAttributes()`/`spanName()`, `LogOptions` + slow-query records, `statementStats` folded into
   `diagnose()`.
8. `07` AS BUILT notes per section; `00` status row; api-snapshot regenerated; size/treeshake goldens
   re-baselined with reasons (decision 2's "pg never in hello-world" is a golden).

**Tests:** tier 0 on the recording mock (statement text of `BEGIN …`, savepoint names, `set_config`
batching, retry schedule with a fake clock, hook wrapping, `NoHandleEscape` type probes, error mapping
table — every SQLSTATE in §4.2 → class); tier 1 (PGlite: savepoint un-poisons `25P02`, `rollbackWith`,
`setLocal` visible to `current_setting`, `streamBatches` sizes, COPY round trip if PGlite supports it,
else tier 2); tier 2 (`test/pg/session.test.ts` etc.: a real `40001` produced by two sessions at
serializable and retried — asserted on `tx.attempt` and on the row (R18); `40P01` **not** retried;
`IndeterminateCommitError` by killing the backend with `pg_terminate_backend` from a third session between
`COMMIT` being written and acknowledged — if that window cannot be hit deterministically, by the mock at
tier 0 with the seam's `commitWritten` state, and the tier-2 test asserts the *classification* on a real
`57P01`; `listen` through a killed backend → `reconnect` + `gap`; `pg_stat_activity` shows one dedicated
LISTEN connection; `diagnosePooler()` says `direct` on the server and `likely-transaction-pooled` through
PgBouncer with `named-statement-survives` deciding (R19); `Session` refused under a transaction profile;
`SET` at connect skipped under it; per-query timeout kills a `pg_sleep` both ways and the two error classes
differ; `copyFrom` 100k rows vs `insertMany` — the crossover number goes in the doc). R10 record with
≥ 12 mutations.

**Gate:** `07` §0's snippet (with `pgPrime`) runs unchanged on a direct URL and through PgBouncer
transaction mode; tier 0 ≤ 5 s; tier 1 and 2 green on PG 15–18; `bench:types` headline unchanged
(session types are not on the query hot path); hello-world tree-shake golden excludes `pg`, `AsyncLocalStorage`
is imported lazily; `package:check` green.

### S — RESULT (2026-08-29)

**Branch:** `worktree-agent-a11d47013517a2506`, eight commits on top of `f053409`. `design/07` is
built end to end; every item of §3 S's build list 1–8 ships, with the divergences named below.

#### Numbers

| Tier | Command | Before | After |
|---|---|---|---|
| 0 | `pnpm --filter pg-prime test` | 778 / 46 files / 5.01–5.46 s | **912 / 47 files / 4.99–5.62 s** (five runs: 4.99, 5.01, 5.25, 5.45, 5.62) |
| 1 | `pnpm --filter pg-prime test:live` (PGlite) | 1 507 + 2 skipped | **1 656 + 6 skipped / 81 files / 28 s** |
| 2 | `test:pg`, PG 17.11 + PgBouncer 1.25 transaction mode | green | **1 714 + 0 skipped / 89 files / 11 s** |
| 2 | `test:pg`, PG 15.19 / 16.15 / 18.6 (no pooler) | green | **1 704 + 10 / 1 705 + 9 / 1 705 + 9**, all green |

Tier 0 is **at** the ceiling and did not move: +134 tests cost nothing measurable, because the cost
of a tier-0 run is dominated by transform and import (47 files) rather than by cases. That is why
the session suite is one file of 134 cases rather than eight files of seventeen (decision 11).

`pnpm typecheck` clean on both packages. `pnpm build && pnpm api-snapshot && pnpm package:check`
green — 8/8 size gates, 4/4 tree-shake gates, emit parity, `check:dts` on 5.9.3 and 7.0.2, pack
smoke. `pnpm bench:types` green: **the headline instantiation counts did not move** (TS 5.9 80 485
unchanged; TS 7 131 388 → 131 354, i.e. noise), which is §3 S's own prediction — session types are
not on the query hot path. Only the `.d.ts` *size* gate moved, and it is re-baselined with a reason.

#### Deliverable → files

| §3 S item | Where |
|---|---|
| 1 · config + handles, presets, `NoHandleEscape`, dev guard | `src/session/{config,types,handles,guard,pg-lazy}.ts`, `src/query/run.ts`, the four interfaces in `src/query/types.ts` |
| 2 · transactions, savepoints, `setLocal`, advisory locks, retry, `rollbackWith` | `src/session/{transaction,handles}.ts` |
| 3 · the §4.2 tree, mapping, redaction, call site, constraint→object | `src/errors/{base,classes,sqlstate,map,refs,redact,predicates,index}.ts` |
| 4 · `POOLER_PROFILES`, `diagnosePooler()`, `diagnose()` | `src/pooler/{profiles,diagnose,index}.ts`, `src/session/gucs.ts` |
| 5 · signals, timeouts, `streamBatches` | `src/session/runner.ts`, `src/query/executor.ts` (`streamBatchesOn`, `RunTiming`) |
| 6 · LISTEN/NOTIFY/COPY + the `connect` seam | `src/session/{listen,copy}.ts`, `src/driver/{copy,pg-adapter,pg-like,types}.ts` |
| 7 · hooks, `SEMCONV`, slow-query log | `src/observe/{events,bus,semconv,log,index}.ts` |
| 8 · notes, exports, budgets, peer metadata | `design/07` (7 AS BUILT blocks + §9 #6/#7), `design/00`, `src/index.ts`, `tools/{budgets.json,size-budget.mjs,api-snapshot/*}`, `bench/types/budget.json`, `fixtures/treeshake/*`, `packages/pg-prime/package.json` |
| tests | `test/session/session.test.ts` (134 tier-0 cases + the mutation runner), `test/query/types/session.probe.ts`, `test/live/session.test.ts` (19), `test/pg/session{,-listen,-pooler,-copy}.test.ts` (12 + 7 + 9 + 3) |

#### Divergences

| Brief / design says | Built | Why |
|---|---|---|
| §3.6: session GUCs ride the startup packet's `options=` | One `set_config` batch per **physical** connection; only `application_name` rides the startup packet | **Measured**: PgBouncer rejects `options=-c statement_timeout=…` with FATAL `08P01 unsupported startup parameter in options`, so `connection:` at a pooler would fail to *connect*. §3.6's own named fallback, promoted to the mechanism. |
| §5.4 probe 1: two `pg_backend_pid()` calls detect a transaction pooler | The probe **creates contention** first — three parallel pooled connections held busy, pid read while they are — and only then compares | **Measured**: through an idle PgBouncer the naive pair reads 343, 343. Under contention it reads 343, 364; a direct connection reads 359, 359 either way. The naive probe is a false negative in exactly the single-client case a diagnostic is run in. |
| §6.5: "payload limit is 8000 bytes" | Refused at **8000**; 7999 is the largest accepted | **Measured**: PostgreSQL's check is `>= NOTIFY_PAYLOAD_MAX_LENGTH` and that constant is 8000. Off by one. |
| §6.6: crossover "expected around 5–10 k rows" | **There is no crossover.** `copyFrom` is 1.5–1.8× faster at 10–100 rows, ~2× at 1 000–10 000, 2.3–3.8× at 100 000 | Measured on PG 17.11 over a local TCP socket, five sizes, printed on every tier-2 run. The reason to prefer `insertMany` under a few thousand rows is ergonomics, not speed. |
| §6.6: `pg-copy-streams` as an optional peer | No peer. `src/driver/copy.ts` is a Submittable over pg's own COPY messages | Decision 9. Also a seam correction: the methods are `sendCopyFromChunk` / `endCopyFrom`, not the `sendCopyData` / `sendCopyDone` the structural declaration had guessed. |
| §4.2: `SchemaError` (class 42), `SyntaxError` (42601) | `SchemaObjectError`, `SqlSyntaxError` | Both names were taken — `SchemaError` by `defineSchema`'s public error, `SyntaxError` by the ECMAScript global. |
| §4.3: `DETAIL` is redacted by default | …except `40P01`, kept verbatim | A deadlock's detail names two processes and two relations and contains no user value; dropping it obeys the letter and destroys the purpose. |
| §6.1/§6.2: `.signal(s)` / `.timeout(ms)` on the builder | `run(q, { signal, timeoutMs })` and `handle.withOptions({ … })` | `Query` and `src/query/select.ts` belong to workstream B this round. Same behaviour, different call site; a one-file change once `Query` is free. |
| §1.3: `[Symbol.asyncDispose]()` written literally | Declared through an inferred key | `tools/check-dts.mjs` measured TS2550 on the 5.9.3 consumer floor without `lib: esnext.disposable`. `await using` still works where the lib has it. |
| §1.5: `.outsideTransaction()` per call on a builder | `db.outsideTransaction()` / `run(q, { outsideTransaction: true })` | Same reason as `.signal()`. |
| §3.6: a per-statement timeout is `SET LOCAL` | …and it restores the transaction's **baseline** with `set_config(…, NULL, true)`, not `0` | `'0'` DISABLES the timeout for the rest of the block; `NULL` restores the value the session would otherwise have (measured, PG 15 and 17). |
| §4.4: `ConstraintRef.declaredAt` | Not built | The schema builder records no declaration sites. |
| §1.6: `experimental_asyncContext()` | Not exported | Nothing in v1 needs it; an unsupported hook nobody asked for is a liability. |
| §7.1: `onPool` on create/destroy | acquire / release / timeout only | The pool is `pg-pool`'s; those two events are not on the seam. |
| §9 #6 `statementTimeout: '30s'` | **Resolved: it stays** | Cost is once per physical connection, not per query; reach is exactly as designed. |
| §9 #7 `cachedDescribe` as the v1 default | **Resolved: not a mode at all** | Its real payoff (decode-plan memoisation) is unconditional already; its other justification (binary results) is out of v1 per `09` §9 #3. |

#### Measured numbers

- **COPY vs `insertMany`** (PG 17.11, local TCP, `test/pg/session-copy.test.ts`): 10 rows 6 ms vs
  4 ms (1.45×) · 100 rows 3 ms vs 2 ms (1.72×) · 1 000 rows 15 ms vs 7 ms (2.31×) · 10 000 rows
  37–142 ms vs 16–18 ms (2.05–8.85×) · 100 000 rows 351–494 ms vs 126–130 ms (2.79–3.80×).
- **Pooler pid probe**: idle PgBouncer 343, 343 → under contention 343, 364; direct 359, 359.
- **Tier 0 duration**: 4.99 / 5.01 / 5.25 / 5.45 / 5.62 s across five runs, against a 778-test
  baseline of 5.01 / 5.01 / 5.46 s on the same machine.
- **Size**: shipped `.js` 700 KB budget → 852 713 B measured (the four new directories are ~88 KB of
  source that design/08 §1.2 predates); `dist/query/types.d.ts` 54 843 → 62 502 B (the four handle
  interfaces); tree-shake `connect-one-select` 47 212 → 69 293 B min+gz, +19 modules, **no `pg` and
  no `node:async_hooks`**. All re-baselined with reasons in `tools/budgets.json._overDesign` and
  `bench/types/budget.json`.

#### R10 — the mutation record

`node packages/pg-prime/test/session/mutations.mjs` re-runs all twenty. **20/20 caught.** Three were
green on the first run and are the reason the record is worth keeping.

| # | Mutated line | Caught by |
|---|---|---|
| M1 | `transaction.ts` — drop `accessMode` from `beginSql` | tier 0 · `BEGIN … > { accessMode: 'read only' }` (5 failed) |
| M2 | `transaction.ts` — accept `deferrable` anywhere | tier 0 · `refuses deferrable outside serializable + read only` |
| M3 | `transaction.ts` — unquote the savepoint name | tier 0 · `the three statements a savepoint emits` (3 failed) |
| M4 | `handles.ts` — stop clearing the poison on `ROLLBACK TO SAVEPOINT` | tier 0 · `a savepoint failure poisons the enclosing transaction…` — **green until the fix**: the child's `TxRuntime` was a copy, so the parent was never poisoned and the clear was a no-op. Fixed by making the poison a shared box. |
| M5 | `transaction.ts` — add `40P01` to the default retry set | tier 0 · `40001 is on by default…` (4 failed) |
| M6 | `transaction.ts` — full jitter → plain exponential | tier 0 · `full jitter is sleep(random(0, …))` |
| M7 | `handles.ts` — delete the `IndeterminateCommitError` retry guard | tier 0 · `shouldRetry: () => true CANNOT override…` — **green until the fix**: the SQLSTATE check below refused it for an unrelated reason, so the documented hard exclusion was not load-bearing. Fixed by moving all three exclusions above `shouldRetry`. |
| M8 | `handles.ts` — stop detecting the COMMIT window | tier 0 · `a connection lost AFTER COMMIT was written…` |
| M9 | `transaction.ts` — `set_config(…, false)` instead of `true` | tier 0 · `builds one statement for N settings` (3 failed) |
| M10 | `runner.ts` — restore a statement timeout with `'0'` instead of `NULL` | tier 0 · `inside a transaction a timeout is SET LOCAL…` |
| M11 | `runner.ts` — apply the dev guard to no handle | tier 0 · `the outer db inside a transaction throws HandleMisuseError` |
| M12 | `sqlstate.ts` — drop the class-prefix fallback | tier 0 · `an unmodelled SQLSTATE lands on its class ancestor` |
| M13 | `redact.ts` — redact a deadlock's DETAIL | tier 2 · `40P01 surfaces as DeadlockDetectedError, carries PG detail` |
| M14 | `redact.ts` — pass the unique-violation DETAIL through | tier 0 · `keeps the COLUMNS and drops the VALUES — the duplicate-signup leak` |
| M15 | `listen.ts` — `<=` instead of `<` on the payload bound | tier 2 · `the 8000-byte payload limit … at the REAL boundary` |
| M16 | `listen.ts` — stop emitting `gap` after a reconnect | tier 2 · `a killed backend produces reconnect AND gap` |
| M17 | `gucs.ts` — apply session GUCs under a transaction profile | tier 2 · `session GUCs are NOT applied — SHOW is the oracle` |
| M18 | `handles.ts` — allow `db.session()` under a transaction profile | tier 0 · `db.session() is refused under a transaction profile` |
| M19 | `copy.ts` — stop escaping tabs in COPY text | tier 1 · `copyFrom encodes through the codecs and copyTo reads it back` — **green until the run spec was fixed**: it had been pointed at a tier-2 file whose fixture data contains no tabs. |
| M20 | `copy.ts` — `String(value)` instead of `codec.encode` | tier 2 · `both paths load the same rows` (2 failed) |

#### Not done, and uncertain

- **`IndeterminateCommitError` on a real server is pinned at tier 0, not tier 2** — design/12 §6's
  named fallback. The window between "COMMIT is on the wire" and "its response is read" is
  sub-millisecond on a local socket and `pg_terminate_backend` cannot be aimed inside it
  deterministically; the attempt lands either side and is correctly *not* indeterminate. So the
  state machine is pinned on the mock (`commitWritten` + a connection-kind failure) and tier 2 owns
  the **classification** of the real `57P01`, exactly as the risk row prescribes.
- **`.signal(ms)` / `.timeout(ms)` / `.outsideTransaction()` as builder methods**, and
  `.withExecMode()`. All four want `Query` in `src/query/types.ts`, which is B's this round.
- **Tree-shake granularity.** `connect-one-select` is now 69 KB min+gz against design/08 §1.2's
  35 KB. The cause is structural and named in `budgets.json`: `07` §1.3 puts `listen`, `copy*`,
  `diagnose*` and `observe` **on** `Db`, so they are reachable from any handle. A dynamic `import()`
  does not help, because the measurement bundles without code splitting and esbuild inlines it. The
  only real lever is a separate `pg-prime/session` entry point, which contradicts §1.3 — recorded
  rather than done.
- **`@pg-prime/otel`**, the ESLint plugin (`07` §1.5 layer 4) and `pg-prime doctor` are separate
  packages/commands and out of scope, as designed.
- **`test/query/named.test.ts` and `test/query/{insert,stream,explain,executor,prepared,assert-shape}.test.ts`
  were not edited**, but their behaviour is now reached through the session runner. They all pass
  unchanged, which is the strongest available statement that the executor's contract is intact.
- **Conflict-prone files for the integrator**: `src/query/types.ts` (my hunks are the four handle
  interfaces plus one import block and one re-export block — B owns the rest), `src/index.ts`,
  `src/query/executor.ts` (`RunTiming`, `streamBatchesOn`), `src/query/raw.ts`,
  `packages/pg-prime/package.json`, `tools/budgets.json`, `tools/api-snapshot/pg-prime.json`,
  `bench/types/budget.json`, `tools/size-budget.mjs` (one measure field + the optional-peer gate),
  `packages/pg-prime/vitest.config.ts` (one glob), `test/live/{_harness.ts,tsconfig.json}`
  (`TestDecl` gained a timeout argument; the tsconfig gained `test/session`), and
  `test/driver/_fake-pg.ts` (two renamed COPY stubs).

### B — Builder gaps (`03` / `09`)

**Owns:** `packages/pg-prime/src/query/{select,relations,cte,scope,projection,ref,fn,window,ops*,
builder-state}.ts`, the `Query`/scope/relation/CTE types in `src/query/types.ts` (not `Db`/`Tx`/
`Session`/`Queryable`), `src/schema/relations.ts` (FK inference), `src/compile/**` (emitter additions
only), `test/query/**`, `test/live-query/**`, `test/fuzz/**`, `bench/types/**` baselines, `03`
AS BUILT notes. Must not touch `src/query/{run,executor,terminals,prepared,raw}.ts`, `src/driver/**`,
`src/schema/{index*,enum*,schema*}.ts`, or the kit.

**Build:**

1. **`$all`** (`03` §2.1/§4.2): `...u.$all` in a projection is `SELECT` of every column of that alias with
   exact types; whole-object nullability rules of `03` §2.2 apply per column (it is a spread, not a
   group); `omit(u.$all, 'passwordHash')` works because it is a plain record. Measure the type cost — a
   `$`-prefixed member on every scope object is the concern `09` §3.5 raised — and record it.
2. **Relation aggregates** `avg`/`min`/`max` (`03` §2.3's table, `09` §3.5 deferred), same hoisting
   and sharing rules as `sum`.
3. **Typed `RelConfig.where`/`orderBy`** — the declaration callback receives the target table's refs
   without a hand annotation; `03` §4.1 AS BUILT amended.
4. **FK inference** per decision 18; `defineSchema`'s five errors become six.
5. **Joins**: `rightJoin`, `fullJoin`, `crossJoin`, `innerJoinLateral`, `leftJoinLateral` (`03` §2.2):
   right/full make the *left* side's refs nullable in the projection type — the same witness mechanism
   WS4 built for left joins, mirrored; `cross` has no `on`; lateral takes a select builder that may
   reference outer refs, and the compiled SQL is golden.
6. **CTEs**: `withRecursive` per decision 17 (measure first; `withRaw` if it does not fit), `fromRaw`
   (`03` §5). Keep the `pg: any` limit on CTE refs as recorded — it is a `04` §1.3 consequence, not a gap.
7. `03` §2.2/§2.3/§2.7/§4.1/§5 AS BUILT notes; Appendix A regenerated; `09` §3.4/§3.5's deferred lists
   annotated with what landed.

**Tests:** tier 0 goldens for every new SQL shape; type probes (`test/query/types/*.probe.ts`) for `$all`,
nullability under right/full, `withRecursive` row typing, FK inference errors; tier 1 (PGlite) execution
of every new spelling with decoded values compared against a hand-written `sql` query; tier 2 OID
differential on PG 17; the builder fuzzer extended to generate the new joins and `$all` (50k clean on
PGlite and PG 17); `bench:types` before/after on the 10/100/400 fixtures. R10 record with ≥ 10 mutations.

**Gate:** every `09` §3.4/§3.5 deferred item is built or re-recorded with a number; `bench:types` ≤ +2 %
per fixture (the plan's own rule — `08` §5 fails at > 5 %, warns at > 2 %, and B is not allowed to spend
the whole warning band); tier 0 ≤ 5 s; fuzz clean; `package:check` green.

---

## 4. Round B (after round A merges and the formatting commit lands)

### D — Docs (`08` §6.4)

**Owns:** `docs/**` (a private workspace `@pg-prime/docs`, Astro Starlight 0.41 / Astro 7), `tools/
{docs-typecheck,docs-examples,docs-coverage,pooler-matrix}.mjs`, `.github/workflows/{ci.yml (docs job),
docs.yml (Pages deploy)}`, root scripts. Must not touch `packages/**` except to fix a doc-found bug
(recorded).

**Build:** the site skeleton with Pagefind search; content = **getting started** (15 minutes, a fresh
reader, no source: install → schema → `pgPrime` → first query → `migrate generate/apply`), **concepts**
(handles, codecs and decode defaults, relations, the migration model, the shadow ladder, proof and
witness), **guides** (schema DSL, queries, relations, transactions and sessions, `sql` tag, streaming,
LISTEN/COPY, testing with PGlite, migrations end to end, seeding and data migrations, checkpoints,
`pull`/adoption), **operations** (locks and CIC, zero-downtime patterns, poolers — the generated matrix,
timeouts, observability/OTel, troubleshooting by exit code and hazard code), **reference** (hand-curated,
one page per entry point, every exported name from `tools/api-snapshot/*.json` with a signature and a
sentence; the CLI reference generated from `pg-prime migrate --help` output goldens; the hazard-code
table from `src/lint/rules.ts`; the error class tree), **compare** ("why not" Drizzle / Prisma / Kysely /
MikroORM, from `research/` and `01` — factual, dated, no adjectives). `tools/docs-typecheck.mjs` extracts
every fenced `ts`/`tsx` block into a temp project against the built packages on **TypeScript 5.9.3**
(the consumer floor); `tools/docs-examples.mjs` runs `title=` blocks against PGlite; `tools/docs-coverage.mjs`
fails on any golden name without a reference entry; the `docs` CI job runs all three plus `astro build`;
`docs.yml` deploys to GitHub Pages on `main` (enabling Pages is an operator step). Update the README to
link the site and `08` §6.4 AS BUILT.

**Gate (R20):** every block compiles, every example runs, coverage 100 %, `astro build` clean, the four
`08` §6.2 #10 artefacts exist, `docs` job < 4 min.

### P — Perf residue (`08` §5)

**Owns:** `bench/runtime/**`, `bench/compare/**` (new), `bench/runtime/budget.json`, `.github/workflows/
ci-nightly.yml` (bench/compare jobs), `packages/pg-prime/src/{codec,compile/decode.ts}` and the
insert-encode path in `src/query/insert.ts` (measured changes only), `09` §3.7 follow-up notes.

**Build:** (1) download the last ≥ 5 nightly `bench-runtime-report` artifacts (`gh run download`) and
size every `_overDesign` entry from that distribution per R21 — close the ones the measurement clears
(the codegen 1.30 budget is the named candidate), tighten the e2e p95/p99 to runner numbers, and record
the method in `budget.json._why`; (2) the batch-insert encode path (e2e 1.9× budget): profile
`insertMany` 1 000 rows, cut per-value work that is not codec encoding (allocation, param array growth,
per-row bind walking), re-measure; (3) `bench/compare`: the nine cases against `drizzle-orm` and `kysely`
on identical SQL through the same `pg` (Prisma only if its generate/engine step fits in the nightly
budget — record either way), as a nightly job writing a job summary table with absolute numbers and
ratios; (4) the > 25 % regression rule: the nightly compares to the previous run's artifact and opens an
issue via `gh` with both tables, once per regression (dedup by title).

**Gate:** every `_overDesign` entry is re-sized from runner data or deleted; batch insert improved by a
measured amount (or recorded as at its floor with the profile); the comparison table appears in the nightly
summary; `bench:compile` gates unchanged.

---

## 5. Definition of done — v1 completion

- [ ] `07` §0's snippet runs unchanged on a direct connection and through PgBouncer transaction mode; a
      real `40001` is retried, a `40P01` is not, an `IndeterminateCommitError` is never retried.
- [ ] `06` §6.4 lists twelve of twelve commands; `pull` round-trips all four corpus schemas to an empty
      `generate`; a killed backfill resumes from its watermark; a fresh database applies checkpoint + tail.
- [ ] Every item on `09` §3.4/§3.5/§3.6's deferred lists is built or re-recorded with a measurement.
- [ ] `ci.yml` has `lint` (type-aware, < 60 s) and `docs` jobs; `release.yml` dry-run is green;
      `.changeset/` exists with the fixed group; `RELEASING.md` exists.
- [ ] `docs/` builds; every code block compiles on TS 5.9.3; every example runs on PGlite; reference
      coverage is 100 % of the api-snapshot goldens; `08` §6.2 #10's four artefacts exist.
- [ ] `bench/runtime/budget.json` has no `_overDesign` entry that was not sized from ≥ 5 runner runs; the
      comparison run exists in the nightly.
- [ ] Tier 0 ≤ 5 s; tier 1/2 green on PG 15/16/17/18 + PgBouncer; `package:check` green; `bench:types`
      within +2 % of `fb723f4` per fixture.

---

## 6. Risks and fallbacks

| Risk | Signal | Fallback |
|---|---|---|
| `oxlint-tsgolint` cannot consume this repo's TS 7 project references | the type-aware rules error at startup | oxlint without them; the five rules recorded as lost in `08` §3.4 AS BUILT; revisit trigger = a tsgolint release note |
| `pg`'s connection-level COPY API changes under us (decision 9) | adapter tests fail on a `pg` minor | the optional-peer path (`pg-copy-streams`), same public API |
| `IndeterminateCommitError`'s window cannot be hit on a real server | the tier-2 test is flaky or impossible | the seam's `commitWritten` state is pinned at tier 0 on the mock; tier 2 asserts the classification on `57P01`; recorded |
| `$all` or `withRecursive` blow the type budget | `bench:types` > +2 % | `$all` ships as an explicit `all(u)` helper instead of a scope member; `withRaw` replaces `withRecursive` (decision 17) |
| `pull` meets a Tier-M shape the DSL still lacks after the index options | the round-trip's unsupported block is non-empty | the DSL grows it in K4 if it is an option on an existing builder; otherwise it is recorded per corpus schema and the gate is met on the remaining three plus a named residue |
| Four agents' branches conflict at merge | cherry-pick conflicts in `types.ts` / `index.ts` / `package.json` | the ownership lines in §3 are the tie-breaker; the integrator resolves and re-runs every gate before pushing |
| Round B docs go stale against round A's API | `docs-typecheck` fails after a later merge | R20 — it fails CI, which is the point |
