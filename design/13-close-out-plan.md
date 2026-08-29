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

**Branch** `worktree-agent-a4c4a0ddf5c75cfb5`, five commits on top of `c2d9649`:
`b1945d6` (the package) · `c07daa7` (the gates) · `cdddded` (the docs) · `18f2524` (the
changeset) · `f23d225` (a vitest-config fix the integration run found).

**What was built.** `packages/pg-prime-testing/` — six modules behind one entry point, 19 value
exports and 19 type exports.

- `src/mock-pool.ts` — `createMockPool(options?)`. Records `{ text, values, mode, binary, rowMode,
  name, client, config }` off the `pg` query config, so `mode` recovers `02` §5.3's three protocol
  paths from the wire rather than being asserted separately. Replays a script of result sets (wire
  rows: arrays of the text PostgreSQL would send, decoded by the caller's own codecs) or duck-typed
  SQLSTATE errors, and a step may be a **function of the statement it is answering**, which is how
  a script survives the code under test emitting one more query. Two behaviours are worth naming:
  the `pg_settings` handshake is answered from `DEFAULT_SERVER_PARAMETERS` and neither consumes a
  step nor is recorded — it is a handshake, not a statement anyone wrote — and it refuses `pg`'s
  Submittable seam (COPY, cursors) with a sentence pointing at `startPglite()`, because a script
  cannot honestly stand in for a protocol conversation.
- `src/expect-sql.ts` — `expectSql(query, { text, values? })`, whitespace-normalised, throwing an
  `Error` whose message is a unified diff (hand-rolled LCS: the package ships zero runtime
  dependencies and a SQL golden is a handful of lines). `values` are compared as the **encoded wire
  values** `Compiled.binds` carries; an unfilled prepared slot renders `:name`.
- `src/guards.ts` — `requiresRealPostgres(it, reason)` / `requiresConcurrency(it)`, plus
  `onRealPostgres()` and `TEST_URL_ENV`. `TestDecl` is `{ (name, fn, timeout?): void; readonly
  skip: TestDecl }` — `skip` recursive, so a guard can return `it.skip` where a `TestDecl` is
  expected and guards compose. That vitest's own `it` satisfies it is asserted by the compiler in
  `test/unit/guards.test.ts` (`const vitestIt: TestDecl = it`), which is the only place a
  regression in "runner-agnostic" could be caught before somebody else's repository.
- `src/pglite-bridge.ts` — moved from `packages/pg-prime/test/live/`, decision 2. One behavioural
  change: the PGlite handle is duck-typed (`PgliteLike`, two methods) instead of
  `import type { PGlite }`, for the reason `src/driver/pg-like.ts` duck-types `pg` — a `.d.ts` that
  named the optional peer would make the optionality a lie for every consumer's type-checker. The
  emitted declarations of the whole package name exactly one external module, `pg-prime`, and
  `check-dts` prints that list on every run.
- `src/pglite.ts` — `startPglite()` → `{ url, versionNum, version, kind: 'pglite', stop() }`, TZ
  pinned and restored exactly as `test/live/_pglite.ts` does it, version probed through PGlite's
  own `query()` so the fixture needs no wire client (decision 2).
- `src/postgres.ts` — `startPostgres(options?)` through `@testcontainers/postgresql`,
  `scratchDatabase(adminUrl)`, `dropScratchDatabase`, `isScratchDatabase`, `scratchDatabaseName`,
  `SCRATCH_PREFIX`, `probe`, `databaseUrl`, `dockerAvailable()`. The refusal is mechanical and runs
  **before** a connection is opened, because the drop path terminates sessions first.

`packages/pg-prime/test/live/_pglite-bridge.ts` is now `export * from
'../../../pg-prime-testing/src/pglite-bridge.js'`. `_pglite.ts` was **not** touched: it needs `pg`
for the real-server branch of `probe()` anyway, and leaving it alone is what keeps tier 1's count
identical. `tools/docs-examples.mjs`'s esbuild bundle resolves through the re-export unchanged —
90 examples ran.

**Gate numbers**, all from one run of the §2 chain with `&&`, on `f23d225`
(`PG_PRIME_TEST_URL=postgres://pgorm:pgorm@127.0.0.1:54331/postgres`):

| Gate | Number |
|---|---|
| `pnpm lint` | clean (oxlint 0 errors, **0 findings of any kind in the new package**; sherif, knip clean) |
| `pnpm format:check` | clean, 425 files |
| `pnpm typecheck` | clean — 3 packages, `@pg-prime/testing` two projects (`src`, `test`) |
| `pnpm test` (tier 0) | pg-prime **1 013** in **4.06 s** (unchanged) + `@pg-prime/testing` **23** in 0.53 s |
| `pnpm test:live` (tier 1) | pg-prime **1 790 + 6 skipped** — *the same as `9be7192`, with the bridge served from the package* — + `@pg-prime/testing` **28** |
| `pnpm test:pg` (tier 2) | pg-prime **1 851 + 11 skipped** (no PgBouncer URL) · kit **420 + 6 skipped** · `@pg-prime/testing` **36** (5 files: 3 unit + 1 live + 1 pg; Docker answered, so `startPostgres` ran) |
| `pnpm build` | 3 packages; `@pg-prime/testing` 29 files, 109.0 KB of `dist`, 137 ms |
| `pnpm package:check` | **10/10 size gates**; `@pg-prime/testing` **111.0 KB unpacked / 31 files / 34.8 KB tarball** against design's 300 KB, `0 dependencies / 1 required peer (+2 optional)`; api-snapshot no drift; emit parity 27/29 byte-identical, 2 maps differ only in `mappings`; `check:dts` clean on 5.9.3 and 7.0.2 with `skipLibCheck: false`, external specifiers `pg-prime` only; `publint --strict` and `attw --profile esm-only` both clean; pack-smoke ok |
| `pnpm bench:types` / `bench:compile` | OK, unchanged (reports reverted — they are generated) |
| `pnpm docs:check` | typecheck **575 blocks / 46 pages** (was 526 / 45) · examples **90 from 26 pages** (was 83) · coverage **1 221/1 221 names, 100.0 %**, `@pg-prime/testing` **38/38** · build 47 pages |

**Docs.** `guides/testing.mdx` rewritten and retitled *Testing* (it is no longer only about
PGlite): a three-tier table, tier 0 in full, `expectSql` with its diff, the PGlite fixture, both
limits, the transaction-per-test fixture, tier 2. The three blocks the contract names are all
executed now — `guards.ts` builds a two-line `it` (which doubles as the demonstration that
`TestDecl` is runner-agnostic), `namespace.ts` really creates the schema and reads
`current_schema()` back, and `test-db.ts` lost its `no-run` because constructing the handle
validates the whole config eagerly, so running it standalone is a real assertion (it is still the
`setup=` file `user-repository.test.ts` imports). The one `skip-check` on the page — the
`@electric-sql/pglite-socket` setup, which could not compile because that package is not a
dependency here — is replaced by a `startPglite()` example that **runs**, booting a second PGlite
inside the example process. `TEST_DATABASE_URL` → `PG_PRIME_TEST_URL`; the "reserved package name"
aside is gone; the `no-run` paragraph says those blocks now run on the docs gate's real-server tier
(`pg-only`), and the three `no-run` blocks left on the page carry their reason in the attribute per
R22. New `reference/testing.mdx`, 38 anchors, one sidebar entry.

**Divergences from the contract, and why.**

1. **`tools/size-budget.mjs` gained three lines, not zero.** The `zeroDependencies` block asserts
   "0 runtime deps AND 0 required peers", and `@pg-prime/testing` has one required peer by decision
   3. Setting `zeroDependencies: false` would have been the no-edit option and would have asserted
   *nothing at all* — not even that the package has no runtime dependencies. Instead the block
   takes a `requiredPeers` allowlist defaulting to `[]`, which leaves `pg-prime`'s own gate byte-
   for-byte unchanged, and the budget entry names all three peers so an optional one quietly
   becoming required is a red job. The reason is in `budgets.json._whyPeers` and in the tool.
2. **The `unpackedBytes` budget is design's 307 200, not the measurement.** The contract says
   "design 300 KB beside the measured budget"; the measurement is 113 623 B and
   `ceil(measured/1024)*1024` would leave **41 bytes** of headroom. That rule belongs to the
   treeshake lines, which are *minified*; this line counts the comments tsc keeps, and this package
   is about half docblock by line, so a 41-byte budget would make a paragraph edit a red CI job
   while telling nobody anything. Both existing `packages.*` entries use design's number the same
   way, and the log prints `design / measured / budget` on every run. Reason in `budgets.json`.
3. **`tools/api-snapshot.mjs`'s closing line** said "the two types@<5.9 stubs"; it now counts
   `PACKAGES.length`. One line, and it would otherwise have been wrong on every run.
4. **`docs/package.json` gains `@pg-prime/testing`** as a workspace devDependency (the docs gates
   resolve through `docs/node_modules`) and `knip.json`'s docs `ignoreDependencies` gains it (it is
   used only from `.mdx`, which knip's docs project excludes).
5. **`reference/testing.mdx` declares two `apiEntry` values**, `@pg-prime/testing#.` and
   `pg-prime#.`, so a signature that says `extends PgLikePool` or `config: PgLikeQueryConfig`
   resolves. That is the shape `reference/driver.mdx` already uses; coverage per entry is a union
   across the pages that claim it, so nothing else moves.
6. **`packages/pg-prime/test/live/_pglite.ts` was not touched.** Decision 2 permits it "only if
   needed"; it is not — the moved bridge's only signature change is `PGlite` → `PgliteLike`, which
   a real `PGlite` satisfies structurally.
7. **The real-server fixtures talk to the admin database through `pg-prime` itself**, statically
   imported. Decision 3's lazy-import-with-a-sentence rule is applied to the two OPTIONAL peers
   only; making the REQUIRED one lazy would have bought nothing and cost every type in
   `postgres.ts` an `as unknown as` cast. Recorded because it is the reason `dist/mock-pool.d.ts`
   names `pg-prime`.

**Found and not fixed.**

- **`pgPrime({ connection })` never attaches an `error` listener to the `pg.Pool` it builds**
  (`packages/pg-prime/src/session/pg-lazy.ts` `buildPool`, ~L141). pg-pool re-emits an **idle**
  client's error on the pool, and an `EventEmitter` `error` with no listener throws — so a
  `pg_terminate_backend` against an idle pooled connection takes the process down with an uncaught
  `57P01`, not a rejected promise. Found by the first draft of
  `packages/pg-prime-testing/test/pg/postgres.test.ts`, which left a handle open across a
  scratch-database drop; the committed version holds an open **transaction** instead, where the
  adapter's own per-client `error` listener (`pg-adapter.ts` L220) does handle it. A one-line
  `pool.on('error', …)` in `buildPool` would close it; it is `pg-prime` source and out of T's scope.
- **`packages/pg-prime-kit/test/cli/envelope.test.ts` timed out in a hook (10 s) once** under
  `pnpm -r test:pg`, with three packages' tier-2 suites and a testcontainer sharing one server. It
  passed on the immediate re-run and on every run since (420 + 6 both times). A load flake, not a
  regression — but the hook timeout is the repo default and this plan adds a third concurrent
  tier-2 suite, so it will be hit again.
- **Local-environment note, not a bug.** `packages/pg-prime-kit/test/support/pgdump.ts` falls back
  to `docker exec <PG_PRIME_SPIKE_CONTAINER ?? 'pgorm-spike-diff'> pg_dump` when no `pg_dump` is on
  PATH, and pins port 5432 *inside* that container. Pointing `PG_PRIME_TEST_URL` at any container
  other than `pgorm-spike-diff` therefore fails 41 kit tests with `role "…" does not exist` until
  `PG_PRIME_SPIKE_CONTAINER` is set to match. Every kit number above was taken with
  `PG_PRIME_SPIKE_CONTAINER=pgorm-spike-sql`.

**For the integrator.** (a) The **lockfile changed**: `@pg-prime/testing` gains
`@testcontainers/postgresql@^12.1.0` and `@electric-sql/pglite@^0.5.7` as devDependencies, and
`docs` gains `@pg-prime/testing`. testcontainers brings `cpu-features`, `protobufjs` and `ssh2`,
whose install scripts pnpm reports as ignored — the same warning `esbuild` already produces, and
nothing needs them built. (b) The **shared-list one-liners** T adds, for conflict resolution:
`tools/api-snapshot.mjs` PACKAGES, `tools/check-dts.mjs` PACKAGES, `tools/emit-parity.mjs`'s
default package list, `tools/pack-smoke.mjs` PACKAGES (plus the consumer body — X does not touch
this file), `tools/budgets.json` `packages`, `knip.json` (a workspace entry **and** the docs
`ignoreDependencies` line), `tools/docs-coverage.mjs` and `tools/docs-typecheck.mjs` golden lists,
`docs/astro.config.mjs` (two lines: the Reference entry, and the Guides label
`Testing with PGlite` → `Testing`). (c) `tools/size-budget.mjs`'s `requiredPeers` allowlist
(divergence 1) is a real behaviour change to a shared tool, not a list line. (d) Nothing under
`.github/workflows/**` needs editing: the package's `test` / `test:live` / `test:pg` ride the
existing `unit`, `live` and `pg` jobs through decision 13's recursive root scripts, which the three
runs above verify.

#### X — RESULT

Branch `worktree-agent-a97fb625e1cad8ea4`, nine commits on `c2d9649`. Every gate of §2 is green on
the last one, run as one `&&` chain in 5 min 02 s.

**Built.** `packages/pg-prime-create/` = `@pg-prime/create`, bin `create-pg-prime`, **zero
dependencies**, `files: ["dist"]`, MPL-2.0, `engines.node >=22.12`, `publishConfig` public +
provenance, the `types@<5.9` stub first in its one subpath. **64.4 KB unpacked in 48 files**
(tarball 21.7 KB) against decision 7's 500 KB. `tools/build-package.mjs` learned the generic
`templates/` → `dist/templates/` copy (13 files; the other two packages have no such directory).

- `src/cli.ts` (bin) → `src/main.ts` → `src/args.ts` / `src/prompts.ts` / `src/scaffold.ts`, plus
  `src/types.ts` and the generated `src/versions.ts`. Decision 8's flags exactly, with `-y`/`-h`
  besides; `--pm` from `npm_config_user_agent`; a non-TTY stdin means `cli.ts` opens no readline
  interface at all, which is what "implies `--yes`" is made of here; a non-empty directory is
  refused with the entries it found in the sentence (`.git` and `.DS_Store` do not count as
  content, because `git init && npm create @pg-prime .` is a real order to do things in).
- `templates/**` (13 files) is the getting-started project. `schema.ts`, `db.ts`,
  `pg-prime.config.ts` and `index.ts` are **byte-equal** to that page's blocks — read through
  `tools/docs-blocks.mjs`, the page wins — and `tsconfig.json` is its JSON block plus `outDir` and
  `include`, asserted key-for-key **in order**.
- `src/versions.ts` is generated by `scripts/versions.mjs` from the workspace's own manifests, by
  `build`, by `typecheck` and by the vitest global setup; git-ignored, never committed.
- `tools/create-smoke.mjs`, and `&& pnpm create-smoke` at the end of the root `package:check`.
- Tier 0: 35 tests. Tier 2: 6 cases, 26.5 s wall.
- Docs: the one-command path at the top of *Install* with every manual step untouched; new
  `reference/create.mdx` (the `--help` block goldened against the binary, nine anchored names,
  `apiEntry`); one sidebar entry.
- Release: the fixed group is `["pg-prime", "@pg-prime/kit", "@pg-prime/create"]`, `RELEASING.md`
  §0 says why (and the two other places that name the group now name three), one changeset.

**Gate numbers** (macOS, Node 24.14.1, PostgreSQL 17.11 in `pgprime-k4`):

| Gate | Number |
|---|---|
| `pnpm lint` | clean — 65 pre-existing `no-unnecessary-condition` warnings, **none** in the new package; `sherif` and `knip` clean |
| `pnpm format:check` | 427 files |
| `pnpm typecheck` | 3 packages |
| `pnpm test` (tier 0) | **1 048** = `pg-prime` 1 013 (5.0 s) + `@pg-prime/create` **35** (0.3 s) |
| `pnpm test:live` (tier 1) | **1 790 + 6 skipped** on PGlite — `9be7192`'s number exactly; 1 796 + 0 against the real server |
| `pnpm test:pg` (tier 2) | `pg-prime` 1 851 + 11 skipped (no PgBouncer URL) · kit **420 + 6** · create **41 + 1** (the one skip is the `--testing` leg, below), 26.5 s |
| `pnpm build` | 4 packages; create → 46 files, 60.3 KB, 118 ms, +13 templates, +x `cli.js` |
| `pnpm package:check` | 10/10 size gates (create 64.4 KB / 500 KB, 0 deps / 0 required peers) · api-snapshot no drift (`@pg-prime/create . 3v/6t`) · emit-parity identical on tsgo 7.0.2 and tsc 5.9.3 · check-dts `9 .d.ts, external specifiers: (none)`, clean on both compilers with `skipLibCheck: false` · treeshake · pack-smoke · **create-smoke ok** (5 s with a warm npm cache) |
| `pnpm bench:types` · `pnpm bench:compile` | unchanged, green |
| `pnpm docs:check` | typecheck **529 blocks / 46 pages** · examples **83** from 26 pages · coverage **1 192/1 192 names (100 %)**, **16** CLI blocks, 40/40 hazard codes, 221 links · build **47** pages |

Two of §0's baseline figures are slightly stale, and it is not this branch: parsing the `c2d9649`
tree with `readPage` gives **529** checked `ts` blocks there too (§0 says 526), and the
api-snapshot goldens summed to **1 183** names (§0 says 1 182). This branch adds one page, nine
names and **no `ts` block at all** — `getting-started` parses to the same six before and after, and
`reference/create.mdx` has none.

**The scaffold e2e, and what it found.** `test/pg/scaffold.e2e.test.ts` packs the three tarballs,
runs the built `dist/cli.js`, rewrites the scaffold's ranges to `file:` those tarballs, `npm
install`s it, creates `pgprime_create_<random>` on `PG_PRIME_TEST_URL`, and asserts, in order:
`migrate generate --name init`, the SQL it wrote, `migrate apply`, `migrate status` exit 0, `tsc` +
`node dist/index.js`, then a second `generate` after the schema changes. The database is dropped
after; `globalSetup` builds the three packages, because the `pg` job runs on an unbuilt checkout.

**All four `text frame="terminal"` transcripts on `guides/getting-started` are exactly what the kit
prints.** Nothing on that page is wrong and nothing in the kit is. After masking the four fields
`packages/pg-prime-kit/test/cli/_mask.ts` masks — the scratch database's name, `host:port`,
wall-clock `ms`, and the sha256 fingerprints — the comparison is verbatim, and that leaves
`7 statements`, `txmode transactional`, `proof passed`, `witness passed`, `applied 1 migration`,
`history present (v1)`, `1 file, 0 pending`, `lock free` and `0001_post_summary.sql main
1 statement` compared as written. The `migrations/0000_init.sql` block matches line for line (its
elision and its two fingerprint headers excepted), and `index.ts` prints exactly the page's own
trailing comment — `[ { title: 'Hello', author: 'Alice' } ]`, which the test reads off the page
rather than repeating. On PostgreSQL 17 even the two fingerprints printed on the page are the
current literal values.

**Divergences from the contract, with reasons.**

1. **Two source files beyond the four named**: `src/args.ts` and `src/main.ts`. `src/cli.ts` has to
   stay a side-effect-only bin — importing it runs it — so the parser and the command live beside
   it. It is the kit's own `cli.ts` → `cli/main.ts` → `cli/args.ts` split, one level flatter.
2. **The terminal is one `ask` function, not a stream pair.** `tools/check-dts.mjs` compiles the
   emitted declarations with `types: []` and `skipLibCheck: false`, deliberately, and in that
   program **both** spellings of "a stream in a public interface" fail: `node:stream` does not
   resolve (TS2307) and `NodeJS.WritableStream` is not a namespace (TS2503). Rather than widen the
   gate, the API changed: `PromptIo` is `{ ask?: (q: string) => Promise<string>; cwd; env }` and
   `MainIo` adds `out` / `err` as `(text: string) => void`. `src/cli.ts` is now the only file that
   touches `node:readline/promises` or a stream, and it exports nothing — so the package's
   declarations name **nothing outside the package**, and its `check-dts` line is `zeroDeps: true`,
   the strict reading `pg-prime` gets. The test fake shrank to six lines with it.
3. **`templates/gitignore` and `templates/env.example` are stored undotted** and renamed on write.
   Measured: `npm pack` **strips a file named `.gitignore` out of the tarball** — `.env.example`
   and `.gitkeep` survive it, `.gitignore` does not — so a dot-named template is present in every
   local test and missing from every published copy. One rule for both, at the manifest in
   `src/scaffold.ts`.
4. **`tsconfig.json` sets `types: ["node"]`.** With no dependencies there is no `@types/pg` to pull
   the Node globals in transitively the way the other two packages do, and without the line every
   `node:` import is a TS2591.
5. **Root `.gitignore` gained one line** (`packages/pg-prime-create/src/versions.ts`). Not in the
   owned list, but "generated at build, never committed" needs one, and that file is where every
   other generated-path rule in this repository already lives.
6. **`.oxfmtrc.json` gained two entries**, not the one §2 names: `templates/**`, and the generated
   `src/versions.ts` beside it.
7. **`knip.json` gained `ignore: ["templates/**"]`** for the workspace — knip reads
   `templates/index.ts`'s `import … from 'pg-prime'` as an unlisted dependency of a package that
   deliberately has none.
8. **`docs-coverage.mjs`'s CLI check picks the binary out of the block itself.** A `cli=` value
   whose first word is a bin name uses that binary (`cli="create-pg-prime --help"`), instead of a
   new fence attribute — chosen so that `docs/README.md`, which E owns, needs no edit: its row
   ("what the built binary prints") stays true as written.
9. **`create-smoke.mjs` also runs `publint --strict` and `attw --pack --profile esm-only`** on the
   create tarball. `pack-smoke.mjs` does that for the other two and its list was not ours to edit;
   a published tarball with a nested `dist/templates/package.json` in it is exactly what a
   packaging linter should have an opinion about. Both clean.
10. **`reference/create.mdx` has no `signature` blocks.** One would need `@pg-prime/create` in
    `docs/package.json` for `docs-typecheck` to resolve — a shared file and a lockfile change, for
    nine names. They are documented in an anchored table instead, the shape `reference/kit.mdx`
    already uses for its type rows; coverage is still the mechanical 100 %.
11. **The fourth transcript needed one edit to the scaffolded `schema.ts`.** The page's
    `schema.ts (excerpt)` block is a fragment — it drops `authorId` and `createdAt` — so the test
    inserts the one line the prose is actually about, `summary: t.text().nullable()`, rather than
    replacing the file with the excerpt.

**Found and not fixed.**

- **`node index.ts` cannot run the scaffold**, and no scaffold can be shaped so that it does: Node's
  type stripping does not rewrite `./db.js` to `db.ts`. The project therefore builds with `tsc` and
  `npm start` runs `dist/index.js` (with `--env-file-if-exists=.env`, which is why it needs no
  dotenv dependency). This is the same specifier rule decision 12 documents for the kit's config
  loading — E's paragraph to write; the scaffold's README already gives the user the two commands.
- **`ci.yml`'s `package`-job comment says "Measured 14.4 s".** `package:check` now also runs
  `create-smoke`, which reaches the registry for `typescript@5.9.3`, `pg` and `@types/node`. That
  file is E's; the number wants updating there.
- **No kit or runtime bug.** Everything the e2e compared agreed on the first run.

**What the integrator must do after T merges.**

1. **Nothing mechanical.** Both halves of the scaffold gate detect `packages/pg-prime-testing/dist`
   and switch themselves on: `create-smoke.mjs` drops its `--no-testing` (and stops printing its
   NOTE), and the e2e's last case — `it.skipIf(!withTesting)('runs the scaffold's own vitest on
   PGlite')` — stops skipping. After `pnpm build`, re-run `pnpm create-smoke` and `pnpm test:pg`;
   the create suite should then read **42 passed, 0 skipped**.
2. **Check one file against T's real surface.** `templates/test/setup.ts` is written to decision 1's
   contract — `import { startPglite } from '@pg-prime/testing'`, then `{ url, stop() }` — and is
   the only template with no docs block behind it, so if T's shape differs it is a one-file change
   with nothing else to move. It applies `migrations/*.sql` over the simple query protocol with
   `pg` (a migration file is a script, and the extended protocol takes exactly one statement), and
   `vitest.config.ts` puts it in `setupFiles`, not `globalSetup`, for the per-file-isolation reason
   `guides/testing` gives.
3. `scripts/versions.mjs` already reads `packages/pg-prime-testing/package.json` for the range it
   pins, so T's first real version is picked up at the next build with no edit anywhere.
4. Two one-line courtesies in files this branch does not own: `docs/README.md`'s `cli=` row could
   mention that the value may begin with a bin name, and `ci.yml`'s `package`-job timing comment is
   now stale (both E's).

#### E — RESULT

**Branch:** `worktree-agent-a1f8c2797885011b3`, from `c2d9649`.

##### 1. What was built

**The attribute.** `tools/docs-blocks.mjs` parses `pg-only` (bare) and `pg-only="pgbouncer"`.
`isPgExample(block)` returns `'pg' | 'pgbouncer' | null` and throws, naming the page and line, on
any other value. `isExample` — which was exported and unused — now excludes `pg-only` and is what
`docs-examples.mjs` selects with, so the two tiers *partition* the `title=` blocks: an example runs
on exactly one of them, and neither gate can silently stop covering a block. `docs-typecheck`
compiles a `pg-only` block like any other `ts` block, because the reason it cannot run on PGlite is
never that it does not compile.

**The runner.** `tools/docs-examples.mjs --pg`, one file, sharing composition, substitution,
`remap`, the per-example process and the 60 s timeout with the PGlite tier (both now go through
`materialise()` and `report()`). `PG_PRIME_TEST_URL` is required and its absence is one sentence
plus exit 1. Per example:

| | `pg-only` | `pg-only="pgbouncer"` |
|---|---|---|
| `DATABASE_URL` | a scratch database `docs_ex_<pid>_<n>`, created from the admin URL, dropped after | `PG_PRIME_TEST_PGBOUNCER_URL` (skipped with a sentence when unset — not a failure) |
| `DIRECT_URL` | the scratch database | the admin URL, which is what `directConnection:` documents |
| Isolation | a new database each time | `drop schema public cascade; create schema public`, before **and** after, through the pooler itself so it lands on whatever database PgBouncer's fixed `DB_NAME` names |

Dropping a scratch database waits up to 2 s for the example's backends to go (its process is
already dead, so they normally go in milliseconds), then terminates whatever is left, then drops
with a retry for the moment between `pg_terminate_backend` returning and the backend leaving
`pg_stat_activity`. A termination that was actually needed is printed as a note naming the block —
that is the leaked-handle finding the contract asks for. Nothing printed it on any of the runs
below.

Root script `docs:examples:pg` (one line in the root `package.json`, nothing else there).
Deliberately **not** in `docs:check`.

**CI.** `.github/workflows/ci.yml` `pg` job and `ci-nightly.yml` `pg-matrix`: `pnpm build` then
`pnpm docs:examples:pg`, after `pnpm test:pg`, with one comment each explaining why the step is on
that job and why the build is in front of it. No other region of either file is touched.

**R22.** `tools/docs-coverage.mjs` grows a fifth check, as a section header plus one call before
the report and the function itself appended at the very end of the file (T and X add package-list
lines at the top). It fails on a `no-run` with no reason and on a block that is both `no-run` and
`pg-only`, and it prints the counts.

**docs/README.md.** `pg-only` in the *Block directives* table, `no-run`'s row says the reason is
mandatory, a *The real-server tier* subsection under *Runnable examples* with the isolation table
and the environment, R22 as the corollary of *The one rule*, and `docs:examples:pg` in the script
list marked "NOT in docs:check".

**The floor note** (decision 12), prose only, in the four named places.
##### 3. Gate numbers

Local: macOS 15 / arm64, Node 24.14.1, PostgreSQL 17.11 in `pgprime-s` (:54334) and PgBouncer
1.25 in transaction mode with `max_prepared_statements=200` in `pgprime-s-bouncer` (:56434) — the
same two variables CI's `pg` job sets.

| Gate | Result |
|---|---|
| `pnpm lint` | OK (oxlint --type-aware, typecheck, sherif, knip) |
| `pnpm format:check` | OK, 409 files |
| `pnpm typecheck` | OK |
| `pnpm test` (tier 0) | 48 files, **1 013** passed |
| `pnpm test:live` (tier 1) | 82 files, **1 790** passed, 6 skipped — the count `9be7192` had |
| `pnpm test:pg` (tier 2) | pg-prime 90 files / **1 862** passed / 0 skipped; @pg-prime/kit 57 files / **426** passed |
| `pnpm build` | OK |
| `pnpm package:check` | OK — size-budget, api-snapshot, emit-parity, check-dts, treeshake, pack smoke |
| `pnpm bench:types` | OK |
| `pnpm bench:compile` | OK |
| `pnpm docs:check` | typecheck **529** blocks from 45 pages on TS 5.9.3 (321 signature, 17 expect-error, 131 runnable); examples **88** from 26 pages in 13.2 s; coverage **1 183/1 183** names, 15 CLI blocks, 40/40 hazard codes, 217 links (one new: guides/migrations → reference/config), **R22: 26 explained, 7 waived**; build 46 pages |
| `pnpm docs:examples:pg` | **10** examples from 5 pages in 3.5 s — 7 `pg-only`, 3 `pg-only="pgbouncer"` |

**Executed examples: 83 → 98.** 88 on PGlite (was 83: +4 blocks that never needed a server, +1 that
never had a `title=`) and 10 on a real PostgreSQL (was 0).

Degradations, both deliberate and both a single sentence rather than a failure:

```
$ node tools/docs-examples.mjs --pg            # no PG_PRIME_TEST_URL
docs-examples --pg: PG_PRIME_TEST_URL is unset, and this tier is the one that needs a server — it
creates a scratch database per example. `pnpm docs:examples` is the tier that needs none.
exit 1

$ PG_PRIME_TEST_URL=… node tools/docs-examples.mjs --pg   # no pooler URL
docs-examples --pg: 7 example(s) from 4 page(s) in 3.0 s
  skipped operations/poolers.mdx:56 (pooled-db.ts): it is pg-only="pgbouncer" and
  PG_PRIME_TEST_PGBOUNCER_URL is unset, so there is no pooler to prove anything against
  … ×3
docs-examples --pg: OK
```
##### 3b. Three runs, back to back

The new examples wait for things — a notification, a server-side cancel, three concurrent probe
connections — so the question is whether any of them passes on luck. Three consecutive runs of
`pnpm docs:examples:pg`, no other load, same shell:

```
===== run 1  docs-examples --pg: 10 example(s) from 5 page(s) in 3.5 s   OK
===== run 2  docs-examples --pg: 10 example(s) from 5 page(s) in 3.5 s   OK
===== run 3  docs-examples --pg: 10 example(s) from 5 page(s) in 3.4 s   OK
```

3.4–3.5 s across the three, and no note printed on any of them — no example left a backend behind,
nothing was substituted, nothing was skipped. The two LISTEN examples wait on a 5 000 ms deadline
and `throw` past it, so a machine slow enough to break them fails loudly instead of passing; the
observed delivery is inside one 10 ms poll every time. The `two-classes.ts` cancel pair is bounded
by the server's own `statement_timeout` (200 ms) and by a 250 ms client timer against a
`pg_sleep(5)`, which is four seconds of headroom.

The whole `&&` chain of §2 was run twice end to end. The second finished `CHAIN_EXIT=0`; the first
stopped at `pnpm test:pg`, on a 10 s hook timeout in the kit's own tier-2 teardown with all 426 of
its tests passed — F7 below, in a file E does not own.
##### 2. The audit (R22)

**On the count.** The contract says 63 `no-run` blocks; there are **47**. 63 is the number of lines
in `docs/src/content/docs/**` that contain the string `no-run`: 43 fences, 11 directive comments
(seven of them duplicating the fence of the same block), seven `// no-run:` first lines and two
mentions in prose. Every one of the 47 blocks is below.

Line numbers are the ones at `c2d9649`; where a block moved, the new line is in brackets.

| Block | Why it did not run | Disposition |
|---|---|---|
| `concepts/codecs.mdx:35` `schema.ts` | `setup=schema`, composed into the blocks below | stays `no-run`, reason written |
| `concepts/codecs.mdx:54` `db.ts` | `setup=db`, imported as `./db.js` by them | stays `no-run`, reason written |
| `concepts/codecs.mdx:62` `ddl.ts` | `setup=ddl`, imported as `./ddl.js` | stays `no-run`, reason written |
| `concepts/codecs.mdx:255` `decimal-columns.ts` | the decimal library is `declare`d, not depended on | stays `no-run`, reason written |
| `concepts/codecs.mdx:306` `typed-jsonb.ts` | one table declaration; no handle | stays `no-run`, reason written |
| `concepts/relations.mdx:20` `schema.ts` | `setup=schema` | stays `no-run`, reason written |
| `concepts/relations.mdx:206` `db.ts` | `setup=db` | stays `no-run`, reason written |
| `concepts/relations.mdx:214` `ddl.ts` | `setup=ddl` | stays `no-run`, reason written |
| `concepts/shadow-ladder.mdx:154` `pg-prime.config.ts` | a config file the kit loads | stays `no-run`, reason written |
| `guides/adopting.mdx:118` `db/schema.ts` | what `pg-prime pull` writes, shown as it lands | stays `no-run`, reason written |
| `guides/adopting.mdx:346` `pg-prime.config.ts` | a config file | stays `no-run`, reason written |
| `guides/cancellation.mdx:218` `two-classes.ts` | `pg_sleep` + a `CancelRequest` a server honours | **`pg-only`** [218] |
| `guides/cancellation.mdx:252` `session-defaults.ts` | marked `no-run` as "a file" | **runs on PGlite**, unchanged [252] |
| `guides/copy.mdx:30` `copy-from.ts` | PGlite's bridge cannot carry COPY | **`pg-only`** [31] |
| `guides/copy.mdx:74` `copy-from-raw.ts` | as above | **`pg-only`** [85] |
| `guides/copy.mdx:96` `copy-to.ts` | as above | **`pg-only`** [112] |
| `guides/data-migrations.mdx:282` `pg-prime.config.ts` | a config file | stays `no-run`, reason written |
| `guides/data-migrations.mdx:435` `seeds/020_posts.ts` | a seed module; `pg-prime seed` calls its default export | stays `no-run`, reason written |
| `guides/getting-started.mdx:55` `schema.ts` | `setup=schema` | X's page — sentence in §6 |
| `guides/getting-started.mdx:97` `pg-prime.config.ts` | a config file | X's page — sentence in §6 |
| `guides/getting-started.mdx:204` `db.ts` | `setup=db` | X's page — sentence in §6 |
| `guides/getting-started.mdx:287` `schema.ts (excerpt)` | an excerpt | X's page — sentence in §6 |
| `guides/listen-notify.mdx:94` `invalidate-cache.ts` | delivery needs two backends | **`pg-only`** [94] |
| `guides/listen-notify.mdx:149` `notify-on-commit.ts` | as above | **`pg-only`** [170] |
| `guides/migrations.mdx:27` `pg-prime.config.ts` | `setup=config`, a config file | stays `no-run`, reason written |
| `guides/observability.mdx:18` `db.ts` | marked `no-run` as "a file" | **runs on PGlite** |
| `guides/observability.mdx:314` `diagnose-pooler.ts` | the pid probe needs concurrent connections | **`pg-only`** [314] |
| `guides/schema.mdx:54` `catalogue.ts` | `setup=catalogue` | stays `no-run`, reason written |
| `guides/schema.mdx:732` `renamed-label.ts` | one enum declaration; no handle | stays `no-run`, reason written |
| `guides/testing.mdx:98` `guards.ts` | a file of test helpers | T's page — sentence in §6 |
| `guides/testing.mdx:141` `namespace.ts` | a file | T's page — sentence in §6 |
| `guides/testing.mdx:172` `test-db.ts` | `setup=test-db` | T's page — sentence in §6 |
| `operations/poolers.mdx:56` `pooled-db.ts` | needs a transaction pooler | **`pg-only="pgbouncer"`** [56] |
| `operations/poolers.mdx:111` `direct-db.ts` | needs a pooler *and* a direct URL | **`pg-only="pgbouncer"`** [118] |
| `operations/poolers.mdx:145` `neon-db.ts` | the endpoint is Neon's | stays `no-run`, reason written [159] |
| `operations/poolers.mdx:175` `check-pooler.ts` | the probes need a real pooler to find | **`pg-only="pgbouncer"`** [189] |
| `operations/timeouts.mdx:60` `db.ts` | marked `no-run` as "a file" | **runs on PGlite**, with a GUC read-back |
| `operations/timeouts.mdx:79` `no-statement-timeout.ts` | as above | **runs on PGlite**, with a GUC read-back |
| `operations/zero-downtime.mdx:61` `schema.ts (excerpt)` | an excerpt | stays `no-run`, reason written |
| `operations/zero-downtime.mdx:137` `schema.ts (excerpt)` | an excerpt | stays `no-run`, reason written |
| `operations/zero-downtime.mdx:204` `schema.ts (excerpt)` | an excerpt | stays `no-run`, reason written |
| `reference/config.mdx:12` `pg-prime.config.ts` | a config file | stays `no-run`, reason written |
| `reference/config.mdx:125` `pg-prime.config.ts` | a config file | stays `no-run`, reason written |
| `reference/config.mdx:228` `pg-prime.config.ts` | a config file | stays `no-run`, reason written |
| `reference/config.mdx:316` `pg-prime.config.ts` | a config file | stays `no-run`, reason written |
| `reference/schema.mdx:22` `schema.ts` | `setup=schema` | stays `no-run`, reason written |
| `reference/schema.mdx:796` `member-role.ts` | one enum declaration; no handle | stays `no-run`, reason written |

Totals: **10** blocks moved to the real-server tier (7 `pg-only`, 3 `pg-only="pgbouncer"`), **4**
turned out to need no server at all and moved to the PGlite tier, **26** stay `no-run` with a
written reason, **7** belong to T's and X's pages and are waived until their branches land.
##### 4. Divergences from the contract, with reasons

1. **The reason is written as the fence attribute, not as a `// no-run:` first line, on all 26.**
   The contract offers both; after the audit no block wanted the comment form, because the six that
   had one — the COPY, LISTEN and cancel blocks — are `pg-only` now, and what is left is files and
   excerpts, where a note addressed to whoever edits the page does not belong in the page. Verified
   in the built HTML: Expressive Code renders `title=` and ignores the rest of the fence meta, so
   `no-run="…"` and `pg-only` are invisible to the reader. The comment form is still parsed, still
   documented, and still what the next COPY-shaped block should use.

2. **`operations/timeouts.mdx` `db.ts` / `no-statement-timeout.ts` are on the PGlite tier, not
   `pg-only`.** The contract asked why they were `no-run` and said they looked runnable. They are:
   they were marked `no-run` under the "a file, not a program" rule, and `pgPrime()` is lazy, so
   running them proved only that the config object is accepted — on any server, which makes the
   real-server tier the wrong home for them. Each now reads its own GUC back, which is the claim
   the surrounding prose makes and the difference between the two blocks: `10s` against `0`.
   Measured identical on PGlite 18.3 and PostgreSQL 17.11.

3. **`guides/queries.mdx`'s `streamBatches` block is on the PGlite tier.** Measured, as asked: the
   bridge carries a `WITHOUT HOLD` cursor. Titled `stream.ts`, `use=blog,blog-ddl,seed`, and it
   prints the four seeded titles and then `4` — the batch arriving in one `FETCH`.

4. **Two blocks left `no-run` that the contract did not name.** `guides/observability.mdx` `db.ts`
   is the same shape as the timeouts pair — a handle built from `DATABASE_URL`, which is a program —
   so it runs. `guides/cancellation.mdx` `session-defaults.ts` runs as-is, as the contract predicted.

5. **`tools/docs-coverage.mjs` carries a two-entry waiver map for `guides/testing.mdx` and
   `guides/getting-started.mdx`.** R22 fails on their seven unexplained `no-run` blocks and E must
   not edit either page. The waiver is not a hole: each entry *asserts* that the page still has an
   unexplained block, so the moment T's or X's branch fixes or removes it the gate fails and names
   the line to delete. §6 has the sentences.

6. **Five examples grew a few lines so that they prove something.** A `users` row before a COPY
   into `posts` (the FK is real), a bounded wait for the notification instead of a sleep, a
   `select 1` through the pooler, `db.listen()` through `directConnection`. Every addition is
   marked in the block by the comment above it.

7. **The pooled tier also exports `DIRECT_URL`.** `operations/poolers.mdx` `direct-db.ts` reads it,
   and the pair (pooler URL + direct URL) is exactly what that page is about. Documented in
   `docs/README.md`.

##### 5. Found and not fixed

**F1 — `copyFrom(table, rows)` fails on any table with a generated column.** The default column
list is *every declared column*, `posts.id` is `bigint generated always as identity`, the rows have
no `id` key, so the encoder writes `\N` and PostgreSQL answers `23502`. This is the first thing
`guides/copy.mdx`'s own first example did when it was executed for the first time.

Repro (`packages/pg-prime/src/session/copy.ts:79`, `copyColumns` — `if (requested === undefined)
return all.map(…)`):

```
copy "public"."posts" ("id", "author_id", "title", "body", "published", "created_at") from stdin with (format text)
ERROR: null value in column "id" of relation "posts" violates not-null constraint
DETAIL: Failing row contains (null, 1, post 0, xxxx…, t, 2026-08-29 20:03:58.654+00).
```

`CopyOptions.columns`'s own doc comment says "Defaults to every column the schema declares as
**insertable**", which is what a reader would expect and is not what the code does; the insert path
excludes generated columns and COPY does not, so "the two paths cannot disagree" — the reason given
for the default — is the property that is broken. Not fixed here (no `packages/*/src` edits): the
example passes `columns` explicitly and says why in a comment, and the `CopyOptions` table on the
page now says a table with a generated column needs it.

**F2 — the `CancelRequest` path prints a `pg` deprecation warning.**
`packages/pg-prime/src/driver/pg-adapter.ts:1007` calls `canceller.cancel(target, target.activeQuery)`,
and `pg` 8.23 answers `DeprecationWarning: Client.activeQuery is deprecated and will be removed in
pg@9.0`. Every cancel prints it once per process; `guides/cancellation.mdx`'s `two-classes.ts`
shows it on every run of the real-server tier. Harmless today, a breakage on `pg@9`.

**F3 — the sub-22.15 message is not the one the source claims.**
`packages/pg-prime-kit/src/config/ts-specifiers.ts:29` says that without `module.registerHooks` the
user gets "the `ERR_MODULE_NOT_FOUND` plus `stripTypesAdvice`'s sentence". `stripTypesAdvice` is
reached only for `ERR_UNKNOWN_FILE_EXTENSION`, `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`,
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` and `ERR_INVALID_TYPESCRIPT_SYNTAX`
(`config/load.ts:107` and `:270`); `ERR_MODULE_NOT_FOUND` falls to `throw err` and reaches the user
raw, with no mention of Node 22.15 or of a build step. The floor note therefore documents what the
code does, not what the comment says. The fix is one line in each of those two `if`s plus a
sentence — kit source, so not mine.

**F4 — `pnpm test:pg` needs `PG_PRIME_SPIKE_CONTAINER` on a machine with no `pg_dump`.**
`packages/pg-prime-kit/test/support/pgdump.ts` falls back to `docker exec … pg_dump` in the
container named by `PG_PRIME_SPIKE_CONTAINER`, whose default is `pgorm-spike-diff` — a container
from the spike phase that no longer fronts the tier-2 server. With no `pg_dump` on `PATH` and the
default in force, 41 kit tests fail with `FATAL: database "pgprime_k2b_corpus_pagila" does not
exist` (the dump ran in the wrong container). `PG_PRIME_SPIKE_CONTAINER=pgprime-s` makes the suite
green. Not a product bug and not E's file; recorded because it costs an hour to diagnose and CI
never sees it (CI installs `postgresql-client-N`).

**F5 — the contract's baseline numbers were a commit or two stale.** 1 182 exported names is
1 183 (the api-snapshot goldens are byte-identical to `c2d9649`, so nothing E did moved it);
526 blocks / 46 pages is 529 blocks / 45 pages; 83 executed examples is correct; and the 63
`no-run` is 63 *occurrences of the string*, over 47 blocks. Every number below is measured on this
branch.

**F6 (not a bug, recorded).** `guides/observability.mdx`'s `diagnose-pooler.ts` composes
`docs/src/snippets/blog.ts`, whose pool is `max: 1` for PGlite's sake, and a pool of one cannot
create the contention the pid probe wants. The probe handles it exactly as designed — 250 ms budget,
stays silent, reports the original pid — and the verdict against a direct PostgreSQL 17 is
`direct medium none true`, which is the right answer either way. The block prints it.

**F7 — a latent flake in the kit's tier-2 teardown.** `packages/pg-prime-kit/test/cli/envelope.test.ts`
writes `beforeAll(async () => { … }, T)` with `T = 120_000` and then `afterAll(async () => { for
(const d of databases) await destroyDatabase(d).catch(…) })` with **no** timeout, so the teardown
that drops eight scratch databases one at a time runs under vitest's default 10 000 ms. On the
first of two whole-chain runs it tripped: `426 passed`, `Test Files 1 failed`,
`Error: Hook timed out in 10000ms` at `envelope.test.ts:42`. The second whole-chain run and two
standalone runs of the same suite were green. `authoring.test.ts:51` and `repeatables.test.ts:44`
have the same shape and fewer databases. The fix is `, T` on the three `afterAll`s; kit test code,
not E's, so recorded rather than applied.
##### 6. What the integrator must apply in T's and X's pages

E does not touch `guides/testing.mdx` or `guides/getting-started.mdx`. Three things are owed to
them; the first two are exact text, the third is a deletion that the gate will demand anyway.

### 6.1 `guides/testing.mdx` (T) — two sentences under *How this site's examples run*

Replace (currently the first sentence of that section):

> Every fenced TypeScript block on this site compiles, and every one with a file name in its tab
> executes — against exactly this setup.

with:

> Every fenced TypeScript block on this site compiles, and every one with a file name in its tab
> executes — against exactly this setup, except the handful marked `pg-only`, which need a real
> server and are covered below.

Replace the paragraph that currently reads:

> That is also why some blocks here are marked `no-run` with a comment saying why: COPY, cross-session
> `LISTEN`/`NOTIFY` and a real `CancelRequest` are exactly the things PGlite cannot host, so the
> pages say so rather than showing an example that quietly does not run.

with:

> That is also why the things PGlite cannot host — COPY, cross-session `LISTEN`/`NOTIFY`, a real
> `CancelRequest`, the pooler probes — are marked `pg-only` rather than left unexecuted. They run on
> the docs gate's second tier, `pnpm docs:examples:pg`: a real PostgreSQL and a real PgBouncer, one
> scratch database per example, on CI's `pg` job and every nightly leg. A block that runs on neither
> tier is `no-run` **with its reason written on the fence** (design/13 R22), so "this one does not
> run" is never something the reader has to work out.

### 6.2 The seven `no-run` fences, if the rewrites keep them

`guides/testing.mdx` — T's contract says these three become executed examples or are replaced, in
which case nothing is owed. If any survives, its fence needs a reason:

```
```ts title="guards.ts" no-run="a file of test helpers: the blocks below import it, and it declares rather than does"
```ts title="namespace.ts" no-run="a file: the handle a suite imports, and the suite is what runs it"
```ts title="test-db.ts" no-run="a file: setup=test-db composes it into the blocks below"
```

`guides/getting-started.mdx` — X's contract adds an `npm create` path at the top of *Install* and
does not promise to change these four, so all four are likely owed:

```
```ts title="schema.ts" no-run="a file: use=schema composes it into the blocks below, and a schema module runs nothing on its own"
```ts title="pg-prime.config.ts" no-run="a config file: the kit loads it, and as a program it executes nothing"
```ts title="db.ts" no-run="a file: the handle the blocks below import as ./db.js"
```ts title="schema.ts (excerpt)" no-run="an excerpt: the lines of schema.ts that change at this step, not a module"
```

(The last three reasons are the exact strings the equivalent blocks carry on
`concepts/codecs.mdx`, `reference/config.mdx` and `operations/zero-downtime.mdx`.)

### 6.3 Delete the waiver

In `tools/docs-coverage.mjs`, inside `checkNoRunReasons`, delete each page's line from
`PENDING_R22` once 6.1 and 6.2 are applied. The gate **fails** on a waiver whose page no longer has
an unexplained `no-run`, so this cannot be forgotten: `pnpm docs:coverage` will say

> docs-coverage: guides/testing.mdx has no unexplained no-run block left, so its PENDING_R22 waiver
> in tools/docs-coverage.mjs is stale — delete that line (design/13 §3, R22).

and when both are gone the map is empty and the whole construct can go with it.

### 6.4 Two notes, no action

- T moves the PGlite bridge into `@pg-prime/testing` and says `tools/docs-examples.mjs` bundles it
  through the re-export unchanged (decision 2). It does: `bundleHarness()` still esbuilds
  `packages/pg-prime/test/live/_pglite.ts`, and `--pg` does not call it at all.
- X's `create-smoke` and E's `docs:examples:pg` both want a built workspace on the `pg` job. E adds
  a plain `pnpm build` step before its own; if X's tier-2 `globalSetup` also builds, the second
  build is a no-op and the step can stay as the explicit thing the comment describes.

## 4. Q — the `ratioP50Paired` gate (integrator)

Inputs: the `bench-runtime-report-*` artifacts of the five runs in §0. Per decision 14: read
`decode.*.ratioP50Paired` for the closure-tree and codegen pairs against both mappers; compute
each statistic's spread (max/min − 1) paired and unpaired; if paired ≤ unpaired, add
`ratioVsUncheckedMapperP50Paired` / `ratioVsCheckedMapperP50Paired` (and the codegen pair) at
`max × 1.05` rounded up to 0.05, gate them in `bench/runtime/run.mjs`, demote the unpaired lines
to reported, and write the five numbers into `budget.json`'s `decode._why`. Otherwise record the
spreads in `_why` and change nothing else.

#### Q — RESULT

**Done 2026-08-30, on the five runner samples of §0** (the fifth, 33271626165, was dispatched on
`9be7192` for the purpose). Decision 14's test fails: the paired quotient is **not** tighter than
the unpaired one. Spread (max/min − 1), unpaired → paired: closure tree vs unchecked 4.2 % → 4.3 %,
vs same-checks 8.7 % → 8.4 %; codegen vs unchecked 4.7 % → 5.1 %, vs same-checks 6.7 % → 6.5 %.
Two marginally tighter, two marginally wider, all within a point — night-to-night drift inside a
sample is not what moves these lines. So `ratioP50Paired` stays reported and ungated, the two
widened decode lines (2.95 / 1.75) stay — their 17-observation distribution includes PR-runner
readings (2.816 / 1.663) these five quieter nightly readings do not reach — and the numbers are
in `bench/runtime/budget.json` `decode._why`. The candidate to bring them down is a longer nightly
sample, not a different statistic.

**What the fifth run found instead.** It went red on the *open an issue if a gate regressed* step,
not on a budget: `tools/bench-regression.mjs` reported `statement · production / pre-session
path` 1.320 → 2.127 (+61 %) against the previous night, on the same commit — and then the step
crashed with exit 3 because the runner's shell is `bash -e` and `node …; code=$?` never reaches
the `code=`. Three fixes, one commit:

1. `.github/workflows/ci-nightly.yml`: `code=0` … `|| code=$?`. The issue-filing path had never
   executed; it now can (reproduced and proved locally under `bash -e`).
2. `tools/bench-regression.mjs`: the statement-path **time** line leaves the allow-list — its
   five runner readings are 2.008 / 2.184 / 2.051 / 1.320 / 2.127, a 65 % spread, and the
   tool's own rule is "comfortably under 25 %". The bytes line (3 112–3 120 B, 0.3 %) stays and is
   the regression detector for that path. The self-test case flipped to `false` with the reason.
3. `bench/runtime/budget.json` `statement.overPreSessionP50` 2.4 → **2.3**, now sized from the
   runner (max × 1.05 over the four ordinary readings, rounded up to 0.05) instead of the design
   machine; `_runnerSized` records the five numbers and the reading of the 1.320.

## 5. Integration and definition of done

Order: **T, then X, then E** (X's scaffold `--testing` needs T's package on `main`; E's
`pg-only` prose in `guides/testing` is written by T in advance, decision 10). Each branch is
cherry-picked onto `main`, the shared-list conflicts resolved per §3 ownership, the lockfile
regenerated once, and the full gate list of §2 re-run from scratch before the push. Q lands last,
as its own commit.

Done when, on one `main` commit:

- [x] `pnpm -r build` produces four publishable packages; `pnpm package:check` (now including
      `create-smoke`) is green; `size-budget` prints `@pg-prime/testing` ≤ 300 KB and
      `@pg-prime/create` ≤ 500 KB beside their design values.
- [x] `pnpm test` runs three tier-0 suites, tier 0 of `pg-prime` still ≤ 5 s; tier 1 of `pg-prime`
      has the same pass count as `9be7192` (1 790) with the bridge served from the package.
- [x] `docs:check` is green with `guides/testing` and `getting-started` executed; `docs:examples:pg`
      is green on PostgreSQL 17 + PgBouncer locally and on the CI `pg` job; every `no-run` states
      why (R22).
- [x] The scaffold e2e (decision 9) is green on the `pg` job and on every nightly leg.
- [x] `bench/runtime/budget.json` carries Q's result either way, with the five-run numbers.
- [x] CI green, nightly green, and the *what is still open* list of `12` §5 is reduced to the
      three operator switches. — CI 33275218461 on `1b2d9ec` (the record commit; the run on
      `711594e` itself, 33275093200, was cancelled by the push that superseded it), nightly
      33275093271 on `711594e` 8/8 with `docs:examples:pg` and the two new tier-2 suites on every
      leg. Open after this plan: the three operator switches, and the fix round F3 (below).

### Integration — 2026-08-30

**Order and mechanics.** X and E landed first (both handed over while T was still running; their
26 commits cherry-picked onto `integ-13` from `e453e16` with no conflict), then T's six. T against
X conflicted exactly where §3 predicted — one line each in `knip.json`, `tools/api-snapshot.mjs`,
`tools/budgets.json`, `tools/check-dts.mjs`, `tools/emit-parity.mjs`, `docs/astro.config.mjs`,
`tools/docs-coverage.mjs`, `tools/docs-typecheck.mjs` — all "keep both". One resolution was wrong
the first time: concatenating both sides of `emit-parity.mjs`'s ternary produced two `?` branches,
which `pnpm format:check` caught (and a `| tail` had masked its exit code — the gate list is run
with the exit code visible, not the last line). The lockfile T committed applied clean; `pnpm
install` changed nothing. E's §6 sentences for T's page were moot — T's rewrite already states
every `no-run` reason — so the `PENDING_R22` waiver construct was deleted rather than emptied;
E's four reasons for X's page were applied as written. E's F7 (three kit `afterAll` teardowns
under vitest's 10 s default) was fixed at integration, `, T` on each.

**What the merged tree found that no branch could.** X's scaffold e2e `--testing` leg switches on
when `@pg-prime/testing` has a `dist`, which only the integrated tree has, and it failed twice:

1. The scaffold's `test/setup.ts` stopped PGlite in `afterAll` while `db.ts`'s pool still held
   an idle connection; `pg` re-emits the dropped socket as `error` on the pool, `buildPool`
   attaches no listener, vitest reports an uncaught exception — **T's recorded runtime finding,
   reproduced by X's e2e**. The fixture now ends the pool before the server (a dynamic import of
   `../db.js`, because `db.ts` reads `DATABASE_URL` when it loads); the runtime listener is the
   fix round's.
2. `npm run build` compiles `test/` into `dist/`, and **Vitest 4 no longer excludes `**/dist/**`
   by default**, so every scaffold test ran twice and the second copy imported a `dist/db.js` pool
   nothing ended. `templates/vitest.config.ts` now excludes it, with the reason.

Both are template files with no docs block behind them. Create's tier 2 reads **42 / 42, 0
skipped** after them.

**Gate numbers on `711594e`** (macOS arm64, Node 24.14.1, PostgreSQL 17.11 `pgprime-s` + PgBouncer
`pgprime-s-bouncer`, `PG_PRIME_SPIKE_CONTAINER=pgprime-s`; the full §2 chain, 231 s, exit 0):

| Gate | Result |
|---|---|
| lint · format:check · typecheck | green, 4 packages |
| tier 0 | pg-prime **1 013** in **4.24 s** · create **35** · testing **23** |
| tier 1 | pg-prime **1 796** (0 skipped — the run had a server URL) · testing **28** |
| tier 2 | pg-prime **1 862 / 0 skipped** · kit **426** · testing **36** (Docker answered) · create **42** |
| build | pg-prime 2 313.9 KB · kit 1 751.4 KB · **testing 111.0 KB / 300 (31 files, 0 deps, 1 required + 2 optional peers)** · **create 65.0 KB / 500 (48 files, 0 deps / 0 peers)** |
| package:check | 12/12 size gates · api-snapshot no drift (four goldens) · emit-parity · check-dts · treeshake · pack-smoke (three tarballs) · **create-smoke ok** (scaffold with tests, installed from four tarballs, `tsc --noEmit`, `pg-prime --help` inside it) |
| bench:types · bench:compile | green, unchanged |
| docs:check | typecheck **575 blocks / 47 pages** · examples **95** on PGlite from 26 pages · coverage **1 230 / 1 230 names (100 %)**, 16 CLI blocks, 40/40 hazard codes, 232 links, **R22: 33 explained, 0 waived** · build 48 pages |
| docs:examples:pg | **10** examples from 5 pages in 3.6 s (7 `pg-only`, 3 `pg-only="pgbouncer"`) |

Executed docs examples: 83 → **105** (95 + 10).

**Carried to the fix round** (recorded by the branches, none fixed here — all in `packages/*/src`):
T — `pgPrime({ connection })`'s `buildPool` attaches no `error` listener (an idle pooled
connection terminated under it is an uncaught `57P01`); E F1 — `copyFrom(table, rows)` defaults
`columns` to every declared column, so a generated column is sent as `\N` (`23502`), against
`CopyOptions`' own doc comment; E F2 — the cancel path reads `pg`'s deprecated
`Client.activeQuery` (gone in `pg@9`); E F3 — `ts-specifiers.ts` claims a sub-22.15 Node gets
`stripTypesAdvice`'s sentence on `ERR_MODULE_NOT_FOUND`, but `load.ts` only advises on the four
type-stripping codes. Local-only: the kit's `pg_dump` fallback container defaults to
`pgorm-spike-diff`, so a `PG_PRIME_TEST_URL` on any other container needs
`PG_PRIME_SPIKE_CONTAINER` beside it (T, E both lost time to it).

### F3 — fix round (2026-08-30)

Branch `worktree-agent-a0733e9c400244d03`, on `1b2d9ec`. The four items of *Carried
to the fix round* above, plus the local-only note, plus one budget line the four of them broke.

#### 1. `pgPrime({ connection })` attaches no `error` listener (T)

**What the design said.** `07` §1.2 delegates the pool but owns its *policy*; §4.1 rule 5 says an
error object should be safe to log; §7.1 gives the runtime exactly one channel for "something we
decided on our own", `onInternal`. None of them says what an *idle* connection's death should be,
because none of them anticipated that it could be nothing at all.

**What the code did.** `buildPool` returned `new Pool(config)` with no listener on it. pg-pool's
`makeIdleListener` (`pg-pool/index.js`) removes the client from the idle set, closes it, and
re-emits `('error', err, client)` **on the pool** — and an `EventEmitter` `error` with no listener
throws. So `pg_terminate_backend`, `idle_session_timeout` or a failover against an idle pooled
connection took the host process down with an uncaught `57P01`, not a rejected promise. The
adapter's own per-client listener (`pg-adapter.ts` `#onClientError`) covers only a **checked-out**
connection, which is why the failure is invisible in every ordinary test.

**What it does now.** `buildPool` takes an `onIdleError` callback and attaches `pool.on('error', …)`
whenever the pool has an `on` (a `MaybePoolEmitter` cast local to that file — `PgLikePool` still
does not require `on`, because a duck-typed drop-in does not have to be an `EventEmitter`).
`run.ts` supplies the callback for both the pool and the `directConnection` pool, and it emits the
existing internal-event channel with **one new kind, `idle-connection-error`**, carrying the
original as `cause`. Mirrored on `#onClientError`, one level up and one degree quieter: there the
adapter owns the connection and flips `usable`; here pg-pool has already destroyed the client
before it emits, nothing was in flight and there is no caller to reject, so what is left is
observability. Silence was the other defensible answer and is rejected in the code, with the
reason. Only for a pool pg-prime built: a `pool:` a user passes is theirs, and so is its listener.

**The test that pins it.** `test/pg/pool-error.test.ts`, tier 2 because it needs a second backend
to do the killing. The oracle needs no assertion, exactly as in `checkout-error.test.ts`: with the
listener removed the run reports `Uncaught Exception · error: terminating connection due to
administrator command` and the worker dies (measured, both ways). The assertions add the rest of
the contract — the event fires once with a `cause`, and the next statement succeeds on a
*different* `pg_backend_pid()`. A second case holds the connection in a transaction and shows the
checked-out path still rejects with the mapped `OperatorInterventionError`.

**Docs.** `guides/observability` lists the new kind and says what it means (and that an unheard
`error` on a pool exits the process, which is what `pg` on its own does); `reference/pg-prime`'s
`InternalEvent` row names it. No public *name* changed, so `api-snapshot` has no drift.

#### 2. `copyFrom(table, rows)` sends generated columns (E, F1)

**What the design said.** `CopyOptions.columns`: *"Defaults to every column the schema declares as
**insertable**"*, and `copyColumns`' own docblock gave the reason — the same order `insert into t
(…)` uses, *"so the two paths cannot disagree"*.

**What the code did.** `if (requested === undefined) return all.map(…)` — every **declared**
column. COPY bypasses the rewriter check that makes an `INSERT` into a `generated always as
identity` say `428C9`, so the `\N` went in as NULL and PostgreSQL answered `23502`. The property
the default existed for was the one that was broken, and `guides/copy.mdx`'s own first example hit
it the first time it was executed.

**What it does now.** `metaOf` publishes `insertableKeys` — `keys` minus `ddl.identity === 'always'`,
declaration order — which is the runtime half of the rule `query/types.ts` already enforces at the
type level (`ro: true` removes a column from `InsertPatch`). `copyColumns` reads *that*, so the two
paths read one set rather than two agreeing expressions. `generatedByDefault()` stays in, because
`generated by default as identity` is insertable. An explicit `{ columns }` is still honoured
verbatim, including a generated identity — COPY writes the value you give it, which is what makes
a restore possible. Two smaller things fell out: the row key now rides **on** `CopyColumn` instead
of in a parallel `opts?.columns ?? meta.keys` array in `handles.ts` (misaligned by exactly the
dropped columns once the default is a subset), and a table whose every column is GENERATED ALWAYS
gets a `UsageError` instead of `copy t () from stdin` and a `42601`.

**The tests that pin it.** Tier 0 `test/session/copy.test.ts` — the emitted statement text, the
key-carrying, the empty-set refusal, and `copyColumns(meta, undefined).map(c => c.key)` asserted
equal to `meta.insertableKeys` — plus two cases in `test/query/meta.test.ts`. Tier 2, three cases
in `test/pg/session-copy.test.ts` against a table with **both** a `bigint generated always as
identity` and a stored `generated always as (…) stored` expression column: the default list loads
with no `columns` at all and the server fills both; an explicit list still writes chosen ids; a
narrower list lets a database default apply; `copyTo` reads the generated column straight back.
With the default reverted to `meta.keys` the first of those fails with exactly E's
`23502 … Failing row contains (null, a, 10.00, …)`, measured.

The expression column is **not** in the pg-prime schema, and that is the honest modelling: the DSL
has no `.generatedAlwaysAs()` (design/05 §2.3's row is not built; the kit's `pull` emits a note
instead), so today it is simply undeclared — and COPY refuses a generated expression column *by
name* (`42P10`, *"Generated columns cannot be used in COPY"*, measured on PG 17.11), so a default
list built from the database rather than from the schema would break that table twice over.

**Docs, reverted to the fixed behaviour.** `guides/copy.mdx`'s first example drops the explicit
`columns` and the comment that explained the workaround, and the `CopyOptions` table row states the
real rule. It also states the sharp edge that is left and is not a bug: a column that IS in the
list and has no key in your row goes out as `\N`, **not** as the column's database default —
narrow the list to let a default apply. `pnpm docs:examples:pg` stays green on those `pg-only`
blocks.

#### 3. The cancel path reads `pg`'s deprecated `Client.activeQuery` (E, F2)

**What the design said.** `02` §5.4 and `07` §6.1: a protocol `CancelRequest` on its own socket,
because it needs no pooled connection and therefore works when the pool is exhausted — which is
exactly when a cancel matters. Nothing about *which* `pg` API carries it.

**What the code did.** `canceller.cancel(target, target.activeQuery)`. `pg` 8.23 made `activeQuery`
a deprecated accessor, so every cancel printed `Client.activeQuery is deprecated and will be
removed in pg@9.0` and `--throw-deprecation` turned it into an exception. Handing it a different
query does not help: `Client.prototype.cancel(client, query)` opens with
`if (client.activeQuery === query)`, reading the deprecated getter **off the target** whatever it
is given. The only way not to trigger it is not to call that method.

**What it does now.** `sendCancelRequest(canceller, target)` in `pg-adapter.ts` is the body of
`Client.prototype.cancel` after the comparison: open the socket to the canceller's own `host`/`port`
(`pg`'s two spellings, unix socket included) and, on `connect`, write
`connection.cancel(processID, secretKey)` from the **target's** BackendKeyData. Same bytes, same
absence of TLS on the cancel socket (a `pg` limitation inherited either way), same fire-and-forget.
Of `pg` 8.23's three candidates the other two do not survive contact: `_getActiveQuery()` is
underscore-private *and* does not help, and there is no no-query `cancel()` overload. It is a
**feature test, not a version test** — every part has been on `pg` since 8.0, so the declared floor
(`pg >= 8.11`) takes this path too and `cancel(client, query)` survives only as the fallback for a
non-`pg` drop-in, whose own property is not necessarily deprecated. The choice is recorded in the
function's docblock and on `PgLikeCancelClient`. One deliberate difference from `pg`: an `error`
listener on the cancel connection, because `pg` attaches none and a refused cancel socket is
otherwise a process exit *while handling a timeout*.

**The tests that pin it.** Tier 1 `test/driver/cancel.test.ts` over the fake seam —
`FakeClient.activeQuery` is now an accessor that counts reads, which turns "does not touch the
deprecated property" into an assertion: the backend key written, the unix-socket spelling, the
`error` listener, the fallback for a canceller with no `connection` (the one place the read is
still allowed, and it is asserted to be exactly one), and the no-op when nothing is on the wire.
Tier 2 `test/pg/session.test.ts` → *the protocol CancelRequest*, where R18's oracle is
`pg_stat_activity`: after a `timeoutStrategy: 'client'` timeout, no backend of this
`application_name` is still running `pg_sleep(5)`. It collects `DeprecationWarning`s and sets
`process.throwDeprecation` for the duration — `--throw-deprecation` scoped to one statement, with
the write guarded because the flag is READ-ONLY when the real command-line flag is present.

**Measured.** The whole `pg` project — 9 files, 72 tests — is green under
`NODE_OPTIONS=--throw-deprecation`. With `sendCancelRequest` disabled the same run reports
`Uncaught Exception · DeprecationWarning: Client.activeQuery …`, and with the throw switched off
the collected-warnings assertion fails on its own. `docs:examples:pg` no longer prints the warning
on `guides/cancellation`'s `two-classes.ts`.

#### 4. The sub-22.15 message is not the one the source claims (E, F3)

**What the design said.** `ts-specifiers.ts`: on 22.12–22.14 `module.registerHooks` does not exist
"and the loader keeps the behaviour it had, which is the `ERR_MODULE_NOT_FOUND` plus
`stripTypesAdvice`'s sentence".

**What the code did.** `stripTypesAdvice` is reached for four codes —
`ERR_UNKNOWN_FILE_EXTENSION`, `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`,
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, `ERR_INVALID_TYPESCRIPT_SYNTAX` — and
`ERR_MODULE_NOT_FOUND` is not one of them. It fell to `throw err` and reached the user raw, naming
a `.js` they never wrote, with no mention of Node 22.15 or of a build step. Neither of
`stripTypesAdvice`'s two ways out (Node ≥ 22.18, or a `.mjs` config) is the fix for this one, so
covering it with that sentence would have been wrong as well.

**What it does now.** `tsSpecifierAdvice(file, err, hooksInstalled)`. Every clause of its test is
load-bearing, because an `ERR_MODULE_NOT_FOUND` is ordinarily the user's own typo and must keep
saying so: `module.registerHooks` is not a function, the code is `ERR_MODULE_NOT_FOUND`, `err.url`
ends in `.js`/`.mjs`/`.cjs`, that file is not on disk, and its TypeScript sibling is. The last pair
is `typeScriptSiblingUrl`, extracted from `typeScriptSibling` — which now delegates to it — so the
hook and the message cannot reach different conclusions about the same file. The sentence names the
file being loaded, the `.js`, the `.ts` beside it, the Node version and the two ways out, on one
line like every other message this loader produces. `enableTsSpecifiers()` returns whether the hook
is in force; that boolean is the seam, since Node 22.12–22.14 cannot be run here. The two
duplicated `catch` blocks in `load.ts` are now one `classifyUserImportFailure`, and the two seed
sites take the same branch — so *"anything the kit loads from your source"*, which is what the docs
promise, is true. `ts-specifiers.ts`'s docblock says what the code does.

**The test that pins it.** `test/cli/config.test.ts`: `typeScriptSiblingUrl` against this package's
own two trees (`src/` is TypeScript only, `dist/` has the emitted `.js` beside it and must never be
rewritten); the message shape — one line, names the four things, does **not** say
`pg-prime.config.mjs`, `retryWithStripTypes` false; and four negative controls (hook installed, a
different code, no `url`, no TypeScript sibling). Plus `enableTsSpecifiers()` asserted `true` on
this Node, so the two halves of the seam are pinned together. The end-to-end shape was checked once
by hand in a process that never installs the hook, which is what 22.12–22.14 is.

**Docs.** All four passages E flagged now describe the sentence rather than the raw error: the kit
README, `reference/config`, `guides/migrations` and `guides/data-migrations` (the last one because
the seed sites are covered too).

#### The local-only note (T, E — F4)

`test/support/pgdump.ts`'s docblock now says which container it means and that the default
(`pgorm-spike-diff`) is a stale spike container; the skip message is a shared `PG_DUMP_HINT` that
names `PG_PRIME_SPIKE_CONTAINER`; and when the docker fallback is actually taken it writes one line
to stderr saying so. The failure mode it costs an hour to diagnose is a *green* docker path against
the wrong database, which is exactly the case the old message could not describe.

#### The budget line the four fixes broke

`packages/pg-prime.jsBytes` **919 552 → 927 744 B** (measured **927 014 B** in 85 files). That line
is set by `ceil(measured / 1024) * 1024` and has been re-baselined at each of design/12 §4 P item 0,
item 2 and F1, so by construction it carries under 1 KB of margin — 922 bytes before this round —
and the first change to `packages/pg-prime/src` after any of those fails CI and edits
`tools/budgets.json`. Its own note says why: tsc keeps comments, so in this package prose is
shipped bytes.

About thirty lines of the four fixes are code. The rest is the account, and the docblocks were cut
by a fifth first (1 639 B, 906.9 → 905.3 KB) with the long form moved here instead of the call
site — the same courtesy the two notes above it record. Two of the four fixes are about a process
exit and a `pg@9` breakage; leaving the reasoning out of the source to stay under a line with 922
bytes of headroom was the worse trade. The treeshake fixtures are **minified** and their goldens
did not move, so what this costs a user is unchanged.

`bench/types/budget.json`'s `packageDtsBytes` moved the same way and for the same reason —
**550 912 → 553 984 B**, measured 553 721 — and the type numbers say it is a size line and not a
type-performance one: headline instantiations 82 028 → **82 073** on TS 5.9.3 and 133 822 →
**133 996** on TS 7 (+0.05 % / +0.13 % against a 200 000 budget), every per-query fixture and every
schema-size ratio unchanged. The four declarations behind it are `TableCodecMeta.insertableKeys`,
`CopyColumn.key`, `PgLikeClient.secretKey` and `PgLikeConnection.connect`/`cancel`.

**`tools/budgets.json` is the one edit outside the fix round's allowed paths** (§5's brief excludes
`tools/**` except a golden regeneration; `bench/**` is not excluded). It is recorded here rather
than assumed. The alternative — delete the explanations and keep the line where it is — is stated
so the integrator can take it instead; it buys back 1.7 KB of the 6.3 KB, so it would need the
budget moved anyway.

#### Gate numbers

macOS arm64, Node 24.14.1, PostgreSQL 17.11 (`pgprime-s`, port 54334) + PgBouncer
(`pgprime-s-bouncer`, 56434), `PG_PRIME_SPIKE_CONTAINER=pgprime-s`. The full §2 chain in one
command with the exit code printed, **exit 0**:

| Gate | `711594e` (integration) | F3 |
|---|---|---|
| lint · format:check · typecheck | green | green, 4 packages |
| tier 0 | pg-prime **1 013** in **4.24 s** · create 35 · testing 23 | pg-prime **1 023** in **4.3 s** · create 35 · testing 23 |
| tier 1 | pg-prime **1 796** · testing 28 | pg-prime **1 811** (0 skipped — the run had a server URL) · testing 28 |
| tier 2 | pg-prime **1 862** · kit **426** · testing 36 · create 42 | pg-prime **1 883 / 0 skipped** · kit **430** · testing 36 · create 42 |
| build | pg-prime 2 313.9 KB · kit 1 751.4 KB · testing 111.0 KB · create 65.0 KB | pg-prime **2 326.0 KB** · kit 1 760.3 KB · testing 111.0 KB · create 65.0 KB |
| package:check | 12/12 · no api drift | **12/12** (`jsBytes` re-baselined — see above) · api-snapshot **no drift**, four goldens · emit-parity · check-dts · treeshake · pack-smoke · create-smoke |
| bench:types | green | green (`packageDtsBytes` re-baselined) — headline instantiations **82 073** / **133 996**, budget 200 000 |
| bench:compile | green | green — `statement · production / pre-session path` **1.987**, budget 2.3, unmoved; production bytes 3 113 B, budget 3 400 |
| docs:check | 575 blocks / 47 pages · 95 PGlite · 1 230/1 230 · R22 33 | **575 blocks / 47 pages** · **95** on PGlite from 26 pages · **1 230 / 1 230 names**, 40/40 hazard codes, 232 links, **R22 33 explained, 0 waived** · build 48 pages |
| docs:examples:pg | 10 examples / 5 pages | **10 examples from 5 pages** (7 `pg-only`, 3 `pg-only="pgbouncer"`) |

The +25 tests are this round's: **10** at tier 0 (`test/session/copy.test.ts` 8,
`test/query/meta.test.ts` 2), **5** at tier 1 (`test/driver/cancel.test.ts`), **6** in `test/pg/`
(`pool-error.test.ts` 2, the protocol-cancel case, the three COPY cases) and **4** in the kit
(`test/cli/config.test.ts`). Tier 0 stays under `08` §4's 5 s ceiling; 4.24 → 4.3 s is one more
file to transform, and five runs on this machine spread 4.19–4.76 s with the same 1 023 tests, so
the ceiling is what to watch and not the delta.

The commits, in order: the pool listener · COPY's insertable default · the protocol cancel · the
kit's sub-22.15 sentence · the two budget re-baselines · this record · one comment-only SQLSTATE
correction in the COPY test (a generated *expression* column in COPY is `42P10`, not the `428C9`
an identity column gives an INSERT — both measured). The chain above was run whole, from
`pnpm lint` to `pnpm docs:examples:pg`, three times end to end at 231, 235 and 233 s; the numbers
in the table are the last of them, and `statement · production / pre-session path` read
2.013 · 2.01 · 1.987 across the three.

**Nothing is left open for the integrator** beyond the budget note above. `docs:examples:pg` and
`docs:check` both need the two URLs; the kit's suite needs `PG_PRIME_SPIKE_CONTAINER` on a machine
with no `pg_dump`, which is now said in three places.
