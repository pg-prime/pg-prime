# packages/pg-prime-kit/src/schema/views.ts

## Purpose
Renders `pgView`/`pgMaterializedView` declarations from a `SchemaLike` into repeatable SQL files under `<repeatablesDir>/020_views/`, keeps that directory in sync, and adjusts the Tier-R view census so declared views are not reported as unmodelled. Called by `generate.ts` (`packages/pg-prime-kit/src/generate.ts:186`–`:235`); the files are then scanned like any repeatable by `repeatables/scan.ts`. Views never go through `schema/emit.ts`.

## Public API
- `VIEWS_DIR` — `"020_views"`. `DECLARED_DIRECTIVE` — `"-- pg-prime:declared view"`, the first line of every generated file.
- `DeclaredView` — `{ kind: "view"|"materializedView", identity, path, sql }`; `path` is relative to the repeatables root.
- `RenderViewsOptions` — `{ defaultSchema? }` (default `"public"`). `RenderedViews` — `{ files, diagnostics }`.
- `renderViewRepeatables(schema, options?)` — renders non-`.existing()` views in `.dependsOn` order; reports `view_conflict` and `view_dependency_cycle` errors.
- `declaredViewIdentities(schema, defaultSchema?)` — every declared `schema.name`, `.existing()` included.
- `ViewCensus` — `{ view, materializedView }` counts. `NO_VIEWS` — frozen zero census.
- `presentDeclaredViews(client, schemas, declared)` — counts which declared identities exist in the database, by kind.
- `renderedViewCensus(rendered)` — counts rendered files by kind.
- `censusWithout(diagnostics, declared)` — subtracts declared counts from `unmodeled_kind` view/matview diagnostics, dropping a kind that reaches zero.
- `SyncViewsOptions` — adds `write: boolean`. `SyncedViews` — adds `written` and `pruned` paths.
- `syncViewRepeatables(schema, dir, options)` — writes changed files and prunes stale generated ones, or with `write: false` reports a `declared_views_stale` warning.

## Flow
1. `renderViewRepeatables` dedupes by identity (`view_conflict`), skips `.existing()` views (`packages/pg-prime-kit/src/schema/views.ts:183`).
2. `order` does a DFS topological sort over `dependsOn` edges inside the declared set, ties by identity; cycle members are reported (`packages/pg-prime-kit/src/schema/views.ts:134`).
3. Each view gets rank 10, 20, …, and path `020_views/<rank 3-digit>_<schema slug>__<name slug>.sql` (`packages/pg-prime-kit/src/schema/views.ts:209`).
4. `bodySql` writes the directive header (`-- pg-prime:tier R`, `-- pg-prime:rank`), then `CREATE OR REPLACE VIEW … (cols) WITH (…) AS <body>` for a view (`packages/pg-prime-kit/src/schema/views.ts:106`).
5. A matview is `DROP MATERIALIZED VIEW IF EXISTS` (no `CASCADE`) + `CREATE MATERIALIZED VIEW … WITH [NO] DATA` (`packages/pg-prime-kit/src/schema/views.ts:115`).
6. An optional `COMMENT ON VIEW|MATERIALIZED VIEW` follows (`packages/pg-prime-kit/src/schema/views.ts:120`).
7. `syncViewRepeatables` reads existing `.sql` files in `020_views/` that start with `DECLARED_DIRECTIVE`, writes wanted files whose text differs, and unlinks generated files no longer wanted (`packages/pg-prime-kit/src/schema/views.ts:341`).
8. With `write: false`, both kinds of mismatch are collected into one `declared_views_stale` warning (`packages/pg-prime-kit/src/schema/views.ts:374`).

## Gotchas
- `generate` passes `write: input.outDir !== undefined`, so a non-writing generate reports staleness instead of repairing (`packages/pg-prime-kit/src/generate.ts:192`).
- Pruning only touches files starting with `DECLARED_DIRECTIVE`; hand-written files and `pull` output (`-- pg-prime:object`) are never deleted.
- Dependency order is baked into filenames; a reordered graph renames files and the old ones are pruned.
- Dependencies outside the declared set are ordered only by directory rank (`010_functions` before `020_views`).
- On a cycle, the cyclic views are still emitted (DFS order), alongside an error diagnostic.
- A matview body change drops and recreates it; indexes on it must be recreated by the user's own `sql/` lane.
- `security_invoker`, `security_barrier`, `check_option` are written only when set on the declaration (`packages/pg-prime-kit/src/schema/views.ts:79`).
- `presentDeclaredViews` matches by name rather than subtracting counts, so unapplied declarations do not hide genuinely unmodelled views.
- `presentDeclaredViews`, `censusWithout`, `renderedViewCensus`, `NO_VIEWS` and `ViewCensus` are not re-exported from `packages/pg-prime-kit/src/index.ts`.

## Tests
- `packages/pg-prime-kit/test/schema-emit/views.test.ts` — rank/filename ordering, `security_invoker` default and comment, reloptions, matview DROP + CREATE without CASCADE, `.withNoData()`, cycle and conflict diagnostics, sync idempotence/pruning/hand-written safety, `write: false` drift report, and an end-to-end generate → apply → census check.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/schema-emit/views.test.ts` (the end-to-end block needs a real server, `PG_PRIME_TEST_URL`).
- Uncovered: `presentDeclaredViews` and `censusWithout` are only exercised through the end-to-end census assertion.
