# @pg-prime/kit

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
