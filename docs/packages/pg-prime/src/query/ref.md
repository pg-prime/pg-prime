# packages/pg-prime/src/query/ref.ts

## Purpose
Runtime column references: `u.email` is a compiler `ColumnNode` with the schema's `RefRuntime` attached at `$`. `refsOf` builds and caches one frozen record of refs per (registry, table, alias), so scopes and lambdas allocate nothing per query.
Callers: `src/query/scope.ts` (`packages/pg-prime/src/query/scope.ts:221`), `src/query/insert.ts`, `src/query/relations.ts`; `RefNode`/`RefScope` types are used by `src/query/builder-state.ts`, `projection.ts`, `select.ts`, `update.ts`, `delete.ts`. Callees: `metaOf` (`src/query/meta.ts`), `col` and `mkNode` (`src/compile/nodes.ts`).

## Public API
- `RefNode` — `ColumnNode` plus `readonly $: RefRuntime`.
- `RefScope` — `Readonly<Record<string, RefNode>>`, one alias's refs keyed by TS column key.
- `RefsAtAlias<T, A>` — type-level refs of table `T` under alias `A` (`RefsOfCols<A, T[COLS]>`).
- `refsOf(t, alias?, registry?)` — typed overloads return `RefsAtAlias<T, A>` or the table's own `T[REFS]`; the untyped `TableLike` overload returns `RefScope`. Same frozen object per (registry, table, alias).

## Flow
1. `refsOf` defaults `alias` to `t.$.name` and `registry` to `defaultRegistry()` (`packages/pg-prime/src/query/ref.ts:100`).
2. The per-registry entry is replaced when `registry.generation` changed (`packages/pg-prime/src/query/ref.ts:107`).
3. Lookup by table (`WeakMap`) then alias (`Map`); a hit returns the cached record (`packages/pg-prime/src/query/ref.ts:111`).
4. `build` reads `metaOf(t, registry)` and, per column, spreads `col(alias, name, codec)` with `$: runtime`, re-registered as an AST node by `mkNode` (`packages/pg-prime/src/query/ref.ts:123`, `packages/pg-prime/src/query/ref.ts:133`).
5. The record is frozen and cached (`packages/pg-prime/src/query/ref.ts:135`).

## Gotchas
- A ref is an AST node, so `` sql`${u.id}` `` splices `"u"."id"` instead of binding a value; a wrapper object would become `$1`.
- Refs have no methods; operators are free functions that take them.
- The spread in `build` drops the AST `WeakSet` registration made by `col()`; `mkNode` restores it. Without it the ref would be treated as data (`packages/pg-prime/src/query/ref.ts:130`).
- Omitting `registry` uses the process-wide `defaultRegistry()`, whose codecs (and enum OIDs) can differ from a db's own registry.
- A registry generation change discards every cached scope for that registry, so refs built before `resolveDynamic` are not reused after it.
- `refsOf` and `RefNode` are internal: `refsOf` is listed in `EXPECTED_ABSENT` in `packages/pg-prime/test/query/index.test.ts`.

## Tests
- `packages/pg-prime/test/query/ops.test.ts` (`properties`): refs cached and identical per (table, alias), frozen, and spliced by the `sql` tag.
- Used as fixtures in `packages/pg-prime/test/query/guards.test.ts`, `packages/pg-prime/test/query/window.test.ts`, `packages/pg-prime/test/live-query/ops.test.ts`, `packages/pg-prime/test/fuzz/fixture.ts`.
- Run: `pnpm --filter pg-prime exec vitest run test/query/ops.test.ts`.
- Not covered directly: cache invalidation on a registry generation change (covered for `metaOf` in `packages/pg-prime/test/query/meta.test.ts`).
