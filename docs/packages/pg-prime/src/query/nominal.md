# packages/pg-prime/src/query/nominal.ts

## Purpose
Decides nominally whether a value is a query: a builder registered by its constructor, or a real AST node from `src/compile/nodes.ts`. Structurally identical objects (for example parsed JSON) are refused, so data cannot reach the emitter as SQL.
Callers: builder constructors in `src/query/select.ts`, `insert.ts`, `update.ts`, `delete.ts` (`registerBuilder`); `exists`/`notExists` in `src/query/fn.ts`, `inQuery` in `src/query/ops.ts`, `fromSelect` in `src/query/insert.ts`, set operations and lateral joins in `src/query/select.ts`, CTEs in `src/query/cte.ts` (`queryAstOf`, `statementAstOf`). Callee: `isAstNode` (`src/compile/nodes.ts`).

## Public API
- `QuerySource` — `{ toAst(): SelectNode | SetOpNode } | SelectNode | SetOpNode`; what `exists`, `notExists` and `inQuery` accept.
- `registerBuilder(b)` — registers `b`'s prototype (or `b` itself when its prototype is `null` or `Object.prototype`).
- `isBuilder(v)` — true when `v`'s prototype is registered, or `v` itself is.
- `queryAstOf(q, where)` — `SelectNode | SetOpNode` from a builder or AST node; throws `BuilderError` for other statement kinds or non-query values.
- `statementAstOf(q, where)` — any `Statement` (select, setop, insert, update, delete) from a builder or AST node; throws `BuilderError` otherwise, and for an update/delete carrying `versionCheck` (`.ifVersion()` cannot be a CTE body).

## Flow
1. A builder constructor calls `registerBuilder(this)`; the first instance of each class adds its prototype to `BUILDER_PROTOS` (`packages/pg-prime/src/query/nominal.ts:88`).
2. `isBuilder` checks the prototype set, then the instance set (`packages/pg-prime/src/query/nominal.ts:97`).
3. `queryAstOf`: a builder's `toAst()` must be `select` or `setop`, else a `BuilderError` names the kind (`packages/pg-prime/src/query/nominal.ts:119`).
4. An AST node is accepted if `isAstNode` and its `k` is allowed (`packages/pg-prime/src/query/nominal.ts:127`).
5. `statementAstOf` then refuses a node with `versionCheck`, whether it came from a builder or a raw `.toAst()` node (`packages/pg-prime/src/query/nominal.ts:143`).
6. Anything else goes to `reject`, whose message names `where` and the value's kind (`packages/pg-prime/src/query/nominal.ts:110`).

## Gotchas
- Registration is per prototype, not per instance: `isBuilder` is true for any object whose prototype is a registered builder prototype, including `Object.create(proto)` (`packages/pg-prime/src/query/nominal.ts:79`).
- `JSON.parse` cannot forge a builder: a `"__proto__"` key in JSON becomes an own property, not a prototype.
- `registerBuilder({})` registers only that object, never `Object.prototype` (`packages/pg-prime/src/query/nominal.ts:90`).
- An AST node of the wrong kind (e.g. an `insert` node passed to `queryAstOf`) falls through to the generic rejection message, not the "this is an insert statement" one (`packages/pg-prime/src/query/nominal.ts:127`).
- `registerBuilder` is internal (`EXPECTED_ABSENT` in `packages/pg-prime/test/query/index.test.ts`); the builder classes are not on the barrel.

## Tests
- `packages/pg-prime/test/query/guards.test.ts` (`a query is a query nominally, not structurally`): `exists`/`notExists`/`inQuery` and `union`/`fromSelect`/`with` refuse look-alikes; a hand-built node from `src/compile/nodes.ts` is accepted.
- `packages/pg-prime/test/query/index.test.ts` — internals stay off the barrel.
- `packages/pg-prime/test/query/version.test.ts` — the `.ifVersion()` CTE refusal, builder and `.toAst()`.
- Run: `pnpm --filter pg-prime exec vitest run test/query/guards.test.ts`.
- Not covered: the `Object.create(proto)` case and the `null`/`Object.prototype` fallback.
