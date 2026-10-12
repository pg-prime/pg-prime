# packages/pg-prime/src/query/insert.ts

## Purpose
The INSERT builder: single-row and bulk `VALUES`, the `unnest` bulk strategy with automatic switching and chunking, `INSERT … SELECT`, `DEFAULT VALUES`, `ON CONFLICT` upserts, and `RETURNING`. Created by `ExecutorImpl.insertInto` in `cte.ts`; `setItemsOf` is reused by `update.ts`. Calls `metaOf` / `refsOf` (`meta.ts`, `ref.ts`), `scope.ts`, `terminals.ts`, `prepared.ts`, and `compile` in `src/compile/compiler.ts`.

## Public API
- `UNNEST_CELLS` — `30_000`; `rows × columns` above which `auto` picks `unnest`.
- `CHUNK_ROWS` — `5_000`; default rows per chunk.
- `InsertBuilder` — immutable insert over a frozen `InsertState`.
- Sources: `values(row)`, `valuesMany(rows, opts?: BulkOpts)`, `defaultValues()`, `fromSelect(q | d => q)`; each replaces the previous source.
- `onConflict(f: (c: ConflictSpec) => ConflictSpec)`, `returning(f)`, `returningAll()`.
- `toAst()`, `compile()` — one statement; throw when the batch chunked. `compileAll()` — every chunk's `Compiled`, memoised.
- Options: `signal`, `timeout`, `outsideTransaction`, `withExecMode`.
- Terminals: `execute()` (one `Runner.run` or `Runner.runChunked`), `executeTakeFirst()`, `prepare()` (throws for a chunked batch), `explain()`, `toSQL()`. No `stream()`.
- `ConflictSpec` — upsert spec: `columns(f)`, `expressions(f)`, `constraint(name)`, `where(f)` (arbiter index predicate), `doNothing()`, `doUpdate((t, excluded) => patch)`, `whereUpdate((t, excluded) => pred)`.
- `setItemsOf(meta, patch, where)` — patch record → `SetItem[]` in table order; throws on `__proto__` or unknown keys.
- `makeInsert(ctx, ctes, h, alias, owner)` — the initial builder; throws for a non-table target. Re-exports types `ProjectionItem`, `Scope`.

## Flow
1. `makeInsert` refuses views/CTEs/derived sources via `writeTargetMessage` and scopes the target alias (`packages/pg-prime/src/query/insert.ts:830`).
2. `values`/`valuesMany` → `#withRows`: `#keysFor` checks every row sets exactly row 0's keys (`packages/pg-prime/src/query/insert.ts:520`).
3. `#withClientDefaults` calls each `.$default()` factory once per row where the key is absent or `undefined`, at call time (`packages/pg-prime/src/query/insert.ts:194`).
4. `#columnsByKey` orders columns by table declaration and rejects unknown keys; `castFirstRow` is set only for `valuesMany` with more than one row (`packages/pg-prime/src/query/insert.ts:575`, `:177`).
5. `fromSelect` resolves a callback against `owner`, peels the sub-select's `WITH` onto the insert (`mergeCtes`, by node identity), and orders columns by the projection (`packages/pg-prime/src/query/insert.ts:227`).
6. `#statements` splits rows into `chunkSize` chunks and builds each with `#valuesSource` or `#unnestSource` per `#strategy` (`packages/pg-prime/src/query/insert.ts:407`).
7. `#strategy`: an array column forces `values` (explicit `unnest` throws); else `auto` picks `unnest` when `rows × columns > UNNEST_CELLS` (`packages/pg-prime/src/query/insert.ts:389`).
8. `#valuesSource` builds `rows × columns` nodes inside `inInternalNodes`; `#unnestSource` sends one `::type[]`-cast array param per column (`packages/pg-prime/src/query/insert.ts:460`, `:486`).
9. `execute` runs one statement directly, or all chunks through `runner.runChunked` (one transaction unless already in one) (`packages/pg-prime/src/query/insert.ts:324`).
10. `onConflict` hands the callback a `ConflictSpec` with the target scope and an `excluded` ref scope built from the same handle (`packages/pg-prime/src/query/insert.ts:240`).

## Gotchas
- A row missing a key is an error, never NULL or `DEFAULT`; `.$default()` columns are added after the rectangularity check (`packages/pg-prime/src/query/insert.ts:510`).
- `values`/`valuesMany` column order is the table's, so key order in the literal does not change the SQL; `fromSelect` column order is the projection's, because `INSERT … SELECT` is positional (`packages/pg-prime/src/query/insert.ts:552`).
- A chunked batch has no single AST: `toAst`, `compile`, `toSQL`, `explain` and `prepare` throw; use `compileAll()` or `execute()` (`packages/pg-prime/src/query/insert.ts:282`).
- `valuesMany([])` throws; `chunkSize` must be a positive integer and `strategy` one of `auto`/`values`/`unnest` (`packages/pg-prime/src/query/insert.ts:600`).
- `nest(...)` groups and relation projections are refused as values; any other non-AST, non-fragment value becomes a bind (`packages/pg-prime/src/query/insert.ts:115`).
- `ConflictSpec.where` is the partial-index predicate and needs `columns`/`expressions` first; `whereUpdate` is `DO UPDATE … WHERE` and needs `doUpdate` first (`packages/pg-prime/src/query/insert.ts:754`, `:777`).
- `ConflictSpec.columns` accepts only refs identical to the target scope's own (`packages/pg-prime/src/query/insert.ts:721`).
- `.$onUpdate()` is not applied to `doUpdate` (that lives in `update.ts`).
- Two different CTE nodes with one name across insert and sub-select throw (`packages/pg-prime/src/query/insert.ts:652`).
- `makeInsert` does not run `checkAlias` on the alias, unlike the other builders.

## Tests
- `packages/pg-prime/test/query/insert.test.ts` — Appendix A goldens, table column order, upsert clauses, both strategies and the `auto` threshold, 5 000/5 001 chunking, wire ceiling, chunk transactions on the mock driver, `fromSelect` order, `.$default()`.
- `packages/pg-prime/test/query/guards.test.ts` — bulk option checks, array column vs `unnest`, markers as values, `onConflict().columns()` identity, `toString`/`__proto__` keys.
- `packages/pg-prime/test/query/executor.test.ts` — `executeTakeFirst` over a chunked insert; `packages/pg-prime/test/query/prepared.test.ts` — chunked insert refuses `prepare`.
- `packages/pg-prime/test/compile/insert.test.ts` — insert emission.
- Live: `packages/pg-prime/test/live-query/writes.test.ts`, `bulk-strategy.test.ts`.
- Run: `pnpm --filter pg-prime exec vitest run test/query/insert.test.ts`; live: `pnpm --filter pg-prime exec vitest run test/live-query/writes.test.ts test/live-query/bulk-strategy.test.ts`.
