# packages/pg-prime/src/query/delete.ts

## Purpose
The DELETE builder with `USING`, `WHERE` and `RETURNING`; its `toAst()` is a `Statement`, so it also serves as a writable CTE body (archive-and-move). Created by `ExecutorImpl.deleteFrom` in `cte.ts`. Uses `checkAlias` / `rebuildScope` from `select.ts`, `sourceOf` / `compileProjection` / `allOf` / `writeTargetMessage` from `scope.ts`, the terminals in `terminals.ts`, and `compile` in `src/compile/compiler.ts`.

## Public API
- `DeleteBuilder` — immutable delete over a frozen `DeleteState`.
- `where(f)` — predicate against the scope; repeated calls AND.
- `using(h, alias?)` — adds a `USING` item and widens the scope; throws if the alias is already in scope.
- `allRows()` — opt-in to a delete with no `where`.
- `returning(f)` (may name `USING` aliases), `returningAll()` (target columns).
- `toAst()`, `compile()` — memoised; throw without `where`/`allRows`.
- Options: `signal`, `timeout`, `outsideTransaction`, `withExecMode`.
- Terminals: `execute()`, `executeTakeFirst()`, `prepare()`, `explain()`, `toSQL()`. No `stream()`.
- `makeDelete(ctx, ctes, h, alias)` — the initial builder; throws for a non-table target. Re-exports type `ProjectionItem`.

## Flow
1. `makeDelete` refuses views/CTEs/derived sources, checks the alias, and builds the scope (`packages/pg-prime/src/query/delete.ts:185`).
2. `where` runs the lambda immediately and ANDs with any earlier predicate (`packages/pg-prime/src/query/delete.ts:70`).
3. `using` resolves the source, checks the alias, refuses a collision, appends the FROM item and rebuilds every scope (`packages/pg-prime/src/query/delete.ts:76`).
4. `toAst` enforces `where`/`allRows`, then builds and memoises a compacted `DeleteNode` (`packages/pg-prime/src/query/delete.ts:117`).
5. `compile` memoises; `execute` hands it with `this.s.run` to `Runner.run` (`packages/pg-prime/src/query/delete.ts:137`, `:161`).

## Gotchas
- A delete with no `.where()` throws unless `.allRows()` was called (`packages/pg-prime/src/query/delete.ts:118`).
- Bulk delete is `inList(t.id, ids)` in `ops.ts`, which compiles to `= any($1)`; an empty list compiles to `false` (`packages/pg-prime/src/query/delete.ts:9`).
- `USING` uses non-lateral FROM items; any source `sourceOf` accepts (table, view, CTE, derived) may be a `USING` item.
- `explain({ analyze: true })` is wrapped and rolled back unless `rollback: false` (via `explainWith`).
- The `executeTakeFirst` comment here says `maxRows` would stop the statement; `packages/pg-prime/src/query/terminals.ts:62` records that it does not.

## Tests
- `packages/pg-prime/test/query/delete.test.ts` — alias, predicate and unqualified RETURNING, void shape, `using()` widening, `= any($1)` bulk delete, empty list → `false`.
- `packages/pg-prime/test/query/guards.test.ts` — missing `where` vs `allRows`, `using()` alias collision.
- `packages/pg-prime/test/query/cte.test.ts` — delete as a writable CTE (archive-and-move).
- Live: `packages/pg-prime/test/live-query/writes.test.ts` (delete by `= any($1)`, empty in-list), `packages/pg-prime/test/live-query/cte.test.ts`.
- Run: `pnpm --filter pg-prime exec vitest run test/query/delete.test.ts`; live: `pnpm --filter pg-prime exec vitest run test/live-query/writes.test.ts`.
