# packages/pg-prime/src/compile/compiler.ts

## Purpose
The single-pass SQL emitter: one recursive descent over a planned AST that appends to a `string[]`, threads a `Bind[]`, and returns a frozen `Compiled`. Called by the statement builders (`packages/pg-prime/src/query/select.ts`, `insert.ts`, `update.ts`, `delete.ts`) and by `packages/pg-prime/src/query/raw.ts` via `compileExpr`; calls `planSelect`, `planReturning`, `exprDigest` and `comparesWholeRows` from `hoist.ts` and `quoteIdentPart` / `quoteStringLiteral` from `packages/pg-prime/src/sql/ident.ts`.

## Public API
- `compile<Row>(stmt: Statement): Compiled<Row>` — emits SQL, binds, decode shape, origins and meta; throws `UnsupportedNodeError`, `BuilderError`, `InvalidFragmentError`, `TooManyParametersError`.
- `compileExpr(e: Expr)` — emits one expression; returns `{ sql, binds, placeholders, usedUnsafeRaw }` (no shape, no parameter cap).

## Flow
1. `compile` creates an `Emitter` and switches on `stmt.k` (`packages/pg-prime/src/compile/compiler.ts:1412`).
2. `select`: `planSelect(stmt)` hoists relations and yields `fields`/`origins`; `emitSelectBody` emits the planned node (`packages/pg-prime/src/compile/compiler.ts:1421`).
3. `insert` / `update` / `delete`: emit the body, then `emitTopReturning` plans the RETURNING list with `planReturning` and keeps its decode plan (`packages/pg-prime/src/compile/compiler.ts:1379`).
4. `setop`: the shape is planned from the leftmost branch with the same `rowEquality` the emitter uses, then `emitSetOpBody` emits both branches (`packages/pg-prime/src/compile/compiler.ts:1399`, `packages/pg-prime/src/compile/compiler.ts:1446`).
5. `emitWith` runs first in each statement body, so CTE parameters get the lowest `$n` (`packages/pg-prime/src/compile/compiler.ts:891`).
6. `emitSelectBodyIn` emits clauses in SQL order; a `select distinct` with ORDER BY first runs `checkDistinctOrder` (`packages/pg-prime/src/compile/compiler.ts:993`).
7. `emitExpr` dispatches on every `Expr` kind; nested selects reached via `emitStatement` or `exists` are planned with `planSelect` on the spot (`packages/pg-prime/src/compile/compiler.ts:1343`, `packages/pg-prime/src/compile/compiler.ts:595`).
8. `param` goes through `Emitter.bindValue`, which encodes non-null values and pushes `$n`; `ph` goes through `bindSlot` (`packages/pg-prime/src/compile/compiler.ts:173`).
9. `emitFromItem` records each table in `reads`; statement targets are recorded in `writes` (`packages/pg-prime/src/compile/compiler.ts:786`, `packages/pg-prime/src/compile/compiler.ts:1076`).
10. After emission, more than 65535 binds throws `TooManyParametersError`; the result and its arrays are frozen (`packages/pg-prime/src/compile/compiler.ts:1464`).
11. An update/delete node's `versionCheck` is copied to `meta.versionCheck`; the key is absent otherwise (`packages/pg-prime/src/compile/compiler.ts:1465`).

## Gotchas
- Injection audit surface: only `IdentPart.quoted` (`packages/pg-prime/src/compile/compiler.ts:743`), `unsafeRaw` text (`packages/pg-prime/src/compile/compiler.ts:748`, sets `usedUnsafeRaw`) and `quoteStringLiteral` for `jsonBuild` keys (`packages/pg-prime/src/compile/compiler.ts:605`) splice non-`$n` text from nodes; identifiers elsewhere go through `quoteIdentPart`.
- Option strings (order direction, nulls, lock strength/wait, frame mode/exclude/bound) map through fixed `switch`es and throw on anything else (`packages/pg-prime/src/compile/compiler.ts:270`).
- A `raw` node is parenthesized in every operand position because its precedence is unknown; `needsParens` also wraps `bin`, `is`, `in`, `between`, `un` operands (`packages/pg-prime/src/compile/compiler.ts:201`).
- A negative literal under a prefix operator or `::` cast is wrapped so `--1` never becomes a line comment (`packages/pg-prime/src/compile/compiler.ts:230`).
- `and()` emits `true`, `or()` emits `false`; `in` with an empty list emits `false` (`true` when negated) (`packages/pg-prime/src/compile/compiler.ts:412`, `packages/pg-prime/src/compile/compiler.ts:475`).
- An empty `array[]` gets `::<elem>[]` appended; a `case` with no `when` throws; a non-finite number literal throws (`packages/pg-prime/src/compile/compiler.ts:583`, `packages/pg-prime/src/compile/compiler.ts:542`, `packages/pg-prime/src/compile/compiler.ts:374`).
- A cross join with `on` throws instead of dropping the predicate; `on: undefined` on other joins emits `on true` (`packages/pg-prime/src/compile/compiler.ts:860`).
- RETURNING emits target columns unqualified only when no FROM/USING item shares the scope; a SELECT nested inside resets to fully qualified (`packages/pg-prime/src/compile/compiler.ts:1329`, `packages/pg-prime/src/compile/compiler.ts:923`).
- `insert` emits `as <alias>` only when the alias differs from the table name (`packages/pg-prime/src/compile/compiler.ts:1080`).
- A set-op branch is parenthesized when it is itself a set op or carries `with`, `orderBy`, `limit`, `offset` or `locking` (`packages/pg-prime/src/compile/compiler.ts:1248`).
- `select distinct` whose ORDER BY item is not in the projection throws `BuilderError`; expressions with a `null` digest pass through (`packages/pg-prime/src/compile/compiler.ts:968`).
- Module-level caches are shared across compiles: `ALIAS_CACHE` (capped at 4096, cleared wholesale) and the `$n` / newline string tables; none holds per-statement state (`packages/pg-prime/src/compile/compiler.ts:63`, `packages/pg-prime/src/compile/compiler.ts:101`).
- `compileExpr` returns unfrozen `binds` and does not enforce the 65535 cap (`packages/pg-prime/src/compile/compiler.ts:1490`).

## Tests
- `packages/pg-prime/test/compile/select.test.ts`, `insert.test.ts` — golden SQL, predicates, ordering, locking, fragments, RETURNING.
- `packages/pg-prime/test/compile/parens.test.ts`, `emit-guards.test.ts` — parenthesization, set-op WITH branches, RETURNING qualification, option whitelists, cross join, case/row/array.
- `packages/pg-prime/test/compile/contract.test.ts` — purity, binds, meta, parameter cap, one-statement output.
- `packages/pg-prime/test/query/select.test.ts` ("distinct refuses an ORDER BY it cannot satisfy") — `checkDistinctOrder`; `packages/pg-prime/test/live-query/select.test.ts` repeats it against a server; `packages/pg-prime/test/fuzz/compiler-fuzz.test.ts` fuzzes the whole compiler.
- Run: `pnpm --filter pg-prime exec vitest run test/compile` (unit); `pnpm --filter pg-prime exec vitest run test/live-query test/fuzz` (live, PGlite).
- Uncovered: no unit test of `ALIAS_CACHE` eviction or the `>65535` branch of `dollarAt`.
