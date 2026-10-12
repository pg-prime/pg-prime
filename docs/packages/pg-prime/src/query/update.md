# packages/pg-prime/src/query/update.ts

## Purpose
The UPDATE builder, including the bulk `UPDATE … FROM (VALUES …)` / `unnest` form for applying different patches per row in one statement. Created by `ExecutorImpl.update` in `cte.ts`. Reuses `setItemsOf` from `insert.ts`, `checkAlias` / `derivedRuntime` / `rebuildScope` from `select.ts`, `oneOf` from `window.ts`, `registerDerived` and projection helpers from `scope.ts`, the terminals in `terminals.ts`, and `compile` in `src/compile/compiler.ts`.

## Public API
- `UpdateBuilder` — immutable update over a frozen `UpdateState`.
- `set(f)` — `(t, v?) => patch`; merges with earlier `.set()` calls; throws if a column is assigned twice.
- `where(f)` — `(t, v?) => predicate`; repeated calls AND.
- `allRows()` — opt-in to an update with no `where`.
- `ifVersion(f, expected)` — optimistic lock: `t => expr`; stored in `version`, not `where`; throws with `fromValues` (either order), for `null`, or when already set.
- `fromValues(rows, codecs, opts?)` — adds a values relation (default alias `v`) to `FROM`; `opts.strategy` is `values` (default) or `unnest`.
- `returning(f)`, `returningAll()` (target columns, unqualified).
- `toAst()`, `compile()` — memoised; throw without `set` or without `where`/`allRows`.
- Options: `signal`, `timeout`, `outsideTransaction`, `withExecMode`.
- Terminals: `execute()`, `executeTakeFirst()`, `executeRowCount()` (command-tag count via `Runner.runCounted`), `prepare()`, `explain()`, `toSQL()`. No `stream()`.
- `ValueCodecs` — `Record<string, AnyCodec>`, column key → codec for `fromValues`.
- `FromValuesOpts` — `{ alias?: string, strategy?: 'values' | 'unnest' }`.
- `makeUpdate(ctx, ctes, h, alias)` — the initial builder; throws for a non-table target. Re-exports types `ColumnMeta`, `ProjectionItem`, `SetItem`.

## Flow
1. `makeUpdate` refuses non-table sources via `writeTargetMessage`, checks the alias, and builds the scope (`packages/pg-prime/src/query/update.ts:380`).
2. `set` calls the lambda with the scope record and, after `fromValues`, the values alias's scope as a second argument (`packages/pg-prime/src/query/update.ts:119`).
3. `setItemsOf` turns the patch into table-ordered `SetItem`s; overlap with existing assignments throws (`packages/pg-prime/src/query/update.ts:123`).
4. `fromValues` validates rows, alias and strategy, then builds `literalValues` (`VALUES` with first-row casts) or `unnestValues` (one `::type[]` array param per key) (`packages/pg-prime/src/query/update.ts:161`).
5. It registers a derived handle for the alias (refs from `codecs`), appends the FROM item, records `valuesAlias`, and rebuilds every scope (`packages/pg-prime/src/query/update.ts:196`).
6. `toAst` enforces `set` and `where`/`allRows`, then builds the node with `#withOnUpdate()` appending `.$onUpdate()` values for unassigned columns (`packages/pg-prime/src/query/update.ts:225`, `:265`).
7. `toAst` ANDs the `.ifVersion()` check into `where` and sets `versionCheck` through `versioned` (`packages/pg-prime/src/query/update.ts:237`); the runner enforces it on every execute path.
8. `compile` memoises; `execute` hands the compiled statement and `this.s.run` to `Runner.run` (`packages/pg-prime/src/query/update.ts:279`, `:303`).

## Gotchas
- An update with no `.where()` throws unless `.allRows()` was called; a `$if` that did not fire is the usual cause (`packages/pg-prime/src/query/update.ts:229`).
- SET targets are emitted unqualified and SET values qualified; the compiler's `emitSetItems` owns that (`packages/pg-prime/src/query/update.ts:4`).
- `.$onUpdate()` factories run once per builder (inside the memoised `toAst`) and never for columns the caller set; they are not applied to `onConflict().doUpdate()` (`packages/pg-prime/src/query/update.ts:252`).
- `fromValues` columns come from `codecs` keys; extra row keys are ignored, missing ones throw. The presence test is `k in row`, so inherited keys (e.g. `toString`) count as present (`packages/pg-prime/src/query/update.ts:346`).
- `fromValues` refuses an empty row list, an alias already in scope, and an array codec under `unnest` (`packages/pg-prime/src/query/update.ts:166`, `:171`, `:180`).
- The derived handle for the values alias is registered with a placeholder `EMPTY_QUERY`; only its refs are used, its FROM item is built separately (`packages/pg-prime/src/query/update.ts:332`).
- `set`'s second argument is `undefined` before `fromValues` is called.
- `.ifVersion()` does not satisfy the no-`where` guard and checks "at least one row"; for per-row versions use `executeRowCount()` against the row count.

## Tests
- `packages/pg-prime/test/query/update.test.ts` — unqualified targets, table-ordered SET, missing `set`, unknown columns, `fromValues` with both strategies, values-ref codecs, missing patch keys, empty patch list, `.$onUpdate()` behaviour.
- `packages/pg-prime/test/query/guards.test.ts` — missing `where` vs `allRows`, `fromValues` alias shadowing, double `.set()` on one column, `__proto__` SET keys.
- `packages/pg-prime/test/query/explain.test.ts` — the ANALYZE rollback rail on updates.
- `packages/pg-prime/test/query/version.test.ts` — `.ifVersion()` SQL, refusals and conflicts on every entry point.
- Live: `packages/pg-prime/test/live-query/writes.test.ts` (update/returning, bulk update by key), `bulk-strategy.test.ts` (`fromValues` values vs unnest), `version.test.ts` (`executeRowCount`, conflicts in a transaction).
- Run: `pnpm --filter pg-prime exec vitest run test/query/update.test.ts`; live: `pnpm --filter pg-prime exec vitest run test/live-query/writes.test.ts`.
- Uncovered: inherited-key acceptance in `fromValues` rows.
