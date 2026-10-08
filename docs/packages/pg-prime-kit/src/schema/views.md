# packages/pg-prime-kit/src/schema/views.ts

## Purpose
Renders `pgView`/`pgMaterializedView` declarations from a `SchemaLike` into repeatable SQL files under `<repeatablesDir>/020_views/`, keeps that directory in sync, and adjusts the Tier-R census so declared objects are not reported as unmodelled. `generate.ts` renders views and counts them (`packages/pg-prime-kit/src/generate.ts:233`, `:271`) and writes them through `syncDeclared` with the rest of the declared lane (`schema/declared.ts`); the files are then scanned like any repeatable by `repeatables/scan.ts`. Views never go through `schema/emit.ts`.

## Public API
- `VIEWS_DIR` — `"020_views"`. `DECLARED_DIRECTIVE` — `"-- pg-prime:declared view"`, the first line of every generated file.
- `DeclaredView` — `{ kind: "view"|"materializedView", identity, path, sql }`; `path` is relative to the repeatables root.
- `RenderViewsOptions` — `{ defaultSchema? }` (default `"public"`). `RenderedViews` — `{ files, diagnostics }`.
- `renderViewRepeatables(schema, options?)` — renders non-`.existing()` views in `.dependsOn` order; reports `view_conflict` and `view_dependency_cycle` errors.
- `declaredViewIdentities(schema, defaultSchema?)` — every declared `schema.name`, `.existing()` included.
- `ViewCensus` — `{ view, materializedView }` counts. `NO_VIEWS` — frozen zero census.
- `presentDeclaredViews(client, schemas, declared)` — counts which declared identities exist in the database, by kind.
- `renderedViewCensus(rendered)` — counts rendered files by kind.
- `censusWithout(diagnostics, declared)` — subtracts per-kind counts (`view`, `policy`, …) from `unmodeled_kind` diagnostics, dropping a kind that reaches zero.
- `SyncViewsOptions` — adds `write: boolean`. `SyncedViews` — adds `written` and `pruned` paths.
- `syncViewRepeatables(schema, dir, options)` — renders, then `syncDeclared` over `020_views/`: writes and prunes, or with `write: false` reports a `declared_views_stale` warning.

## Flow
1. `renderViewRepeatables` dedupes by identity (`view_conflict`), skips `.existing()` views (`packages/pg-prime-kit/src/schema/views.ts:182`).
2. `order` does a DFS topological sort over `dependsOn` edges inside the declared set, ties by identity; cycle members are reported (`packages/pg-prime-kit/src/schema/views.ts:133`).
3. Each view gets rank 10, 20, …, and path `020_views/<rank 3-digit>_<schema slug>__<name slug>.sql` (`packages/pg-prime-kit/src/schema/views.ts:208`).
4. `bodySql` writes the directive header (`-- pg-prime:tier R`, `-- pg-prime:rank`), then `CREATE OR REPLACE VIEW … (cols) WITH (…) AS <body>` for a view (`packages/pg-prime-kit/src/schema/views.ts:105`).
5. A matview is `DROP MATERIALIZED VIEW IF EXISTS` (no `CASCADE`) + `CREATE MATERIALIZED VIEW … WITH [NO] DATA` (`packages/pg-prime-kit/src/schema/views.ts:114`).
6. An optional `COMMENT ON VIEW|MATERIALIZED VIEW` follows (`packages/pg-prime-kit/src/schema/views.ts:119`).
7. `syncViewRepeatables` delegates to `syncDeclared` with `dirs: [VIEWS_DIR]`, which writes wanted files whose text differs and unlinks declared files no longer wanted (`packages/pg-prime-kit/src/schema/views.ts:309`).
8. With `write: false`, mismatches are reported as one `declared_views_stale` warning instead.

## Gotchas
- `generate` writes the lane only when `outDir` is set; otherwise it reports staleness instead of repairing (`packages/pg-prime-kit/src/generate.ts:312`).
- Pruning only touches files whose first line starts with `-- pg-prime:declared`; hand-written files and `pull` output are never deleted, and a hand file at a wanted path is `declared_conflict` with nothing written.
- Dependency order is baked into filenames; a reordered graph renames files and the old ones are pruned.
- Dependencies outside the declared set are ordered only by directory rank (`010_functions` before `020_views`).
- On a cycle, the cyclic views are still emitted (DFS order), alongside an error diagnostic.
- A matview body change drops and recreates it; indexes on it must be recreated by the user's own `sql/` lane.
- `security_invoker`, `security_barrier`, `check_option` are written only when set on the declaration (`packages/pg-prime-kit/src/schema/views.ts:78`).
- `presentDeclaredViews` matches by name rather than subtracting counts, so unapplied declarations do not hide genuinely unmodelled views.
- `presentDeclaredViews`, `censusWithout`, `renderedViewCensus`, `NO_VIEWS` and `ViewCensus` are not re-exported from `packages/pg-prime-kit/src/index.ts`.

## Tests
- `packages/pg-prime-kit/test/schema-emit/views.test.ts` — rank/filename ordering, `security_invoker` default and comment, reloptions, matview DROP + CREATE without CASCADE, `.withNoData()`, cycle and conflict diagnostics, sync idempotence/pruning/hand-written safety, `write: false` drift report, and an end-to-end generate → apply → census check.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/schema-emit/views.test.ts` (the end-to-end block needs a real server, `PG_PRIME_TEST_URL`).
- Uncovered: `presentDeclaredViews` and `censusWithout` are only exercised through the end-to-end census assertion.
