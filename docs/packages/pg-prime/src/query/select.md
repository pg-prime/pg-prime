# packages/pg-prime/src/query/select.ts

## Purpose
The runtime SELECT builder and the set-operation builder. One class (`SelectBuilder`) implements the `Query`, `GroupedQuery` and `SetQuery` stage interfaces declared in `types.ts`; the type layer decides which methods are reachable. Created by `ExecutorImpl.from` / `fromCte` / `fromRaw` in `cte.ts`; `rebuildScope`, `checkAlias` and `derivedRuntime` are reused by `update.ts`, `delete.ts` and `cte.ts`. Calls `scope.ts` (sources, scopes, projections), `window.ts`, `terminals.ts`, `prepared.ts`, `nominal.ts` and `compile` in `src/compile/compiler.ts`.

## Public API
- `SelectBuilder` — immutable select over a frozen `SelectState`; every method returns a new builder.
- Projection: `select(f)` (replaces), `selectAll(alias)`, `distinct()`, `distinctOn(f)`.
- Clauses: `where(f)` / `having(f)` (AND on repeat), `groupBy(f)` (replaces), `orderBy(f)` (appends), `limit(n)` / `offset(n)` (`int4` binds), `window(name, f)`, `forUpdate(opts?)`.
- Joins: `innerJoin` / `leftJoin` / `rightJoin` / `fullJoin(h, alias?|on, on?)`, `crossJoin(h, alias?)`, `innerJoinLateral` / `leftJoinLateral(sub, alias, on?)`.
- Composition: `$call(f)`, `$if(cond, f)`; set ops `union`, `unionAll`, `intersect`, `intersectAll`, `except`, `exceptAll` → `SetOpBuilder`.
- Shaping: `asScalar()` (scalar subquery expression), `as(name)` (derived-table handle), `toAst()`, `compile()` (memoised per instance).
- Options: `signal`, `timeout(ms)`, `outsideTransaction()`, `withExecMode(mode)` — accumulate `QueryRunOptions`.
- Terminals: `execute()`, `executeTakeFirst()`, `prepare(name?, opts?)`, `stream(opts?)`, `explain(opts?)`, `toSQL()`.
- `SetOpBuilder` — `orderBy` (over output columns), `limit`, `offset`, the six set ops (chain left-nested), `as`, `toAst`, `compile`, the four option setters and the same terminals.
- `LockOpts` — `{ strength?, of?, wait? }` for `forUpdate`.
- `rebuildScope(sources, ctx)` — every alias's scope derived against the full alias list.
- `derivedRuntime(name)` — synthetic `TableRuntime` for derived/CTE handles.
- `checkAlias(alias)` — returns `alias`; throws for compiler-reserved `_r<digits>`.
- `makeSelect(ctx, ctes, h, alias)` — the initial builder (alias defaults to the source name). Also re-exports type `OrderItem`.

## Flow
1. `makeSelect` resolves the source, checks the alias, and builds the first scope via `rebuildScope` (`packages/pg-prime/src/query/select.ts:821`).
2. Each callback method runs its lambda immediately against `this.s.scope` (`call`, `packages/pg-prime/src/query/select.ts:123`) and stores coerced nodes in a new state.
3. `select` compiles the projection with the current outer-joined alias set from `#outerJoined` (`packages/pg-prime/src/query/select.ts:175`).
4. `#join` resolves source, alias and ON; `#widen` refuses a taken alias, adds the source and rebuilds every scope; ON runs against the widened scope (`packages/pg-prime/src/query/select.ts:383`, `:427`).
5. `#lateral` builds the sub-query against the current (pre-widen) scope, registers it as a derived handle, then widens; ON defaults to none (`ON TRUE` at emit) (`packages/pg-prime/src/query/select.ts:352`).
6. `toAst` refuses a missing projection, then builds a compacted `SelectNode`, memoised in `#ast` (`packages/pg-prime/src/query/select.ts:510`).
7. `compile` memoises `compileAst(toAst())` in `#compiled`; `execute` passes it with `this.s.run` to `Runner.run` (`packages/pg-prime/src/query/select.ts:536`, `:575`).
8. `#setop` turns this query into the left branch and wraps it in a `SetOpBuilder`; `makeSetOp` derives `resultRefs` from the left-most branch's fields and carries this builder's run options (`packages/pg-prime/src/query/select.ts:465`, `:796`).

## Gotchas
- There is no implicit `select *`: `toAst`, `execute`, `prepare`, `stream` and every set op throw without `.select()`/`.selectAll()` (`packages/pg-prime/src/query/select.ts:607`).
- `rightJoin`/`fullJoin` after `.select()` throw: the projection's types and `nestNullable` witnesses are already fixed (`packages/pg-prime/src/query/select.ts:394`).
- `#outerJoined` replays joins in order when right/full joins are present: a right join nulls every alias bound before it; a full join also nulls its own (`packages/pg-prime/src/query/select.ts:191`).
- Every scope is rebuilt on each join so relation-accessor child aliases avoid all bound aliases; otherwise a later join could make a correlation compare a column with itself (`packages/pg-prime/src/query/select.ts:417`).
- `forUpdate` validates `strength`/`wait` with `oneOf` at runtime; `of` is not checked at runtime (only by the `LockOpts` type in `types.ts`) (`packages/pg-prime/src/query/select.ts:295`).
- `asScalar` requires exactly one projected column that is not a `nest` group or relation projection (`packages/pg-prime/src/query/select.ts:481`).
- `SetOpBuilder` chaining resets `orderBy`/`limit`/`offset`; any already set move into the (parenthesised) left branch (`packages/pg-prime/src/query/select.ts:718`).
- Set-op run options come from the left-most builder only; the right branch's options are dropped (`packages/pg-prime/src/query/select.ts:811`).
- Set-op `orderBy` sees output columns by name (unqualified), not table scopes (`packages/pg-prime/src/query/select.ts:686`).
- `toSQL()` does not throw on unfilled placeholders or a missing executor, but does throw without a projection.
- A branch keeps its own `WITH`; CTE lists are not hoisted across set-op branches (`packages/pg-prime/src/query/select.ts:135`).

## Tests
- `packages/pg-prime/test/query/select.test.ts` — projection shape, `$all`/`omit`, nest/nestNullable witnesses, right/full/cross/lateral joins, immutability and compile memo, `forUpdate`, distinct on.
- `packages/pg-prime/test/query/setop.test.ts` — six set ops, output-column ORDER BY, left-most result shape, parenthesised branches, branches with `WITH`, jsonb under distinct set ops.
- `packages/pg-prime/test/query/guards.test.ts` — keyword guards, unprojected compile, `asScalar` on a group, alias collisions, `_rN` aliases.
- `packages/pg-prime/test/query/window.test.ts`, `executor.test.ts`, `stream.test.ts`, `explain.test.ts`, `prepared.test.ts` cover the terminals through select builders.
- Builder-level options (`timeout`, `withExecMode`, set op keeping the left branch's option): `packages/pg-prime/test/session/session.test.ts:1933`.
- Live: `packages/pg-prime/test/live-query/select.test.ts`, `setop-window.test.ts`, `relations.test.ts`.
- Run: `pnpm --filter pg-prime exec vitest run test/query/select.test.ts test/query/setop.test.ts`; live: `pnpm --filter pg-prime exec vitest run test/live-query/select.test.ts`.
- Uncovered: no test asserts that the right branch's run options are dropped.
