---
'@pg-prime/kit': minor
---

**Declared views ride the `sql/` repeatables lane, and the Tier-U census stops counting them** —
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
