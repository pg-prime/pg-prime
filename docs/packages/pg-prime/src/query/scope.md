# packages/pg-prime/src/query/scope.ts

## Purpose
Resolves anything that can sit in a FROM clause (table, view, CTE, derived table, raw FROM item) to a `SourceRuntime`, and builds the cached per-alias scope objects that builder callbacks receive. Used by `select.ts`, `insert.ts`, `update.ts`, `delete.ts`, `cte.ts` and `window.ts`; calls `refsOf` (`ref.ts`), `metaOf` (`meta.ts`), `mergeAccessors` (`relations.ts`), `planSelect` (`src/compile/hoist.ts`) and node constructors in `src/compile/nodes.ts`. Also re-exports the projection helpers of `projection.ts`.

## Public API
- `SourceRuntime` — `{ kind: 'table'|'view'|'cte'|'derived', name, fromItem(alias, lateral), refs(alias, registry) }`.
- `DerivedField` — `{ key, codec }`, one addressable column of a sub-select.
- `fieldsOfQuery(node)` — column fields of a select/set-op (left-most branch), skipping `nest` groups; relation columns get `jsonCodecJson`.
- `registerCte(handle, name, fields)` — registers a CTE handle: FROM item `"name" as "alias"`, refs from `fields`.
- `registerDerived(handle, name, node, fields)` — registers a derived-table handle: FROM item is a (possibly lateral) subquery.
- `registerRawFrom(handle, name, item, fields)` — registers a prebuilt raw FROM item (used by `fromRaw`).
- `sourceOf(h)` — the `SourceRuntime` for a handle; throws `BuilderError` naming accepted sources.
- `writeTargetMessage(verb, source)` — the error text for a non-table write target (view-specific wording for views).
- `scopeFor(handle, alias, ctx, visible?)` — cached scope: refs, relation accessors (tables only), and `$all`.
- `allOf(scope)` — the scope's column refs only, as a projection record (`selectAll`, `returningAll`).
- Re-exports from `projection.ts`: `assertSafeKey`, `compileProjection`, `isGroup`, `isNested`, `makeNested`, `nest`, `nestNullable`, `NO_LEFT_JOINS`, `omit`, `outputColumn`, `projectionItem`, `registryOr`, `toExprList`, `toExprNode`, `toOrderItems`.

## Flow
1. `sourceOf` checks the nominal `SOURCES` `WeakMap` (CTE/derived/raw), then the `TABLE_SOURCES` memo (`packages/pg-prime/src/query/scope.ts:195`).
2. Otherwise a handle with a string `$.name` is a table, or a view when `$.view` is set; its name is the schema key (`NAME` symbol) when present, else `$.name` (`packages/pg-prime/src/query/scope.ts:205`).
3. `scopeFor` looks up `SCOPE_CACHE` by registry, resetting the entry when `registry.generation` changes (`packages/pg-prime/src/query/scope.ts:273`).
4. The cache key is the alias plus the avoid-list (`visible`, with `alias` prepended if missing) (`packages/pg-prime/src/query/scope.ts:301`).
5. On a miss, `source.refs(alias, registry)` builds refs; for `kind === 'table'` `mergeAccessors` adds relation accessors whose child aliases avoid every visible alias (`packages/pg-prime/src/query/scope.ts:311`).
6. `withAll` freezes the scope with `$all` pointing at the ref record (`packages/pg-prime/src/query/scope.ts:328`).

## Gotchas
- Source membership is nominal (`WeakMap`): a structurally similar plain object (e.g. from `JSON.parse`) is not a CTE or derived source (`packages/pg-prime/src/query/scope.ts:60`).
- A table column whose TS key is `$all` throws when its scope is built (`packages/pg-prime/src/query/scope.ts:329`).
- Avoid-list order is part of the cache key; two chains reaching the same alias set in different orders build the scope twice (a cost, not a wrong answer) (`packages/pg-prime/src/query/scope.ts:283`).
- Views have `kind: 'view'`, get no relation accessors, and are refused by the write builders via `writeTargetMessage` (`packages/pg-prime/src/query/scope.ts:229`).
- `fieldsOfQuery` omits `nest({...})` keys, so such a key read off a CTE/derived scope is `undefined` (`packages/pg-prime/src/query/scope.ts:75`).
- Derived/CTE refs carry a synthetic `ColumnRuntime` with `pgType: 'unknown'` and `notNull: false`, so they never witness `nestNullable` (`packages/pg-prime/src/query/scope.ts:99`).
- Scope callbacks run at call time, once; nothing here defers them.

## Tests
- No dedicated spec. Covered through `packages/pg-prime/test/query/select.test.ts` (`$all`, `omit`, aliasing, relation scopes), `packages/pg-prime/test/query/cte.test.ts` (CTE/raw sources), `packages/pg-prime/test/query/relations.test.ts` and `packages/pg-prime/test/query/guards.test.ts` (`__proto__`, alias collisions).
- Views as sources and the write refusal: `packages/pg-prime/test/live-query/views.test.ts`.
- Run: `pnpm --filter pg-prime exec vitest run test/query/select.test.ts test/query/cte.test.ts`.
- Uncovered: no test targets the registry-generation reset of `SCOPE_CACHE` (`packages/pg-prime/test/query/meta.test.ts` covers the analogous `metaOf` memo).
