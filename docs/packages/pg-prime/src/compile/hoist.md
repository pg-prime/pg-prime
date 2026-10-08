# packages/pg-prime/src/compile/hoist.ts

## Purpose
The planner: a pure AST → AST pre-pass that hoists nested relations into `LEFT JOIN LATERAL`s, shares duplicate relation aggregates (the compiler's only CSE), expands `nest({...})` groups, aligns `DISTINCT ON` with `ORDER BY`, and produces the positional decode plan. Called by `compiler.ts` (`planSelect`, `planReturning`, `exprDigest`, `comparesWholeRows`), `packages/pg-prime/src/query/scope.ts` and `cte.ts` (decode fields), and `ops.ts`, `fn.ts`, `relations.ts`, `select.ts` (`codecOf`); builds nodes via `nodes.ts`.

## Public API
- `codecOf(e: Expr): AnyCodec` — the codec describing an expression's result (`over` → its function's codec, predicates → `boolCodec`, `array` → array of `elemCodec`, unknown → `unknownCodec`).
- `jsonCast(e, codec): Expr` — wraps `e` in `::text` when `codec.jsonEncode === 'text'` (e.g. `int8`, `numeric`), else returns `e`.
- `exprDigest(e): string | null` — injective structural digest; `null` means unknown (raw fragment, volatile function, unrecognised node).
- `sameExpr(a, b): boolean` — reference-equal or equal non-null digests.
- `comparesWholeRows(n: SelectNode): boolean` — `distinct` without a non-empty `on` list.
- `PlannedSelect` — `{ node, fields, origins }`.
- `planSelect(node, rowEquality = false): PlannedSelect` — memoized planning of one select; `rowEquality` marks a set-op branch.
- `planReturning(items)` — expands groups and subquery-strategy relations in a RETURNING list; returns `{ items, fields, origins }`.

## Flow
1. `planSelect` picks a memo (`PLANNED` or `PLANNED_EQ`) by `rowEquality || comparesWholeRows(node)` and returns a hit (`packages/pg-prime/src/compile/hoist.ts:1207`).
2. On a miss it runs `planSelectUncached` inside `inInternalNodes`, then memoizes both the input and the planned node (`packages/pg-prime/src/compile/hoist.ts:1214`).
3. `rewriteClauses` walks projection, `distinct on`, `where`, `groupBy`, `having`, `orderBy` and `windows`, replacing each `sq` node with `hoist: true` by a shared lateral reference (`packages/pg-prime/src/compile/hoist.ts:680`).
4. `share` digests the subquery; a digest hit returns the existing `"_rN"."v"` column, otherwise it appends `left join lateral (…) as "_rN" on true` (`packages/pg-prime/src/compile/hoist.ts:489`).
5. `alignDistinctOn` prefixes `orderBy` with any missing `DISTINCT ON` keys (`asc`), keeping matched items and the caller's remainder (`packages/pg-prime/src/compile/hoist.ts:1173`).
6. Fast path: with no new laterals and no `nested`/`group` items, returns leaf `col` fields with `idx` = projection position (`packages/pg-prime/src/compile/hoist.ts:1234`).
7. Otherwise `flatten` walks the projection: a group recurses with a dotted alias prefix and adds one `group` field; a relation calls `hoistOne` and adds one `json` field; a plain item adds one `col` field (`packages/pg-prime/src/compile/hoist.ts:997`).
8. `hoistOne` plans the relation's own query in a fresh `Cse` scope, builds `json[b]_build_object` entries through `buildJsonEntries` (applying `jsonCast` per leaf), and recurses into nested relations (`packages/pg-prime/src/compile/hoist.ts:853`).
9. `one`: inner select projects `"o"` with `limit 1`; `many`: inner select projects `"o"` plus hidden order keys `k0…`, wrapped by `coalesce(json_agg("x"."o" order by "x"."kN"), '[]')` (`packages/pg-prime/src/compile/hoist.ts:888`, `packages/pg-prime/src/compile/hoist.ts:909`).
10. Laterals are appended after the select's own joins, aggregate laterals before relation laterals (`packages/pg-prime/src/compile/hoist.ts:1243`, `packages/pg-prime/src/compile/hoist.ts:1256`).

## Gotchas
- The planner assigns no `$n`; numbering stays one textual pass in the emitter, so a lateral's `limit` gets a lower `$n` than the parent's.
- Returns the same node by reference when nothing changes; `rewrite` and `rewriteAll` allocate only on the first changed element (`packages/pg-prime/src/compile/hoist.ts:627`).
- `rewrite` does not descend into another subquery's `query` or into `exists`, and `from`/`joins` are not walked (`packages/pg-prime/src/compile/hoist.ts:616`).
- A `sq` with `hoist: true` whose digest is `null` is still lifted, just never shared (`packages/pg-prime/src/compile/hoist.ts:490`).
- `VOLATILE` function names block sharing; `now()` is deliberately absent (`packages/pg-prime/src/compile/hoist.ts:159`). Digests refuse `with`, `locking`, `windows`, `values`/`func` FROM items, and nested/group items (`packages/pg-prime/src/compile/hoist.ts:441`).
- Lateral aliases `_r0`, `_r1`, … are allocated outer-before-inner from one `Seq` per plan; an explicit `NestedPlan.alias` wins (`packages/pg-prime/src/compile/hoist.ts:864`).
- Relation columns are `json` by default and `jsonb` when the statement compares whole rows (`distinct`, `union`, `intersect`, `except`); an explicit `variant: 'json'` there throws `BuilderError` (`packages/pg-prime/src/compile/hoist.ts:837`).
- A `one()` relation with its own `limit` or `offset` throws `UnsupportedNodeError` (`packages/pg-prime/src/compile/hoist.ts:880`).
- In RETURNING a relation needs `strategy: 'subquery'`, else `UnsupportedNodeError` (`packages/pg-prime/src/compile/hoist.ts:1024`).
- Dotted aliases over 63 UTF-8 bytes fall back to `_gN`; aliases are cosmetic since decoding is positional (`packages/pg-prime/src/compile/hoist.ts:978`).
- `origins` is indexed by row position; only schema columns and `.as(codec)` fragments get one (`packages/pg-prime/src/compile/hoist.ts:1118`).

## Tests
- `packages/pg-prime/test/compile/nested.test.ts` — lateral golden SQL, `$n` order, decode shape, `::text` casts, `[]` coalesce, nesting depth, `jsonCast`, `planSelect` identity.
- `packages/pg-prime/test/compile/cse.test.ts`, `cse-collision.test.ts` — what is and is not shared, digest injectivity.
- `packages/pg-prime/test/compile/plan-guards.test.ts` — `one()` limit/offset refusal, DISTINCT ON rewrite, `_gN` alias fallback.
- `packages/pg-prime/test/query/select.test.ts` ("distinct on leads the ORDER BY") — `alignDistinctOn` cases including partial matches.
- `packages/pg-prime/test/query/relations.test.ts` — builder-level relations, shared aggregates, RETURNING, jsonb under distinct; `packages/pg-prime/test/live-query/relations.test.ts`, `select.test.ts`, `setop-window.test.ts` run the same against PGlite.
- Run: `pnpm --filter pg-prime exec vitest run test/compile test/query/relations.test.ts test/query/select.test.ts`; live: `pnpm --filter pg-prime exec vitest run test/live-query`.
- `codecOf` is checked against server-reported OIDs in `packages/pg-prime/test/live-query/ops.test.ts`. Uncovered: `sameExpr` has no direct unit test.
