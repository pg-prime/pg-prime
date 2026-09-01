# 14 — promise audit: design/01's v1 table vs the tree. Implementation & Test Plan

2026-09-01. design/13 closed `12` §5's list; this round closes the gaps a row-by-row audit of
**design/01 §3's `v1` rows against the built surface** found. The audit method: every `v1` row was
checked against the code, the API snapshots (`tools/api-snapshot/*.json`) and the design AS BUILT
records; a row is a **gap** only if it is v1-promised, unbuilt, and no later decision superseded it.
Stale design notes discovered on the way (things marked "not built" that ARE built: `renamedValues`,
`pgDomain`/`pgSequence`, the four builder run-option methods, `verify --from-checkpoint`) are not
gaps — the layered-record convention already carries their corrections.

**The gaps, with their design/01 §3 row:**

| Row | Promise | State found |
|---|---|---|
| 49 | `EXCLUDE` constraints (operator + `WHERE`) — *declarable and diffable* | catalog/diff side modeled (K3); **no `exclude()` in the DSL** (snapshot: 0 hits) |
| 50 | Indexes: partial, **expression**, opclass, `USING`, nulls-not-distinct, `.concurrently()` | partial/opclass/using/nnd built; **expression `.on(sql…)`, `.with()`, `.concurrently(false)`, `.tablespace()` not built**; `pull` records expression indexes as unsupported |
| 51 | Generated columns (`GENERATED ALWAYS AS … STORED`), type-level never-erasure | diff side modeled (`p.generated === 's'`); **no `.generatedAlwaysAs()` in the DSL**, no type-level erasure, `insertableKeys` cannot know them |
| 54 | `COMMENT ON` for tables/columns/**types** | tables/columns built; **`pgEnum`/`pgDomain` have no `comment` option** |
| 58 | Views + matviews as **typed read-only entities** (DDL body via `sql/` lane, `REFRESH` helper) | **nothing** — snapshot 0 hits, no refresh helper; kit only counts views in the Tier-U census |
| 61 | `definePgType()` codec/extension registration API | `Registry`/`createRegistry`/`enumCodec` exist; **no public extension-type descriptor**; the `resolveDynamic` per-database-OID path exists for enums only |
| 62 | pgvector reference pack (column + index helpers, `<->`/`<=>` operators) | `vector`/`tsvector` column types exist; **the six distance operators are still the WS5 deferral** in `ops.manifest.ts`; `citext` (row 44) absent entirely |

**Examined, not gaps, recorded here so nobody re-audits them:** row 56 (per-object ownership
markers) is partially carried by kit's Tier-U census + `--strict-unmodeled` + `pgView(...).existing()`
(this round); full per-object markers would ripple through the IR and stay v1.x. Rows 59/63/64
(functions/triggers/policies as DSL, structured diffing of view/function bodies, `definePolicy`) are
**v1.x by design/01's own table** — the `sql/` repeatable lane is the v1 mechanism and it is built.
Row 62's "index helpers" need no new spelling: `index().using('hnsw')` + per-column `opclass` items
are built, and `.with({ m, ef_construction })` arrives with row 50's `.with()` (G, this round).

Also this round, integrator-owned: the `pull`-as-`NOCREATEDB` tier-3 round-trip test noted in `12`
K4's residue (folded into G), the stale `verify --from-checkpoint` row in `06` §6.2's table gets its
inline correction marker, and the docs reference signature-drift gate (`12` D's "obvious next gate")
is attempted if integration leaves room — recorded, not promised.

---

## 0. At a glance

| WS | Deliverable | Primary oracle | Gate to leave | 
|---|---|---|---|
| **G** | **DDL close-out**: `exclude()` (the `05`:783 sketch surface), `.generatedAlwaysAs(expr, { stored })`, index options (`.on(sql…)` expressions, `.with({…})`, `.concurrently(false)`, `.tablespace()`, `fillfactor`), `comment` on `pgEnum`/`pgDomain`; through `emitSchema` → diff → `generate` → `pull`; type-level erasure of generated keys; `insertableKeys` excludes generated; the NOCREATEDB `pull` test | `pg_dump` (D10) **strict** on every new fixture; the OID/live differential for generated columns on PG 17 | every new kind has a strict witness fixture; `fixtures/diff/unmodeled` still fails; type erasure pinned by `expect-type` tests; full §2 chain green |
| **W** | **Views, row 58's contract exactly**: `pgView`/`pgMaterializedView` declared-columns + `existing()` forms, body through the repeatables lane, `refreshMaterializedView` on `Db`, census stops flagging declared views | a real server: declared view queryable through the builder with exact types; `REFRESH MATERIALIZED VIEW [CONCURRENTLY]` observed in the statement log; kit census before/after | view entities usable in `.from()` with read-only typing; refresh helper tier-2 tested; **no structured diffing** (row 63, v1.x); full §2 chain green |
| **V** | **Extension types**: `definePgType()` public descriptor riding a generalized `resolveDynamic`; `citext` + `vector(n)` column factories; the six pgvector distance operators off `ops.manifest`'s deferred list; guards for PGlite/extension-absent | the OID differential against `pgprime-vec` :54337 (pgvector 0.8.6); the ops-manifest self-gates | six operator rows confirmable (not deferred) with live differential; `citext`/`vector` round-trip tier 2; graceful typed skip when the extension is absent; full §2 chain green |

Round: **G ∥ W ∥ V** (worktrees), then integrator (order G → V → W), then the full chain, push, CI + nightly.

## 1. Decisions taken here (so agents do not re-derive them)

1. **The mandate is design/01 §3's v1 rows, not design/05's maximal sketches.** Where the two
   disagree, 01 wins on *whether* and 05 wins on *spelling*. W is the sharp case: build row 58
   (typed entities + `sql/`-lane body + refresh helper), do NOT build `05` §3.6's normalized-diff
   strategy — that is row 63, v1.x.
2. **`exclude()`'s spelling is the `05`:783 sketch**: `exclude(name).using(method).on([ref, 'op'],
   …).where(fragment)` plus `.deferrable()`/`.initiallyDeferred()`. `.requires(extension)` is
   optional scope — build it only if `pgExtension` already gives the capability check for free;
   otherwise record one sentence in the RESULT.
3. **Generated columns are `STORED` only.** `{ stored: true }` is the default and only value;
   `VIRTUAL` is a typed refusal naming PG 18 (`05`:676's gate), because the diff layer already
   refuses in-place conversion of `attgenerated='v'`. The expression form takes a fragment or a
   `(cols) => fragment` callback (`05`:180). Type level: the key is erased from `Insertable`/
   `Updateable` exactly as identity-`always` is; `metaOf().insertableKeys` excludes it, which
   makes F3's COPY refusal client-side and sentence-shaped instead of server-side 42P10.
4. **Index options land as the `05`:783 block i1–i8 minus what is already built**: expression
   `.on(fragment)`, `.with({…})` (rendered sorted, text values quoted), `.concurrently(false)`
   (the D15 opt-out — a *generate*-time fact, carried on the IR like `nullsNotDistinct`),
   `.tablespace(name)`, `.fillfactor(n)` (sugar for `.with({ fillfactor: n })`). `pull` learns
   expression indexes (normalized through the shadow like every other definition text) and its
   residue list shrinks accordingly; whatever it still cannot express keeps an exact reason string.
5. **`definePgType()` generalizes the enum path, not a new mechanism**: a descriptor
   `{ name, schema?, encode, decode, typeClass?, arrayOf? }` registered on the registry;
   `resolveDynamic` resolves its per-database OID from `pg_type` exactly as it does `pg_enum`,
   pending-codec window included. `citext` and `vector` ship as reference users of it **in the
   core package** (row 61 says one package; a separate `@pg-prime/pgvector` is not this round).
6. **The vector operators come off the deferred list only with the live differential.** The six
   rows (`l2` `<->`, `cosine` `<=>`, `innerProduct` `<#>`, `l1` `<+>`, `hamming` `<~>`, `jaccard`
   `<%>`) get operand/result types per `03` §2.9's table, gated by the `vector` type class, with
   the OID differential run against `pgprime-vec`. PGlite has no pgvector: tier-1 skips with the
   guard sentence; the nightly pg-matrix images have none either, so the tier-2 suite guards on
   `pg_available_extensions` and skips with a reason — locally `pgprime-vec` :54337 is the oracle.
7. **Docs rules R22 applies to the new pages**: pgvector examples are `no-run` in *both* executed
   tiers (PGlite lacks the extension; CI's `postgres:17` service too) with the reason naming the
   tier-2 suite; matview/refresh examples execute on PGlite (it supports them). Every new exported
   name gets its reference entry (`docs-coverage` will hold the door).
8. **Budgets move only with the account.** bench:types ≤ +2 % per fixture (12 B's rule); size/dts
   budgets re-baselined with the measured number and the reason in the same commit; api-snapshot
   goldens regenerated, never hand-edited.
9. **Changesets**: one per touched package per workstream, `minor`, text naming the design/01 row.
10. **Worktree discipline as in 11/12/13**: branch from the plan commit, no push, handover =
    branch + SHAs + RESULT section appended to this file (`#### G/W/V — RESULT`); dedicated
    containers per agent; the full §2 gate chain green in the worktree before handover.

## 2. The gate chain (verbatim, exit codes visible)

`pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm test:live && pnpm test:pg
&& pnpm build && pnpm package:check && pnpm bench:types && pnpm bench:compile && pnpm docs:check
&& pnpm docs:examples:pg`

Env for tier 2 + docs:examples:pg: `PG_PRIME_TEST_URL` / `PG_PRIME_TEST_PGBOUNCER_URL` /
`PG_PRIME_SPIKE_CONTAINER` per agent assignment; V additionally `PG_PRIME_TEST_VECTOR_URL=
postgres://postgres:postgres@127.0.0.1:54337/postgres` (name chosen here; the suite skips without it).

## 3. Ownership

- **G**: `packages/pg-prime/src/schema/{ddl,extras,column,objects}.ts`, `src/query/meta.ts`
  (insertableKeys), type-level in `src/schema/types.ts`; kit `src/schema/emit.ts`, `src/diff/*`,
  `src/pull/*`, fixtures + tests; docs schema-guide + reference entries for the new spellings.
- **W**: new `packages/pg-prime/src/schema/view.ts` + exports; `src/query` FROM-source seam
  (smallest change that admits a view entity); refresh helper on `Db` (`src/session/handles.ts`
  or the smallest honest seam); kit census/pull awareness of declared views; docs.
- **V**: `packages/pg-prime/src/codec/*` (descriptor + resolveDynamic generalization), column
  factories, `src/query/ops.manifest.ts` + operator wiring; vector/citext tier-2 suite; docs
  pgvector page.
- **Shared** (integration keep-both, as in 13): `src/index.ts`, `tools/api-snapshot/pg-prime.json`
  (+ kit's), `tools/budgets.json`, `bench/types/budget.json`, docs sidebar/reference partition,
  `.changeset/*`. G and V both touch `column.ts` — different regions (ddl fields vs factories).

Integration order **G → V → W**, integrator re-runs the chain on the merged tree, pushes, watches
CI + dispatched nightly, appends the integration record here.

## 4. Definition of done

- [ ] design/01 §3 rows 49, 50, 51, 54(types), 58, 61, 62 each either built to their acceptance
      sentence or re-recorded here with the measured reason.
- [ ] Every new object kind: strict D10 witness fixture; negative control still fails.
- [ ] Type-level: generated/identity erasure pinned; view read-only typing pinned; budgets ≤ +2 %.
- [ ] Docs: coverage 100 %, R22 reasons on every new `no-run`, examples tiers green.
- [ ] Full chain green on the merged tree; CI + nightly green on the pushed record.
- [ ] This file carries G/W/V RESULTs + the integration record; memory updated.
