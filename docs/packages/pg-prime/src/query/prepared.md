# packages/pg-prime/src/query/prepared.ts

## Purpose
`placeholder(name, codec)` and the `PreparedQuery` artifact returned by every builder's `.prepare()`. A prepared query is client-side only: the frozen `Compiled` (SQL, bind plan with holes, decode plan, meta); executing it re-encodes parameters and does nothing else. Server-side named statements are a separate opt-in (`{ statement: 'named' }`).
Callers: `.prepare()` in `src/query/select.ts`, `src/query/insert.ts`, `src/query/update.ts`, `src/query/delete.ts` via `prepareFrom`; `placeholder` and the types are on the package barrel (`packages/pg-prime/src/index.ts:548`). Callees: `assertNoExtraPlaceholders` in `src/query/executor.ts`, and `runnerOf`, `streamWith`, `explainWith`, `toSQLOf`, `mergeRun`, `withRunOption`, `takeFirst` in `src/query/terminals.ts`.

## Public API
- `placeholder(name, codec)` — a named hole typed by `codec`, returned as `Expr<CodecOut<C>, C['name']>`; throws `BuilderError` for an empty or non-string name.
- `PrepareOptions` — `{ statement?: StatementMode }`; `'named'` pins server-side prepared statements for this query.
- `PreparedQuery<P, O>` — `name`, `sql`, `meta`, `compile()`, `toSQL(params?)`, `execute(params)`, `executeTakeFirst(params)`, `stream(params, opts?)`, `explain(params, opts?)`.
- `PreparedQuery` option setters — `signal(s)`, `timeout(ms)`, `outsideTransaction()`, `withExecMode(mode)`; each returns a new `PreparedQuery` over the same `Compiled`.
- `PreparedQueryImpl<O>` — the frozen class implementing `PreparedQuery<Values, O>`; not on the barrel.
- `prepareFrom(ctx, compiled, name?, opts?, run?)` — constructs a `PreparedQueryImpl`; the shared entry for all builders.

## Flow
1. A builder compiles once and calls `prepareFrom`, passing its inherited `QueryRunOptions` (`packages/pg-prime/src/query/prepared.ts:217`).
2. The constructor stores ctx, `Compiled`, name, `opts.statement` and run options, then freezes the instance (`packages/pg-prime/src/query/prepared.ts:125`).
3. `execute(params)` builds run options via `#run`: rejects extra keys with `assertNoExtraPlaceholders`, then merges `params` and the statement mode (`packages/pg-prime/src/query/prepared.ts:182`).
4. It calls `runnerOf(ctx).run(compiled, runOptions)`; the executor's `bindsToParams` encodes each slot and throws on a missing key (`packages/pg-prime/src/query/prepared.ts:199`).
5. `stream` merges stream options with `mergeRun` and delegates to `streamWith`; `explain` delegates to `explainWith` with the same run options (`packages/pg-prime/src/query/prepared.ts:207`).
6. Option setters call `#with`, which rebuilds the instance with `withRunOption(prev, patch)` and keeps `#statement` (`packages/pg-prime/src/query/prepared.ts:140`).

## Gotchas
- Mode precedence: a `statement` from run options (`withExecMode`, or inherited from the builder) wins over `.prepare(name, { statement })` (`packages/pg-prime/src/query/prepared.ts:190`).
- `execute`, `executeTakeFirst` and `explain` are `async`, so a bad `params` object rejects rather than throwing synchronously (`packages/pg-prime/src/query/prepared.ts:195`).
- Extra keys fail in `#run` before the runner; a missing key fails later, inside `bindsToParams` (`packages/pg-prime/src/query/executor.ts:179`).
- A key present with value `null` or `undefined` binds SQL NULL (`packages/pg-prime/src/query/executor.ts:186`).
- `P` is written by hand at `.prepare<P>()` and is not linked to the placeholders in the query; only the runtime check enforces it.
- `toSQL(params?)` never throws on an unfilled hole.
- `name` is the JS-side label for logs; it is never used as the server-side statement name.
- `compile()` returns the identical `Compiled` object on every call.
- A chunked insert refuses `.prepare()` (that check is in `src/query/insert.ts`, not here).

## Tests
- Unit: `packages/pg-prime/test/query/prepared.test.ts` — compile-once and encode-per-execution spies, `$n` bind order, missing/extra keys, empty placeholder name, `toSQL`, `executeTakeFirst`, chunked-insert refusal, JS name vs server name.
- `packages/pg-prime/test/query/named.test.ts` — `.prepare(name, { statement: 'named' })` on an unnamed db.
- Live: `packages/pg-prime/test/live-query/executor.test.ts` (`.prepare() round-trips typed parameters`, bigint past 2^53, `explain` with bound params).
- Run: `pnpm --filter pg-prime exec vitest run test/query/prepared.test.ts`; `... test/live-query/executor.test.ts` (live).
- Not covered: the `PreparedQuery` setters (`signal`, `timeout`, `outsideTransaction`, `withExecMode`) and the mode-precedence rule; builder-level `withExecMode` is tested in `packages/pg-prime/test/pg/session.test.ts`.
