# packages/pg-prime/src/query/types.ts

## Purpose
The query builder's type engine: the declared interfaces of every builder stage (`Query`,
`GroupedQuery`, `SetQuery`, the write builders), the handle types (`Queryable`, `Db`, `Tx`,
`Session`), the scope/projection/relation algebra, plus a re-export hub for the operators, `sql`,
`nest`, `over`, `pgPrime` and session/executor types. Almost entirely types; the runtime lives in
`packages/pg-prime/src/query/{select,insert,update,delete,cte,scope,window,run}.ts`. Imported by
`packages/pg-prime/src/index.ts` (explicit name lists), `query/{ops,fn,ops.types,projection,prepared,
run,window}.ts`, and most tests under `packages/pg-prime/test/query/` as `import * as q`.

## Public API
- Schema access: `TableAt<H>`, `RefsAt<H>`, `SelectAt<H>`, `ColsAtH<H>`, `RelsAtH<H>` — indexed
  access into a handle's table and relation registry, never a conditional.
- Expressions: `Expr<T, P = string>` (`[OUT]`, `[SRC]`, `[META].pg`; extends `Projectable`),
  `ExprOf<T>` (only `[OUT]`), `Operand<T>` (`T | ExprOf<T>`).
- Projection: `Projection` (`Record<string, Projectable>`), `Project<P>` (one indexed access per key),
  `ProjectPreJoin<P>` (pre-left-join type per key; used by `nestNullable`).
- Scope: `Sources`, `RefsOf<S>`, `ScopeOf<S, N>` (refs + `$all` + relation accessors per alias;
  aliases in `N` get `NullRef`s), `NullRef<R>`, `NullRefsAt<H>`, `NullRow<T>`, `AllRefs<R>` (`$all`).
- Relations: `RelPickers<H>`, `RelAccessor` (`ManyRel` for `many`, else `OneRel`), `RelAggs`
  (`count`/`sum`/`avg`/`min`/`max`/`exists`/`some`/`none`/`every`), `RelOpts`, `SubQuery`, `SubScope`, `RelsNs`.
- GROUP BY guard: `Grouping`, `GroupKeysOf<G>` (`"alias.column"` strings), `PkOf<H>` (per-column
  `pk`), `GroupedScope<S, N, G>` (row-set relation accessors return a branded error unless the PK is grouped).
- Set operations: `RowSource<O>`, `SELECT_SOURCE` (runtime `Symbol.for('pg-prime.SELECT_SOURCE')`),
  `SelectSource<O>`, `SetOps`, `SetResult`, `SetMismatch`, `SetQuery<O, B>`, `ResultRefs<O>`.
- Select stages: `Query<S, O, N>` (select, where, joins incl. lateral, groupBy, window, forUpdate,
  `$call`/`$if`, terminals, option setters), `GroupedQuery<S, O, N, G>`, `IfResult`.
- Row helpers: `RowOf<Q>`, `InferResult<Q>`, `AnyQuery`.
- CTEs: `CteColMeta`, `CteTable`, `CteSchema`, `CteHandle<N, O>` (a synthetic one-table schema),
  `CteExecutor<C>`, `WithOpts`, `RecursiveOpts`.
- Entry points: `Executor` (`from`, `with`, `withRecursive`, `fromRaw`, `insertInto`, `update`,
  `deleteFrom`, `sql`), `FromRawOpts`, `RawShape<C>`, `LockOpts<A>`.
- Handles: `Queryable<Sc>` (`h`, `kind`, `run`, `explain`, `stream`, `streamBatches`, `notify`,
  `withOptions`, `refreshMaterializedView`, `copyFrom`/`copyTo`), `Db`, `Tx`, `Session`, `SchemaExecutor` (deprecated alias).
- Writes: `InsertQuery<H, O, C>`, `InsertPatch<T>`, `BulkOpts`, `ConflictBuilder<H>`,
  `UpdateQuery<H, O, V>`, `SetPatch<T>`, `ValueRefs<C>`, `FromValuesOpts`, `DeleteQuery<H, O, S>`; update and
  delete carry `executeRowCount(): Promise<number>` and `ifVersion(f, expected: NoInfer<NonNullable<T>>)`.
- Operator re-exports: `sql` and fragment types; all of `./ops.js` and `./fn.js`; operand types from
  `./ops.types.js`; `OPS`, `CONFIRMABLE`, `OpClass`, `OpSpec` (`packages/pg-prime/src/query/types.ts:1705`).
- Runtime re-exports: `nest`, `nestNullable`, `omit`, `over`, `pgPrime`, `compileOnly`, `statementStats`,
  `placeholder`, describe-cache helpers, `CodecMismatchError`, session/executor/prepared/raw/window types.

## Flow
1. `Executor.from(h, alias?)` yields `Query<Record<A, H>, unknown>` (`packages/pg-prime/src/query/types.ts:1050`).
2. Callbacks receive `ScopeOf<S, N>` (`:288`): refs from the table's precomputed `[REFS]`, `$all`,
   and relation accessors.
3. `innerJoin`/`crossJoin` widen `S`; `leftJoin` adds the alias to `N`, `rightJoin` adds every
   existing alias, `fullJoin` both (`packages/pg-prime/src/query/types.ts:750`–`:806`).
4. `select(f)` sets `O = Project<P>` (`:712`); `selectAll(a)` reads `SelectAt`, wrapped in `NullRow` if `a ∈ N`.
5. `groupBy(f)` moves to `GroupedQuery` with `G = GroupKeysOf<…>`; `GroupGuard` (`:552`) swaps
   relation accessors for `BlockedRelPickers` unless the table's `PkOf` is grouped.
6. `union`/`intersect`/`except` resolve through `SetResult` (`:635`): non-SELECT, missing projection
   or column mismatch become an `OrmTypeError` in return position, else `SetQuery`.
7. `$if(boolean, f)` resolves through `IfResult` (`:931`): error if the branch drops a column.
8. `execute`/`executeTakeFirst`/`prepare`/`stream` are wrapped in `Selected` (`:916`), an
   `OrmTypeError` while `O` is `unknown`.
9. `RowOf<Q>` reads `[ROW]` (`:992`).
10. Writes: `insertInto`/`update`/`deleteFrom` return a `WriteToViewMsg` error for a `[READONLY]`
    handle (`:1094`), else the write builder; `returning` uses `SelfScope` (`:1491`).

## Gotchas
- `Query`, `GroupedQuery`, `SetQuery` and the write builders carry `[INV]: (o: O) => O`, making them
  invariant in `O`; reassigning `q = q.select(…)` to a differently typed variable is a compile error.
- Errors are return-position `OrmTypeError` sentinels, so an unused bad set-op or `$if` reports
  nothing; spell `OrmTypeError<…Msg>` inline, not via an alias (`packages/pg-prime/src/query/errors.ts`).
- `nestNullable` always widens to `| null`, even when nothing was outer-joined; use `nest` then.
- `PkOf` only sees per-column `pk`; a table-level composite `primaryKey(...)` yields `never`, which
  the guard treats as allowed (`packages/pg-prime/src/query/types.ts:516`).
- Grouping is keyed by table name in `[SRC]`, so in a self-join grouping `p.id` unlocks both aliases.
- The guard only checks a `.select` after `.groupBy`; one made before is not re-checked (`:743`).
- CTE and `fromRaw` columns carry `pg: any` (`packages/pg-prime/src/query/types.ts:1021`): operator
  gates check only the `[OUT]` shape there, not the PG class (pinned in `packages/pg-prime/test/query/types/cte.probe.ts:100`).
- `window(name)` and `over(e, name)` take bare `string`; an undeclared name throws `BuilderError` at runtime.
- `forUpdate({ of })` is typed to the scope's aliases (`LockOpts<keyof S & string>`, `packages/pg-prime/src/query/types.ts:741`).
- `valuesMany` rejects a heterogeneous batch at the type level via `SameColumns`
  (`packages/pg-prime/src/query/types.ts:1422`).
- `SELECT_SOURCE` is the only runtime value declared here; the public barrel exports it separately.
- `export *` re-exports `RANGE_ELEMENT_NAMES`; `packages/pg-prime/src/index.ts` deliberately omits it.
- `nest`/`nestNullable`/`omit` come from `./scope.js` here, but `index.ts` imports them from
  `./query/projection.js`.
- `dist/query/types.d.ts` size is gated by `largestDtsBytes` in `tools/budgets.json:19`; any growth fails CI.

## Tests
- Type probes: `packages/pg-prime/test/query/types/*.probe.ts` (select, join, left-join nullability,
  nest, relations, group-by guard, setop, if, call, invariance, cte, write, view, session, prepared,
  infer-result, ops, audit, all) and `packages/pg-prime/test/query/query.probe.ts`; checked by
  `pnpm --filter pg-prime typecheck` (`tsc -p test/query/tsconfig.json`), not by vitest.
- Barrel contents: `packages/pg-prime/test/query/index.test.ts`
  (`pnpm --filter pg-prime exec vitest run test/query/index.test.ts`).
- Runtime behaviour behind these types: `packages/pg-prime/test/query/*.test.ts` (unit) and
  `packages/pg-prime/test/live-query/*.test.ts` (PGlite); e.g.
  `pnpm --filter pg-prime exec vitest run test/query test/live-query`.
- Type-cost budgets: `pnpm bench:types` (repo root).
- Uncovered: no runtime check that the declared interfaces match the builder classes beyond what
  the probes and runtime suites exercise.
