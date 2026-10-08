# packages/pg-prime/src/query/relations.ts

## Purpose
Builds the relation accessors (`u.posts.many(...)`, `.count()`, `.some(...)`, ...) that appear next to column refs in a builder scope. Each accessor turns a `ResolvedRelation` from `src/schema/relations.ts` into a nested-plan marker (`many`/`one`/`all`), a shared scalar subquery (aggregates), or an `EXISTS` node.
Caller: `src/query/scope.ts` (`mergeAccessors`, `packages/pg-prime/src/query/scope.ts:312`). Callees: `resolveRelations` (`src/schema/`), AST constructors in `src/compile/nodes.ts`, `codecOf` (`src/compile/hoist.ts`), `fn` (`src/query/fn.ts`), `compileProjection`/`makeNested`/`toExprNode`/`toOrderItems` (`src/query/projection.ts`), `refsOf` (`src/query/ref.ts`), `metaOf` (`src/query/meta.ts`).

## Public API
- `RelOpts` — `{ variant?: 'json' | 'jsonb', strategy?: 'lateral' | 'subquery' }`, the per-projection options for `many`/`one`/`all`.
- `accessorsFor(ctx, tableKey, refs, ancestors)` — accessor objects per relation declared on `tableKey`, or `undefined` when the ctx has no tables/rels or the table declares none.
- `mergeAccessors(ctx, tableKey, alias, refs, ancestors)` — `refs` itself when there are no accessors, else a frozen `{ ...refs, ...accessors }`.
- Accessor members (returned objects, not exports): `many(f?, opts?)`, `one(f?, opts?)`, `all(opts?)`, `count()`, `sum(f)`, `avg(f)`, `min(f)`, `max(f)`, `exists()`, `some(f?)`, `none(f?)`, `every(f)`.

## Flow
1. `accessorsFor` resolves relations for the table key and builds one `accessor` per relation name (`packages/pg-prime/src/query/relations.ts:524`).
2. Each accessor builds its `Correlated` lazily on first use and memoises it (`packages/pg-prime/src/query/relations.ts:448`).
3. `correlate` looks up the target table, picks a child alias that no ancestor uses, and builds child refs (`packages/pg-prime/src/query/relations.ts:155`).
4. Through a junction: the junction is an inner join inside the sub-select and the correlation is junction-to-parent; otherwise target-to-parent column pairs, ANDed (`packages/pg-prime/src/query/relations.ts:170`).
5. The child scope gets its own accessors via `mergeAccessors`, so relations nest (`packages/pg-prime/src/query/relations.ts:205`).
6. On every accessor call, `declaredWhere` re-runs the declaration's `where` against the child scope and ANDs it in (`packages/pg-prime/src/query/relations.ts:226`, `packages/pg-prime/src/query/relations.ts:450`).
7. `many`/`one` run the caller's callback on an immutable `RelSub` (`where`, `orderBy`, `limit`, `offset`, `select`); it must return a `RelSub` (`packages/pg-prime/src/query/relations.ts:295`).
8. `nestedOf` builds the `SelectNode` (default projection = every child column; declared `orderBy` unless the caller ordered) and wraps it with `makeNested` (`packages/pg-prime/src/query/relations.ts:328`).
9. Aggregates go through `scalarOf`, a scalar subquery marked shareable so identical ones hoist into one lateral (`packages/pg-prime/src/query/relations.ts:379`).
10. `exists`/`some`/`none`/`every` go through `existsOf` with `select 1` (`packages/pg-prime/src/query/relations.ts:394`).

## Gotchas
- `all()` uses the relation's own kind (`many` or `one`); `many()`/`one()` force the kind regardless of the declaration (`packages/pg-prime/src/query/relations.ts:461`).
- `required` is only passed for `one` plans (`packages/pg-prime/src/query/relations.ts:361`).
- `limit`/`offset` on the sub-query are `int4` binds inside the lateral, so the limit is per parent (`packages/pg-prime/src/query/relations.ts:273`).
- A caller `orderBy` replaces the declared `orderBy` entirely; they are not merged (`packages/pg-prime/src/query/relations.ts:342`).
- Only an ancestor alias forces a suffix (`users` inside `users` becomes `users2`); shadowing a sibling alias is allowed (`packages/pg-prime/src/query/relations.ts:119`).
- `sum` is `coalesce(sum(x), 0)` with the zero typed by the aggregate's result codec; `avg`/`min`/`max` are not coalesced and are NULL over an empty relation (`packages/pg-prime/src/query/relations.ts:471`).
- `every(p)` is `NOT EXISTS (... AND p IS NOT TRUE)`: NULL counts as not satisfying, and an empty relation is true (`packages/pg-prime/src/query/relations.ts:499`).
- A relation that points at a table missing from `ctx.tables` throws `BuilderError` naming it (`packages/pg-prime/src/query/relations.ts:100`).
- `some`/`none` call `corr()` twice, so the declared `where` lambda runs twice per call (`packages/pg-prime/src/query/relations.ts:493`).
- The `alias` parameter of `mergeAccessors` is unused (`packages/pg-prime/src/query/relations.ts:546`).

## Tests
- Unit: `packages/pg-prime/test/query/relations.test.ts` — golden SQL of the feed query, per-parent `LIMIT` numbering, aggregate sharing, `some`/`none`/`every`/`exists`, m2m junctions, composite keys, `all`/`one`/`strategy`/`variant`, declared defaults, child aliases, `avg`/`min`/`max`, declared `where` evaluated per use.
- Live: `packages/pg-prime/test/live-query/relations.test.ts` — per-parent pagination against a `row_number()` oracle, empty relations as `[]`, deep decoding, relations in `RETURNING`, sibling-alias shadowing, `distinct` over relation columns, aggregate OIDs.
- Type-level cardinality (`many` → `T[]`, `maybeOne` → `T | null`): `packages/pg-prime/test/query/typecheck.test.ts`.
- Run: `pnpm --filter pg-prime exec vitest run test/query/relations.test.ts`; `... test/live-query/relations.test.ts` (live).
