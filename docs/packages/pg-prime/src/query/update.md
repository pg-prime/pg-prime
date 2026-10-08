# packages/pg-prime/src/query/update.ts

## Purpose
The UPDATE builder, including the bulk `UPDATE … FROM (VALUES …)` / `unnest` form for applying different patches per row in one statement. Created by `ExecutorImpl.update` in `cte.ts`. Reuses `setItemsOf` from `insert.ts`, `checkAlias` / `derivedRuntime` / `rebuildScope` from `select.ts`, `oneOf` from `window.ts`, `registerDerived` and projection helpers from `scope.ts`, the terminals in `terminals.ts`, and `compile` in `src/compile/compiler.ts`.

## Public API
- `UpdateBuilder` — immutable update over a frozen `UpdateState`.
- `set(f)` — `(t, v?) => patch`; merges with earlier `.set()` calls; throws if a column is assigned twice.
- `where(f)` — `(t, v?) => predicate`; repeated calls AND.
- `allRows()` — opt-in to an update with no `where`.
- `fromValues(rows, codecs, opts?)` — adds a values relation (default alias `v`) to `FROM`; `opts.strategy` is `values` (default) or `unnest`.
- `returning(f)`, `returningAll()` (target columns, unqualified).
- `toAst()`, `compile()` — memoised; throw without `set` or without `where`/`allRows`.
- Options: `signal`, `timeout`, `outsideTransaction`, `withExecMode`.
- Terminals: `execute()`, `executeTakeFirst()`, `prepare()`, `explain()`, `toSQL()`. No `stream()`.
- `ValueCodecs` — `Record<string, AnyCodec>`, column key → codec for `fromValues`.
- `FromValuesOpts` — `{ alias?: string, strategy?: 'values' | 'unnest' }`.
- `makeUpdate(ctx, ctes, h, alias)` — the initial builder; throws for a non-table target. Re-exports types `ColumnMeta`, `ProjectionItem`, `SetItem`.

## Flow
1. `makeUpdate` refuses non-table sources via `writeTargetMessage`, checks the alias, and builds the scope (`packages/pg-prime/src/query/update.ts:363`).
2. `set` calls the lambda with the scope record and, after `fromValues`, the values alias's scope as a second argument (`packages/pg-prime/src/query/update.ts:116`).
3. `setItemsOf` turns the patch into table-ordered `SetItem`s; overlap with existing assignments throws (`packages/pg-prime/src/query/update.ts:120`).
4. `fromValues` validates rows, alias and strategy, then builds `literalValues` (`VALUES` with first-row casts) or `unnestValues` (one `::type[]` array param per key) (`packages/pg-prime/src/query/update.ts:152`).
5. It registers a derived handle for the alias (refs from `codecs`), appends the FROM item, records `valuesAlias`, and rebuilds every scope (`packages/pg-prime/src/query/update.ts:186`).
6. `toAst` enforces `set` and `where`/`allRows`, then builds the node with `#withOnUpdate()` appending `.$onUpdate()` values for unassigned columns (`packages/pg-prime/src/query/update.ts:215`, `:252`).
7. `compile` memoises; `execute` hands the compiled statement and `this.s.run` to `Runner.run` (`packages/pg-prime/src/query/update.ts:266`, `:290`).

## Gotchas
- An update with no `.where()` throws unless `.allRows()` was called; a `$if` that did not fire is the usual cause (`packages/pg-prime/src/query/update.ts:219`).
- SET targets are emitted unqualified and SET values qualified; the compiler's `emitSetItems` owns that (`packages/pg-prime/src/query/update.ts:4`).
- `.$onUpdate()` factories run once per builder (inside the memoised `toAst`) and never for columns the caller set; they are not applied to `onConflict().doUpdate()` (`packages/pg-prime/src/query/update.ts:239`).
- `fromValues` columns come from `codecs` keys; extra row keys are ignored, missing ones throw. The presence test is `k in row`, so inherited keys (e.g. `toString`) count as present (`packages/pg-prime/src/query/update.ts:329`).
- `fromValues` refuses an empty row list, an alias already in scope, and an array codec under `unnest` (`packages/pg-prime/src/query/update.ts:157`, `:161`, `:170`).
- The derived handle for the values alias is registered with a placeholder `EMPTY_QUERY`; only its refs are used, its FROM item is built separately (`packages/pg-prime/src/query/update.ts:315`).
- `set`'s second argument is `undefined` before `fromValues` is called.
- The `executeTakeFirst` comment here says `maxRows` would stop the statement; `packages/pg-prime/src/query/terminals.ts:62` records that it does not.

## Tests
- `packages/pg-prime/test/query/update.test.ts` — unqualified targets, table-ordered SET, missing `set`, unknown columns, `fromValues` with both strategies, values-ref codecs, missing patch keys, empty patch list, `.$onUpdate()` behaviour.
- `packages/pg-prime/test/query/guards.test.ts` — missing `where` vs `allRows`, `fromValues` alias shadowing, double `.set()` on one column, `__proto__` SET keys.
- `packages/pg-prime/test/query/explain.test.ts` — the ANALYZE rollback rail on updates.
- Live: `packages/pg-prime/test/live-query/writes.test.ts` (update/returning, bulk update by key), `bulk-strategy.test.ts` (`fromValues` values vs unnest).
- Run: `pnpm --filter pg-prime exec vitest run test/query/update.test.ts`; live: `pnpm --filter pg-prime exec vitest run test/live-query/writes.test.ts`.
- Uncovered: inherited-key acceptance in `fromValues` rows.
