# 08 — Package Architecture & Engineering Setup

**Status:** DECISIONS (round 2). **Date:** 2026-08-14.
**Scope:** package topology, naming, module/exports design, build toolchain, test infrastructure,
benchmarking, release discipline, repo layout.
**Method:** every number below that is marked `[verified]` was measured in this session against the
live npm registry or by executing the tool locally (probe dir kept out of the repo). Nothing is
taken from memory.

---

## 0. Verified facts that drove these decisions

These changed the answers materially versus what round-1 research assumed. Read them first.

| # | Finding | Evidence |
|---|---|---|
| F1 | **`typescript@7.0.2` is `latest` (2026-07-08).** It is the native Go compiler, shipped via 20 platform `optionalDependencies`; `package.json` has `"main": null` and the root export is only `./lib/version.cjs`. **The classic JS compiler API is gone from the `typescript` package at 7.x** — it lives at `typescript/unstable/*`. `typescript@6.0.3` (2026-04-16) is the last JS-based release. | `[verified]` installed both, read `package.json` |
| F2 | **tsgo emits full `.d.ts` + `.d.ts.map`** under `module: nodenext`, `strict`, `declarationMap`, `verbatimModuleSyntax`, `erasableSyntaxOnly`. A trivial project compiles in **70 ms**. | `[verified]` local emit |
| F3 | **Tooling that consumes the TS compiler API cannot run on TS 7.** `typescript-eslint@8.67.0` peer is `>=4.8.4 <6.1.0`; `typedoc@0.28.20` peer tops out at `6.0.x`; `@ark/attest` depends on `@typescript/vfs` + `@typescript/analyze-trace`. | `[verified]` registry peer ranges |
| F4 | **The `types@<X>` export-condition gate works, including on subpath exports, and still works under TS 7.** Built a fake package with `"types@<5.9"` first in each condition object; TS 5.4.5 got the error stub, TS 5.9.3 / 6.0.3 / 7.0.2 all resolved the real declarations. | `[verified]` compiled the same app against 4 TS versions |
| F5 | **The prescribed ESM-only package shape passes `publint` clean and `attw` as expected** (`node16 (from ESM)` 🟢, `bundler` 🟢, `node10` 💀 by design). | `[verified]` ran `publint@0.3.23` + `@arethetypeswrong/cli@0.18.5` |
| F6 | **PGlite 0.5.5 is PostgreSQL 18.3 in WASM, zero npm deps, boots in ~0.6 s.** Verified working: full DDL (functions, triggers, domains, composite types, ranges, partitions, generated columns, identity, matviews + `REFRESH … CONCURRENTLY`), **RLS with real roles and policy enforcement**, `CREATE INDEX CONCURRENTLY`, advisory locks, same-session LISTEN/NOTIFY, 431 rows in `pg_class`. Contrib extensions (`pg_trgm`, `btree_gist`, …) work but must be injected at construction, not via bare `CREATE EXTENSION`. 2PC is disabled. | `[verified]` 20-case probe |
| F7 | **`@electric-sql/pglite-socket@0.2.8` lets the real `pg@8.23.0` driver talk to PGlite over TCP.** Verified through the actual wire: extended-protocol parameters, **named prepared statements**, `rowMode: 'array'`, `binary: true`, transactions + savepoints. | `[verified]` `pg` Pool against `PGLiteSocketServer` |
| F8 | **PGlite is a single backend, and `maxConnections > 1` multiplexes N sockets onto it — session state is shared.** Two "connections" reported `pg_backend_pid() = 42` for both; `set_config` on conn A was visible on conn B; a temp table created on A was readable from B; **`pg_advisory_lock(42)` on A followed by `pg_try_advisory_lock(42)` on B returned `true`** (real PG returns `false`); cross-connection `LISTEN`/`NOTIFY` delivered nothing. | `[verified]` — this is the decisive test-tier finding |
| F9 | **`pg-orm-ts` is dead on npm: "Unpublished on 2026-08-04".** Unpublished names are not reusable. `pg-orm` is taken (2015, `0.0.4`, abandoned). | `[verified]` `npm view` / registry |
| F10 | Size anchors: `kysely@0.29.5` = **1.65 MB unpacked / 610 files**, of which JS 710 KB (303 files) and `.d.ts` 997 KB (304 files). `drizzle-orm@0.45.2` = 9.94 MB / 2666 files. `drizzle-kit@0.31.10` = 9.79 MB; the `1.0.0-rc.4` line is **95 MB unpacked**. `@prisma/client@7.9.1` = 74.77 MB. `pg@8.23.0` installs to **828 KB / 14 packages**. | `[verified]` registry `dist.unpackedSize` + local install |

---

## 1. Package topology

### 1.1 The split

**Four published packages at 1.0. Hard cap: never more than six.** MikroORM ships 21 packages / 8 MB
and pays for it in every install-doc and every version-skew bug report; Drizzle ships two and that is
the right number. We copy the count, not the contents.

| Package | Role | Deps | Build | Budget (unpacked) |
|---|---|---|---|---|
| **`pgorm`** | The runtime. Schema DSL, codec registry, query builder + compiler, executor, transactions, structural driver adapters, migration *applier*. | **zero runtime deps, zero peer deps** | `tsgo`, unbundled ESM | **≤ 2.5 MB / ≤ 400 files** |
| **`pgorm-kit`** | The CLI. Introspection, diff engine, plan emission, hazard linter, `verify` / `baseline` / `push`, codemods. | bundled & inlined | `esbuild` single file + `tsgo` for `.d.ts` | **≤ 8 MB** (hard fail 12 MB) |
| **`@pgorm/testing`** | Structural driver mock, ephemeral PGlite/testcontainer fixtures, `expectSql` golden helpers. Dev-only. | `@electric-sql/pglite` + `@testcontainers/postgresql` as **optional** peers | `tsgo` | ≤ 300 KB |
| **`create-pgorm`** | `pnpm create pgorm` scaffolder. | bundled | `esbuild` | ≤ 500 KB |

**Deliberately NOT separate packages:**

- **No `@pgorm/adapter-pg`.** The adapter interface is structural (`PgLikePool`, per research §6) — it
  never imports `pg`'s types, it declares the shape `pg` happens to satisfy. That is ~300 LOC and it
  ships as the `pgorm/adapter-pg` **subpath**, not a package. Same for `pgorm/adapter-pglite`. This is
  how we get zero deps *and* zero peer deps, and how Neon/Hyperdrive duck-type in for free.
- **No `@pgorm/pgvector` / `@pgorm/postgis`.** Extension codecs are pure TS with no dependencies; they
  ship as `pgorm/pgvector` and `pgorm/postgis` subpaths and tree-shake to zero when unused. Splitting
  them into packages buys nothing and costs a version-skew axis.
- **No `@pgorm/core` + `@pgorm/postgres` split.** There is no second dialect. Ever. That split is the
  thing we are differentiating against.

**Where the CLI/runtime boundary sits (the load-bearing decision):**
`pgorm` contains the migration **applier** (read `.sql` + `.plan.json`, take
`pg_advisory_xact_lock`, honour `txmode`, record in the history table) because production apps run
migrations at boot and must not install a CLI to do it. `pgorm-kit` contains the migration
**author** (introspect → diff → emit → lint), which is a dev-time-only concern and is where all the
weight is. This is the Kysely `kysely/migration` lesson applied deliberately rather than as a 0.29
breaking change: **`pgorm/migrate` is a first-class subpath from day one and is never re-exported
from the root.**

### 1.2 Size budgets, and how they are enforced

Anchored on F10. `kysely` is the closest comparable (types-heavy, zero-dep, ESM-only) at 1.65 MB, and
it has no schema DSL, no codecs and no diff engine — so ~1.5× of Kysely is the honest target for
`pgorm`.

| Budget | Value | Enforcement |
|---|---|---|
| `pgorm` unpacked | ≤ 2.5 MB, ≤ 400 files | `tools/size-budget.mjs`, fails CI |
| `pgorm` total `.d.ts` | ≤ 900 KB across ≤ 200 files (warn at 750 KB) | same |
| `pgorm` **largest single `.d.ts`** | **≤ 40 KB** | same — this is the canary. Drizzle's `codecs.d.ts` (34 KB) and `select.d.ts` (31.5 KB) are exactly where its 1.96 MB came from |
| `pgorm` total JS | ≤ 700 KB raw | same |
| Tree-shaken "connect + one select" | ≤ 35 KB min+gz | `tools/treeshake-check.mjs` |
| Tree-shaken "full CRUD + tx" | ≤ 55 KB min+gz | same |
| Full root import | ≤ 120 KB min+gz | same |
| `pgorm` runtime deps / peer deps | **0 / 0** | asserted in `size-budget.mjs` |
| `pgorm-kit` unpacked | ≤ 8 MB (fail 12 MB); single bundle file ≤ 2 MB | `size-budget.mjs` |

The min+gz numbers are **provisional and get baselined on the first release**, then ratcheted
downward only. Budgets live in `tools/budgets.json` and every change to that file requires a
reviewer-visible justification in the PR body.

**The `pgorm-kit` headline:** ≤ 8 MB against drizzle-kit's 95 MB is a **~12× smaller** dev
dependency. That number goes in the README, because "one number that explains why this exists" is
worth more than a paragraph.

### 1.3 Name — availability verified against the live registry

`pg-orm` is taken (abandoned 2015 package). **`pg-orm-ts` is unusable**: the registry reports
`Unpublished on 2026-08-04`, and npm does not permit reuse of unpublished names. `[verified]`

Three candidates, all confirmed **404 on the registry** (unscoped name free) **and** zero packages
under the matching scope, on 2026-08-14:

| Rank | Name | Runtime pkg | CLI pkg | Scope | Notes |
|---|---|---|---|---|---|
| **1 — RECOMMEND** | **`pgorm`** | `pgorm` | `pgorm-kit` | `@pgorm` | Free `[verified: 404]`. Says exactly what it is; unbeatable for search ("postgres orm typescript"). `pgorm-kit` also free `[verified]`. Near-collisions exist (`noflo-pgorm`, `@titanpl/pgorm`) but neither owns the bare name. |
| 2 | `pgloom` | `pgloom` | `pgloom-kit` | `@pgloom` | Free `[verified: 404]`, zero search collisions at all. More brandable/trademarkable; weaving metaphor fits schema→types. Costs discoverability. |
| 3 | `pglayer` | `pglayer` | `pglayer-kit` | `@pglayer` | Free `[verified: 404]`. Safe, forgettable. |

**Recommendation: `pgorm`, and claim all three of `pgorm` + `pgorm-kit` + the `@pgorm` scope on day
one** (before the first commit — squatting is cheap and irreversible-if-lost). Publish `0.0.0`
placeholders immediately with a README pointing at the repo. The unscoped names are what users type;
the `@pgorm` scope exists so future packages never need a new brand.

*Caveat to close manually:* GitHub org availability could not be verified in-session (the unauth API
rate-limited us, `403` for every probe). Check `github.com/pgorm` before committing to the name;
`pgorm-dev` or `pgorm-org` are acceptable fallbacks since the npm name is what matters.

### 1.4 Monorepo tooling

- **pnpm 11 workspaces** (`pnpm-workspace.yaml`), default isolated `node_modules`. The isolation is
  not incidental: it is what lets `packages/pgorm` build on `typescript@7.0.2` while
  `bench/types` and `docs/` pin `typescript@6.0.3` for the tools that cannot run on 7 (F3). One
  hoisted TS would make that impossible.
- **No Turborepo / Nx / Moon at v0.** Four packages, topological ordering already built into
  `pnpm -r`, and a `tools/` dir of plain `.mjs` scripts. Adding a task runner is a drop-in decision
  we can make later; adding it now is a config language and a 50 MB dev dep for no measured win.
  **Revisit trigger: CI wall clock > 5 min.**
- **`sherif`** (zero-config monorepo linter) in CI for dependency-version consistency and workspace
  hygiene. **`knip`** for unused exports/deps/files — it also catches export-map entries that point
  at nothing, which is a real class of publish bug.
- **Release: Changesets** (`@changesets/cli@^3`; 3.0.0 landed 2026-08-11 and requires
  `node ^22.11 || ^24 || >=26`, `pnpm >=10` `[verified]` — aligned with our floor. If 3.0 proves
  rough in week 1, fall back to the `2.31.x` maintenance line).
  - `pgorm` and `pgorm-kit` are a **`fixed` version group** — they always publish the same version.
    Version skew between an ORM and its CLI is a permanent support tax (it is the top confusion in
    Drizzle's tracker); we design it away.
  - `@pgorm/testing` and `create-pgorm` version independently.
  - CI enforces `changeset status --since=origin/main` on every PR touching `packages/`.
- **`pkg-pr-new`** on every PR → installable preview builds
  (`pnpm add https://pkg.pr.new/pgorm@<sha>`). For a migration tool, "try my fix against your real
  schema" is the single highest-value contributor loop.

---

## 2. Module & exports design

### 2.1 Export map

ESM-only, `"type": "module"`, `"sideEffects": false`, two conditions per entry plus the version gate.
The gate must be **first in every condition object and present on every subpath** — otherwise a deep
import silently bypasses it. `[verified working, F4]`

```jsonc
{
  "name": "pgorm",
  "type": "module",
  "sideEffects": false,
  "license": "Apache-2.0",
  "engines": { "node": ">=22.12" },
  "files": ["dist"],
  "publishConfig": { "access": "public", "provenance": true },
  "exports": {
    ".":                  { "types@<5.9": "./dist/unsupported-typescript.d.ts",
                            "types": "./dist/index.d.ts",
                            "default": "./dist/index.js" },
    "./schema":           { "...same shape..." },   // DDL builders: table/column/index/policy/trigger/function/domain/…
    "./sql":              { "..." },                // sql tag, identifier + JSON-path sanitizers, unsafeRaw
    "./migrate":          { "..." },                // runtime applier: advisory lock, txmode, history table
    "./codecs":           { "..." },                // codec registry + custom-codec authoring API
    "./adapter-pg":       { "..." },                // structural PgLikePool adapter (does NOT import `pg`)
    "./adapter-pglite":   { "..." },
    "./pgvector":         { "..." },
    "./postgis":          { "..." },
    "./package.json":     "./package.json"
  }
}
```

**Why `./schema` is not in the root barrel.** DDL builders are imported by *both* app code and the
CLI. Keeping them behind their own entry means (a) `pgorm-kit` loads the schema graph without ever
touching the executor, (b) an application's server bundle never pulls DDL builders, and (c) the
tree-shaking golden files (§2.4) become meaningful instead of trivially green. The runtime imports
schema **types only** (`import type`), which erase. A lint rule forbids value imports across the
boundary.

**Node floor `>=22.12`** — the first Node 22 LTS where `require(esm)` is unflagged, so a CJS consumer
at least gets a working dynamic path. PG floor is **15** (round-1 decision). TS floor is **5.9**
(below).

### 2.2 TypeScript floor: 5.9, not 5.4

Round-1 recorded "TS ≥ 5.4" because that is Kysely's floor. With F1 in hand that is the wrong number
for a greenfield project. **Floor = `typescript@5.9.3`** (2025-09-30), gated by `"types@<5.9"`.

Rationale: TS 6.0 is the deprecation-alignment release and TS 7.0 is the same checker in Go — so
**5.9, 6.0 and 7.0 share checker semantics**, and 5.9 is the closest 5.x to them. Supporting 5.4–5.8
means supporting four additional checkers whose deep-generic inference differs, on a project whose
entire risk profile is deep-generic inference, with a small maintainer count. A four-version support
matrix (5.9 / 6.0 / 7.0 / 7-next) is testable; an eight-version one is theatre. Lowering a floor
later is non-breaking, so this is the reversible direction.

The stub, `src/unsupported-typescript.d.ts`, brands each root export so the message text lands in the
error. Verified output under TS 5.4.5:

```
error TS2349: This expression is not callable.
  Type '{ readonly __pgormTypeError__: "pgorm requires TypeScript >= 5.9. Please upgrade."; } & String'
  has no call signatures.
```

Refinement over Kysely's version: name the brand key so it reads first in a truncated hover — use
`{ ERROR: 'pgorm requires TypeScript >= 5.9 — see https://pgorm.dev/ts' }` rather than a
`__dunder__` key.

### 2.3 No default export — policy

**Named exports only. No `export default`, no `export =`, no `namespace` exports, no cross-entry
re-export barrels.** Reasons, in order of weight: (1) named exports keep bundler tree-shaking
analysis exact, (2) auto-import suggestions are correct and stable, (3) `export =` and default
interop are the two biggest sources of "works in my bundler, not in yours" bug reports, (4)
`erasableSyntaxOnly` already bans namespaces. Enforced by an `oxlint` `no-default-export` rule **and**
by `tools/api-snapshot.mjs`, which writes every entry's exported-name list to a committed golden file
— so any addition or removal to the public surface shows up as a reviewable diff. That golden file is
also the mechanical basis for 1.0 criterion #1.

### 2.4 Tree-shaking verification method

Not "we set `sideEffects: false` and hope". Concretely, `tools/treeshake-check.mjs`:

1. For each fixture in `fixtures/treeshake/<case>/entry.ts`, bundle with **esbuild**
   (`--bundle --format=esm --minify --platform=node --metafile`) and independently with **rollup**
   (different DCE implementation = a real second opinion).
2. Assert `gzip(bundle) ≤ budgets.json[case]`.
3. **Assert the exact set of included input modules against a committed golden file**, derived from
   the esbuild metafile. This is the part that actually works: it catches "the query builder now
   pulls in the DDL differ" on the PR that introduces it, with a diff a reviewer can read. Size
   budgets alone drift silently.
4. A `sideEffects` correctness fixture: import the package, use nothing, assert the bundle is
   **< 200 bytes**.
5. `publint --strict` + `attw --pack --profile esm-only` on every PR. The prescribed shape is already
   known-clean `[verified, F5]`; the gate exists to keep it that way.

---

## 3. Build & toolchain

### 3.1 Compiler

**`pgorm` runtime: `tsc` only (via `tsgo`, `typescript@7.0.2`). Unbundled ESM, 1:1 source→output file
mapping. No bundler, ever.**

This is the Kysely model and it is unambiguously right for a types-heavy library: the `.d.ts` the
compiler emits is exactly what the compiler consumes, deep-import paths inside inferred types resolve
correctly, `declarationMap` gives go-to-definition into our real sources, and there is no dts-rollup
step to bloat or silently mangle a conditional type. Every bundler-based dts pipeline (api-extractor,
rollup-plugin-dts, rolldown-plugin-dts) is a place where 1.96 MB of declarations comes from. Multiple
public entries come from the export map pointing at real emitted files, not from bundler entry
config.

**Emit-parity guard.** TS 7 is six weeks old as a stable release. `tools/emit-parity.mjs` builds
`packages/pgorm` twice — once with `typescript@6.0.3` and once with `tsgo@7.0.2` — and `diff -r`s the
two `dist/` trees, failing on any difference. That converts "is the new compiler's emit trustworthy?"
from an unknown into a test, and gives us a one-line fallback (`build with 6.0.3`) if it ever fires.

**`pgorm-kit` CLI: bundled with `esbuild@0.28` into a single ESM file with a shebang; `.d.ts` for its
small programmatic API emitted by `tsgo`.** Bundling pays here and only here: CLI cold-start matters,
and inlining deps means `npm i -D pgorm-kit` never surprises anyone with a transitive tree.
**esbuild rather than `tsdown`** — `tsdown@0.22` (rolldown) is the Vite team's tsup successor and is
where the ecosystem is heading, but it is pre-1.0 and we would be taking it for a job esbuild does in
20 lines of stable config. **Revisit `tsdown` when it hits 1.0.**

### 3.2 Declaration strategy & budget

- `declaration: true`, `declarationMap: true`, `sourceMap: true`. Ship `dist/**/*.d.ts` +
  `.d.ts.map` + `.js.map`; do **not** ship sources (`files: ["dist"]`) — maps point at published
  `.map` files with `sourcesContent` inlined for the small files and omitted for large ones.
- **`isolatedDeclarations`: `false` in `pgorm` (the builder API is inference-heavy and explicit
  return types there would be both unwritable and worse for users), `true` in `pgorm-kit`,
  `@pgorm/testing` and `create-pgorm`** — where it is free and buys parallel emit plus a guarantee
  that no inferred type leaks a deep internal path.
- **Budget: ≤ 900 KB total, ≤ 200 files, ≤ 40 KB per file** (§1.2). `tools/size-budget.mjs` prints
  the top-10 largest declarations on failure so the offender is obvious.
- **`skipLibCheck: true` for the normal build** (speed), plus a dedicated CI job `check:dts` that
  type-checks the *emitted* `dist/**/*.d.ts` with `skipLibCheck: false` under **each** supported TS
  version. That is the guarantee that matters and it costs seconds.

### 3.3 Strictness (`tsconfig.base.json`)

```jsonc
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"],
    "module": "nodenext", "moduleResolution": "nodenext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,
    "noUnusedLocals": true, "noUnusedParameters": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "erasableSyntaxOnly": true,
    "declaration": true, "declarationMap": true, "sourceMap": true,
    "skipLibCheck": true
  }
}
```

`erasableSyntaxOnly` is not cosmetic: it bans enums, namespaces and parameter properties, which means
our sources run unmodified under `node --experimental-strip-types` and under every transpiler. For a
library people will use in Node's native TS mode, that is a compatibility guarantee we get for free
by turning on a flag on day one — and an expensive refactor if we turn it on in year two.

`exactOptionalPropertyTypes` is included deliberately despite the friction, because a query builder's
`{ limit?: number }` vs `{ limit?: number | undefined }` distinction is exactly the kind of thing
that becomes an unfixable API bug once published.

### 3.4 Dual lint

Two gates, not three:

1. **Types-as-lint: `tsgo --noEmit -b`** across the workspace. Sub-second inner loop (F2), and it is
   the gate that actually catches bugs in this codebase.
2. **`oxlint@1.78`** as the only ESLint-class linter, with **`oxlint-tsgolint@7.0.2001`** enabled for
   the type-aware rules (it is powered by typescript-go, so it runs on the same TS 7 install — no
   second TypeScript needed for linting). Required type-aware rules for an async DB library:
   `no-floating-promises`, `no-misused-promises`, `await-thenable`, `require-await`,
   `no-unnecessary-condition`. Plus `no-default-export` and a restricted-import rule enforcing the
   entry-point boundaries from §2.1.

**We do not run `typescript-eslint`.** Its peer range caps at TS 6.0.x (F3), so adopting it means
pinning a second TypeScript solely for linting, on a project whose whole thesis is "no accidental
weight". If a rule we need turns out to be missing from oxlint's type-aware set, the escape hatch is
a single `typescript-eslint` CI job in an isolated workspace package pinned to `6.0.3` — added only
when a concrete rule justifies it.

Formatting: `oxlint`'s formatter if stable, else `prettier` with zero config beyond `.editorconfig`.
Formatting is not a design decision and should not consume review time.

---

## 4. Test infrastructure

Runner: **Vitest 4** with workspace projects, one project per tier. (`node:test` is tempting for
dependency minimalism, but projects/matrix, golden-file snapshots, coverage and concurrency control
are worth one dev dependency in a monorepo.)

### 4.1 Tier 0 — unit, against the structural driver mock

Agent 02's `PgLikePool` seam makes this free: `@pgorm/testing` exports `createMockPool()`, which
returns a `PgLikePool`-shaped object that records every `{ text, values, mode, binary, rowMode }` and
replays scripted result sets. **Every SQL-emitting path gets a golden-string assertion.** No database,
no I/O. **Target: the whole tier 0 suite under 5 seconds.** This is where 80% of the tests live and it
is the reason `pnpm test` can be the default command.

### 4.2 Tier 1 — PGlite. **VERDICT: adopt, as the default local target, with a hard boundary.**

PGlite 0.5.5 is better than expected and the evidence is hands-on (F6, F7). It is **PostgreSQL 18.3**,
zero npm dependencies, boots a fresh database in ~0.6 s, needs no Docker, and works on macOS, Linux
and Windows identically — so `git clone && pnpm i && pnpm test` works for a first-time contributor on
any machine. Verified working: the full DDL surface we intend to differentiate on (functions,
triggers, domains, composite types, ranges, partitions, generated/identity columns, matviews with
`REFRESH … CONCURRENTLY`), **RLS with real roles and enforced policies**, `CREATE INDEX CONCURRENTLY`,
advisory locks, and — via `@electric-sql/pglite-socket` — the **real `pg` driver over the real wire
protocol**, including named prepared statements, `rowMode: 'array'` and `binary: true`.

**And it has one disqualifying limitation that the docs do not lead with, which we verified (F8): it
is a single backend.** With `maxConnections > 1`, pglite-socket multiplexes sockets onto one PG
session. Both "connections" report `pg_backend_pid() = 42`; `set_config` and temp tables leak between
them; **`pg_advisory_lock()` on one and `pg_try_advisory_lock()` on the other returns `true` where
real PG returns `false`**; cross-connection `LISTEN`/`NOTIFY` delivers nothing.

That last one matters more than anything else on this page: **our migration runner's advisory-lock
safety would test green on PGlite while being completely broken.** So:

> **Rule: anything whose correctness depends on a second session runs on tier 2 and is banned from
> tier 1.** Concretely banned from PGlite: advisory-lock contention, cross-session LISTEN/NOTIFY, row-
> and DDL-lock waiting, `40001` serialization-failure retry, deadlock detection, `lock_timeout` /
> `statement_timeout` behaviour under contention, connection-pool semantics, and PgBouncer modes.
> `@pgorm/testing` exports the PGlite fixture with a `requiresConcurrency()` guard that throws
> loudly rather than passing quietly.

Second boundary: PGlite is PG **18.3**, above our PG-15 floor, so it cannot catch version-gated
`pg_catalog` differences. Tier 2 is mandatory, not optional.

Tier 1 covers: codec round-trips (encode → wire → decode for every column type), DDL emit + apply +
introspect, migration golden files and roundtrip-verify, query-builder output against a real planner,
error-code mapping, and the sanitizer differential tests. Extensions are injected at construction
(`new PGlite({ extensions: { pg_trgm, btree_gist } })`) — bare `CREATE EXTENSION` fails.

### 4.3 Tier 2 — testcontainers, real PostgreSQL

`@testcontainers/postgresql@12.1` against **PG 15, 16, 17, 18**, plus a **PgBouncer 1.24
transaction-mode** container (round-1 §7 made pooler safety a first-class design axis; it needs a
first-class test target).

- **Isolation strategy: one container per PG version per CI job**, per-test isolation via
  `CREATE DATABASE t_<n> TEMPLATE base` (~100 ms). Container-per-test is the standard way to make a
  test suite take 40 minutes.
- **On PRs: PG 17 only.** On `main` and nightly: the full 15/16/17/18 × PgBouncer matrix.
- Exclusive coverage: everything in the tier-1 ban list, plus real extension availability
  (`postgis`, `pgvector`), `pg_stat_statements`, role/grant behaviour across genuinely separate
  sessions, and `CREATE INDEX CONCURRENTLY` under a concurrent write load (the case where `txmode
  none` actually earns its complexity).

### 4.4 Migration-engine test strategy

The diff engine is the headline feature and, per round-1 risk #3, its failure mode is a long tail. Five
mechanisms, in order of value:

1. **Golden-file diffs.** `fixtures/migrations/<case>/{from.ts, to.ts, expected.sql,
   expected.plan.json}`. `pnpm test:golden -u` regenerates. **Any PR that changes emitted SQL shows
   the SQL diff in review** — this is the single most important review artifact in the project and it
   should be impossible to merge a diff-engine change without one.
2. **Roundtrip-verify as a test oracle.** For every fixture: apply `expected.sql` to an empty
   database → introspect → diff against `to.ts` → **assert the diff is empty**. Then apply again →
   assert idempotent. Then diff `to.ts` against itself → **assert empty** (this is the phantom-diff
   class: MikroORM's enum diffs, Prisma's partial-index churn). This is `migrate verify` used as a
   test, which is also why `verify` must be a shipped command.
3. **Grammar-based schema fuzzing.** Generate random `(A, B)` schema pairs over the DDL IR; assert
   `introspect(apply(diff(A, B))) ≡ B`, and that `diff(A, A)` is empty (minimality). Seeded, with
   shrinking on failure. 200 cases in PR CI, 50 000 nightly.
4. **Sanitizer fuzzing — security-critical, day one.** Round-1 §8 and the three Kysely CVEs make
   identifier and JSON-path emission the highest-risk code in the repo. `fast-check` properties over
   arbitrary Unicode input, asserting: (a) our emitted identifier is **byte-identical to PostgreSQL's
   own `quote_ident($1)`** and our literal to `quote_literal($1)`, evaluated by executing both against
   a live server (differential testing against the reference implementation — not against our own
   idea of correct); (b) the emitted fragment parses to the intended AST shape via libpg_query
   (`pgsql-parser`), proving no escape from the quoting context; (c) a committed regression corpus
   seeded with the exact GHSA-wmrf-hv6w-mr66 / GHSA-pv5w-4p9q-p3v2 payloads. Runs on both tiers.
   ≥10⁷ generated cases before 1.0.
5. **Real-world corpus.** ~20 public PG schemas (Discourse, Mastodon, Sentry, PostgREST samples,
   Supabase templates): dump → introspect → emit TS schema → emit SQL → **assert empty diff**. Cheap
   once introspection works, and it is the test most likely to find the bugs users would have found.
   Nightly.

Coverage gate: 90% lines on `pgorm`, 85% on `pgorm-kit`. Not 100% — chasing the last 10% on a code
generator produces tests that assert the implementation.

### 4.5 Type-level testing (harness — budgets are agent 04's)

- **Assertions: `expect-type@1.4`.** Zero dependencies, no runner, works on every TS version. Because
  assertions are ordinary type expressions in ordinary test files, **the whole type-assertion suite is
  re-run for free by every `tsc --noEmit` in the TS matrix** — 5.9, 6.0, 7.0 and 7-next all check it.
  No other option gives that.
- **Type *performance*: `@ark/attest@0.56`**, in `bench/types`, a workspace package pinned to
  `typescript@6.0.3` (it needs the JS compiler API — F3). `attest` produces instantiation counts and
  is literally the tool Prisma used to benchmark Drizzle, so our numbers are comparable to published
  ones. Baselines committed to `bench/types/baselines.json`; `--update-baselines` to change them.
- **Expected-error tests:** `tools/type-errors/` compiles fixtures with the TS 6.0.3 API and asserts
  the **message text** of our branded `PgOrmTypeError<'…'>` diagnostics against golden files. Error
  message quality is a headline DX feature (round-1: Drizzle's error spew is its own top complaint);
  features have tests, so error messages get tests.
- **`tstyche` considered and rejected.** Its distinguishing feature is built-in multi-TS-version
  targeting, which `expect-type` + a `tsc` matrix already gives us without a second runner. Keep it
  as the fallback if `@ark/attest`'s TS-7 incompatibility ever becomes blocking.

### 4.6 CI matrix

| Job | Matrix | Trigger | Budget |
|---|---|---|---|
| `lint` | oxlint + `tsgo --noEmit -b` | every PR | < 60 s |
| `unit` (tier 0) | Node **22.12, 24, 26** × ubuntu | every PR | < 2 min |
| `types` | TS **5.9.3, 6.0.3, 7.0.2**, + `7-next` (continue-on-error) — type-check fixtures **and** lib-check the emitted `dist/**/*.d.ts` | every PR | < 4 min |
| `pglite` (tier 1) | Node 24 × **ubuntu, macos, windows** | every PR | < 5 min |
| `pg` (tier 2) | PG **17** | every PR | < 6 min |
| `pg-matrix` (tier 2) | PG **15, 16, 17, 18** + PgBouncer 1.24 | main + nightly | — |
| `package` | `publint --strict`, `attw --pack --profile esm-only`, size budgets, `.d.ts` budget, tree-shake goldens, `emit-parity` | every PR | < 2 min |
| `bench:compile` + `bench:types` | deterministic, no DB | every PR (gate) | < 3 min |
| `bench:runtime` | fixed runner, vs raw `pg` | nightly + `perf` label | — |
| `corpus` + `fuzz` | 50k schema pairs, 10⁷ sanitizer cases | nightly | — |

Windows in tier 1 is a genuine, free win from PGlite — no Docker on Windows CI, which is where
Postgres-tooling projects usually give up on Windows support entirely.

---

## 5. Performance benchmarking

The bar from round-1 is "near-raw driver overhead"; the anti-target is Prisma 7's ~11× average /
~27× p99. Both of those are *ratios*, so the harness measures ratios.

**Design: every case is a pair.** `raw()` uses `pg` directly, `orm()` uses `pgorm`, against the same
database, the same query, the same connection settings, interleaved in the same process to cancel
drift. We report `overhead_p50 = orm_p50 / raw_p50` and `overhead_p99`, never absolute milliseconds in
isolation.

**Nine core cases:** point select by PK; select 1 000 rows; insert one; insert 1 000 (batch);
update by PK; delete by PK; a 5-statement transaction; one-level relation load (vs a hand-written
`LATERAL` + `json_agg`); two-level relation load.

**Gate: p50 ≤ 1.15×, p99 ≤ 1.30× raw `pg`** on all nine. Published in the README as a table with the
raw numbers and the machine spec, because a ratio without absolutes is marketing.

**What runs where — the important part.** A wall-clock database benchmark on a shared CI runner is
noise, and gating PRs on noise trains people to re-run CI until it passes. So:

- **In CI on every PR (hard gate, deterministic, no database):**
  1. **SQL-compilation throughput** — builder → `{ sql, params }`, no I/O. This isolates *our*
     overhead from PostgreSQL's latency and is stable enough to gate. Target: ≥ 200 000 simple
     selects/sec; alloc-per-compile tracked and gated (allocation count is where ORM overhead
     actually hides).
  2. **TypeScript compile-time gate** — `@ark/attest` instantiation counts on the 10 / 100 / 400-table
     fixture schemas against committed baselines, plus `tsgo --extendedDiagnostics` wall-clock and
     `--generateTrace` output size. **Fail on > 5% instantiation growth, warn at > 2%.** Round-1
     risk #1 says this is the number-one technical risk of the inference approach; a risk you measure
     on every PR is a managed risk. Budgets are agent 04's; the wiring is here.
- **Nightly on a fixed runner:** the full nine-case ratio benchmark, plus a comparison run against
  `drizzle-orm`, `kysely` and `@prisma/client` on identical queries. Results posted to a tracked
  dashboard; a >25% regression opens an issue automatically.
- **On PRs labelled `perf`:** the runtime benchmark runs and posts a 3-run-median comparison comment.
  Informational, never blocking.

Harness: **`mitata@1.0.34`** for the no-I/O microbenchmarks (best-in-class for small durations, prints
distributions rather than a single mean), plain `perf_hooks` percentile collection for the DB cases
where the distribution shape *is* the result.

---

## 6. Release discipline

The two failure modes to avoid are precisely characterised by the research: **Drizzle's eternal RC**
(1.0.0-beta.1 on 2025-11-03, still `rc.4` on 2026-06-27 — ~9.5 months, and `latest` still resolves to
the 0.4x line) and **Kysely's permanent 0.x** (1.0 refused twice, most recently "Because we don't feel
like it", while shipping a hard break — the migration API moving out of the root entry — in a minor).
Both are policy failures, so the fix is policy.

### 6.1 Versioning policy

- **We ship `0.x` until the 1.0 criteria are met, and breaking changes land in a MINOR (`0.N.0`),
  never in a PATCH.** This is stated in the README's first section, not buried in CONTRIBUTING.
- **Every breaking change requires**: a `BREAKING:` section in the changeset, a before/after entry in
  `MIGRATING.md`, and — wherever the change is mechanical — a codemod shipped as
  `pgorm-kit codemod <name>`. A breaking change without a migration path does not merge.
- **Cadence:** a minor roughly every 6 weeks; patches whenever needed. `ROADMAP.md` carries the 1.0
  checklist with a per-item status and is updated on every minor.
- **The no-RC-purgatory rule:** *never more than 3 consecutive prereleases of the same target version,
  and never more than 8 weeks on a prerelease line.* If `1.0.0-rc.3` is not shippable, **we cut scope,
  not another RC.** (Drizzle's line ran 26+ prereleases across 9.5 months. This rule is what that
  costs, written down in advance.)
- **The no-permanent-0.x rule:** the 1.0 criteria below are a **closed list**. Nothing may be added to
  it after publication. When every item is green, **1.0.0 ships within 30 days**, regardless of what
  else is in flight.
- **Post-1.0:** strict semver. At most one major per 12 months. Every major ships with codemods and a
  6-month support window for the previous major.

### 6.2 The 1.0 criteria — closed list, 12 items

1. **API frozen.** No breaking public-surface change for two consecutive minors (~12 weeks), proven
   by the committed `api-snapshot` golden files.
2. **DDL coverage complete.** Tables, columns, PK/FK/unique/check/exclusion constraints, indexes
   (partial, expression, opclass, `INCLUDE`), enums, domains, composite types, sequences, views,
   matviews, functions, triggers, RLS policies, roles/grants, schemas, extensions, comments,
   partitions — each with a golden-file fixture **and** a roundtrip-verify test.
3. **`migrate verify` returns an empty diff** across the entire fixture corpus **and** ≥ 15
   third-party real-world schemas.
4. **Zero open `bug:diff` issues** at cut.
5. **Runtime perf:** p50 ≤ 1.15× and p99 ≤ 1.30× raw `pg` on all nine core cases, published with the
   machine spec.
6. **Type perf:** ≤ 25 000 instantiations for the 100-table fixture, ≤ 8 s cold `tsc --noEmit` on the
   400-table fixture, and **no schema size at which check time is superlinear** (measured across
   10/100/400). *(Exact thresholds are agent 04's to set; the gate exists regardless.)*
7. **Size budgets met:** `pgorm` ≤ 2.5 MB unpacked, `.d.ts` ≤ 900 KB, no single `.d.ts` > 40 KB,
   hello-world ≤ 35 KB min+gz, **zero runtime deps and zero peer deps**; `pgorm-kit` ≤ 8 MB.
8. **Security:** sanitizer fuzz suite green over ≥ 10⁷ generated cases differential-tested against
   PostgreSQL's own `quote_ident`/`quote_literal`; `SECURITY.md` published with a disclosure address
   and a ≤ 72 h triage commitment; every release published via npm **trusted publishing** with
   provenance attestation.
9. **Support matrix green in CI:** PG 15/16/17/18, Node 22/24/26, TS 5.9/6.0/7.0, plus PgBouncer
   transaction mode.
10. **Docs complete:** every public export documented; a 15-minute getting-started a fresh reader can
    finish without opening source; a migrations guide; an operations guide (locks, CIC, zero-downtime
    patterns); a "why not X" comparison page. All code samples type-checked in CI.
11. **Governance:** ≥ 2 people hold npm publish rights and repo admin; `GOVERNANCE.md` published; the
    release runbook has been executed end-to-end by the *second* person at least once.
12. **Adoption evidence:** ≥ 3 named production users (or ≥ 1 above 1M req/day), and 8 consecutive
    weeks with no P0 issue open longer than 72 h.

### 6.3 Changelog & release automation

Changesets → `changesets/action` opens a "Version Packages" PR on merge to `main` → merging it runs
`pnpm publish -r` from CI. Publishing uses **npm trusted publishing (OIDC)** with
`provenance: true` — no long-lived npm token exists anywhere, which after the 2025 supply-chain
incidents is table stakes and is also the mechanism that makes criterion #11 possible (the *workflow*
is the publisher, so adding a second human is a permissions change, not a secret hand-off).
`CHANGELOG.md` is generated per-package by Changesets; GitHub Releases are cut from it.

### 6.4 Docs site

- **Astro Starlight** (`@astrojs/starlight@0.41`) for guides, concepts, recipes, the operations
  manual, and the comparison pages. MDX, Pagefind search built in, `starlight-versions` for versioned
  docs once 1.0 lands.
- **No TypeDoc at v0.** Two reasons: it peers at TS ≤ 6.0.x (F3), so it would force a second pinned
  TypeScript into the repo; and TypeDoc output for a deeply-generic type system is unreadable spew —
  the exact artefact that makes Kysely's and Drizzle's generated docs unhelpful. Instead the API
  reference is **hand-curated Starlight pages whose code samples are compiled in CI**
  (`tools/docs-typecheck.mjs` extracts every fenced `ts` block and type-checks it). Hand-written docs
  that cannot rot beat generated docs that nobody reads. **Revisit post-1.0** as a supplementary "full
  API index" in an isolated workspace package pinned to `typescript@6.0.3`.
- **Docs examples are tests.** Blocks tagged `title=` are extracted into `examples/` and *executed*
  against tier-1 PGlite. Cheap, and it is a differentiator: nobody's ORM docs are green-CI-verified.
- Hosting: Cloudflare Pages (or GH Pages) from the `docs/` workspace.

### 6.5 License

**Apache-2.0** for `pgorm`, `pgorm-kit`, `@pgorm/testing` and `create-pgorm`, with a `NOTICE` file.
Docs content **CC-BY-4.0**.

Rationale: the express patent grant (§3) and patent-retaliation clause are the reason enterprise OSS
review boards wave Apache-2.0 through, and a schema-diff engine plus a SQL compiler is exactly the
category where that matters. `drizzle-orm` and Prisma both chose Apache-2.0; Kysely and MikroORM chose
MIT. MIT is the alternative if maximum familiarity is judged more valuable than the patent grant, but
there is no practical downside to Apache-2.0 for a library nobody will statically link into a GPLv2-
only project. **Contributions under DCO sign-off, not a CLA** — a CLA deters drive-by contributors and
we have nothing to relicense toward.

### 6.6 Governance — the bus-factor-1 answer

Kysely's health is genuinely good and its adoption is genuinely real, and it is *still* the thing
every evaluation flags, because ~90% of human commits are one person who has publicly refused both
money and a 1.0. That is an optics problem as much as a real one, and both halves are addressable:

- **`GOVERNANCE.md`** naming maintainers, the contributor → maintainer path (3 merged non-trivial PRs
  + one shadowed release), public RFC issues required for any public-API change, and an explicit
  **succession clause**: if the lead is unreachable for 90 days, named backup maintainers assume
  publish rights.
- **Two humans with publish rights and repo admin from day one**, plus trusted publishing so CI — not
  a personal token — is the actual publisher.
- **`CONTRIBUTING.md`** whose setup section is three commands (`pnpm i`, `pnpm build`, `pnpm test`)
  **with no Docker required** — that is what tier 1 buys us and it should be the first line, because
  "you need Docker and a local Postgres" is where most would-be contributors stop.
- **We accept funding**, explicitly contra Kysely: GitHub Sponsors + Open Collective, with
  `FUNDING.md` stating what money buys (maintainer hours and the PG-matrix CI bill). Refusing funding
  is a principled position that structurally caps maintenance capacity; we are not taking it.
- `SECURITY.md` with GitHub private vulnerability reporting enabled, plus `SUPPORT.md` and issue
  templates — including a dedicated **"diff engine produced wrong SQL"** template that *requires* a
  minimal `from`/`to` schema pair, because that is the bug class that will dominate the tracker.

---

## 7. Repo layout

```
pgorm/
├─ .github/
│  ├─ workflows/            ci.yml  nightly.yml  release.yml  bench.yml  codeql.yml  scorecard.yml
│  ├─ ISSUE_TEMPLATE/       bug.yml  diff-bug.yml  type-perf.yml  feature.yml  config.yml
│  ├─ CODEOWNERS  dependabot.yml  pull_request_template.md  FUNDING.yml
├─ .changeset/              config.json  *.md
├─ packages/
│  ├─ pgorm/                                   # runtime — zero deps, ESM-only, tsc-emitted
│  │  ├─ src/
│  │  │  ├─ index.ts                           # root entry: client, tx, query builder
│  │  │  ├─ schema/         index.ts  table.ts  columns/  constraints/  indexes/  policies/
│  │  │  │                  triggers.ts  functions.ts  domains.ts  composites.ts  partitions.ts  ir.ts
│  │  │  ├─ sql/            index.ts  tag.ts  identifier.ts  json-path.ts  unsafe-raw.ts
│  │  │  ├─ codecs/         index.ts  registry.ts  scalar/  array.ts  json.ts  range.ts  temporal.ts
│  │  │  ├─ builder/        select.ts  insert.ts  update.ts  delete.ts  expression.ts  relations.ts
│  │  │  ├─ compiler/       compile.ts  nodes.ts
│  │  │  ├─ executor/       exec-mode.ts  result.ts  errors.ts
│  │  │  ├─ migrate/        index.ts  applier.ts  lock.ts  history.ts  txmode.ts
│  │  │  ├─ adapter/        types.ts  pg.ts  pglite.ts        # structural — imports no driver
│  │  │  ├─ pgvector.ts  postgis.ts
│  │  │  ├─ unsupported-typescript.d.ts        # the types@<5.9 stub
│  │  │  └─ internal/                          # never exported
│  │  ├─ test/              unit/  pglite/  pg/  types/
│  │  └─ package.json  tsconfig.json  README.md
│  ├─ pgorm-kit/                               # CLI + diff engine — esbuild single-file bundle
│  │  ├─ src/               cli.ts  commands/  introspect/  diff/  plan/  lint/  apply/  codemod/
│  │  ├─ test/              unit/  golden/  fuzz/  corpus/
│  │  └─ package.json  tsconfig.json  build.mjs
│  ├─ pgorm-testing/        src/{mock-pool.ts,pglite-fixture.ts,pg-fixture.ts,expect-sql.ts}   # → @pgorm/testing
│  └─ create-pgorm/         src/  templates/
├─ fixtures/
│  ├─ schemas/              10-tables/  100-tables/  400-tables/        # type-perf fixtures
│  ├─ migrations/<case>/    from.ts  to.ts  expected.sql  expected.plan.json
│  ├─ treeshake/<case>/     entry.ts  expected-modules.json            # metafile goldens
│  └─ corpus/               discourse.sql  mastodon.sql  sentry.sql  …
├─ bench/
│  ├─ runtime/              cases/  harness.ts  baselines.json          # ratio vs raw `pg`
│  ├─ compile/              cases/  harness.ts  baselines.json          # SQL-compile throughput
│  └─ types/                cases/  attest.config.ts  baselines.json    # pins typescript@6.0.3
├─ examples/                quickstart/  relations/  migrations/  rls/  partitions/  pooler/
├─ docs/                                                                # Astro Starlight
│  ├─ src/content/docs/     guides/  concepts/  reference/  operations/  compare/
│  └─ astro.config.mjs  package.json
├─ tools/
│  ├─ budgets.json          size-budget.mjs     treeshake-check.mjs
│  ├─ emit-parity.mjs       api-snapshot.mjs    docs-typecheck.mjs
│  └─ type-errors/          run.mjs  fixtures/  golden/
├─ pnpm-workspace.yaml  pnpm-lock.yaml  package.json
├─ tsconfig.base.json  tsconfig.json  vitest.config.ts  .oxlintrc.json
├─ .npmrc  .nvmrc  .editorconfig  .gitignore
└─ LICENSE  NOTICE  README.md  CONTRIBUTING.md  GOVERNANCE.md  SECURITY.md
   SUPPORT.md  ROADMAP.md  MIGRATING.md  CHANGELOG.md
```

---

## 8. Open items for the team lead

1. **Confirm the name.** `pgorm` is the recommendation; GitHub org availability is the one thing not
   verifiable in-session. Claim `pgorm`, `pgorm-kit` and the `@pgorm` scope on npm today regardless of
   the final call — placeholders are free and the names are not.
2. **TS floor 5.9 vs 5.4.** I chose 5.9 (§2.2) to keep the supported-checker count at four. If
   adoption research says otherwise, dropping to 5.4 later is non-breaking; raising it is not.
3. **Apache-2.0 vs MIT** (§6.5) — a one-line decision that is effectively irreversible after the first
   external contribution.
4. **Agent 04 owns the numeric type-perf budgets**; §5 and criterion #6 carry placeholders. The
   harness (`bench/types`, pinned to `typescript@6.0.3`, `@ark/attest`, committed baselines, 5%
   fail / 2% warn) is wired here and does not depend on the values.
5. **Agent 02's `PgLikePool` seam** is assumed to be structural and driver-free; `@pgorm/testing`'s
   `createMockPool()` and the `pgorm/adapter-pg` subpath both depend on that shape holding.
```
