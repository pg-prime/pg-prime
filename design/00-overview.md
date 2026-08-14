# pg-orm-ts — Design Overview & Decision Record

**Date:** 2026-08-14
**Status:** Round-2 synthesis. Eight design agents produced `design/01`–`08`; this doc records the unified architecture, reconciles cross-doc conflicts, and lists the decisions awaiting user sign-off. Research basis: `../research/SUMMARY.md`.

## Document map

| Doc | Owns | Headline decision |
|---|---|---|
| [01-features.md](./01-features.md) | Scope | Tiered feature spec; v1 has two XL items (unified builder, diff engine); explicit "never" list |
| [02-driver.md](./02-driver.md) | Driver seam | Structural `PgDriver`/`PgConnection`, zero deps *and* zero peer deps; text-only decoding v1; per-query parser neutralization via `pg`'s `query.types` |
| [03-query-builder.md](./03-query-builder.md) | Query engine | Immutable AST → single-pass compiler → `{sql, binds, shape}`; scope-lambda references; LATERAL `json_agg` nesting with per-codec JSON casts (no dehydration tax) |
| [04-type-system.md](./04-type-system.md) | Types | Hybrid: runtime builders + flat `ColMeta` payload flattened once per table; no whole-schema type param → schema-size-independent query cost (measured 1.00 ratio vs Kysely 2.43) |
| [05-schema-api.md](./05-schema-api.md) | Schema surface | `pgTable(name, cols, extras[])` heterogeneous extras; `defineRelations` w/ FK inference; functions/triggers = structural signature + body-hash repeatables; `renamedFrom` fires iff old-exists-and-new-doesn't |
| [06-migrations.md](./06-migrations.md) | Migration engine | **Adopt `@supabase/pg-delta`** — pinned, behind a ~400-LOC `DiffBackend` port; no plan written to disk until proven on a shadow clone; M/R/O/U object tiers; idempotency-linted `txmode none` files |
| [07-runtime.md](./07-runtime.md) | Execution | `unnamedExtended` default (pooler-safe *is* the fast mode on `pg`); 40001 retry on-by-default at RR/serializable only; `IndeterminateCommitError` outside `ConnectionError`; declared (not detected) `poolerMode` |
| [08-architecture.md](./08-architecture.md) | Packaging | 4 packages (`pgorm`, `pgorm-kit`, `@pgorm/testing`, `create-pgorm`); tsgo + oxlint, unbundled ESM; PGlite default test tier w/ multi-session ban; closed 12-item 1.0 list, ≤3 RCs/≤8 weeks |

## Load-bearing verified facts (from this round's hands-on work)

- **npm:** `pg-orm-ts` is dead (unpublished 2026-08-04; npm forbids reuse). `pgorm`/`pgorm-kit`/`@pgorm` verified available today. Claim promptly.
- **pg-delta alpha.39** has a reproducible enum-ordering correctness bug — caught by its own `provePlan`. Hence the prove-before-write rule (D6 in 06).
- **Binary result format is unusable through `pg`** — `pg-protocol` UTF-8-decodes every DataRow field (corruption measured live). Text decode only in v1; seam stays wired.
- **TypeScript 7 (native, Go) is `latest`** and drops the JS compiler API — typescript-eslint, typedoc, and `@ark/attest` all break on it. Toolchain in 08 routes around this; attest job pins TS 5.9.
- **PGlite advisory locks lie** (`pg_try_advisory_lock` returns true where real PG returns false) — single-backend; multi-session tests must run on real PG.
- Type budget measured, not estimated: 100-table headline scenario checks in 1.11 s on TS 5.9 / 0.231 s on TS 7, 137,778 instantiations — gates set at ≤2.0 s / ≤0.5 s / ≤200k, with a schema-size-independence ratio gate of ≤1.15.

## Reconciliations (conflicts between docs, resolved)

**R1 — Column nullability default.** 05's examples use `.notNull()` (nullable-by-default); 04 decided **NOT NULL by default, `.nullable()` opts in** — nullable-as-union is free at the type level while `.notNull()` costs a distributive `Exclude` per column, and it removes Drizzle's #1 footgun. **04 wins; 05's examples to be amended.** DDL-vs-TS split (`$` law) is unaffected. *(User sign-off requested — most user-visible DX decision in the project.)*

**R2 — TS floor.** 04 proved 5.4 works (all probes pass on 5.4.5/5.9.3/7.0.2); 08 recommends 5.9. **Recommend 5.9**: budgets are defined on 5.9/7, the support matrix halves, and lowering a floor later is non-breaking while raising one is. The `types@<5.9` gate is built and verified. *(User sign-off.)*

**R3 — `sql` fragment typing.** 03's stricter form is final: the tag takes **no type parameter**; a result-typed fragment requires `.as(codec)` — a bare cast is a compile error. This subsumes 04's `sql<T>`-with-codec framing.

**R4 — `cachedDescribe` justification.** 07 kept it opt-in as the precondition for binary results; 02 killed binary v1. `cachedDescribe` remains opt-in, justified only by decode-plan reuse, and becomes interesting again if a binary-capable adapter lands.

**R5 — Nested JSON rehydration (the #1 cross-doc risk, per 04).** The differentiator claim "a column types and decodes identically at any nesting depth" holds only if 03's compiler emits per-codec JSON casts *and* every codec implements `decodeJson`. **Contract adopted:** `decodeJson` is a required `Codec` member (not optional), plus a CI golden test decoding every built-in codec at depth 0 and depth 3 and asserting identical values. No `ShallowDehydrate` fallback types will be written — if the test fails, the build fails.

**R6 — Migration lock.** 06's session-advisory-lock + heartbeat lease supersedes the research sketch's `pg_advisory_xact_lock` (which can't scope a transactionless CIC file). 07's `poolerMode` and 06's two-transaction `pg_backend_pid()` probe agree on transaction-pooler detection.

**R7 — Scope amendments to 01.** RLS/policies move **into v1** as Tier-R repeatables (06 showed repeatables need no differ, making this cheaper than deferring). 01's three open questions are answered by siblings: pg-delta → adopt-pinned (06); perf bar → ≤1.15× raw `pg` median / ≤1.30× p99 (08's 1.0 list); package split → 4 packages (08).

## Sign-off outcomes (user, 2026-08-14)

1. **Name: APPROVED — `pgorm` + `@pgorm` scope.** User action required: create the `@pgorm` org on npmjs.com and publish placeholders for `pgorm` / `pgorm-kit` / `create-pgorm` (bare names are first-come-first-served; the scope is protected once the org exists).
2. **TS: build on TS 7 internally, consumer floor 5.9.** Clarified: the floor is not a devDependency question — it's the oldest TypeScript version *consumers* can use to typecheck their apps against our published `.d.ts`. We compile and typecheck with tsgo (TS 7); the `types@<5.9` export gate turns older consumers' failures into a one-sentence error. A TS-7-only floor was rejected: too much of the consumer base and tooling is still on 5.x/6.x, and lowering a floor later is non-breaking while raising one is.
3. **License: MPL-2.0.** User requirement: open source, and forks must stay open source. Apache/MIT fail that (permissive → closed forks allowed). GPL/AGPL satisfy it but are rejected for a library: linking semantics scare adopters away from bundling an ORM into their apps. **MPL-2.0 is the fit** — file-level copyleft: any modified copy of our files must be published under MPL, while apps importing the library are untouched. Recorded as decided; revisit only if the user wants strong copyleft at the cost of adoption.
4. **Nullability: APPROVED — NOT NULL by default**, `.nullable()` opts in (R1 stands; 05's examples to be amended).
5. **Views: `securityInvoker: true` stays the default** (delegated decision). Rationale: this is a PG-only tool that ships RLS as a v1 feature; a view that silently bypasses RLS is a data leak, and the divergence from PG's default is one documented line plus an explicit `securityInvoker: false` escape. The `pull` command annotates introspected legacy views with their actual setting so adoption never flips behavior.
6. **Decode defaults: APPROVED** — `int8`→`bigint`, `numeric`→`string`, `date`→branded `'YYYY-MM-DD'` string, `timestamptz`→`Date`.
7. **Diff engine: PIVOT — build our own; pg-delta becomes a dev-time differential-testing oracle** (user asked "can we have our own pg diff tool?" — yes, and the design makes it cheaper than research assumed). 06's D1 superseded (amendment noted there); D2–D12 stand unchanged. Why own-diff is now M/L rather than XL: (a) the Tier-R repeatable model removes functions/views/triggers/policies — the objects with the worst diff semantics — from the differ entirely; (b) annotation-first `renamedFrom` removes rename *inference*, pg-delta's main advantage; (c) the prove-on-shadow-clone gate (D6) catches any ordering/correctness bug before a plan reaches disk, which is exactly how pg-delta's own enum bug was caught. What remains to build: `pg_catalog` extraction for ~12 M-tier object kinds into 06's fact-base IR, dependency-ordered DDL emission, and hazard classification. pg-delta (pinned, devDependency only) runs in CI as a second opinion over the fixture corpus — disagreements become test cases, and its enum-ordering repro is fixture #1.

## Week-1 empirical tasks (carried from the docs)

- ~~Live-PG test: bind parameters in `DECLARE … CURSOR` over extended protocol~~ **ANSWERED YES** (spike, PG 17.11): `.stream()` is zero-dep, `pg-cursor` struck entirely. Boundaries: cursors are transaction-scoped (25P01 outside), FETCH count cannot be a bind param (inlined validated integer).
- **User:** create the `@pgorm` npm org + publish placeholder `pgorm`/`pgorm-kit`/`create-pgorm` (time-sensitive).
- Spike the in-house diff engine: catalog extraction for tables/columns/constraints/indexes/enums into the fact-base IR, diff + emit for a 3-table fixture, proven on a shadow clone; wire pg-delta as the CI differential oracle with the enum-ordering repro as fixture #1.
- Stand up the type-budget CI harness (04's numbers as the initial baselines) before the first `table()` implementation lands.
- Fuzz harness skeleton for `sql.ident` with the dual oracle (`format('%I')` + temp-table roundtrip; 03).
