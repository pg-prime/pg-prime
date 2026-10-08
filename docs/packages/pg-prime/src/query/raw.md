# packages/pg-prime/src/query/raw.ts

## Purpose
``db.sql`...` ``: a whole statement written as an `sql` fragment and run without a builder. Rows are `Record<string, unknown>` keyed by field name and decoded by the OID the server reports, through the describe cache in `src/query/executor.ts`.
Caller: `makeRaw` from the executor's `sql` member in `src/query/cte.ts` (`packages/pg-prime/src/query/cte.ts:329`); `RawQuery`/`RawRow` types are on the package barrel and in `src/query/types.ts`. Callees: `compileExpr` (`src/compile/compiler.ts`), the `sql` tag and `toNode` (`src/sql/`), `dynamicRowDecoder` (`src/query/executor.ts`), `runnerOf`/`explainWith`/`toSQLOf`/`takeFirst` (`src/query/terminals.ts`), and the session runner's `runRaw`.

## Public API
- `RawRow` — `Record<string, unknown>`.
- `RawQuery` — `sql`, `execute()`, `executeTakeFirst()`, `stream(opts?)`, `explain(opts?)`, `toSQL()`.
- `makeRaw(ctx, strings, values)` — builds a `RawQuery` from a template literal bound to a `BuilderCtx`.
- `registryOf(ctx)` — returns `ctx.registry`; no caller in `src` or `test` uses it.

## Flow
1. `makeRaw` runs the `sql` tag and `compiledOf` compiles it to a synthetic frozen `Compiled` with `shape: { k: 'void' }` and `meta.kind: 'select'` (`packages/pg-prime/src/query/raw.ts:71`).
2. `execute()` maps binds to params (`value` → `encoded`) and computes `paramTypesOf` (`packages/pg-prime/src/query/raw.ts:116`).
3. If the runner has `runRaw` (both runners `pgPrime` builds do), it sends a `StatementDescriptor` with `operation: 'other'`, so hooks, error mapping and per-statement timeouts apply (`packages/pg-prime/src/query/raw.ts:124`).
4. `perform` runs `conn.execute` and decodes with `dynamicRowDecoder(sql, fields, env.registry)` (`packages/pg-prime/src/query/raw.ts:133`).
5. Without `runRaw`, it falls back to `runner.use` and a bare `conn.execute` (`packages/pg-prime/src/query/raw.ts:118`).
6. `stream()` uses `runner.scope` and `rawStream`, building the decoder from the first chunk (`packages/pg-prime/src/query/raw.ts:151`, `packages/pg-prime/src/query/raw.ts:162`).
7. `explain()` and `toSQL()` reuse `explainWith` and `toSQLOf` on the synthetic `Compiled` (`packages/pg-prime/src/query/raw.ts:157`).

## Gotchas
- Rows are keyed by field name, so two columns with the same name (`select u.id, p.id`) collapse to one; alias them.
- A `placeholder()` spliced into a raw fragment is sent as NULL: every non-`value` bind maps to `null` (`packages/pg-prime/src/query/raw.ts:116`, `packages/pg-prime/src/query/raw.ts:172`).
- The synthetic `Compiled` always says `kind: 'select'` with empty `writes`, so `explain({ analyze: true })` on a raw `UPDATE`/`DELETE` is not wrapped in the rollback rail and really runs (`packages/pg-prime/src/query/raw.ts:78`, `packages/pg-prime/src/query/executor.ts:1036`).
- `assertShape` has nothing to check (`shape` is `void`); values are only as typed as the registry's codec for each reported OID.
- Raw statements always run unnamed; the descriptor path does not go through `runOn`'s named-statement logic.
- The fallback `runner.use` path passes no `signal` to `conn.execute` (`packages/pg-prime/src/query/raw.ts:120`).

## Tests
- Unit (mock driver): `packages/pg-prime/test/query/named.test.ts` (`the description cache` — one plan per 100 executions, name-keyed rows, OID-signature rebuild, `0A000` invalidation).
- Live: `packages/pg-prime/test/live-query/executor.test.ts` (`the fragment-only statement and its decode-plan cache`, including stream and explain on `db.sql`).
- `db.sql` is also used as an oracle in many live and pg suites (e.g. `packages/pg-prime/test/pg/session.test.ts`).
- Run: `pnpm --filter pg-prime exec vitest run test/query/named.test.ts`; `... test/live-query/executor.test.ts` (live).
- Not covered: the `explain({ analyze: true })` rollback-rail gap for mutating raw statements, and placeholders inside `db.sql`.
