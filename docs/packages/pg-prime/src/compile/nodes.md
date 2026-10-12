# packages/pg-prime/src/compile/nodes.ts

## Purpose
Frozen AST node constructors plus the nominal node registry that decides whether a value is SQL or data. Called by the query layer (`packages/pg-prime/src/query/*.ts`), the `sql` tag (`packages/pg-prime/src/sql/fragment.ts`), and the planner (`hoist.ts`); builds the shapes declared in `ast.ts` and uses `quoteIdentPart` from `packages/pg-prime/src/sql/ident.ts`.

## Public API
- `mkNode(n)` — freezes `n`, registers it in the `WeakSet` registry unless inside `inInternalNodes`, returns it.
- `inInternalNodes(f)` — runs `f` with registration suppressed (freezing still happens); returns `f()`.
- `isAstNode(v)` — true iff `v` was registered; nominal, never structural.
- `isRawPart(v)` — registered and of a kind allowed in a `sql` fragment part (an `Expr` kind, `ident`, `unsafeRaw`).
- `nodeKindOf(v)` — the node's `k`, or `'clause'`; for error messages only.
- `tableMeta(schema, name)`, `columnMeta(name, codec)` — schema seam with pre-quoted `qualified` / `quoted`.
- `table`, `subquery`, `rawFrom`, `join`, `leftJoinLateral`, `cteRef`, `valuesFrom`, `funcFrom` — FROM items and joins; each pre-quotes its alias.
- `col`, `param` (default `unknownCodec`), `placeholder`, `lit` (non-string literals, default `unknownCodec`).
- `bin(op, l, r, resultCodec = boolCodec)` and `eq`, `neq`, `lt`, `lte`, `gt`, `gte` — binary operators.
- `and`, `or`, `not`, `is`, `isNull`, `isNotNull`, `isTrue` — boolean connectives and `is` tests.
- `inList`, `inAny`, `inQuery` — `in (…)`, `= any(…)`, `in (select …)`; each takes `negated`.
- `jsonGet`, `jsonGetText`, `jsonPath`, `jsonPathText`, `jsonHasKey`, `jsonContains` — `->`, `->>`, `#>`, `#>>`, `?`, `@>` with the key/path/doc as a parameter.
- `fn`, `agg`, `countStar`, `over`, `cast`, `caseWhen`, `rowExpr`, `arrayExpr` — calls, aggregates, windows, casts, `case`, `row()`, `array[]`.
- `jsonBuild`, `jsonAgg`, `exists`, `scalarSubquery(query, codec, hoist?)` — JSON construction and subquery expressions.
- `raw(chunks, parts, resultCodec = null)` — a `sql` fragment node; throws `InvalidFragmentError` if `chunks.length !== parts.length + 1`.
- `markSite(node, site)`, `siteOf(node)` — record / read the `.as(codec)` call site in a side `WeakMap`.
- `order`, `asc`, `desc`, `projection`, `nested(key, plan)`, `group(key, plan)`, `setItem` — clause items.
- `select`, `insert`, `update`, `del`, `setop`, `cte` — statement constructors (`del` because `delete` is reserved).

## Flow
1. A constructor builds a plain object literal and passes it to `mkNode` (`packages/pg-prime/src/compile/nodes.ts:147`), which freezes it and adds it to `NODES` when `internalDepth === 0`.
2. Callers handing values back to the library (`sql` hole classification, `toExpr`, `queryAstOf`) ask `isAstNode` / `isRawPart`; an unregistered value is treated as data and becomes `$n` (`packages/pg-prime/src/sql/fragment.ts:162`, `packages/pg-prime/src/query/ops.ts:102`, `packages/pg-prime/src/query/nominal.ts:127`).
3. `planSelect` and the query layer's hot paths wrap internal node building in `inInternalNodes` to skip the `WeakSet.add` (`packages/pg-prime/src/compile/hoist.ts:1214`, `packages/pg-prime/src/query/insert.ts:471`, `packages/pg-prime/src/query/projection.ts:328`).
4. JSON accessors route every key or path through `param()`; paths use a derived `text[]` codec (`packages/pg-prime/src/compile/nodes.ts:139`).

## Gotchas
- Never replace `isAstNode` with a structural `'k' in v` check: `JSON.parse` output could then forge an `unsafeRaw` node (`packages/pg-prime/src/compile/nodes.ts:153`).
- The registry holds every node kind (order items, statements, `ColumnMeta`), so `isAstNode` alone does not mean "expression"; use `isRawPart` for fragment parts (`packages/pg-prime/src/compile/nodes.ts:157`).
- A node built inside `inInternalNodes` that later reaches a template hole is classified as data and bound as `$n` (`packages/pg-prime/src/compile/nodes.ts:113`). `internalDepth` is a counter because planning recurses (`packages/pg-prime/src/compile/nodes.ts:88`).
- `lit` has no runtime string check; `sql.lit` is the runtime backstop (`packages/pg-prime/src/compile/nodes.ts:272`).
- `nested()` and `group()` store `lit(null)` as a placeholder `expr`; `hoist.ts` replaces or ignores it (`packages/pg-prime/src/compile/nodes.ts:544`, `packages/pg-prime/src/compile/nodes.ts:552`).
- `markSite` uses a `WeakMap` so the site never appears on the node and `toStrictEqual` comparisons do not depend on `NODE_ENV` (`packages/pg-prime/src/compile/nodes.ts:510`).
- `scalarSubquery` always writes `hoist` (possibly `undefined`) so every `sq` node shares one hidden class (`packages/pg-prime/src/compile/nodes.ts:473`).
- `cte(n)` shallow-copies `n` but does not freeze its `columns` array (`packages/pg-prime/src/compile/nodes.ts:577`).

## Tests
- `packages/pg-prime/test/sql/tag.test.ts` ("forgery resistance") and `packages/pg-prime/test/query/guards.test.ts` cover JSON-forged nodes being treated as data; `packages/pg-prime/test/sql/tag-guards.test.ts` covers `isRawPart` refusing order items, statements and FROM items.
- `packages/pg-prime/test/compile/contract.test.ts` checks nodes are frozen; `packages/pg-prime/test/compile/*.test.ts` and `packages/pg-prime/test/query/ops.test.ts` use the constructors throughout.
- Run: `pnpm --filter pg-prime exec vitest run test/sql test/compile test/query/guards.test.ts`.
- Uncovered: no test asserts that nodes built inside `inInternalNodes` are absent from the registry.
