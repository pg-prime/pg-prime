# 13 — v1 close-out plan

**Status:** plan, 2026-08-30. Format of `11` and `12`: §0 what it is, §1 decisions, §2 rules,
§3 contracts, §4 the integrator's own item, §5 integration + definition of done.

## 0. What this is

`12` §5 closed with a list headed *what is still open after this plan*. Minus the three operator
switches (npm trusted publisher per package, *Allow GitHub Actions to create and approve pull
requests*, Pages source), which only a human can flip, every line on it is here:

| Id | Workstream | What | Owner |
|---|---|---|---|
| **T** | `@pg-prime/testing` | The package `08` §1 describes and `docs/guides/testing` already documents by hand: `createMockPool`, the PGlite fixture with its bridge, `requiresConcurrency`, the real-server fixtures, `expectSql`. | agent, worktree |
| **X** | `@pg-prime/create` | `npm create @pg-prime` — a scaffold that IS the getting-started page, proved by installing it from tarballs and running it against a server. | agent, worktree |
| **E** | docs tier 2 + floor note | `streamBatches`, COPY, LISTEN, `CancelRequest` and the pooler blocks executed against a real PostgreSQL in CI (`pg-only`), every remaining `no-run` stating why, and the Node ≥ 22.15 `module.registerHooks` note. | agent, worktree |
| **Q** | `ratioP50Paired` gate | Five runner samples exist as of 2026-08-29 (33242675982, 33246087296, 33246453272, 33246810860, 33271626165); size the paired gate from them and retire the two widened decode budgets. | integrator |

Nothing here changes the runtime's public API except by addition of two packages. `12`'s rules
R18–R21 stay in force.

## 1. Decisions

1. **`@pg-prime/testing`'s surface is the docs page's vocabulary.** Names: `createMockPool`,
   `startPglite`, `startPostgres`, `scratchDatabase`, `requiresRealPostgres(it, reason)`,
   `requiresConcurrency(it)`, `expectSql`. Runner-agnostic: the guards take the runner's `it`
   (anything shaped `{ (name, fn, timeout?): void; skip: same }`) — the package never imports
   vitest. The one environment variable is the repo's own, `PG_PRIME_TEST_URL`; the page's
   `TEST_DATABASE_URL` is renamed to it.
2. **The PGlite bridge moves into the package.** `packages/pg-prime-testing/src/pglite-bridge.ts`
   is the one copy; `packages/pg-prime/test/live/_pglite-bridge.ts` becomes a re-export by
   *relative source path* (`../../../pg-prime-testing/src/pglite-bridge.js`), so there is no
   workspace dependency cycle (`pg-prime` dev-depending on a package that peer-depends on it).
   Tier 1's pass count must not move. `tools/docs-examples.mjs` bundles through the re-export
   unchanged. The version probe that today needs `pg` goes through PGlite's own handle instead,
   so `startPglite()` needs no wire client.
3. **Peers.** `pg-prime` is a required peer (`>=0.0.0`; `workspace:*` dev). `@electric-sql/pglite`
   and `@testcontainers/postgresql` are optional peers, imported lazily from the fixture that
   needs them, with a sentence naming the missing package when the import fails. `size-budget`
   lists optional peers in the budget entry, as `pg` is listed for `pg-prime`.
4. **`@pg-prime/testing` builds like the kit**: `tools/build-package.mjs`, tsc, `isolatedDeclarations`,
   the `types@<5.9` stub first in every `exports` subpath, `files: ["dist"]`, ≤ 300 KB unpacked
   (`08` §1). Versioned independently (`08` §1.3 stands).
5. **The scaffold IS the getting-started page.** Flat layout — `schema.ts`, `db.ts`,
   `pg-prime.config.ts`, `index.ts` (the page's `first-query.ts`), `migrations/`, `tsconfig.json`
   (the page's block plus `outDir`/`include`), `package.json`, `.gitignore`, `.env.example`,
   `README.md`; with tests: `vitest.config.ts`, `test/setup.ts` (PGlite via `@pg-prime/testing`),
   `test/index.test.ts` (the transaction-per-test fixture from `guides/testing`). A tier-0 test
   asserts each template that has a docs block is **byte-equal** to that block; the page is the
   source of truth. `templates/` is ignored by oxfmt and oxlint for that reason.
6. **`@pg-prime/create` joins the fixed version group** (`.changeset/config.json`:
   `["pg-prime", "@pg-prime/kit", "@pg-prime/create"]`). Deviation from `08` §1.3 with a reason: a
   scaffolder pins what it scaffolds, and a pin generated at build time from the workspace
   versions is exact only if the scaffolder ships every time they do. `@pg-prime/testing` stays
   independent. `RELEASING.md` §0's table says so.
7. **`@pg-prime/create` builds with tsc too** — `08` §1's "esbuild" is superseded the way `08` §3.1
   AS BUILT superseded it for the kit: a zero-dependency package has nothing to inline.
   `tools/build-package.mjs` learns to copy a package's `templates/` into `dist/templates/`
   (generic: if the directory exists). Bin `create-pg-prime`, ≤ 500 KB unpacked.
8. **The CLI.** `create-pg-prime [dir] [--yes] [--pm npm|pnpm|yarn|bun] [--testing|--no-testing]
   [--install|--no-install] [--git|--no-git]`. Prompts through `node:readline/promises`; a non-TTY
   stdin implies `--yes`; defaults are: the package manager detected from `npm_config_user_agent`,
   tests **on**, install on, git on. A non-empty directory is refused with a sentence. `--help`'s
   table is goldened on the docs reference page exactly as the kit's are.
9. **The scaffold gate has two halves.** `tools/create-smoke.mjs` (in `package:check`): pack the
   four packages, scaffold with `--yes --no-install --no-git`, install the scaffold from the
   **tarballs**, `tsc --noEmit` it. The package's own tier-2 suite (`test:pg`, so it rides the
   `pg` job and the nightly matrix through `pnpm -r`): the same scaffold against a scratch
   database — `pg-prime migrate generate --name init`, `migrate apply`, `migrate status` exit 0,
   run `index.ts`, and run the scaffold's own vitest on PGlite. The page's terminal transcripts
   are compared against what those commands print, modulo the volatile fields the kit's own
   goldens already mask.
10. **Docs tier 2.** A fence attribute `pg-only` marks a `title=` block that runs against a real
    server; `pg-only="pgbouncer"` runs it with `DATABASE_URL` set to the PgBouncer URL. The PGlite
    gate (`docs:examples`) skips them; `docs:examples:pg` runs them, one **scratch database per
    example** from `PG_PRIME_TEST_URL` (pgbouncer blocks share the pooled database and are isolated
    by `drop schema public cascade`, since PgBouncer's `DB_NAME` is fixed). It runs in the CI `pg`
    job and every nightly `pg-matrix` leg, after `pnpm build`.
11. **R22 (new): every `no-run` states why.** A `no-run` block's first line is `// no-run: <reason>`
    (or the attribute carries `no-run="<reason>"` for blocks that are fragments). `docs-coverage`
    fails on a `no-run` with no reason. E audits all 63 and reclassifies: real-server → `pg-only`;
    pooler → `pg-only="pgbouncer"`; fragments and excerpts stay `no-run` with the reason written.
12. **The Node floor is documented, not raised.** The kit's `engines` stays `>=22.12`. The `.js` →
    `.ts` sibling resolution (`12` F2 item j) is described where config/seed loading is
    documented as Node ≥ 22.15 (`module.registerHooks`), with what happens below it.
13. **Root scripts go recursive** (done in this plan's commit): `test` and `test:live` become
    `pnpm -r --if-present`, and the kit's `test` alias goes — its suite is tier 2 and is `test:pg`.
    So a new package's `test` / `test:live` / `test:pg` ride CI's `unit`, `live` and `pg` jobs with
    no workflow edit; `typecheck`, `build` and `test:pg` were already recursive.
14. **Q's rule.** The paired budget is `max × 1.05` over the five runner samples, rounded up to
    0.05, gated **only if** the paired statistic's spread across the five is no wider than the
    unpaired one's. If it is gated, the two unpaired lines (2.95 / 1.75) become reported, not
    gated. If it is not, that is recorded and the lines stay — R21 forbids sizing from anything
    else.

## 2. Rules

R18–R21 (`12` §2) apply unchanged. R22 is decision 11.

Integration lessons from `12`, restated as rules for the three branches:

- The local gate list is **all** of: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, tier 0
  (`pnpm test`), tier 1 (`pnpm test:live`), tier 2 (`pnpm test:pg` with `PG_PRIME_TEST_URL`
  set), `pnpm build`, `pnpm package:check`, `pnpm bench:types`, `pnpm bench:compile`,
  `pnpm docs:check`. Chain them with `&&`. A branch is handed over green on every one.
- Generated files stay out of the formatter (`.oxfmtrc.json` `ignorePatterns`): api-snapshot
  goldens, `unsupported-typescript.d.ts`, kit envelope goldens, bench reports, and now
  `packages/pg-prime-create/templates/**`.
- Budgets move by measurement and the reason goes in the file: `tools/budgets.json` gets a
  `packages` entry per new package (designed value beside the budget); `bench/types/budget.json`
  is untouched unless `pg-prime`'s own `.d.ts` grows.
- No `Co-Authored-By` trailers, no "Generated with" lines, anywhere.

## 3. Contracts

Every contract lists the files a branch OWNS. A shared file appears under exactly one owner or
under **integrator**; the other branches do not edit it and record what they need in their RESULT.

### T — `@pg-prime/testing`

**Builds** (`08` §1 table, §4.1, §4.2; `docs/guides/testing`):

- `src/mock-pool.ts` — `createMockPool(script?)`: a `PgLikePool`-shaped object that records every
  `{ text, values, mode, binary, rowMode }` and replays scripted result sets, with the SQLSTATE
  error path scriptable. Usable as `pgPrime({ pool })`.
- `src/pglite-bridge.ts` (moved, decision 2) and `src/pglite.ts` — `startPglite()` returning
  `{ url, versionNum, version, kind: 'pglite', stop() }`, TZ pinned exactly as the harness pins it.
- `src/postgres.ts` — `startPostgres()` through `@testcontainers/postgresql` (optional peer,
  skipped loudly without Docker) and `scratchDatabase(adminUrl)` for an existing server: creates
  `pgprime_test_<random>`, returns `{ url, drop() }`, refuses to drop anything not so named.
- `src/guards.ts` — the two guards, decision 1.
- `src/expect-sql.ts` — `expectSql(query, { text, values? })` via `compileOnly`, whitespace-
  normalised, throwing an `Error` whose message is a unified diff.
- Tests: tier 0 for the mock and `expectSql`; tier 1 for the PGlite fixture (its own
  `vitest run --project live`); tier 2 for `scratchDatabase` and — when Docker answers —
  `startPostgres`.
- `docs/src/content/docs/guides/testing.mdx` rewritten around the package: the `guards.ts`,
  `namespace.ts` and `test-db.ts` blocks become executed examples or are replaced by ones that
  are; the "reserved package name" aside goes; the paragraph on `no-run` says those blocks now run
  on the docs gate's real-server tier (`pg-only`, decision 10). New `reference/testing.mdx` with
  `apiEntry` so `docs-coverage`'s 100 % rule covers the package.
- Gates: the package added to `tools/api-snapshot.mjs`, `check-dts.mjs`, `emit-parity.mjs`,
  `pack-smoke.mjs` (install the tarball; the consumer exercises the mock pool and `expectSql`),
  `tools/budgets.json`, `knip.json`, `tools/docs-coverage.mjs` and `docs-typecheck.mjs` package
  lists, `docs/astro.config.mjs` sidebar (one entry). A changeset (`@pg-prime/testing: minor`).

**Owns:** `packages/pg-prime-testing/**`, `packages/pg-prime/test/live/_pglite-bridge.ts`,
`packages/pg-prime/test/live/_pglite.ts` (only what decision 2 needs), `guides/testing.mdx`,
`reference/testing.mdx`, its one line in each shared list above.

**Does not touch:** root `package.json`, `ci.yml`, `docs/README.md`, `tools/docs-examples.mjs`,
`tools/docs-blocks.mjs`, `tools/build-package.mjs`, `getting-started.mdx`.

### X — `@pg-prime/create`

**Builds** (`08` §1 table; decisions 5–9):

- `src/cli.ts` (bin), `src/scaffold.ts`, `src/prompts.ts`, `src/versions.ts` (generated at build
  from the workspace `package.json`s — a build step in the package, not a committed file),
  `templates/**` (decision 5).
- `tools/create-smoke.mjs` and its `&& pnpm create-smoke` in the root `package:check` script
  (X owns that one root-script line). `tools/build-package.mjs`: the `templates/` copy.
- The package's tier-0 suite (template ↔ docs-block equality, argument parsing, refusal of a
  non-empty directory, non-TTY implies `--yes`) and its tier-2 suite (decision 9). The tier-2
  suite builds what it needs in a `globalSetup`, as the kit's does, because the `pg` job runs
  `pnpm test:pg` on an unbuilt checkout.
- `guides/getting-started.mdx` gains the `npm create @pg-prime@latest my-app` path at the top of
  *Install*, with the manual steps kept. New `reference/create.mdx` (flags table goldened against
  `--help`). `.changeset/config.json` fixed group (decision 6), `RELEASING.md` §0 row, a changeset
  (`@pg-prime/create: minor`). `.oxfmtrc.json` + `.oxlintrc.json` ignore `templates/**`.
- Gates: the same shared lists as T, one line each: `api-snapshot.mjs`, `check-dts.mjs`,
  `emit-parity.mjs`, `tools/budgets.json`, `knip.json`, `docs-coverage.mjs` (package list **and**
  the `--help` golden check, which today is hard-wired to the kit binary), `docs-typecheck.mjs`,
  `docs/astro.config.mjs` (one entry). `pack-smoke.mjs` is **not** edited — `create-smoke.mjs`
  packs its own list.

**Owns:** `packages/pg-prime-create/**`, `tools/create-smoke.mjs`, `tools/build-package.mjs`,
`getting-started.mdx`, `reference/create.mdx`, `.changeset/config.json`, `RELEASING.md`, the
`package:check` line, its one line in each shared list.

**Does not touch:** `ci.yml`, `docs/README.md`, `tools/docs-examples.mjs`, `tools/docs-blocks.mjs`,
`tools/pack-smoke.mjs`, `guides/testing.mdx`, anything under `packages/pg-prime/**` or
`packages/pg-prime-kit/**` (a kit bug found by the scaffold e2e is recorded, not fixed here).

### E — docs tier 2, the audit, the floor note

**Builds** (decisions 10–12):

- `tools/docs-blocks.mjs`: `pg-only` parsed; `isExample` excludes it; `isPgExample(block)` new.
- `tools/docs-examples.mjs --pg`: `PG_PRIME_TEST_URL` required (`PG_PRIME_TEST_PGBOUNCER_URL` for
  the pgbouncer blocks, skipped with a sentence if unset); scratch database per example, created
  from the admin URL and dropped after, `DATABASE_URL` pointing at it; the same one-line URL
  substitution rule, the same per-example process and timeout. Root script `docs:examples:pg`.
- The audit of all 63 `no-run` blocks, recorded as a table in the RESULT (page:line, reason,
  disposition). Executed real-server examples for: `copyFrom` / `copyFromRaw` / `copyTo`
  (`guides/copy`), cross-session LISTEN/NOTIFY including `notify-on-commit` (`guides/listen-notify`),
  `CancelRequest` (`guides/cancellation` `two-classes.ts`), `diagnosePooler` (`guides/observability`),
  the pooled/direct/check-pooler blocks (`operations/poolers`, `pg-only="pgbouncer"`; the Neon
  block stays `no-run` with the reason), and a **titled** `streamBatches` example
  (`guides/queries` — the block at ~L1044 has no `title=` and so never ran; on PGlite if the bridge
  carries the cursor, `pg-only` if not — measured, and the answer recorded).
- R22 enforcement in `tools/docs-coverage.mjs`: a `no-run` without a reason fails.
- `ci.yml` `pg` job and `ci-nightly.yml` `pg-matrix`: `pnpm build` then `pnpm docs:examples:pg`.
- `docs/README.md`: the `pg-only` directive and R22 documented in *Block directives* and
  *Runnable examples*.
- The floor note (decision 12): `packages/pg-prime-kit/README.md` (the type-stripping paragraph),
  `reference/config.mdx` (loading), `guides/data-migrations.mdx` (the specifier paragraph near
  L465), `guides/migrations.mdx` (L20). Prose only; no kit source.

**Owns:** `tools/docs-blocks.mjs`, `tools/docs-examples.mjs`, the R22 check in
`tools/docs-coverage.mjs` (T and X add package-list lines to the same file — E's edit is a new
function plus one call, placed at the end of the file), `docs/README.md`, `.github/workflows/**`,
the root `docs:examples:pg` script line, every docs page named above, the kit README paragraph.

**Does not touch:** `guides/testing.mdx`, `guides/getting-started.mdx`, `reference/**` other than
`config.mdx`, any `packages/*/src/**`, `tools/pack-smoke.mjs`, `tools/build-package.mjs`.

### RESULT sections

Each branch appends its report under its own heading below — nowhere else in this file — as
`12` §3 did: what was built, the numbers from every gate, what diverged from the contract and
why, what was found and not fixed.

#### T — RESULT

_(pending)_

#### X — RESULT

_(pending)_

#### E — RESULT

_(pending)_

## 4. Q — the `ratioP50Paired` gate (integrator)

Inputs: the `bench-runtime-report-*` artifacts of the five runs in §0. Per decision 14: read
`decode.*.ratioP50Paired` for the closure-tree and codegen pairs against both mappers; compute
each statistic's spread (max/min − 1) paired and unpaired; if paired ≤ unpaired, add
`ratioVsUncheckedMapperP50Paired` / `ratioVsCheckedMapperP50Paired` (and the codegen pair) at
`max × 1.05` rounded up to 0.05, gate them in `bench/runtime/run.mjs`, demote the unpaired lines
to reported, and write the five numbers into `budget.json`'s `decode._why`. Otherwise record the
spreads in `_why` and change nothing else.

#### Q — RESULT

_(pending)_

## 5. Integration and definition of done

Order: **T, then X, then E** (X's scaffold `--testing` needs T's package on `main`; E's
`pg-only` prose in `guides/testing` is written by T in advance, decision 10). Each branch is
cherry-picked onto `main`, the shared-list conflicts resolved per §3 ownership, the lockfile
regenerated once, and the full gate list of §2 re-run from scratch before the push. Q lands last,
as its own commit.

Done when, on one `main` commit:

- [ ] `pnpm -r build` produces four publishable packages; `pnpm package:check` (now including
      `create-smoke`) is green; `size-budget` prints `@pg-prime/testing` ≤ 300 KB and
      `@pg-prime/create` ≤ 500 KB beside their design values.
- [ ] `pnpm test` runs three tier-0 suites, tier 0 of `pg-prime` still ≤ 5 s; tier 1 of `pg-prime`
      has the same pass count as `9be7192` (1 790) with the bridge served from the package.
- [ ] `docs:check` is green with `guides/testing` and `getting-started` executed; `docs:examples:pg`
      is green on PostgreSQL 17 + PgBouncer locally and on the CI `pg` job; every `no-run` states
      why (R22).
- [ ] The scaffold e2e (decision 9) is green on the `pg` job and on every nightly leg.
- [ ] `bench/runtime/budget.json` carries Q's result either way, with the five-run numbers.
- [ ] CI green, nightly green, and the *what is still open* list of `12` §5 is reduced to the
      three operator switches.
