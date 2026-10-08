# packages/pg-prime/src/compile/ast.ts

## Purpose
Type-only declaration of the immutable query AST: a discriminated union tagged by `k`, made of frozen plain objects with no classes or methods. Nodes are built by `packages/pg-prime/src/compile/nodes.ts`, rewritten by `hoist.ts`, and read by `compiler.ts`; the types are imported by the query layer (`packages/pg-prime/src/query/*.ts`), `packages/pg-prime/src/sql/fragment.ts`, `packages/pg-prime/src/schema/ddl.ts` (`RawNode`) and `packages/pg-prime/src/session/copy.ts` (`ColumnMeta`).

## Public API
- `TableMeta`, `ColumnMeta`, `QualifiedName` — schema seam; `qualified` / `quoted` are pre-quoted identifiers so the emitter never quotes a schema name.
- `Statement` — `SelectNode | InsertNode | UpdateNode | DeleteNode | SetOpNode`, the inputs `compile()` accepts.
- `SelectNode` — `with`, `distinct { on? }`, ordered `projection`, `from`, `joins`, `where`, `groupBy`, `having`, `windows`, `orderBy`, `limit`, `offset`, `locking`.
- `InsertNode`, `InsertSource` (`values` | `unnest` | `select` | `defaults`), `OnConflictNode` — insert with optional `castFirstRow`, upsert target/action, `returning`.
- `UpdateNode`, `DeleteNode`, `SetItem` — target table, `set` list, `from` / `using` items, `where`, `returning`.
- `SetOpNode`, `CteNode` — `union`/`intersect`/`except` (± `all`) with whole-result `orderBy`/`limit`/`offset`; CTE with `recursive`, `materialized`, column list.
- `FromItem` — `TableRefNode`, `SubqueryNode` (`lateral`), `ValuesNode`, `FuncNode`, `CteRefNode`, `RawFromNode`; each carries a pre-quoted `qAlias`.
- `JoinNode` — `inner | left | right | full | cross`; `on: undefined` means `on true`.
- `Expr` — union of 22 expression kinds: `col`, `param`, `ph`, `lit`, `bin`, `bool`, `un`, `between`, `in`, `is`, `fn`, `agg`, `over`, `case`, `cast`, `row`, `array`, `sq`, `exists`, `jsonBuild`, `jsonAgg`, `raw`.
- `ColumnNode`, `ParamNode`, `PlaceholderNode`, `LiteralNode` — leaves; `ParamNode` is always emitted as `$n`, `LiteralNode` holds only `number | bigint | boolean | null`.
- `BinaryOp` — the closed list of infix operator tokens the emitter may splice (comparison, text, array/jsonb/range, pgvector).
- `BinaryNode`, `BoolNode`, `UnaryNode`, `IsNode`, `InNode`, `BetweenNode` — predicates and operators; `BoolNode` is n-ary `and`/`or`.
- `FuncCallNode`, `AggNode`, `OverNode`, `WindowDef`, `NamedWindow`, `FrameBound` — calls, aggregates (`distinct`, `orderBy`, `filter`, `star`), window functions.
- `CaseNode`, `CastNode`, `RowNode`, `ArrayNode` — `case`, `::type`, `row(...)`, `array[...]` (`elemCodec` is the element codec).
- `SubqueryExprNode`, `ExistsNode` — scalar subquery (optional `hoist` marker) and `[not] exists`.
- `JsonBuildNode`, `JsonAggNode` — `json[b]_build_object` / `json[b]_agg`, the latter with `emptyAs: '[]'` for `coalesce`.
- `RawNode`, `RawPart`, `IdentPart`, `RawSpliceNode` — the `sql` fragment: interleaved `chunks`/`parts`, `ident` holes, `unsafeRaw` splices.
- `ProjectionItem`, `OrderItem` — `{ key, expr, nested?, group? }` and `{ e, dir, nulls? }`.
- `NestedPlan` — a relation projection (`kind: 'many' | 'one'`, `query`, `alias?`, `variant?`, `required?`, `strategy?`).
- `GroupPlan` — a `nest({...})` group (`items`, `nullable`, `sentinel?`, `witnesses?`).

## Flow
1. The query layer builds nodes through the constructors in `packages/pg-prime/src/compile/nodes.ts`, which freeze each node.
2. `NestedPlan` and `GroupPlan` items and `SubqueryExprNode.hoist` exist only before planning; `planSelect` / `planReturning` in `hoist.ts` replace them with flat projections and lateral joins.
3. `compile()` in `compiler.ts` switches on `k` to emit SQL; `contract.ts` reuses `QualifiedName` for `CompiledMeta`.

## Gotchas
- Optional members are declared `?: T | undefined` because the repo enables `exactOptionalPropertyTypes` and `hoist.ts` builds nodes by spreading (`packages/pg-prime/src/compile/ast.ts:12`).
- The `[spike]` markers and the header note that unmarked kinds are rejected are stale: `emitExpr` has a branch for every `Expr` kind (`packages/pg-prime/src/compile/compiler.ts:380`).
- `BinaryOp` is closed; adding an operator means adding a union member here (`packages/pg-prime/src/compile/ast.ts:302`); the operator table in the design doc is regenerated from the `OPS` manifest (`packages/pg-prime/src/query/ops.manifest.ts`) by `packages/pg-prime/test/query/ops-table.test.ts`.
- `RawNode` invariant: `chunks.length === parts.length + 1` (`packages/pg-prime/src/compile/ast.ts:540`); `raw()` checks it; for a hand-built node the emitter only throws on a missing part (`packages/pg-prime/src/compile/compiler.ts:731`).
- `GroupPlan.sentinel` and `witnesses` index the group's `items`, not the result row; `hoist.ts` translates them and drops non-column members (`packages/pg-prime/src/compile/hoist.ts:1058`).
- `NestedPlan.alias` may be omitted; `planSelect` then assigns `_r0`, `_r1`, … left to right (`packages/pg-prime/src/compile/hoist.ts:864`).
- `SubqueryExprNode.hoist` is set only by `packages/pg-prime/src/query/relations.ts`; it may change the plan, never the result (`packages/pg-prime/src/compile/ast.ts:499`).
- `LiteralNode` never holds a string; strings in a query position are parameters (`packages/pg-prime/src/compile/ast.ts:282`).

## Tests
- No spec targets this file directly (types only). Node shapes are exercised by every suite under `packages/pg-prime/test/compile/` and by `packages/pg-prime/test/query/ast-equivalence.test.ts`, which checks builder output `toStrictEqual` to hand-built trees.
- Run: `pnpm --filter pg-prime exec vitest run test/compile test/query/ast-equivalence.test.ts`.
- Uncovered: none specific; type-level correctness is enforced by `tsc`, not by a spec.
