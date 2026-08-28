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

### K4 — RESULT (2026-08-29)

**Done, and the gate came out one better than §6 sized it: `pull` round-trips ALL FOUR corpus
schemas with an EMPTY unsupported block, not three plus a named residue.**

One correction to this plan's own arithmetic before the numbers: §3 K4 item 4 calls `pull`
"`06` §6.2's missing twelfth command". §6.2's twelve are the ten design/11 K2b shipped plus
`checkpoint` and `db seed`, so its twelfth is **`db seed`**; `pull` is a thirteenth that §6.2
never listed and that `00` decision 5 specifies. All thirteen ship. Recorded in `06` §6.5.

**Numbers.** Kit suite **379 → 411** (405 passed + 6 pooler-gated skips), 51 → 56 files, green on
**all four majors**: PG 15 `:54335` 64.4 s · PG 16 `:54336` 44.4 s · PG 17 `:54333` 38.6–69.8 s ·
PG 18 `:54332` 45.1 s. `pnpm test` (tier 0) 46 → 47 files, 778 → **790 tests**, **4.69–5.32 s**
across five runs on a busy design machine (ceiling 5.0 s; the run is transform-dominated and the
new file's own twelve tests measure 4 ms) · `pnpm test:live` 80 files, **1 519 passed + 2
skipped** · root `pnpm typecheck` clean · `pnpm build` clean ·
`pnpm api-snapshot` `@pg-prime/kit` 162 → **174 values / 166 types**, `pg-prime` **234v/234t**
(root) and **51v/80t** (`./schema`) · `pnpm package:check` green (8/8 size gates, emit parity
0 FAIL, `check:dts` clean, tree-shake ok after one re-baseline, publint/attw clean, the tarball's
`pg-prime --help` runs).

11 new source files (**2 984 lines**: `src/data/{batch,lag}.ts`, `src/seed/{run,db}.ts`,
`src/checkpoint/checkpoint.ts`, `src/pull/{pull,emit-ts,parse,tier-r}.ts`,
`src/cli/commands/{checkpoint,seed,pull}.ts`) plus one new DSL file
(`packages/pg-prime/src/schema/objects.ts`); 6 new test files (**1 428 lines**) and 4 new
envelope goldens.

| # | deliverable | files |
|---|---|---|
| 1 | the `-- pg-prime:batch` runner: directive, loop, watermark, lag, `status`, the working template | `src/runner/files.ts` (`BatchDirective`), `src/data/{batch,lag}.ts`, `src/history/store.ts` (`data_progress`), `src/runner/{run,status}.ts`, `src/cli/commands/{apply,status}.ts`, `src/generate.ts` (`dataMigrationSql`), `src/config/{define,load}.ts` (`replicas`) |
| 2 | `db seed`, `.sql` + typed `.ts`, sets, the production refusal | `src/seed/{run,db}.ts`, `src/cli/commands/seed.ts`, `src/config/{define,load}.ts` (`seeds`) |
| 3 | checkpoints: write, the fresh-database jump, `verify --from-checkpoint`, drift naming | `src/checkpoint/checkpoint.ts`, `src/cli/commands/{checkpoint,verify,status}.ts`, `src/runner/{run,status}.ts`, `src/history/store.ts` (`recordSuperseded`, `recordCheckpoint`), `src/plan/plan.ts` (the `checkpoint` directive) |
| 4 | `pull` | `src/pull/{pull,emit-ts,parse,tier-r}.ts`, `src/cli/commands/pull.ts`, `src/cli/main.ts` (the noun table) |
| 5 | the DSL and its emitter half | `packages/pg-prime/src/schema/{extras,column,objects,index}.ts`, `packages/pg-prime/src/index.ts`, kit `src/schema/{emit,types}.ts`, `src/config/load.ts`, `src/generate.ts` (`annotationHints`) |
| 6 | AS BUILT notes | `06` §3.2 · §4.5 · §6.4 · **§6.5** (new) · **§7.1** (new), `05` §2.3 · §2.4 · §5.1, `00-overview`, the kit README |

#### The `pull` gate, per corpus

Every row: load the committed corpus → `pull` through the binary → `pull` again (byte-identical)
→ `migrate generate` against **the same database** → `up_to_date`. "Build from empty" is a second
`generate` against a fresh database, which produces the one plan a pulled schema can produce and
proves it on a clone; `--dump-oracle strict` is asked for only where the schema has no Tier-R
objects, because the proof's clone gets the plan's DDL and the desired shadow also gets `sql/`
(`06` §3.8), so on a schema with views `pg_dump` is *expected* to differ by exactly those.

| schema | schemas | pulled objects | `sql/` repeatables | unsupported | `generate` | build-from-empty |
|---|---|---|---|---|---|---|
| chinook | 1 | 11 table | 0 | **0** | `up_to_date` | proof passed, D10 **strict** `passed` |
| northwind | 1 | 14 table | 0 | **0** | `up_to_date` | proof passed, D10 **strict** `passed` |
| adventureworks | 11 | 68 table, 6 domain, 36 sequence, 2 extension, 10 schema | 93 (87 view, 2 matview, 3 function, 1 prelude) | **0** | `up_to_date` | proof passed, D10 `warn` |
| pagila | 1 | 22 table (incl. a RANGE-partitioned parent and 7 children), 13 sequence, 2 domain, 1 enum | 33 (9 function, 15 trigger, 7 view, 1 matview, 1 prelude) | **0** | `up_to_date` | proof passed, D10 `warn` |

§6's fallback row sized this at "three plus a named residue". The four shapes that would have been
that residue were each an option on an existing builder and were built instead — `t.raw(pgType)`,
`primaryKey({ name })`, `clusterOn()`, `partitionBy()`/`partitionOf()` — together with the three
standalone declarations `pgDomain` / `pgSequence` / `pgExtension`, which are **Tier-M facts the
differ would otherwise DROP out of any adopted database**. That is the bar the additions were
judged against, and it is a correctness argument rather than a convenience one.

#### `bench:types` — before / after

Not one per-declaration or per-query number moved, on either compiler. That is the property
design/12 §3 K4 asks for ("runtime-metadata-only additions must not move the instantiation
counts"), and it holds exactly:

| metric | before | after |
|---|---|---|
| instantiations / column (5.9.3 · 7.0.2) | 3 · 3.08 | **3 · 3.08** |
| instantiations / table | 36 · 37 | **36 · 37** |
| instantiations / declared relation | 32.5 · 32.5 | **32.5 · 32.5** |
| instantiations / table, all row shapes | 342 · 387 | **342 · 387** |
| marginal instantiations / query (25/100/300 tables) | 40 | **40** |
| schema-size independence ratio | 1.000 | **1.000** |

Three numbers did move, all by a **constant**, and the constant is the point: the
`fixedSchemaRegistryTouch` family on TS 7.0.2 rose by exactly **+59** at 25, 100 *and* 300
tables (16 395 → 16 454, 24 050 → 24 109, 44 450 → 44 509), with `perTable` unchanged at 102.1 —
i.e. the new exported declarations are checked once, not once per table. Headline: 80 485 →
80 822 on 5.9.3 (**+0.42 %**) and 131 388 → 131 560 on 7.0.2 (**+0.13 %**), both far inside the
+2 % gate. `.d.ts` bytes 377 261 → 389 448 (+3.2 %), budget 409 600.

One packaging budget moved: `treeshake.root-import-all` 52 224 → **53 248 B** by
`tools/budgets.json`'s own rule (`min(design, ceil(measured/1024)*1024)`), +1 182 B measured,
still **2.3× below** design/08 §1.2's 122 880. `connect-one-select` and `full-crud-tx` grew by
+48 B and +46 B *inside* their existing budgets, which is the evidence that the new declarations
are not reachable from a program that only opens a handle and runs a select.

#### Divergences from the brief, with reasons

| # | Brief / design says | Built | Why |
|---|---|---|---|
| 1 | `index(cols, { using, where, include, nullsNotDistinct })` with per-column `{ column, desc, nulls, opclass }` | `index(name, opts?)` / `uniqueIndex(name, opts?)` **plus** the four chained methods, with the item objects on `.on(...)` | `05` §2.4's built spelling is `index('name').on(...)` and `06`/`12` §0 say a decision recorded in `05` is not re-opened here. Both option forms exist; the name stays first because an index's name is the thing a migration renames |
| 2 | `05` §2.4 spells per-column options as `t.b.desc().nullsLast()` | item objects — `{ column: t.b, desc: true, nulls: 'last' }` | `Ref` is the hottest type in the package (`[REFS]` holds one per column of every table). Three methods on it are paid for by every schema in every program, for a feature that appears in a handful of index declarations. Recorded in `05` §2.4 AS BUILT |
| 3 | K4 owns "**only** the index options and the two `renamedFrom` spellings" in `packages/pg-prime/src/schema/` | five more additions: `t.raw`, `primaryKey({ name })`, `clusterOn`, `partitionBy`/`partitionOf`, and `pgDomain`/`pgSequence`/`pgExtension` | Each is a **Tier-M fact the differ already models**, so a DSL that cannot declare it makes `pull` emit a schema whose first migration DROPS it. §6's own fallback row anticipates growing the DSL "when it is an option on an existing builder"; the three standalone declarations are the exception to that phrasing and are justified by the same DROP argument. All are non-generic runtime metadata — see the bench table |
| 4 | `pull` emits `from 'pg-prime'` | `from 'pg-prime/schema'` (+ `'pg-prime/sql'` when a CHECK or a partial index needs `sql.unsafeRaw`) | Both are documented public subpaths, and it keeps the pulled file's imports off the root barrel, which `S` owns this round. The names are exported from the root too |
| 5 | `verify --from-checkpoint` "replays from the newest checkpoint" | built, and the **default is OFF** | `verify` always replays into a fresh ephemeral database, which is exactly §4.5's jump condition — `auto` would silently turn every `verify` into a partial replay reported as a full one. `--from-checkpoint` with no checkpoint on disk is still refused |
| 6 | §4.5: an existing database "ignores checkpoints entirely" | ignoring is **recorded**, as `superseded` | Left pending, a checkpoint makes `status` exit 5 for ever and `check` fail on every commit after it landed. Left absent, §5.1 step 5 cannot tell a jumped file from a deleted one |
| 7 | §7's batch example is `UPDATE … WHERE id IN (SELECT … LIMIT n)` | the template writes a **keyset** batch; both shapes run | The `IN (SELECT … LIMIT n)` form has no watermark, so every iteration re-scans from the top of the table (O(N²/n) row reads, each batch slower than the last) and a crash leaves nothing to resume from. A statement with no `rows_done` column still falls back to the command tag, which IS §7's shape |
| 8 | §7: `data_progress` "persisted after each batch" | written **inside** the batch's transaction | Strictly stronger and, unlike §5.4's DDL, available here — a data migration's work is ordinary DML. It is what makes R15's "never restarts" an invariant instead of a likelihood |
| 9 | — | a partition child is `CREATE TABLE` + `ALTER TABLE parent ATTACH PARTITION`, not `CREATE TABLE … PARTITION OF` | Found by pagila **on PG 18**: `PARTITION OF` clones the parent's constraints *with their names*, and PG 18 catalogues NOT NULL as a named `pg_constraint` row, so the next `generate` planned a rename of an inherited constraint, which PostgreSQL refuses. `pg_dump` uses the same two-step form |
| 10 | — | `pull` writes `sql/000_prelude.sql` containing `SET check_function_bodies = false` when the schema has functions | A `LANGUAGE sql` body is parsed at CREATE time, so a function that calls another cannot be created before it — and the call graph is not in `pg_depend` for non-atomic SQL bodies, so there is no order to sort them into. `pg_dump` emits exactly this line in its own preamble |
| 11 | design/11 K2b: "the emitter does not rewrite `defaultSql`" | one exception, `remapNextval` | A `serial`-shaped column's `nextval('public.s'::regclass)` pointed at the *real* sequence under a temp-schema shadow, so the desired IR silently lost the `column → sequence` edge: a fingerprint difference with **no delta**. The rewrite parses the `regclass` literal as a qualified name and fires only when it names a sequence the registry declares |

#### R10 — fifteen mutations, fifteen caught (one after a test was added)

PG 17 (`:54333`) unless stated; the suite named is the one run, and each mutation was reverted
before the next.

| # | file · mutation | caught by |
|---|---|---|
| 1 | `data/batch.ts` — delete `if (progress.watermark !== null) watermark = progress.watermark` | `data/batch.test.ts` ×2 — "expected '3000' to be '50000'" |
| 2 | `history/store.ts` — `dataProgressSql` writes `rows_done` as `0` | `data/batch.test.ts` ×2 — the committed watermark and the committed rows stop agreeing |
| 3 | `data/batch.ts` — swallow `options.onInfo?.(…)` in `waitForLag`'s no-replica branch | `data/batch.test.ts` — "expected [] to have a length of 1" |
| 4 | `runner/run.ts` — `const resumedBatch = false` | `data/batch.test.ts` — `applied[0].batch.resumed` |
| 5 | `runner/files.ts` — `first("batch")` → `first("batches")` | `data/batch.test.ts` ×8 |
| 6 | `runner/files.ts` — ignore `max-iterations` | `data/batch.test.ts` — the directive parser |
| 7 | `runner/run.ts` — drop `superseded` from `isSettled` | `checkpoint/checkpoint.test.ts` — the second apply on a jumped database exits 4 |
| 8 | `runner/run.ts` — jump even when `rows.length > 0` | `checkpoint/checkpoint.test.ts` ×3 |
| 9 | `checkpoint/checkpoint.ts` — `exact: true` unconditionally | `checkpoint/checkpoint.test.ts` — the drift report |
| 10 | `seed/run.ts` — remove the `production` refusal branch | `seed/seed.test.ts` |
| 11 | `seed/run.ts` — `--set` never collects the set's files | `seed/seed.test.ts` |
| 12 | `pull/emit-ts.ts` — drop `.nullable()` from the column chain | `pull/roundtrip.test.ts` ×4 |
| 13 | `pull/parse.ts` — drop `ON DELETE` / `ON UPDATE` from the FK recogniser | `pull/roundtrip.test.ts` ×2 (adventureworks, pagila) |
| 14 | `schema/emit.ts` — do not emit `ALTER TABLE … CLUSTER ON` | `pull/roundtrip.test.ts` (adventureworks) |
| 15 | `schema/emit.ts` — drop `DESC` from an index item | **NOT caught at first.** `roundtrip.test.ts` builds database B from A's extracted IR, so an option the emitter drops is missing from *both* sides and `pg_dump` agrees with itself. `emit.test.ts` gained an exact-text assertion for every index option, and the mutation is caught by it |

One earlier attempt (`const size = BATCH_DEFAULTS.size` in `parseBatch`) did not compile once
mutated and was rewritten as #5 before being counted.

#### Not done / uncertain

- **`renamedValues`** on `pgEnum` (`ALTER TYPE … RENAME VALUE`, `05` §3.2) is still not built.
  The four `renamedFrom` spellings all are, and `generate` reads all four.
- **`pull` cannot express**, and records as residue when it meets them: expression indexes,
  `WITH (…)` / `TABLESPACE` on an index, `EXCLUDE` constraints, `NOT VALID` constraints,
  composite types, generated columns, column collations, unlogged tables. None appears in the
  four corpora; each has an exact `reason` string and a `pull.report.json` entry.
- **`pull` on shadow tier 3 is untested.** The round-trip runs on tier 2 because the corpus
  databases have `CREATEDB`. Two tier-3 text paths were fixed here (`remapTypeQualifier`,
  `remapNextval`) and are covered by `schema-emit/roundtrip.test.ts`'s tier-3 case, but nobody
  has run `pull` → `generate` as a `NOCREATEDB` role.
- **An extension cannot be normalised in shadow tier 3** and now says so with a
  `shadow_extension_fixed_schema` warning. This is `06` §3.2's stated constraint, not a
  regression; it is why `pgExtension` is deliberately absent from the shared emitter fixture,
  with the reason written in the fixture.
- **The batch runner's lag wait is unbounded** by design (see `06` §7.1). An operator who wants
  it to stop kills the process; the watermark is committed, so the next `apply` resumes.
- **`--offline` / shadow tier 4 stays refused**, per decision 14, and `06` §3.2 AS BUILT now says
  why at length: checkpoints give an IR of a *past* state, never IR(desired), and IR(desired) is
  a function of a database by construction (`11` §1.5).
- **`db seed` has no `--dry-run`.** `--list` prints what would run; actually rehearsing a seed
  would mean opening a transaction and rolling it back, which is a different feature.

---

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
