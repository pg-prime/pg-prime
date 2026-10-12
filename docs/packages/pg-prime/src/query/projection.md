# packages/pg-prime/src/query/projection.ts

## Purpose
The one place a user value becomes an AST expression, plus the two projection markers the planner expands: `nest`/`nestNullable` groups and relation projections. Re-exported through `scope.ts` to the builders (`select.ts`, `insert.ts`, `update.ts`, `delete.ts`, `window.ts`); imported directly by `relations.ts` (to avoid a cycle through `scope.ts`), `fn.ts` (`toExprNode`), `insert.ts` (`isGroup`, `isNested`) and `src/index.ts` (`nest`, `nestNullable`, `omit`). Builds nodes via `src/compile/nodes.ts`; `src/compile/hoist.ts` consumes the markers.

## Public API
- `nest(p)` — groups columns into a nested result object; zero SQL cost.
- `nestNullable(p)` — as `nest`, but the whole object is `null` when its left-joined source missed; type is always `| null`.
- `omit(r, ...keys)` — shallow copy of a record without `keys` (used as `omit(t.u.$all, 'passwordHash')`).
- `isGroup(v)`, `isNested(v)` — nominal tests for the two markers.
- `makeNested(plan)` — wraps a `NestedPlan` as a projectable marker (called by `relations.ts`).
- `assertSafeKey(key, where)` — returns `key`; throws `BuilderError` for `__proto__`.
- `toExprNode(v, where)` — AST node or `sql` fragment → expression; throws for a relation marker or any bare value.
- `NO_LEFT_JOINS` — frozen empty set, for statements with no outer join (RETURNING, relation inner selects).
- `projectionItem(key, v, leftJoined)` — one `ProjectionItem` (group, nested, or expression).
- `compileProjection(p, leftJoined)` — projection record → frozen item list in key order.
- `toOrderItems(v)` — value or array → `OrderItem[]`; a bare expression means `asc`.
- `toExprList(v, where)` — value or array → frozen expression list.
- `outputColumn(key, codec)` — an unqualified output-column ref for `ORDER BY` on a set-op result.
- `registryOr(r)` — `r` or `defaultRegistry()`.

## Flow
1. `nest`/`nestNullable` build a `GroupMarker` eagerly with `NO_LEFT_JOINS`, so malformed members throw at the call site, and register it in `GROUPS` (`packages/pg-prime/src/query/projection.ts:175`).
2. `compileProjection` walks keys inside `inInternalNodes`, calling `projectionItem` per key (`packages/pg-prime/src/query/projection.ts:328`).
3. `projectionItem` checks the key, then: group → reuse the eager plan if nothing is left-joined, else rebuild with the join set; nested → `nestedItem`; else `toExprNode` (`packages/pg-prime/src/query/projection.ts:292`).
4. `buildGroupPlan` recurses into members, records the first NOT NULL scalar ref as `sentinel`, and for nullable groups computes `witnesses` (`packages/pg-prime/src/query/projection.ts:142`).
5. `groupWitnesses` picks left-joined NOT NULL members, else every left-joined member, else `[]` (never null) (`packages/pg-prime/src/query/projection.ts:127`).

## Gotchas
- Markers are nominal (`WeakSet`), never structural, so parsed JSON cannot impersonate one (`packages/pg-prime/src/query/projection.ts:14`).
- No `param()` fallback: a bare JS value in a projection throws; use `val(v, codec)` or `` sql`…`.as(codec) `` (`packages/pg-prime/src/query/projection.ts:258`).
- A NOT NULL array column (`arrayDim > 0`) is not a nullness witness (`packages/pg-prime/src/query/projection.ts:103`).
- Witness choice depends on the join set known when `.select()` runs; `select.ts` refuses right/full joins after `.select()` so the set cannot grow retroactively. The comment at `packages/pg-prime/src/query/projection.ts:310` still says only inner/left joins exist.
- `omit` copies; `$all` is a shared frozen record and must not be mutated (`packages/pg-prime/src/query/projection.ts:209`).
- `compileProjection` skips per-item node registration (`inInternalNodes`); only the items, not the expressions inside them, are unregistered (`packages/pg-prime/src/query/projection.ts:322`).
- `registryOr` has no caller in `src/`.

## Tests
- `packages/pg-prime/test/query/select.test.ts` — `nest` byte-identical SQL, `nestNullable` witnesses (driving-side NOT NULL, two left-joined aliases, fallback), `$all`/`omit`, bare-value refusal.
- `packages/pg-prime/test/query/guards.test.ts` — `__proto__` keys, markers refused as insert values.
- Live: `packages/pg-prime/test/live-query/select.test.ts` (nest/nestNullable against a server).
- Fuzz generator uses `nest` (`packages/pg-prime/test/fuzz/builder-generator.ts:44`).
- Run: `pnpm --filter pg-prime exec vitest run test/query/select.test.ts test/query/guards.test.ts`.
