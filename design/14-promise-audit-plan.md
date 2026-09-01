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

---

#### G — RESULT (2026-09-01)

Branch `worktree-agent-a8bbf175e51185134`, on `9d3f01d`. design/01 §3 rows **49**, **50**, **51**
and **54(types)** are built end to end — DSL → `emitSchema` → shadow → diff → `generate` → `pull` —
plus design/12 K4's `NOCREATEDB` residue item. Ten commits, oldest first; this record is the
eleventh and last on the branch:

| SHA | what |
|---|---|
| `0eed210` | `feat(schema)`: `exclude()`, `.generatedAlwaysAs()`, the five index options, `comment` on `pgEnum`/`pgDomain` |
| `765e0c6` | `fix(query)`: `insertableKeys` drops a stored generated column; COPY says `42P10` itself |
| `ba568d2` | `feat(kit)`: the emitter — EXCLUDE, generated columns, index `WITH`/`TABLESPACE`/expressions, `COMMENT ON TYPE` |
| `15efebd` | `feat(kit)`: `pull` learns all four, plus the `NOCREATEDB` test |
| `a4d7758` | `test(kit)`: `fixtures/diff/generated` and `fixtures/diff/index-options`, strict D10 |
| `61b0613` | `feat(kit)`: `.concurrently(false)` reaches the differ |
| `757b1d7` | `docs(schema)`: reference + guides + regenerated api-snapshot goldens |
| `b4ee330` | `chore(budgets)`: the three size gates, re-baselined with the account |
| `71a8623` | `chore(changeset)`: one per touched package, `minor` |
| `afaaeab` | `design(05)`: the AS BUILT records, in the layered style |

##### What is built

**Row 49 — `exclude()`.** `exclude(name).using(m).where(sql\`…\`).deferrable()/.initiallyDeferred()
.requires(ext).on([ref | sql, 'op'], …)`. Elements are column references (quoted identifiers) or
fragments (parenthesised); the operator is checked against PostgreSQL's own operator alphabet at
declaration time. The emitter writes PostgreSQL's clause order and the shadow load is what proves
it. **`.requires()` IS built** — decision 2 left it optional, and it turned out to be free in the
sense the decision meant: `emitSchema` already has `schema.extensions`, so the capability check is
eight lines and an `error` diagnostic naming the `pgExtension(...)` to add, instead of a `42704`
about an operator class three steps later.

**Row 51 — `.generatedAlwaysAs(expr, { stored })`.** Fragment or `(cols) => fragment`; the callback
is resolved by `pgTable` off a names-only pre-pass built ONLY when some column of that table asks
for one. `ro: true`, so the key is erased from `Insert<>`/`Update<>` with no new type machinery.
`{ stored: false }` is an `OrmTypeError` in parameter position plus a runtime sentence naming PG 18.

**Row 50 — the rest of the i1–i8 sketch.** Expression keys (bare fragment or item object), `.with()`
(sorted, text values quoted, merging), `.fillfactor(n)`, `.tablespace(name)`, `.concurrently(false)`.

**Row 54 — `comment` on `pgEnum` / `pgDomain`**, emitted as `COMMENT ON TYPE` for both, which is
what the catalog-side renderer already said.

**`pull`** learns all four plus `TABLESPACE`, and `test/pull/ddl-closeout.test.ts` asserts the
residue is EMPTY on a fixture that contains every one of them, with `generate` against the same
database `up_to_date` under a strict D10 witness. Its second `describe` is design/12 K4's item: the
same loop as a `WITH LOGIN NOCREATEDB NOSUPERUSER` role, asserting `shadow.tier === 3`, an empty
diff, and no `pgprime_shadow_%` schema left behind.

##### Divergences from the plan, and why

1. **`exclude(...).on(...)` is terminal.** Decision 2 fixes the spelling at `05`:783's sketch, which
   chains `.where()` AFTER `.on()`. That requires the builder itself to be the `TableExtra`, and the
   node's fields are exactly the method names — `using`, `where`, `deferrable`, `initiallyDeferred`
   — so one object cannot hold both. Renaming the fields (`method`, `predicate`, `deferral`) would
   work and would make `TableExtra` inconsistent with every other node in the file for the sake of
   one call order. Terminal `.on()` is what `index` and `unique` already do. Recorded in `05` §2.4.
2. **`.concurrently(false)` is NOT an IR fact.** Decision 4 says "a *generate*-time fact, carried on
   the IR like `nullsNotDistinct`". `nullsNotDistinct` is a **catalog** fact — it is inside
   `pg_get_indexdef` — and `CONCURRENTLY` is not, and can never be: it describes how the index is
   built. A payload field would read `false` on the DSL side and absent on the catalog side and
   every such index would diff for ever. It travels as `BuildOptions.noConcurrentIndexes`, filled by
   the new `nonConcurrentIndexes(schema)` straight off the registry — the same out-of-band route
   `annotationHints` already uses for `renamedFrom`.
3. **`copyColumns` REFUSES an explicitly named generated expression column.** The brief says
   `insertableKeys` "turns F3's server-side 42P10 COPY refusal into a client-side sentence". Doing
   only the default list would leave `{ columns: ['total'] }` reaching the server, so
   `TableCodecMeta` gained `generatedKeys` and the explicit path refuses with the SQLSTATE and the
   column in the message. An **identity** column named explicitly is still honoured — F3's rule,
   because COPY writes the value you give it and that is what makes a restore possible.
4. **Two public type changes.** `IndexItem.column` widens to `string | undefined` beside a new
   `expression` (exactly one is set), and `NullableFn`'s sentence is amended to name both generated
   spellings. Both are `minor` on a `0.x` package; the second also edits the reference page, which
   reproduces that type verbatim.
5. **`.tablespace()` has no live fixture.** A tablespace is a cluster-level object with a filesystem
   path behind it: no CI leg has one and creating one needs a `docker exec mkdir` plus a superuser.
   The emitted clause is pinned by exact text in `test/schema-emit/emit.test.ts`, `pull` reads one
   back out of `pg_get_indexdef` and `parseIndexDef` has a unit path for it — but nothing loads a
   `TABLESPACE` clause into a shadow, so its round-trip is untested against a server. Said out loud
   rather than hidden behind a green tick.
6. **`fixtures/diff/generated` adds one column per table, and there is a finding behind that.**
   Two `add` deltas on one table are ordered by NAME (`diff/diff.ts` sorts on the encoded id), not
   by the desired `attnum`, so adding `label` and `total` to one table produces `label, total` where
   the desired state says `total, label` and the D10 witness classifies the table as `reordered`.
   It is *repairable* — unlike `evolve`'s, which is `ADD COLUMN` having nowhere else to put a
   column — so recording it in the fixture's `reordered` list would weaken what that field means.
   The fixture uses two tables instead, and the differ's sibling-`add` ordering is left as a note
   for the backlog: it is a change to a shared sort that every plan's statement order reads, and it
   is not in G's deliverable.

##### The gate chain (verbatim, exit 0)

macOS arm64, Node 24.14.1, PostgreSQL 17.11 in `pgprime-k4` (127.0.0.1:54333),
`PG_PRIME_SPIKE_CONTAINER=pgprime-k4`, **no PgBouncer**.

| Gate | Result |
|---|---|
| lint · format:check · typecheck | green, 4 packages (oxlint: warnings only, all pre-existing) |
| tier 0 | pg-prime **1 046** in **4.72 s** measured alone (5.13 s inside `pnpm -r`, which runs three packages at once) · create **35** · testing **23** |
| tier 1 | pg-prime **1 834** · testing **28** |
| tier 2 | pg-prime **1 896 / 11 skipped** · kit **438 / 6 skipped** · testing **36** · create **42** |
| build | pg-prime 2 368.9 KB (341 files) · kit 1 780.8 KB (289) · testing 109.0 KB · create 60.9 KB |
| package:check | 12/12 size gates · api-snapshot no drift · emit-parity · check-dts · treeshake (4/4, module goldens ok) · pack-smoke · create-smoke |
| bench:types | green; **every** gated per-declaration and per-query check unchanged, headline +0.49 % / +0.44 % |
| bench:compile | green, unchanged |
| docs:check | typecheck **580 blocks / 47 pages** · examples **95** on PGlite from 26 pages · coverage **1 243 / 1 243 (100 %)**, 40/40 hazard codes, 233 links, **R22: 36 explained, 0 waived** · build 48 pages |
| docs:examples:pg | **7** examples from 4 pages in 3.6 s; the 3 `pg-only="pgbouncer"` blocks skip with their reason |

**Every skip in this run is pooler-guarded, by design.** No PgBouncer was assigned to G, so
pg-prime's 11 tier-2 skips are `07` §5's pooler-profile and §5.1 transaction-pooling cases and the
kit's skipped file is `test/runner/pooler.test.ts`; the kit's 6 skipped tests are the same count it
skipped before this round. `docs:examples:pg` is green **without** a bouncer — the three blocks that
need one skip with the R22 reason — so the integrator's run of it should differ only by those three.

##### Budgets

| Line | Before | Measured | New | Why |
|---|---|---|---|---|
| `packages/pg-prime.jsBytes` | 927 744 | **944 322** (85 files) | 945 152 | four DSL surfaces + the prose that says why; tsc keeps comments |
| `bench/types` `packageDtsBytes` | 553 984 | **568 778** | 569 344 | `schema/extras.d.ts` 9 501 → 17 707, `schema/column.d.ts` 16 250 → 20 637, and four smaller |
| treeshake `connect-one-select` | 73 728 | **74 084** | 74 752 | +1 101 B min+gz |
| treeshake `full-crud-tx` | 73 728 | **74 326** | 74 752 | +1 092 B min+gz |
| treeshake `root-import-all` | 80 896 | **82 415** | 82 944 | +2 275 B min+gz |

The treeshake **module sets did not move** (62 / 62 / 72, every golden ok), and `schema/extras.js` is
not in either `connect` fixture at all — so `exclude()` and the index builders cost a connecting
application nothing. What it does pay for is `.generatedAlwaysAs()`, `pgTable`'s guarded pre-pass,
`generatedKeys`, and error message TEXT, which is the one kind of prose esbuild keeps.

##### R10 mutation spot-checks (each applied, measured, reverted)

| # | Mutation | Measured failure |
|---|---|---|
| 1 | `schema/emit.ts` drops the `GENERATED ALWAYS AS (…) STORED` clause | `emit.test.ts` "writes GENERATED ALWAYS AS (…) STORED for both forms" fails. The R1 round-trip stays GREEN — which is the asymmetry that test's docblock claims: it builds B from A's IR, so a clause dropped from A is missing from both sides and `pg_dump` agrees with itself. |
| 2 | the EXCLUDE clause loses its `WHERE (…)` | `emit.test.ts` "writes both EXCLUDE forms, in PostgreSQL's own clause order" fails |
| 3 | `diff/ddl.ts` `createIndex` strips ` WITH (…)` from `pg_get_indexdef` | corpus **`index-options`** fails: `residual drift: ["alter index:public.docs_body_idx"]`, 1 delta |
| 4 | `diff/ddl.ts` `columnClause` drops its `generated === 's'` branch | corpus **`generated`** fails: `residual drift: ["alter column:public.invoices.total","alter column:public.tags.slug"]`, 2 deltas |
| 5 | `pull/parse.ts` cannot read an `EXCLUDE` | BOTH cases of `test/pull/ddl-closeout.test.ts` fail with a non-empty `x constraint` residue — including the `NOCREATEDB` one |
| 6 | `nonConcurrentIndexes`' predicate inverted | 3 cases in `test/generate/rewrites.test.ts` fail, including row 1's original |
| 7 | `.generatedAlwaysAs()` returns `ro: M['ro']` instead of `ro: true` | 4 `expectTypeOf` errors from `tsc -p test/schema/tsconfig.json` — the erasure and both sentinels |

**The negative control still fails.** `fixtures/diff/unmodeled` is a TABLE storage parameter, which
the extractor deliberately does not model; `test/dump-oracle.test.ts`'s blind-spot case asserts
`oracle.status === "failed"` and `proof.status === "failed"` and is green. `fixtures/diff/index-options`
is its mirror image and moves an INDEX's `fillfactor`, which `pg_get_indexdef` does carry.

##### Files

`packages/pg-prime/src/schema/{extras,column,table,objects,index}.ts`, `src/index.ts`,
`src/query/{meta,scope}.ts`, `src/session/copy.ts`;
`packages/pg-prime-kit/src/{schema/emit,diff/ddl,generate,index,pull/parse,pull/emit-ts}.ts`;
`fixtures/diff/{generated,index-options}/`;
tests — `packages/pg-prime/test/schema/g14-ddl-closeout.test.ts` (new),
`test/schema/{columns,k4-additions}.test.ts`, `test/query/meta.test.ts`,
`test/session/copy.test.ts`, `test/pg/session-copy.test.ts`,
`packages/pg-prime-kit/test/pull/ddl-closeout.test.ts` (new), `test/corpus.test.ts`,
`test/generate/rewrites.test.ts`, `test/schema-emit/{fixture,emit,roundtrip}.ts`;
docs — `reference/{schema,kit}.mdx`, `guides/{schema,copy}.mdx`;
shared — `src/index.ts` exports (both packages), `tools/api-snapshot/{pg-prime,pg-prime-kit}.json`
and the two `unsupported-typescript.d.ts` stubs, `tools/budgets.json`,
`bench/types/budget.json`, `.changeset/*`, `design/05-schema-api.md`.

##### What G did NOT do

- **The table-level `withOptions()` / `tablespace()` / `unlogged()` nodes.** `05` §2.4 lists them
  and they are NOT this row: `fixtures/diff/unmodeled` is a table storage parameter and it is the
  negative control the D10 oracle exists to demonstrate. Modelling them would delete that fixture's
  reason to exist, and design/14 §0 requires it to keep failing.
- **`.collate()`, `.storage()`, `.compression()`, `.oneOf()`, `.deprecated()`, `.notValid()`,
  `partitions({ manage, unknown })`, `rls.*`, `dropColumn`, `external`, `replicaIdentity`.** Still
  the `05` §2.3/§2.4 gaps; `pull` still records a column collation and a `NOT VALID` constraint as
  residue, with the reasons it already had.
- **VIRTUAL generated columns.** Decision 3, refused at the type level and at runtime.
- **`pull` of an EXCLUDE element carrying an opclass or a collation**, and of an index key this
  recogniser cannot split with certainty. Both keep an exact reason string; a recogniser that
  guesses emits a schema that looks right and migrates the object away.
- **Sibling `add`-delta ordering** (divergence 6 above) — a change to a shared sort, recorded rather
  than made.
- **`docs:examples:pg` with a pooler**, and the nightly PG 15/16/18 matrix. G has neither; the three
  pgbouncer blocks skip with their reason and the chain is green without them.

##### For the integrator

Shared-file hunks, in the order §3 predicts them:

- `packages/pg-prime/src/index.ts` — one value (`exclude`) and five types
  (`ExcludeItem`, `ExcludePair`, `GeneratedAlwaysAsOptions`, `IndexExpression`,
  `StorageParameters`) added to the two sorted lists; `packages/pg-prime/src/schema/index.ts` the
  same. **Keep both** with V's column factories: different regions of the same sorted lists.
- `packages/pg-prime-kit/src/index.ts` — one name, `nonConcurrentIndexes`.
- `tools/api-snapshot/*.json` and the two `unsupported-typescript.d.ts` stubs — regenerate with
  `pnpm api-snapshot` after merging, never resolve by hand.
- `tools/budgets.json` — `packages/pg-prime.jsBytes`, the three treeshake lines, and two
  `_overDesign` paragraphs. The SUM is what ships (design/12's round-A lesson), so re-measure on
  the merged tree and set each line to `ceil(measured / 1024) * 1024` again.
- `bench/types/budget.json` — `packageDtsBytes` and its `_packageDtsBytesWhy`. Same rule.
- `docs/src/content/docs/reference/schema.mdx` is heavily edited by G and untouched by W and V;
  `reference/kit.mdx` gains one table row. The sidebar is not touched — no new page.
- `packages/pg-prime/test/pg/session-copy.test.ts` now declares `doubled` in the schema. If a later
  round reverts `.generatedAlwaysAs()`, that file's `ledger` goes back to four columns.
#### V — RESULT (2026-09-01)

Branch `worktree-agent-a73fb94e383fd28b2`, six commits off `9d3f01d`, oldest first:

| SHA | What |
|---|---|
| `01e20ba` | `feat(codec)`: `definePgType()`, `resolveDynamic`'s `base` branch, the `citext`/`vector` codecs, `TypeClass: 'vector'` |
| `117e766` | `feat(schema)`: `t.citext()` / `t.vector(n)` / `VECTOR_MAX_DIMENSIONS`, and `codecFor`'s typmod strip |
| `1212a3a` | `feat(query)`: the six distance operators, their two operand classes, the manifest rows, the six `BinaryOp` tokens, the api-snapshot golden |
| `89aff3c` | `test`: tier 0 / tier 1 / tier 2 and the two-question guard |
| `86ca6b6` | `docs`: the pgvector guide, sixteen reference entries, `03` §2.9's layered note, the changeset |
| `10b67d7` | `chore(size)`: five budgets re-baselined with their accounts |

**Deliverable 1 — `definePgType()` (row 61).** `{ name, schema?, encode, decode, typeClass?, arrayOf? }`
→ a `Codec` with **no OID**, registered by name only until
`resolveDynamic(conn, [{ name, kind: 'base' }])`. The generalization is one branch beside `enum`
and `domain` and **no new mechanism**: the enum branch takes the *labels* from the catalogue and
everything else from the request, the domain branch takes the *base codec* from the registry, and
`base` takes the *whole codec* from the registry and only the number from the catalogue — which is
the only per-database thing about an extension type. There is no descriptor map and no new registry
method; `registry.register(codec)` is the registration, which is what makes a third party's
`hstore` three lines. Nothing registered under the name is an error naming `definePgType`.

The `base` branch keeps the registered codec's own `sqlName` rather than recomputing it from the
request the way `enum`/`domain` do. That is deliberate, and it is the pending-codec window's real
contract: a statement compiled before the registry met the database is **byte-identical** to one
compiled after (asserted in tier 2). Qualify an off-`search_path` extension by putting `schema` on
the *descriptor*, not on the request.

Four derivations, each because asking would be asking for a measurement the descriptor's author
cannot make: `oid`/`paramOid` `undefined`; `jsonEncode: 'text'`, so the compiler emits `::text`
inside `json_build_object` and the depth-3 payload is *by construction* the string `decode` reads
at depth 0 — R5 total for any type, with no per-type `to_json` measurement; `decodeJson` derived
from `decode`; `sqlName` quoted (and qualified) once.

**Deliverable 2 — `citext` and `vector(n)` (rows 44, 62).** Verified first, as asked: the API
snapshot's `vector` hits were `tsvectorCodec`, and `citext` appeared only as a *string* in `TextPg`
and in `relations.ts`'s comparability families — zero builders, zero codecs. Both now ship in the
core package as reference users of `definePgType` (row 61 says one package). `citext` reads
`string` verbatim; `vector` reads `number[]` and encodes `[1,2,3]`, with `NaN`/`±Infinity` refused
by index client-side. `citext[]` and `vector[]` both work.

**Divergences, with reasons:**

1. **`t.vector(n)` needed a seam that did not exist.** `ddl.pgType` is both the DDL text and the
   registry key, so `vector(1536)` resolved to nothing. `codecFor` now strips a trailing `(…)` on
   a miss — tried second, never first. A typmod is not a type: PostgreSQL has one `varchar` (1043)
   and one `vector`, and the modifier rides in `atttypmod`. Side effect, and a real fix:
   `t.raw('varchar(50)')` and `t.raw('numeric(10,2)')` — design/05 §5.3's escape hatch — used to
   declare columns `metaOf` refused to build a codec for at all.
2. **`TypeClass` gained a member, `'vector'`.** Not decoration: `arrayCodec`'s leaf rule is
   per-element-codec and only `json`-classed elements were leaves, so a `vector[]` holding
   `[[1,2],[3,4]]` would have been written `{{1,2},{3,4}}`. Measured on pgvector 0.8.6:
   `array['[1,2]'::vector,'[3,4]'::vector]` is `{"[1,2]","[3,4]"}`. The alternative — refusing to
   derive `vector[]` at all — is a capability hole where a one-word family closes it, and the
   `TypeClass` docblock already names the leaf rule as one of its two jobs.
3. **`arrayOf` is a boolean.** The contract lists the field; its useful meaning is "derive
   `<name>[]` from the catalogue's `typarray`", default `true`, `false` for a type whose array form
   the author models. Carried on a module-private `WeakSet`, not a public `Codec` field, because it
   is a fact about the *registration* and would otherwise have to be documented on fifty built-ins.
   Exercised in tier 2 by `halfvec`.
4. **`EXTENSION_CODECS` had to be exported from the root**, not just `./codecs` — `api-snapshot`
   invariant 1 (a subpath may not name what the root does not).

**Deliverable 3 — the six operators, with the live differential.** Operand types read off
`pg_operator` on the container, not off the README, and the table produced two corrections to how
`03` §2.9's single "vector" row reads:

- `<->`, `<=>`, `<#>`, `<+>` are `vector`/`vector` (also `halfvec`/`sparsevec`, neither modelled);
- **`<~>` and `<%>` are `bit`/`bit`** — hence two gates, `VectorOperand` and `BitOperand`;
- **`<#>` is the NEGATED inner product**, pgvector's convention so ascending order stays
  most-similar-first. Passed through unchanged.

Manifest: `OPS` stays 101 rows, `CONFIRMABLE` **92 → 98**, deferred **7 → 1** (`fn.rank` alone).
`test/query/ops.test.ts` loses its `o.class !== 'vector'` filter and its
`deferred.toMatch(/pgvector EXTENSION type/)` row, which is replaced by the opposite assertion plus
an exact list of what may still be deferred. `test/live-query/ops.test.ts`'s two count assertions
were already derived and self-adjusted; nothing was loosened.

**The six differential readings** — `select <expr>`'s own `RowDescription.dataTypeID`, against
`pgprime-vec` (pgvector 0.8.6 on PostgreSQL 17.11), printed by the tier-2 suite:

```
l2=701 · cosine=701 · innerProduct=701 · l1=701 · hamming=701 · jaccard=701
```

701 is `float8`, and the expected value is not hand-written — it is read off each expression's own
result codec, so the assertion is "the codec this operator claims is the type PostgreSQL produces".
The semantic differential runs beside it with per-row operands (`('[' || u.id || ',1,0]')::vector`,
`(u.id::int4)::bit(3)`) and six thresholds chosen so **no two operators select the same ids**:
`<->` {2,3,4}, `<=>` {3,4,5,6}, `<#>` {4,5,6}, `<+>` {3}, `<~>` {2,4,6}, `<%>` {2,3,4,5,6}. A
transposed token changes the answer — the only property a differential over six `float8`-returning
operators can have.

**Deliverable 4 — the guards.** Two questions, both printed:

| Where | Question | Mechanism | Measured |
|---|---|---|---|
| tier 1, `live-query/ops.test.ts` | is pgvector installed on `PG_PRIME_TEST_URL`? | `beforeAll` probe → `announce` once + `ctx.skip(reason)` per case | PGlite: 12 cases skipped with the sentence; pgvector container: all 12 run |
| tier 2, `pg/vector.test.ts` | is `PG_PRIME_TEST_VECTOR_URL` set? | collection-time `TestDecl` guard (house style) | unset: 17 skipped, sentence + `docker run` recipe printed |
| tier 2, same file | does `pg_available_extensions` have `vector` **and** `citext`? | `beforeAll` → `announce` + `ctx.skip` | stock `postgres:17` (`:54334`): 17 skipped naming the missing extension |

Two mechanisms because there are two questions and only one is answerable without a round trip.
Both write to `process.stderr` via `announce`, because vitest drops `console.*` from the collection
phase — the finding `_harness.ts` already records.

**Numbers.** Full chain green, exit 0 on every gate, in this order:
`lint · format:check · typecheck · test · test:live · test:pg · build · package:check · bench:types
· bench:compile · docs:check`, plus plain `docs:examples` and — not required of me, run anyway
against the same container — `docs:examples:pg`.

- tier 0 — pg-prime **50 files / 1046 tests**, +17 (`test/query/extension-types.test.ts`) and +6
  goldens; whole monorepo green.
- tier 1 — against `pgprime-vec`: **85 files / 1846 tests, 0 skipped**. Against PGlite:
  1828 passed / **18 skipped** (12 of them the vector class, with the sentence).
- tier 2 — pg-prime **95 files / 1924 passed / 11 skipped**; kit 424/6; testing 36; create 42. The
  11 skips are all PgBouncer: `pgprime-vec` is a plain PostgreSQL, no pooler was started and
  `PG_PRIME_TEST_PGBOUNCER_URL` was unset, so `07` §5/§5.1 is unverified in my runs **by design**
  and untouched by this workstream. The integrator's pooler run covers it.
- api-snapshot regenerated by the tool: **+16 names** (13 values, 3 types) — `definePgType`,
  `PgTypeDescriptor`, `citext`, `vector`, `VECTOR_MAX_DIMENSIONS`, `citextCodec`, `vectorCodec`,
  `EXTENSION_CODECS`, `l2`, `cosine`, `innerProduct`, `l1`, `hamming`, `jaccard`, `VectorOperand`,
  `BitOperand`.
- docs — coverage **1253/1253 (100 %)** on all eight entries, 241 internal links, R22 on 38 `no-run`
  blocks (5 new, every one naming `test/pg/vector.test.ts`); `docs:typecheck` 589 blocks OK;
  `docs:examples` 95 examples OK; `docs:examples:pg` 7 OK.
- budgets, each re-baselined **in the same commit** with the account in `_overDesign`:

| Budget | Was | Measured | Now | Rule |
|---|---|---|---|---|
| `pg-prime.jsBytes` | 927 744 | 947 588 | 948 224 | ceil-to-1 KB |
| `pg-prime.largestDtsBytes` | 76 358 | 76 385 | 76 385 | at the measurement (as its two prior re-baselines) |
| `treeshake.connect-one-select` | 73 728 | 74 311 | 74 752 | ceil-to-1 KB |
| `treeshake.full-crud-tx` | 73 728 | 74 564 | 74 752 | ceil-to-1 KB |
| `treeshake.root-import-all` | 80 896 | 81 902 | 81 920 | ceil-to-1 KB (still 33 % below design) |
| `bench/types packageDtsBytes` | 553 984 | 567 988 | 568 320 | ceil-to-1 KB |

The three treeshake module goldens gained **exactly two entries each** — `codec/define.js` and
`codec/extensions.js` — regenerated with `--update`, and that is not a missed shake: `Registry`'s
constructor registers the two shipped extension codecs by name so `t.citext()`/`t.vector(n)`
resolve through `codecFor`'s ordinary scalar path, and `connect + one select` builds a `Registry`.

**bench:types — the ≤ +2 % rule.** Every gated line passes. Per-fixture instantiations moved
+0.05 % … +0.8 % on TS 5.9.3; every 300t/25t ratio is still **1.000**; headline 82 073 → 82 145
(+0.09 %) on 5.9.3 and 133 996 → 134 344 (+0.26 %) on 7.0.2. **One figure is above 2 %** and is
recorded rather than waved past: the `empty` fixture on TS 7 is +3.47 % (10 026 → 10 374). It is a
*fixed* import cost of two new declaration files — **every** TS-7 fixture moved by the same +348,
which is exactly why the percentage shrinks as the fixture grows and why no ratio moved at all. It
is not a per-table or per-query cost, so the band the rule is about is untouched.

**What I did NOT do.**

- **No kit-side work.** `emitSchema` / diff / `pull` were not touched and no `fixtures/diff`
  fixture covers a `vector(n)` column or an HNSW index with an opclass. The kit's shadow database
  has no pgvector, so a strict `pg_dump` witness for one needs a pgvector image in the kit's
  harness — outside V's ownership (`§3` gives me `src/codec/*`, the factories, `ops.manifest` +
  wiring, the tier-2 suite and the docs page) and worth a line in a later round's scope.
- **No index DSL work.** `.with({ m, ef_construction })` is G's (`§1` decision 4). The guide says
  the storage parameters exist and points at the `sql/` lane rather than promising a spelling that
  is not on my branch; if G lands `.with()`, that paragraph is worth one sentence at integration.
  `using('hnsw')` + per-column `opclass` already existed and needed nothing.
- **`halfvec` and `sparsevec` are not modelled.** They carry four of the six operators in pgvector
  0.8 and are deliberately *not* members of `VectorOperand`: admitting the name would type-check a
  query no codec could decode. `t.raw('halfvec(1024)')` + `definePgType` is the documented path,
  and tier 2 proves it works by doing it.
- **No auto-resolution at connect.** Nothing in `src/` calls `resolveDynamic` — already true for
  enums and domains — so an application calls it once per physical database. Making `pgPrime` do it
  from the schema is a real improvement and a separate decision (it needs the schema's type set and
  a connect hook); the guide documents the explicit call.
- **`PG_PRIME_TEST_PGBOUNCER_URL` was never set**, so every pooler-guarded case skipped in my runs.
  Nothing here touches that path.
- `bench/runtime/report.json` is deliberately **not** committed: `bench:compile` rewrites it on
  every run and none of its gates moved.

**For the integrator.** Shared-file hunks: `src/index.ts` (16 names in four blocks — the schema
values, the codec values + `PgTypeDescriptor`, the ops values, the ops types);
`src/query/types.ts` (two type re-exports); `tools/api-snapshot/pg-prime.json` (regenerate with
`pnpm api-snapshot` after merging, never merge by hand); `tools/budgets.json` (two numbers under
`packages/pg-prime`, three under `treeshake`, one new `_measuredBeforeExtensionTypes` block, three
`_overDesign` paragraphs); `bench/types/budget.json` (`packageDtsBytes` + its `_why`);
`fixtures/treeshake/*/expected-modules.json` (two lines each — re-run `--update` on the merged
tree, the numbers will move again); `docs/astro.config.mjs` (one sidebar line under Guides);
`.changeset/hip-cars-argue.md`. The ops-manifest self-gates that moved:
`test/query/ops.test.ts`'s golden-vs-manifest comparison no longer filters the vector class (so all
101 rows need a golden) and its "deferred with a reason" row is inverted; `CONFIRMABLE` is 98.
#### W — RESULT (2026-09-01)

Branch `worktree-agent-adb9776629526bbc1`, five commits off `9d3f01d`, not pushed. design/01 §3
row 58 is built to its acceptance sentence: `pgView` / `pgMaterializedView` yield a queryable entity
with no insert/update/delete, and `insertInto(view)` is a compile error.

**Commits, oldest first**

| SHA | What |
|---|---|
| `0c72793` | `feat(schema)`: the DSL, the typed read-only entity, the query seam, `refreshMaterializedView` |
| `7019c05` | `feat(kit)`: declared views into the `sql/` lane, the census |
| `0ef87cc` | `chore(budgets)`: 1 471 instantiations recovered, then four numbers re-baselined |
| `b3bd62b` | `docs(views)`: the guide, 36 reference entries, two changesets |
| `3956ee0` | `chore(bench)`: the two reports regenerated on the final tree |

**1 — the DSL** (`packages/pg-prime/src/schema/view.ts`, new)

`pgView(name, options?).columns((t) => ({…}))` then `.as(sql`…`)` or `.existing()`; `05` §3.6's
forms (b) and (c). Options `.with({ securityInvoker, securityBarrier, checkOption })` with
**`securityInvoker: true` as the default** (D14), `.comment()`, `.renamedFrom()`, `.dependsOn(…)`.
Matviews add `.withNoData()` and `.refreshable({ concurrently })` and have no `.with(…)` — a matview
carries none of the three reloptions, so a method that could only throw is worse than its absence.
The body is rendered to DDL text at declaration time through `fragmentDdlText`, so a bind parameter
in a position the catalog cannot hold fails on the import of the schema file.

**Divergence, deliberate: a view is its own handle and is NOT a `defineSchema` entry.** It carries
a one-entry `[SCHEMA]` — the `CteSchema` trick — so `db.from(activeUsers)` takes the value directly
and every join, operator and projection works with zero query-layer changes; unlike a CTE handle it
carries real `Cols`, so the PG type class per column survives. A view is not an `AnyTable` (no
`[INS]`, no `[UPD]`), so `defineSchema({ activeUsers })` is a compile error — a view has no
relations for the registry to add and no insert shape to offer, and the honest spelling is the
direct one. The kit finds views on the module's exports, next to `pgDomain`.

**2 — read-only, twice.** Type level: a new exported `READONLY` slot, read in **return** position by
`insertInto` / `update` / `deleteFrom` on both `Executor` and `CteExecutor`, resolving to
`OrmTypeError<WriteToViewMsg<…>>`. Parameter position was rejected on `types.ts`'s own recorded
measurement (an argument-position check prints the argument type twice: 926 chars on 5.9.3, 1 319 on
7.0.2, against D9's 300). Golden `tools/type-errors/__golden__/insert-into-view.*.txt`: **1 line,
261 chars, byte-identical on 5.9.3 and 7.0.2**, and no other golden moved. Runtime: `sourceOf`
answers `kind: 'view'` off `$.view` — structurally, because `src/schema` may not import `src/query`
(design/08 §2.1), so a nominal `registerView` would have had nobody allowed to call it — and the
three write builders already refused a non-table `kind`; they now say what to do instead.
`PgPrimeTypeError` is the design docs' name; the tree spells it `OrmTypeError`.

**3 — the `sql/` lane.** `migrate generate` renders each declared view into
`<repeatablesDir>/020_views/NNN_<schema>__<name>.sql` **before** `loadDesired` loads the lane, so the
shadow holds the current definitions and the proof covers them. From there it is an ordinary
repeatable and every downstream command is unchanged.

**Divergence, and the reason: a file, not `ScanOptions.extra`.** The in-memory route was the
smaller diff and it is wrong. `apply`, `status` and `doctor` do not load the TypeScript schema —
`apply` must work in a deploy image that ships migrations and nothing else — so a view contributed
only in memory reads as an orphan to `doctor` (`planRepeatables` computes orphans as recorded-minus-
on-disk) and never re-applies at deploy time. Writing is gated on `outDir`, so `migrate check`
writes nothing and reports `declared_views_stale` instead; and the write happens at the top of
`generate` rather than beside the plan files because a view-only change produces an **empty
structural diff** and returns `up_to_date` long before the writing block — which is exactly the
change the lane exists to carry. `.dependsOn` is a topological sort whose rank is in the filename
(the pass has no dependency graph; scan order is one lexicographic walk); reordering renames files
and the stale ones are pruned, and pruning only ever deletes a file carrying `-- pg-prime:declared
view`, so a hand-written view or one `pull` wrote is never touched. A cycle is a diagnostic.

Census: `generate` subtracts the declared views **by name**, via one small `presentDeclaredViews`
query against the target. By count would lie in both directions — with four declarations, three
plain views in the database and one of them undeclared, count arithmetic silences the undeclared
one, which is the failure this was measured hitting. `extractCatalog` is untouched (it is also G's
neighbourhood this round), so `doctor` still reports the raw catalog count; recorded below.

**4 — `refreshMaterializedView`.** **Divergence: on `Queryable`, not on `Db`.** `REFRESH MATERIALIZED
VIEW CONCURRENTLY` inside `BEGIN … COMMIT` was measured working on PG 17.11 before the seam was
chosen, so the common shape is a refresh in the transaction that also writes the audit row, and a
`Db`-only helper would force that out of the transaction. It is installed exactly where `copyFrom`
is. It goes through `runner.runRaw`, not `runner.use`, so it earns `07` §7.1's events, §4's mapping
and §6.2's timeout — the tier-2 test asserts the exact statement text in the log, which is the point:
a `REFRESH` that silently dropped `CONCURRENTLY` passes every functional assertion.

**Numbers**

| Gate | Result |
|---|---|
| `pnpm lint` · `format:check` · `typecheck` | 0 |
| `pnpm test` (tier 0) | 1 040 pg-prime + 23 testing + create/kit's own; **4.28 s → 4.43 s** wall |
| `pnpm test:live` on PGlite | 86 files, 1 830 passed, 6 skipped |
| `pnpm test:live` on PG 17.11 | 86 files, **1 836 passed, 0 skipped** |
| `pnpm test:pg` | pg-prime 96/1 902 (11 skipped), kit 57/435 (6 skipped), create 42, testing 36 |
| `pnpm build` · `package:check` | 0 |
| `pnpm bench:types` | headline 82 339 / 134 339 against 200 000; worst fixture **+3.49 %** (`empty`) |
| `pnpm bench:compile` | 0 |
| `pnpm docs:check` · `docs:examples` | 0; 100 examples / 27 pages; coverage **100 % on all four packages** |
| `pnpm docs:examples:pg` | 7 examples / 4 pages, 3 PgBouncer blocks skipped loudly |

**The 11 + 3 skips are the PgBouncer ones.** No pooler was assigned to this worktree, so
`test/pg/session-pooler.test.ts`, four cases in `test/pg/session.test.ts` and the three
`pg-only="pgbouncer"` docs blocks skip with their own printed reason (`PG_PRIME_TEST_PGBOUNCER_URL is
unset … UNVERIFIED in this run`). Everything else in tier 2 ran against `pgorm-spike-sql`
(PostgreSQL 17.11 on :54331). The 6 tier-1 skips on PGlite are the `requiresConcurrency()` set.

**Budgets moved, each with the measurement in the same commit** — and only after two rounds of
recovering the cost first:

- the stage-2 builder is untyped internally and cast once at the public boundary, the way `pgTable`
  already was: **−989 instantiations**;
- `ViewImpl extends TableImpl` instead of a second `implements ViewRuntime` class with its own
  key→ref `Map`: **−459**. `TableImpl` is exported to that one sibling for it;
- `buildColumnRefs` shared by `pgTable` and both view factories: −23, so that one is about drift and
  not cost (`view.ts` had already lost the `(casing strategy: …)` half of the duplicate-name
  sentence while it was a copy).

| Budget | From | To | Measured |
|---|---|---|---|
| `packages/pg-prime.jsBytes` | 927 744 | 944 128 | 943 606 B in 87 files |
| `packages/pg-prime.largestDtsBytes` | 76 358 | 78 393 | set AT the measurement |
| `bench/types packageDtsBytes` | 553 984 | 575 488 | 574 856 B |
| `treeshake.connect-one-select` | 73 728 | 74 752 | 73 850 (+867) |
| `treeshake.full-crud-tx` | 73 728 | 74 752 | 74 111 (+877) |
| `treeshake.root-import-all` | 80 896 | 82 944 | 82 330 (+2 190) |

`fixtures/treeshake/root-import-all/expected-modules.json` gains `dist/schema/view.js` and nothing
else; the two connect fixtures do not include the module at all, so their delta is the read-only
guard and the REFRESH helper, which `07` §1.3 puts on every handle.

**The one number over the plan's band, stated plainly.** design/14 §1.8 says ≤ +2 % per
`bench:types` fixture. `empty` is **+3.49 %** (10 026 → 10 376 on TS 7) and four other
declaration-only fixtures are between +2.1 % and +2.9 % on TS 5.9.3. `empty` has no schema and no
query in it: it measures "what does one more source file in the library cost", the delta is a
**constant 350** that does not scale with schema size or query count, and it is 350 after 1 471 were
taken back. Everything the band exists to protect is unmoved: every real query fixture ≤ +0.95 %,
headline +0.26 %, and per column (3.0), per table (36), per declared relation (37.5), marginal per
usage (40), all five per-query figures (94 / 177 / 252 / 8 744.8 / 942) and all three schema-size
independence ratios (1.000) are **unchanged to the digit**. The account is in
`bench/types/budget.json`'s `_packageDtsBytesWhy`.

**Not built, with the row that defers each**

1. **The builder-inferred form** — `pgView('v').as((q) => q.from(users)…)`, `05` §3.6's form (a).
   `src/schema` may not depend on `src/query` (design/08 §2.1), and the feature's diff story is
   **row 63** (v1.x). Declared columns are the v1 spelling and they are strictly more honest: the
   inferred form would have to re-derive a PG type per projected expression.
2. **Structured diffing of a view definition** — **row 63**, v1.x, and design/14 decision 1's scope
   guard names it. `05` §3.6's normalized-definition strategy is not built; the body is a hashed
   repeatable, which is `01` §3's lane decision.
3. **`.indexes(…)`, `.using('heap')`, `.tablespace(…)` on a matview** — `05` §3.6's sketch, not in
   row 58. It does not drop out naturally: the index renderer is a private function in the kit's
   `src/schema/emit.ts` (G's file this round), and a matview's repeatable is DROP + CREATE, so a
   declared index needs a recreation story that does not exist yet. The unique index `CONCURRENTLY`
   needs therefore lives in the user's own `sql/` lane, the generated file says so in its header,
   and the guide has an aside about it.
4. **Lint `SEC002`** (a matview reading an RLS-enabled table) and **`concurrently: true` without a
   unique index as a lint error** — both `05` §3.6, both the kit's lint rules. The second cannot be
   a lint in v1 *because* of (3): pg-prime cannot see an index it cannot declare. It is the server's
   `55000`, mapped and rethrown, and the tier-2 test pins that it is never a silent downgrade.
5. **The census subtraction is `generate`-side only.** `doctor` has no schema loaded and reports the
   raw catalog count. Making it schema-aware means `doctor` importing the user's TypeScript, which
   is a change to what that command is; recorded rather than done.
6. **`pull` still writes views to `sql/020_views/` unmarked.** Promoting a pulled view to a TS
   declaration leaves the pulled file behind and nothing detects the duplicate. One diagnostic
   comparing `-- pg-prime:object view <identity>` against the declared set would close it; `pull` is
   G's directory this round.
7. **The declared column types are not verified against the view's actual output types.** The shadow
   knows both after `loadDesired`; a query comparing `pg_attribute` for the created view against the
   declaration would turn a wrong `t.text()` into an author-time diagnostic instead of a decode
   surprise. Worth doing, out of this round.

**Shared-file hunks the integrator must know**

- `packages/pg-prime/src/index.ts` — 4 values (`isView`, `pgMaterializedView`, `pgView`, `READONLY`)
  and 19 types across the schema value block, the schema type block and the phantom-symbol block;
  `RefreshMaterializedViewOptions` added to the `./query/run.js` type re-export.
- `packages/pg-prime/src/schema/index.ts` — `READONLY` in the symbol block, one `export`/`export type`
  pair for `./view.js`.
- `packages/pg-prime/src/schema/table.ts` — three hunks: `TableRuntime.view?: ViewInfo`, `TableImpl`
  exported, and `pgTable`'s column loop replaced by the extracted `buildColumnRefs`. **G owns
  `column.ts` / `extras.ts` / `ddl.ts` / `objects.ts`, not this file**, but a reviewer should know
  `pgTable`'s body moved.
- `packages/pg-prime/src/query/types.ts` — the six write entry points on `Executor` and
  `CteExecutor`, `Queryable.refreshMaterializedView`, three imports.
- `packages/pg-prime/src/query/scope.ts` — `SourceRuntime['kind']` gains `'view'`, one line in
  `sourceOf`, and the new `writeTargetMessage`; one line each in `insert.ts` / `update.ts` /
  `delete.ts`.
- `packages/pg-prime/src/session/handles.ts` — `refreshSql`, `RefreshMaterializedViewOptions`, one
  `install()` in `installQueryable`; `src/query/run.ts` adds the name to the `compileOnly` refusal
  list and re-exports the option type.
- `packages/pg-prime/test/schema/fixture.ts` — two new exports (`activeUsers`, `userStats`) consumed
  by `tools/type-errors/cases/insert-into-view.ts` and `test/query/types/view.probe.ts`.
- `tools/api-snapshot/{pg-prime,pg-prime-kit}.json` and both `src/unsupported-typescript.d.ts`
  stubs — all four are `node tools/api-snapshot.mjs` output, never hand-edited. `pg-prime` `.`
  311v/365t → 315v/384t, `./schema` 51v/80t → 55v/98t; `@pg-prime/kit` +5 values, +8 types.
- `tools/budgets.json` — two numbers in `packages/pg-prime`, three in `treeshake`, a new
  `_measuredBeforeViews` block, and an appended paragraph in each of the four `_overDesign` entries.
- `bench/types/budget.json` — `packageDtsBytes` and a prepended paragraph in `_packageDtsBytesWhy`.
- `fixtures/treeshake/root-import-all/expected-modules.json` — one line.
- **Kit, and the file G is most likely to collide on:** `src/generate.ts` gains an import block, a
  view-sync block at the top of `generate()`, and `extractorDiagnostics` becoming two `censusWithout`
  calls. `src/config/load.ts` (`declarationOf` + `isTableLike` + the `views` bucket),
  `src/schema/types.ts` (`ViewLike`, `SchemaLike.views`), `src/index.ts` (one export block), and the
  new `src/schema/views.ts`. **`src/schema/emit.ts`, `src/diff/*` and `src/pull/*` are untouched.**
- Docs: `astro.config.mjs` sidebar (one line, after `guides/copy`), `reference/schema.mdx` (a new
  `## Views and materialized views` section between Enums and Schemas/domains, plus one row in the
  phantom-slot table and "Fourteen" → "Fifteen"), `reference/pg-prime.mdx` (`Queryable`'s signature
  block and a new `## Refreshing a materialized view` before `## Pooling`), `reference/kit.mdx`
  (three rows in the "Loading the desired state" table and a new `## Declared views` before
  `## Database helpers`), and the new `guides/views.mdx`.
- `.changeset/olive-views-arrive.md` (`pg-prime`, minor) and `.changeset/quiet-lanes-render.md`
  (`@pg-prime/kit`, minor).
