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
| **`pg-prime`** | The runtime. Schema DSL, codec registry, query builder + compiler, executor, transactions, structural driver adapters, migration *applier*. | **zero runtime deps, zero peer deps** | `tsgo`, unbundled ESM | **≤ 2.5 MB / ≤ 400 files** |
| **`@pg-prime/kit`** | The CLI. Introspection, diff engine, plan emission, hazard linter, `verify` / `baseline` / `push`, codemods. | bundled & inlined | `esbuild` single file + `tsgo` for `.d.ts` | **≤ 8 MB** (hard fail 12 MB) |
| **`@pg-prime/testing`** | Structural driver mock, ephemeral PGlite/testcontainer fixtures, `expectSql` golden helpers. Dev-only. | `@electric-sql/pglite` + `@testcontainers/postgresql` as **optional** peers | `tsgo` | ≤ 300 KB |
| **`@pg-prime/create`** | `npm create @pg-prime` scaffolder. | bundled | `esbuild` | ≤ 500 KB |

**Deliberately NOT separate packages:**

- **No `@pg-prime/adapter-pg`.** The adapter interface is structural (`PgLikePool`, per research §6) — it
  never imports `pg`'s types, it declares the shape `pg` happens to satisfy. That is ~300 LOC and it
  ships as the `pg-prime/adapter-pg` **subpath**, not a package. Same for `pg-prime/adapter-pglite`. This is
  how we get zero deps *and* zero peer deps, and how Neon/Hyperdrive duck-type in for free.
- **No `@pg-prime/pgvector` / `@pg-prime/postgis`.** Extension codecs are pure TS with no dependencies; they
  ship as `pg-prime/pgvector` and `pg-prime/postgis` subpaths and tree-shake to zero when unused. Splitting
  them into packages buys nothing and costs a version-skew axis.
- **No `@pg-prime/core` + `@pg-prime/postgres` split.** There is no second dialect. Ever. That split is the
  thing we are differentiating against.

**Where the CLI/runtime boundary sits (the load-bearing decision):**
`pg-prime` contains the migration **applier** (read `.sql` + `.plan.json`, take
`pg_advisory_xact_lock`, honour `txmode`, record in the history table) because production apps run
migrations at boot and must not install a CLI to do it. `@pg-prime/kit` contains the migration
**author** (introspect → diff → emit → lint), which is a dev-time-only concern and is where all the
weight is. This is the Kysely `kysely/migration` lesson applied deliberately rather than as a 0.29
breaking change: **`pg-prime/migrate` is a first-class subpath from day one and is never re-exported
from the root.**

### 1.2 Size budgets, and how they are enforced

Anchored on F10. `kysely` is the closest comparable (types-heavy, zero-dep, ESM-only) at 1.65 MB, and
it has no schema DSL, no codecs and no diff engine — so ~1.5× of Kysely is the honest target for
`pg-prime`.

| Budget | Value | Enforcement |
|---|---|---|
| `pg-prime` unpacked | ≤ 2.5 MB, ≤ 400 files | `tools/size-budget.mjs`, fails CI |
| `pg-prime` total `.d.ts` | ≤ 900 KB across ≤ 200 files (warn at 750 KB) | same |
| `pg-prime` **largest single `.d.ts`** | **≤ 40 KB** | same — this is the canary. Drizzle's `codecs.d.ts` (34 KB) and `select.d.ts` (31.5 KB) are exactly where its 1.96 MB came from |
| `pg-prime` total JS | ≤ 700 KB raw | same |
| Tree-shaken "connect + one select" | ≤ 35 KB min+gz | `tools/treeshake-check.mjs` |
| Tree-shaken "full CRUD + tx" | ≤ 55 KB min+gz | same |
| Full root import | ≤ 120 KB min+gz | same |
| `pg-prime` runtime deps / peer deps | **0 / 0** | asserted in `size-budget.mjs` |
| `@pg-prime/kit` unpacked | ≤ 8 MB (fail 12 MB); single bundle file ≤ 2 MB | `size-budget.mjs` |

The min+gz numbers are **provisional and get baselined on the first release**, then ratcheted
downward only. Budgets live in `tools/budgets.json` and every change to that file requires a
reviewer-visible justification in the PR body.

**AS BUILT · 2026-08-28.** `tools/size-budget.mjs` and `tools/budgets.json` exist and are gated by
the `package` CI job. The artifact lines are measured from `npm pack --dry-run --json` — the file
list npm would actually ship, `files: ["dist"]` and the implicit `README`/`LICENSE` applied — not
from `du dist/`. Measured for `pg-prime`: **1 547 KB unpacked / 231 files** (budget 2 560 KB / 400),
**378 KB of `.d.ts` across 58 files** (budget 900 KB / 200), **604 KB of JS** (budget 700 KB),
**0 dependencies / 0 peerDependencies** — asserted, not assumed. `@pg-prime/kit`: **390 KB unpacked
/ 87 files** against 8 MB. Two lines do not pass as written and both are recorded in
`budgets.json._overDesign` rather than quietly widened: the **40 KB per-file `.d.ts` canary**
(§3.2 AS BUILT) and **`connect-one-select`** (§2.4 AS BUILT). Both gates are set *at* the
measurement, so they ratchet.

**The `@pg-prime/kit` headline:** ≤ 8 MB against drizzle-kit's 95 MB is a **~12× smaller** dev
dependency. That number goes in the README, because "one number that explains why this exists" is
worth more than a paragraph.

### 1.3 Name — DECIDED

Runtime `pg-prime` · CLI `@pg-prime/kit` · test helpers `@pg-prime/testing` · scaffolder
`@pg-prime/create` (`npm create @pg-prime`) · anything else that ships lives under `@pg-prime/*`
(adapters and extensions stay *subpaths* of the runtime, §1.1). The `@pg-prime` npm org and the GitHub
org `pg-prime` are held. Renamed from `pgorm` / `pgormjs` on 2026-08-27; the SQL-side prefix is
`pgprime_` because PostgreSQL reserves `pg_` for system schemas (42939) — a rule PGlite does not enforce.

The one lesson worth keeping from the search: **a 404 on the registry does not mean a name is
available.** Bare `pgorm` returned 404 and was nevertheless permanently unpublishable — npm's
similarity rule rejects it against the squatted 2015 `pg-orm` ("Package name too similar to
existing package pg-orm"). The rule compares names with `.`, `-` and `_` stripped, so check every
punctuation-equivalent (`pg-prime` ≡ `pgprime` ≡ `pg_prime` ≡ `pg.prime`, all unregistered on
2026-08-27) and treat the first `0.0.0` publish as the proof. `pg-orm-ts` is separately dead:
unpublished 2026-08-04, and npm forbids reuse of unpublished names.

**Status:** `pgormjs@0.0.0` (the pre-rename placeholder) is published and will be deprecated.
`pg-prime`, `@pg-prime/kit`, `@pg-prime/testing` and `@pg-prime/create` are unclaimed — placeholders
are free and the names are not.

### 1.4 Monorepo tooling

- **pnpm 11 workspaces** (`pnpm-workspace.yaml`), default isolated `node_modules`. The isolation is
  not incidental: it is what lets `packages/pg-prime` build on `typescript@7.0.2` while
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
  - `pg-prime` and `@pg-prime/kit` are a **`fixed` version group** — they always publish the same version.
    Version skew between an ORM and its CLI is a permanent support tax (it is the top confusion in
    Drizzle's tracker); we design it away.
  - `@pg-prime/testing` and `@pg-prime/create` version independently.
  - CI enforces `changeset status --since=origin/main` on every PR touching `packages/`.
- **`pkg-pr-new`** on every PR → installable preview builds
  (`pnpm add https://pkg.pr.new/pg-prime@<sha>`). For a migration tool, "try my fix against your real
  schema" is the single highest-value contributor loop.

---

## 2. Module & exports design

### 2.1 Export map

ESM-only, `"type": "module"`, `"sideEffects": false`, two conditions per entry plus the version gate.
The gate must be **first in every condition object and present on every subpath** — otherwise a deep
import silently bypasses it. `[verified working, F4]`

```jsonc
{
  "name": "pg-prime",
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
CLI. Keeping them behind their own entry means (a) `@pg-prime/kit` loads the schema graph without ever
touching the executor, (b) an application's server bundle never pulls DDL builders, and (c) the
tree-shaking golden files (§2.4) become meaningful instead of trivially green. The runtime imports
schema **types only** (`import type`), which erase. A lint rule forbids value imports across the
boundary.

**Node floor `>=22.12`** — the first Node 22 LTS where `require(esm)` is unflagged, so a CJS consumer
at least gets a working dynamic path. PG floor is **15** (round-1 decision). TS floor is **5.9**
(below).

**AS BUILT · 2026-08-28 (the packaging pass).** The export map above was written before the code
existed. What ships is six entries, not ten, and the difference is that five of the planned subpaths
have nothing behind them yet while one planned *omission* was reversed.

| Planned | Built | Why |
|---|---|---|
| `.` | **yes** → `dist/index.js` | The curated root barrel (221 value + 211 type exports). |
| `./schema` | **yes** → `dist/schema/index.js` | The existing barrel, verbatim: its 38 values and 57 types are exactly the root's schema slice. |
| `./sql` | **yes** → `dist/sql/index.js` | Ditto, 23 values / 17 types. |
| `./codecs` | **yes** → `dist/codec/index.js` | The directory is `src/codec/`, the subpath is `./codecs` — the subpath name is what §2.1 promised and the directory name is not API. |
| `./adapter-pg`, `./adapter-pglite` | **no** — replaced by **`./driver`** | There is one *structural* adapter, `pgDriver(pool)` over any `PgLikePool` (`02` §1, `08` §8 resolution 5). It duck-types `pg`, PGlite-over-a-socket and Neon identically, so there is nothing for a second subpath to contain. `./driver` → `dist/entry/driver.js`, a thin re-export file rather than `src/driver/index.ts` itself: that barrel deliberately exports `typeSource` and `assertSessionGucs`, which are `@internal` and which `test/query/index.test.ts` asserts are *absent* from the public surface. |
| `./migrate` | **no** | The migration applier is `@pg-prime/kit`'s `runner/apply.ts` today, not `pg-prime`'s. §1.1's boundary argument (production apps run migrations at boot and must not install a CLI) still stands and is still unimplemented; the subpath is reserved by not being used for anything else. |
| `./pgvector`, `./postgis` | **no** | The extension codecs do not exist. |
| `./package.json` | **yes** | |

Every entry has `"types@<5.9"` **first**, then `"types"`, then `"default"`, on every subpath — F4's
requirement, and `tools/pack-smoke.mjs` proves it fires by compiling a real consumer on TypeScript
5.8.3 on every run.

**§2.1's "why `./schema` is not in the root barrel" is recorded as NOT ADOPTED.** `design/09` decided
the opposite — "one import for an application file" — and `src/index.ts` has re-exported the whole
schema DSL since WS1; `test/query/index.test.ts` pins it. The three reasons §2.1 gave are answered
rather than ignored: (a) `@pg-prime/kit` does not import `pg-prime` at all, so it never loads the
executor by any route; (b) `./schema` exists as a subpath, so an application that wants only the DDL
builders can still import only them; (c) the tree-shake goldens are not trivially green — but the
reason is worse than §2.1 feared and has nothing to do with the schema DSL: see the AS BUILT note
under §2.4. Reversing this later is a breaking change to the root barrel, and the argument for
reversing it would have to come from a measurement, not from this paragraph.

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
  Type '{ readonly __pg-primeTypeError__: "pg-prime requires TypeScript >= 5.9. Please upgrade."; } & String'
  has no call signatures.
```

Refinement over Kysely's version: name the brand key so it reads first in a truncated hover — use
`{ ERROR: 'pg-prime requires TypeScript >= 5.9 — see https://pg-prime.dev/ts' }` rather than a
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

**AS BUILT · 2026-08-28.** `tools/api-snapshot.mjs` is built; the goldens are
`tools/api-snapshot/pg-prime.json` (`.` 221 values / 211 types, `./schema` 38/57, `./sql` 23/17,
`./codecs` 58/17, `./driver` 5/25) and `tools/api-snapshot/pg-prime-kit.json` (76/64). Values are
read by **importing the built entry and taking `Object.keys()`** — what Node actually hands a
consumer — and types by reading the entry `.d.ts` through the **TypeScript 5.9.3 compiler API**
(`checker.getExportsOfModule`, aliases resolved), not by regex: every entry here is a re-export
barrel, which is exactly the shape a regex over the entry file gets wrong. The two readings are
cross-checked against each other and the tool names any symbol they disagree on. Three things it
asserts beyond "nothing changed": **no `default` export** anywhere (§2.3's `no-default-export`, which
has no oxlint to live in yet); **every subpath's names are a subset of the root's**, so
`pg-prime/driver` can never say something `pg-prime` does not; and **the `types@<5.9` stubs mirror
the root entry exactly** — they are *generated* from these lists, so a name added to the barrel
without regenerating is a `--check` failure rather than a stub that has silently rotted into
"module has no exported member". One wrinkle worth recording: the kit's `export type * from
"./catalog/payloads.js"` puts `GENERATED_NAME` (a `const`) into the entry's type space with no
marker on the resulting symbol, so it is exported neither as a usable value nor as a usable type;
the tool reads the export *declarations* to classify it correctly rather than trusting symbol flags.

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

**AS BUILT · 2026-08-28.** All five steps exist. `tools/treeshake-check.mjs` stages the built
package into a throwaway `node_modules/pg-prime` in `os.tmpdir()` — `package.json` + `dist/`, i.e.
exactly what `files: ["dist"]` publishes — so every fixture resolves **through the export map**;
bundling `src/` would test something we do not ship. esbuild is the gate, rollup +
`@rollup/plugin-node-resolve` runs beside it as the independent DCE opinion (its output is minified
with esbuild's `transform` so the two numbers are comparable, rather than adding terser for one
number). The goldens are built from `metafile.outputs[…].inputs` filtered to `bytesInOutput > 0`,
not from `metafile.inputs`: the latter is every module *scanned*, which is all 48 of them for every
fixture including the empty one, and a golden made from it would be identical everywhere and
therefore worthless. `publint --strict` and `attw --pack --profile esm-only` are in
`tools/pack-smoke.mjs`; both are clean on both packages, and attw's grid is exactly F5's
(`node16 (from ESM)` 🟢, `bundler` 🟢, `node10` 💀 ignored by the profile).

Measured, min+gz, 2026-08-28 (design → measured → budget, bytes):

| Fixture | design/08 §1.2 | measured | budget | modules |
|---|---|---|---|---|
| `connect-one-select` | 35 840 | **46 291** | 47 104 | 39 package modules |
| `full-crud-tx` | 56 320 | **46 660** | 47 104 | the same 39 |
| `root-import-all` | 122 880 | **50 004** | 50 176 | 46 |
| `side-effects-only` | 200 | **20** | 200 | **0** |

Three of the four ratchet **below** design on their first measurement. `connect-one-select` does
not, and the reason is the finding of this pass: **`connect-one-select` and `full-crud-tx` include
the identical 39 modules.** The query builder is one object graph — `compileOnly(schema)` and
`pgPrime({driver, schema})` both return an executor whose `from` / `insertInto` / `update` /
`deleteFrom` / `with` are methods, so every write builder is reachable from the first line of any
program that opens a handle. Adding insert, update, delete and `db.transaction()` to a program that
already runs one select adds no module and 369 bytes. So the honest reading of these four numbers is
not "connect + one select is 29% over budget" but "**the whole library is 50 KB min+gz against a
120 KB ceiling, and tree-shaking granularity inside the query builder is coarse — 93% of the package
is reachable from `connect + one select`**". Getting the first line to 35 KB is a code change
(making unused builders unreachable from the handle), not a budget change; `tools/budgets.json.
_overDesign` carries the whole argument and the per-module byte counts.

`side-effects-only` at **0 retained modules / 20 bytes** is the `sideEffects: false` claim verified
rather than asserted: nothing in the package does anything observable at import time.

---

## 3. Build & toolchain

### 3.1 Compiler

**`pg-prime` runtime: `tsc` only (via `tsgo`, `typescript@7.0.2`). Unbundled ESM, 1:1 source→output file
mapping. No bundler, ever.**

This is the Kysely model and it is unambiguously right for a types-heavy library: the `.d.ts` the
compiler emits is exactly what the compiler consumes, deep-import paths inside inferred types resolve
correctly, `declarationMap` gives go-to-definition into our real sources, and there is no dts-rollup
step to bloat or silently mangle a conditional type. Every bundler-based dts pipeline (api-extractor,
rollup-plugin-dts, rolldown-plugin-dts) is a place where 1.96 MB of declarations comes from. Multiple
public entries come from the export map pointing at real emitted files, not from bundler entry
config.

**Emit-parity guard.** TS 7 is six weeks old as a stable release. `tools/emit-parity.mjs` builds
`packages/pg-prime` twice — once with `typescript@6.0.3` and once with `tsgo@7.0.2` — and `diff -r`s the
two `dist/` trees, failing on any difference. That converts "is the new compiler's emit trustworthy?"
from an unknown into a test, and gives us a one-line fallback (`build with 6.0.3`) if it ever fires.

**`@pg-prime/kit` CLI: bundled with `esbuild@0.28` into a single ESM file with a shebang; `.d.ts` for its
small programmatic API emitted by `tsgo`.** Bundling pays here and only here: CLI cold-start matters,
and inlining deps means `npm i -D @pg-prime/kit` never surprises anyone with a transitive tree.
**esbuild rather than `tsdown`** — `tsdown@0.22` (rolldown) is the Vite team's tsup successor and is
where the ecosystem is heading, but it is pre-1.0 and we would be taking it for a job esbuild does in
20 lines of stable config. **Revisit `tsdown` when it hits 1.0.**

**AS BUILT · 2026-08-28.**

- **The compiler half is built as designed.** Both packages emit unbundled ESM with
  `tsc -p tsconfig.build.json` (`tools/build-package.mjs`, which also removes `dist/` first and
  copies the hand-written `src/unsupported-typescript.d.ts` that tsc treats as an input and never
  emits). `pnpm build` = 148 ms for `pg-prime` (229 files) + 128 ms for the kit (85 files).
- **`tools/emit-parity.mjs` compares 5.9.3 against 7.0.2, not 6.0.3 against 7.0.2.** `typescript@6.0.3`
  has never been installed in this repo; `typescript59` = `npm:typescript@5.9.3` has, because it is
  the **consumer floor** (§2.2, §8 resolution 2) and is already what `bench/types` and
  `tools/type-errors` gate on. 5.9.3 is also the *stronger* comparison — it is further from 7.0 than
  6.0 is, and it is the version whose behaviour we promise. **Result: every one of the 57 emitted
  `.js` files in `pg-prime` and 21 in the kit is byte-identical between the two compilers.** Two
  categories of difference exist, both printed by name on every run rather than filtered by
  extension: (1) one `.d.ts`, `compile/nodes.d.ts`, where an inferred parameter type prints as
  `nulls?: 'first' | 'last'` under tsgo and `nulls?: "first" | "last"` under 5.9.3 — same type,
  different quote character; (2) 29 of 114 maps in `pg-prime` and 20 of 56 in the kit differ in
  `mappings` alone (the two compilers choose slightly different source positions), with `version`,
  `file`, `sources`, `sourceRoot` and `names` identical everywhere. A difference in any other map
  key, or any other kind of `.d.ts` difference, fails.
- **The kit is NOT bundled, and there is no `bin`.** §3.1 bundles the kit because CLI cold-start
  matters; there is no CLI — no `src/cli.ts`, no `bin` field, no commands. Bundling a programmatic
  API into one file would cost the deep-import paths in its own `.d.ts` and buy nothing. So the kit
  ships `tsc` output with `pg` as a real runtime dependency and `@types/pg` beside it — the latter
  is in `dependencies`, not `devDependencies`, because the emitted `dist/db/pg.d.ts` really does say
  `import pg from "pg"` and name `pg.Client` in the signature of the exported `withClient`. That was
  checked against the emitted output, not guessed. §1.2's "single bundle file ≤ 2 MB" line is
  therefore *not applicable* rather than passing, and `tools/budgets.json` says so. The esbuild
  bundle arrives with the CLI.

### 3.2 Declaration strategy & budget

- `declaration: true`, `declarationMap: true`, `sourceMap: true`. Ship `dist/**/*.d.ts` +
  `.d.ts.map` + `.js.map`; do **not** ship sources (`files: ["dist"]`) — maps point at published
  `.map` files with `sourcesContent` inlined for the small files and omitted for large ones.
- **`isolatedDeclarations`: `false` in `pg-prime` (the builder API is inference-heavy and explicit
  return types there would be both unwritable and worse for users), `true` in `@pg-prime/kit`,
  `@pg-prime/testing` and `@pg-prime/create`** — where it is free and buys parallel emit plus a guarantee
  that no inferred type leaks a deep internal path.
- **Budget: ≤ 900 KB total, ≤ 200 files, ≤ 40 KB per file** (§1.2). `tools/size-budget.mjs` prints
  the top-10 largest declarations on failure so the offender is obvious.
- **`skipLibCheck: true` for the normal build** (speed), plus a dedicated CI job `check:dts` that
  type-checks the *emitted* `dist/**/*.d.ts` with `skipLibCheck: false` under **each** supported TS
  version. That is the guarantee that matters and it costs seconds.

**AS BUILT · 2026-08-28.**

- `declaration` + `declarationMap` + `sourceMap` are on in both packages' `tsconfig.build.json`, and
  `files: ["dist"]` ships the maps but not the sources. `isolatedDeclarations` is `false` in
  `pg-prime` and **`true` in `@pg-prime/kit`**, as prescribed. Turning it on in the kit cost exactly
  **one** annotation (`export const MIGRATION_NAME: RegExp` in `src/plan/plan.ts`), which is the
  clearest possible evidence for §3.2's claim that it is free on that side of the split.
- **`check:dts` is built** — `tools/check-dts.mjs`, wired into `pnpm package:check` and the `package`
  CI job. It writes a throwaway tsconfig into `os.tmpdir()` that `include`s `<pkg>/dist/**/*.d.ts`
  with `noEmit`, `strict`, `nodenext` and **`skipLibCheck: false`**, and runs it on **5.9.3 and
  7.0.2**. Result: clean on both, for both packages (58 `.d.ts` in `pg-prime` at 553 ms / 199 ms;
  22 in the kit at 1 024 ms / 283 ms). It also parses every emitted `.d.ts` with the TypeScript API
  and asserts that `pg-prime`'s declarations name **no** non-relative module — the zero-dependency
  promise checked at the declaration level rather than only at `package.json`. (Parsed, not
  grepped: `src/driver/pg-like.ts` and `src/driver/types.ts` both explain in prose why they do *not*
  `import type { Pool } from 'pg'`, and a regex reports the seam as a violation of itself.)
- **The 40 KB per-file canary is BREACHED and is recorded, not loosened.** `dist/query/types.d.ts`
  measures **54 843 B (53.6 KB)**, 34% over. That file is design/03's type layer — `Db`, `Query`, the
  operand and projection families, the join/group/set-op state machine — and every name in it is
  re-exported from the root barrel and pinned by `tools/api-snapshot/pg-prime.json`, so splitting it
  is a public-API refactor and out of the packaging pass's scope. `bench/types` has been measuring
  the same file at 54 808 B under 5.9.3 since WS7, so it is a known, stable number and not a new
  regression. `tools/budgets.json._overDesign` carries design's 40 960 beside the measurement, the
  budget is set **at** the measurement so any growth at all fails CI, and `size-budget.mjs` prints
  design / measured / budget on every run. The rest of §1.2's declaration budget is comfortable:
  **378 KB total across 58 files** against 900 KB / 200 files.

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

**Round-A integration · 2026-08-29.** Two scope adjustments after the session layer (`12` §3 S) and
the builder gaps (`12` §3 B) merged over the lint rules: `typescript/require-await` is **off for
`packages/*/test/**` and `**/*.probe.ts`** — a test callback written `async () => value` exists to
satisfy a Promise-returning signature (`db.transaction`, `db.session`, `PgDriver.destroy`), and the
rule's target, a library function that was meant to await and does not, is `src/`, where it stays on
(one directive in `src/driver/pg-adapter.ts`'s `release`, the async seam). And `no-restricted-imports`
has a one-file override for `src/session/pg-lazy.ts`, the single `import('pg')` that `12` §1
decision 2 allows; the driver layer still never names `pg`.

**The one-time format (decision 19) · 2026-08-29.** `oxfmt` over the whole tree, one commit, and
`pnpm format:check` in the `lint` job from then on. Formatting is *not* behaviour-neutral everywhere:
a formatter that reflows a statement moves it off the line its `@ts-expect-error` guards, and a
`.json` golden compared as text changes bytes. `.oxfmtrc.json` therefore ignores `**/*.probe.ts`,
`packages/pg-prime/test/query/types/**`, `tools/type-errors/**` (recorded diagnostics carry line
numbers), the three test files that use the directive inline (`schema/audit.test.ts`,
`sql/kysely-cve.test.ts`, `fuzz/builder-generator.ts`), and `packages/*/test/**/*.json` (the kit's
envelope goldens). Those files keep their hand layout on purpose.

---

## 4. Test infrastructure

Runner: **Vitest 4** with workspace projects, one project per tier. (`node:test` is tempting for
dependency minimalism, but projects/matrix, golden-file snapshots, coverage and concurrency control
are worth one dev dependency in a monorepo.)

### 4.1 Tier 0 — unit, against the structural driver mock

Agent 02's `PgLikePool` seam makes this free: `@pg-prime/testing` exports `createMockPool()`, which
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
> `@pg-prime/testing` exports the PGlite fixture with a `requiresConcurrency()` guard that throws
> loudly rather than passing quietly.

> **Addendum, 2026-08-25 (WS-L).** `@electric-sql/pglite-socket` turned out not to be usable as
> the socket in front of it — PGlite emits a spurious `ReadyForQuery` after every
> extended-protocol error, which desynchronises `pg` on ~50% of erroring parameterised queries.
> `pg-prime` ships its own ~130-line bridge in `test/live/_pglite-bridge.ts` instead. F7's finding
> (the real `pg` driver over the real wire protocol) stands; the package does not. See `09` §2.4.

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

Coverage gate: 90% lines on `pg-prime`, 85% on `@pg-prime/kit`. Not 100% — chasing the last 10% on a code
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
  the **message text** of our branded `PgPrimeTypeError<'…'>` diagnostics against golden files. Error
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

**AS BUILT · 2026-08-27 (design/09 WS7 · §3.7).** Which of the ten rows above exist, and under
which name. Nothing has been run on GitHub's runners yet for the rows marked *new*; the workflows
parse and the topology is the PR `pg` job's, which is green (`09` §3.6 follow-up).

| Row above | Built? | As |
|---|---|---|
| `lint` | **no** | Follow-up. Nobody owns oxlint + `tsgo --noEmit -b` in `09`; `pnpm typecheck` covers the second half on TS 7.0.2 only. |
| `unit` (tier 0) | yes | `ci.yml` job `unit`, Node 22.12 / 24 / 26 × ubuntu. 715 tests, 4.9 s. |
| `types` | partly | `ci.yml` job `types` — TS **5.9.3 and 7.0.2** (not 6.0.3, and no `7-next` arm: `04` §3.6 records that `@ark/attest` cannot run on TS 7 at all, and the two-compiler matrix is what `bench/types` measures). The `.d.ts` **size** budget is here; **lib-checking the emitted `dist/**/*.d.ts` landed on 2026-08-28 in the `package` job instead** (`tools/check-dts.mjs`, both compilers, `skipLibCheck: false`), because it needs a build and this job does not do one. |
| `pglite` (tier 1) | yes, as **`live`** | `ci.yml` job `live`, Node 24 × ubuntu / macos / windows. |
| `pg` (tier 2) | yes | `ci.yml` job `pg`, PostgreSQL 17 **+ PgBouncer 1.25** (`09` §3.6 added the pooler, which this table did not ask for). |
| `pg-matrix` (tier 2) | **new** | `ci-nightly.yml` job `pg-matrix`, PG **15 / 16 / 17 / 18**, each with its own `edoburu/pgbouncer` in transaction mode. Nightly + `workflow_dispatch`; not on `main` pushes, because a four-server matrix on every merge buys a signal that changes only when a PG major does. |
| `package` | **yes** (2026-08-28) | `ci.yml` job `package`, ubuntu × Node 24, every PR: `pnpm build` then `pnpm package:check` = `size-budget` → `api-snapshot --check` → `emit-parity` → `check:dts` → `treeshake` → `pack-smoke` (which is `pnpm pack` both packages, install the tarballs into a throwaway project, compile and RUN a consumer on TypeScript 5.9.3, then watch the same file be refused by 5.8.3 with the `types@<5.9` message, plus `publint --strict` and `attw --pack --profile esm-only`). **Measured 14.4 s** end to end on the design machine against this table's 2-minute budget — of which ~9 s is `pack-smoke`'s two `npm install`s from the registry, so the runner's number will be larger and still nowhere near the budget. Node is pinned rather than matrixed: the artifact is compiler output, and the gzip baselines are measured against one zlib. |
| `bench:compile` + `bench:types` | yes | Both inside `ci.yml` job `types`, gating, **46 s combined** against this table's 3-minute budget. `bench:compile` is `@pg-prime/bench-runtime --compile-only`: compile time, allocations per compile, §1.1's two structural claims, and the decoder against its hand-written oracle. |
| `bench:runtime` | **new** | `ci-nightly.yml` job `bench` (report uploaded as an artifact) and `ci.yml` job `perf`, which exists only when a PR carries the `perf` label and is `continue-on-error` — §5's "informational, never blocking". |
| `corpus` + `fuzz` | partly | `ci-nightly.yml` job `fuzz` at `PG_PRIME_FUZZ_CASES=1000000` for all three fuzzers (measured: 144 s against PG 17), with the *server* oracles sampled and the sample printed. The 50 000 schema pairs are `@pg-prime/kit`'s corpus and are not wired. |

Two things this table asks for and WS7 deliberately did not do: **gate PR CI on wall-clock**
(§5 says not to, so every timed budget is a ratio — `09` §3.7 decision 1), and **publish absolute
milliseconds as the gate** (they are in `bench/runtime/report.json` beside every ratio, because a
ratio without absolutes is marketing).

---

## 5. Performance benchmarking

The bar from round-1 is "near-raw driver overhead"; the anti-target is Prisma 7's ~11× average /
~27× p99. Both of those are *ratios*, so the harness measures ratios.

**Design: every case is a pair.** `raw()` uses `pg` directly, `orm()` uses `pg-prime`, against the same
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
  `pg-prime codemod <name>`. A breaking change without a migration path does not merge.
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
7. **Size budgets met:** `pg-prime` ≤ 2.5 MB unpacked, `.d.ts` ≤ 900 KB, no single `.d.ts` > 40 KB,
   hello-world ≤ 35 KB min+gz, **zero runtime deps and zero peer deps**; `@pg-prime/kit` ≤ 8 MB.
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

**MPL-2.0** for `pg-prime`, `@pg-prime/kit`, `@pg-prime/testing` and `@pg-prime/create`. Docs content
**CC-BY-4.0**.

Rationale (00-overview sign-off 3): the requirement is that forks stay open source. Apache-2.0 and
MIT fail it — permissive licences allow closed forks. GPL/AGPL satisfy it but are wrong for a
library, because linking semantics scare adopters away from bundling an ORM into their app.
MPL-2.0 is file-level copyleft: a modified copy of *our* files must be published under MPL, while
an application that merely imports the library is untouched.

The cost, accepted knowingly: MPL lacks Apache-2.0's express patent grant, which some enterprise
OSS review boards look for. Revisit only to move *toward* stronger copyleft, never weaker — a
licence can be relaxed after the fact only with every contributor's consent.

## 7. Repo layout

```
pg-prime/
├─ .github/
│  ├─ workflows/            ci.yml  nightly.yml  release.yml  bench.yml  codeql.yml  scorecard.yml
│  ├─ ISSUE_TEMPLATE/       bug.yml  diff-bug.yml  type-perf.yml  feature.yml  config.yml
│  ├─ CODEOWNERS  dependabot.yml  pull_request_template.md  FUNDING.yml
├─ .changeset/              config.json  *.md
├─ packages/
│  ├─ pg-prime/                                   # runtime — zero deps, ESM-only, tsc-emitted
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
│  ├─ pg-prime-kit/                               # CLI + diff engine — esbuild single-file bundle
│  │  ├─ src/               cli.ts  commands/  introspect/  diff/  plan/  lint/  apply/  codemod/
│  │  ├─ test/              unit/  golden/  fuzz/  corpus/
│  │  └─ package.json  tsconfig.json  build.mjs
│  ├─ pg-prime-testing/        src/{mock-pool.ts,pglite-fixture.ts,pg-fixture.ts,expect-sql.ts}   # → @pg-prime/testing
│  └─ pg-prime-create/         src/  templates/
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

## 8. Resolutions

Every item that was open here has been decided; recorded so the reasoning is not re-litigated.

1. **Name** — decided, §1.3. `pg-prime` / `@pg-prime/kit` / `@pg-prime/testing` / `@pg-prime/create`.
2. **TS floor** — **5.9**, and it is a *consumer* floor, not a devDependency question: we compile
   and typecheck with tsgo (TS 7), while 5.9 is the oldest TypeScript a consumer may use against
   our published `.d.ts`. The `types@<5.9` export gate turns an older consumer's failure into one
   sentence. Lowering a floor later is non-breaking; raising one is not.
3. **License** — **MPL-2.0**, §6.5.
4. **Type-perf budgets** — measured, not estimated, and wired into `bench/types` with committed
   baselines: 137,778 instantiations / 1.11 s on TS 5.9 / 0.231 s on TS 7 for the 100-table
   headline, against gates of 200k / 2.0 s / 0.5 s and a schema-size-independence ratio of 1.15
   (measured **1.00**). `@ark/attest` is *not* part of the harness — it cannot run on TS 7 and has
   been removed from the tree; the per-construct baselines it would have provided are still unwired.
5. **`PgLikePool` seam** — holds. `packages/pg-prime/src/driver` imports nothing non-relative, and
   `pg.Pool` casts to it structurally with no `as any`.

```
