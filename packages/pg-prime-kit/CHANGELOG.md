# @pg-prime/kit

## 0.2.0

### Minor Changes

- [#3](https://github.com/pg-prime/pg-prime/pull/3) [`a75e3a1`](https://github.com/pg-prime/pg-prime/commit/a75e3a19a2e9f615acdbc1d9e240bfc81bf9e9dd) Thanks [@YohoCX](https://github.com/YohoCX)! - **Column collations: `.collate(name)`.**
  
  `t.text().collate('C')` declares `position text COLLATE "C"`, the byte-order collation a
  fractional-index `position` column needs. `.collate()` is available on `text`, `varchar`, `citext`,
  their arrays and `t.raw()` columns. On any other type it is a compile error that says why. On an
  enum column it throws a `SchemaError` when the schema is declared. The collation is recorded as
  `ColumnDdl.collation`.
  
  `migrate generate` now handles a collation change on an existing column as its own case. Adding,
  changing or removing a collation plans `ALTER TABLE … ALTER COLUMN … TYPE <same type> [COLLATE "…"]`
  with the new warning **`LK113`**: the column's indexes are rebuilt under `ACCESS EXCLUSIVE`, but the
  table is not rewritten. Before this release, a collation-only change was reported as a narrowing
  type change (`MF105`, an error) together with `LK108` and `BC103`. A change of type keeps those
  three hazards.
  
  When a unique index, a primary key, a unique or exclusion constraint, or a `CHECK` covers the column,
  the statement also carries the new error **`MF107`**: rebuilding the index or re-checking the
  constraint under the new collation can fail on existing rows, such as `'a'` and `'A'` under a
  case-insensitive collation. It is not raised on a table proven empty.
  
  `pull` now emits `.collate("C")` for a column with a `pg_catalog` collation. Before, it listed the
  column under `-- pull: unsupported`. A column whose collation lives in another schema stays listed
  there.
  
  The collation name is a single identifier and must name a `pg_catalog` collation: migrations run
  under `search_path = pg_catalog`, so a collation created in another schema does not resolve.
  
  **Upgrading a 0.1.0 migration history:** the catalog extractor now records a collation outside
  `pg_catalog` as `"schema"."name"`, so a managed column that already uses one fingerprints
  differently and the next `migrate apply` stops with `fingerprint_mismatch`. If your managed schemas
  use such a collation, re-baseline once after upgrading (`pg-prime migrate baseline --force`).
  Columns with `pg_catalog` collations, or none, are unaffected.

- [#3](https://github.com/pg-prime/pg-prime/pull/3) [`2fb8de6`](https://github.com/pg-prime/pg-prime/commit/2fb8de66277938afdfc9d7684bd89dfca5d36c08) Thanks [@YohoCX](https://github.com/YohoCX)! - **Declared RLS policies and `updated_at` triggers ship through the `sql/` repeatable lane.**
  
  - `migrate generate` renders every `definePolicy(...)` export into `sql/050_policies/<schema>__<table>.sql`,
    every `updatedAtTrigger(...)` into `sql/070_triggers/`, and a `sql/990_declared_prune.sql` that drops
    objects this lane created and no longer declares. Each object carries a
    `COMMENT … IS 'pg-prime:declared sha256:<hash>'` marker, so hand-written objects are never touched.
  - `rls.force()` / `rls.enable()` put `FORCE` / `NO FORCE ROW LEVEL SECURITY` in the table's policy file,
    committed with the policies. `FORCE` is not a schema fact, so no fingerprint changes and no re-baseline
    is needed on upgrade.
  - The shadow loads the lane from memory, rendered into its own schemas, and never runs the prune: a
    temp-schema generate leaves the target's policies alone.
  - Lane hazards are checked before anything is written, against the target's full policy set and the
    shadow's: RL101 (a role loses a command), RL103 (`NO FORCE` on a forced table), RL105 (a restrictive
    policy removed) and RL108 (`FORCE` filters the owner). An unacknowledged one refuses with exit 2;
    `--allow-data-loss --reason` records the acknowledgement in the prune file's header.
    `declared_conflict` (a hand file that writes a declared object or sits at a declared path) and
    `policy_unknown_role` also refuse.
  - `migrate apply` re-applies a declared file whose objects are missing, carry another hash or have the
    wrong `FORCE` state, even when its bytes match the recorded checksum.
  - `migrate verify` checks the markers and `FORCE` state on the replay (drift, exit 4) and warns on an
    RLS table with no policy. `migrate doctor` reports `declared_missing`, `declared_orphan`,
    `declared_unmarked` and `rls_not_forced`, and says when the prune file may be deleted. `migrate check`
    exits 3 on a stale or conflicting lane.
  - `pull` writes RLS flags and policies as `rls.*()` / `definePolicy(...)`, and the runner sets
    `row_security = off`, so a filtered read fails with 42501 instead of returning too few rows.
  - New exports: `renderDeclared`, `syncDeclared`, `declaredCensus`, `POLICIES_DIR`, `TRIGGERS_DIR`,
    `PRUNE_FILE`, `LaneRefusedError` and their types; `SchemaLike.policies`.

### Patch Changes

- [#3](https://github.com/pg-prime/pg-prime/pull/3) [`98ad069`](https://github.com/pg-prime/pg-prime/commit/98ad069d689b69d4ad76a3c159bda5820341bf80) Thanks [@YohoCX](https://github.com/YohoCX)! - The package READMEs no longer claim `0.0.0` or "nothing is usable yet". `@pg-prime/testing`'s README now lists what it ships — `createMockPool`, `expectSql`, `startPglite`, `startPostgres`, `scratchDatabase` and the skip guards — with a minimal `startPglite` example, and `pg-prime`'s README names `pg` as the optional peer the `connection:` form needs.
- Updated dependencies [[`a75e3a1`](https://github.com/pg-prime/pg-prime/commit/a75e3a19a2e9f615acdbc1d9e240bfc81bf9e9dd), [`6a7ed8e`](https://github.com/pg-prime/pg-prime/commit/6a7ed8e4f9e63e3437400848c0b743dad71a9708), [`98ad069`](https://github.com/pg-prime/pg-prime/commit/98ad069d689b69d4ad76a3c159bda5820341bf80), [`60b99c8`](https://github.com/pg-prime/pg-prime/commit/60b99c86c94d5a720682e775f32913e0a1c7ce31), [`7667362`](https://github.com/pg-prime/pg-prime/commit/7667362fd19a099f294d79901e2e487efb58455e), [`7e93af3`](https://github.com/pg-prime/pg-prime/commit/7e93af378387d69d2d736276527def3d63fc9e63)]:
  - pg-prime@0.2.0

## 0.1.0

### Minor Changes

- [`36dff23`](https://github.com/pg-prime/pg-prime/commit/36dff2302e3747dd1c6a46b96fcb20cfe37263a6) Thanks [@YohoCX](https://github.com/YohoCX)! - First release of the fixed `pg-prime` / `@pg-prime/kit` pair: a PostgreSQL-only, zero-dependency,
  ESM-only TypeScript ORM — schema DSL, `sql` tag, typed query builder with relations, codec
  registry and a structural driver seam — together with the migration engine behind the `pg-prime`
  CLI, which diffs a live catalog against the schema you wrote, proves the plan on a shadow clone
  and applies it under an advisory lock.
  
  Pre-alpha, and the API will change: this is `0.x`, breaking changes land in a minor and never in a
  patch, and the closed 1.0 checklist is `design/08-architecture.md` §6.2.

- [`21d2e66`](https://github.com/pg-prime/pg-prime/commit/21d2e66a332ffa47aba3fce5f8530706af673615) Thanks [@YohoCX](https://github.com/YohoCX)! - The migration side of design/01 §3 rows **49**, **50**, **51** and **54**: the four object kinds
  the DSL learned this round now emit, diff and `pull`.
  
  `emitSchema` writes `EXCLUDE USING … (elem WITH op) WHERE … DEFERRABLE`, `GENERATED ALWAYS AS (…)
  STORED`, an index's `(expression)` keys, `WITH (…)` (sorted, text values quoted) and `TABLESPACE`,
  and `COMMENT ON TYPE` for a `pgEnum` / `pgDomain` comment. An `exclude(...).requires('btree_gist')`
  whose extension the registry does not declare is an error diagnostic naming the declaration to add,
  rather than a `42704` about an operator class three steps later on the shadow.
  
  `pg-prime pull`'s residue list shrinks by four kinds: an exclusion constraint, a stored generated
  column, an expression index key, and an index's `WITH (…)` / `TABLESPACE`. What it still cannot
  express keeps an exact reason — an EXCLUDE element carrying an opclass, a key this recogniser
  cannot split with certainty, `attgenerated = 'v'`.
  
  `BuildOptions.noConcurrentIndexes` carries design/05 §2.4's `index('…').concurrently(false)` into
  the differ, filled by the new exported `nonConcurrentIndexes(schema)`. It travels beside the IR
  rather than inside it because `CONCURRENTLY` is a property of how an index is built: `pg_get_indexdef`
  has nothing to say about it, so a payload field would differ between the two sides for ever.

- [`c530947`](https://github.com/pg-prime/pg-prime/commit/c530947c9c0317560bac4754119930ff7689e8e7) Thanks [@YohoCX](https://github.com/YohoCX)! - **Declared views ride the `sql/` repeatables lane, and the Tier-U census stops counting them** —
  design/01 §3 row 58, the kit half.
  
  `migrate generate` renders every `pgView` / `pgMaterializedView` in the schema into
  `<repeatablesDir>/020_views/NNN_<schema>__<name>.sql`, before the shadow database loads the lane —
  so the shadow holds the current definitions, the proof covers them, and a view that selects a column
  the migration is about to drop fails at author time. From there they are ordinary repeatables:
  hashed, drift-detected, re-applied when the hash changes, and a positive line in the pull request
  that changed them.
  
  A file rather than an in-memory contribution because `migrate apply`, `migrate status` and
  `migrate doctor` do not load the TypeScript schema — `apply` has to work in a deploy image that
  ships migrations and nothing else — so an in-memory view would read as an orphan to `doctor` and
  would never re-apply at deploy time.
  
  `.dependsOn(…)` is a topological sort whose rank is baked into the filename, because the repeatables
  pass walks the directory in one lexicographic sort and has no dependency graph. Reordering renames
  files; the stale ones are pruned on the next `generate`, and only a file carrying the new
  `-- pg-prime:declared view` marker is ever deleted — a hand-written view in the same directory, or
  one `pull` wrote, is never touched. A cycle is a diagnostic, not a silent order. `migrate check`
  writes nothing at all: it reports `declared_views_stale` instead.
  
  The Tier-U census subtracts the declared views **by name**, not by count: `presentDeclaredViews`
  asks the catalog which declarations actually exist, so a declaration that has not been applied yet
  cannot over-subtract and hide a genuinely unmodelled view. A view you have not declared still shows
  up in `N view object(s) present and not diffed`. `extractCatalog` itself is unchanged, so
  `migrate doctor` still reports what is in the database.
  
  New on the barrel: `renderViewRepeatables`, `syncViewRepeatables`, `declaredViewIdentities`,
  `VIEWS_DIR`, `DECLARED_DIRECTIVE`, and the `DeclaredView` / `RenderedViews` / `SyncedViews` /
  `RenderViewsOptions` / `SyncViewsOptions` / `ViewLike` / `ViewRuntime` / `ViewInfo` types.
  `SchemaLike` gains an optional `views` list.
  
  Two fixes that come with it: a view is table-shaped, so `loadSchema`'s table sweep now excludes
  anything carrying `$.view` (without that a view would have been emitted as a `CREATE TABLE`), and a
  schema module that exports declarations but no tables is no longer an error — a `views.ts` or a
  `domains.ts` beside `tables.ts` is a normal way to organize a schema.
  
  Pre-alpha, and the API will change: this is `0.x`, breaking changes land in a minor and never in a
  patch.

### Patch Changes

- Updated dependencies [[`faf2f01`](https://github.com/pg-prime/pg-prime/commit/faf2f013fde077c2ff819c5d5ecbf61a7069e691), [`2655664`](https://github.com/pg-prime/pg-prime/commit/2655664ba433821176d790d4baf2608fb3f26fb3), [`21d2e66`](https://github.com/pg-prime/pg-prime/commit/21d2e66a332ffa47aba3fce5f8530706af673615), [`36dff23`](https://github.com/pg-prime/pg-prime/commit/36dff2302e3747dd1c6a46b96fcb20cfe37263a6), [`c530947`](https://github.com/pg-prime/pg-prime/commit/c530947c9c0317560bac4754119930ff7689e8e7)]:
  - pg-prime@0.1.0
