# packages/pg-prime/src/query/errors.ts

## Purpose
The query layer's diagnostics: template-literal string types used as type-error sentences (wrapped in `OrmTypeError<...>` at the use site in `src/query/types.ts`), and the runtime `CodecMismatchError` thrown by `assertShape` in `src/query/executor.ts`.
Callers: `src/query/types.ts` (message types), `src/query/executor.ts` (`CodecMismatchError`); `CodecMismatchError` and `CodecMismatch` are on the package barrel (`packages/pg-prime/src/index.ts:567`). Callee: `PgPrimeError` (`src/sql/errors.ts`).

## Public API
- `SetOpMissingColumnMsg<B, K>`, `SetOpExtraColumnMsg<B, K>`, `SetOpColumnTypeMismatchMsg<B, K>` — union branch column mismatches; `B` is the 1-based branch index.
- `GroupByNeedsParentKeyMsg<A, K>` — a relation row-set projection after `groupBy()` without the parent's primary key.
- `WriteToViewMsg<V, N>` — `insertInto`/`update`/`deleteFrom` given a view.
- `CteNameTakenMsg<N>` — a CTE name already declared on the query.
- `SetOpNeedsSelectMsg`, `SetOpNeedsProjectionMsg`, `ExecuteNeedsProjectionMsg` — set-op branch not a SELECT / not projected; `.execute()` without a projection.
- `IfDropsColumnMsg<K>` — a `$if` branch that drops an already-selected column.
- `HeterogeneousBulkMsg` — `valuesMany()` rows with differing columns.
- `CodecMismatch` — `{ column, declared, declaredOid, actual, actualOid, origin? }`.
- `renderCodecMismatch(m)` — the error text; pure.
- `CodecMismatchError` — `PgPrimeError` with `code: 'CODEC_MISMATCH'` and `mismatch: CodecMismatch`.

## Flow
1. `assertShape` finds a declared OID that differs from `RowDescription.dataTypeID` and constructs `CodecMismatchError` (`packages/pg-prime/src/query/executor.ts:290`).
2. The constructor calls `renderCodecMismatch` for the message (`packages/pg-prime/src/query/errors.ts:229`).
3. Lines 1–2 name the column, declared codec and OID, and what Postgres returned (or "an unregistered type") (`packages/pg-prime/src/query/errors.ts:188`).
4. With `origin.column` (a schema column) it reports schema drift and suggests running the pending migration (`packages/pg-prime/src/query/errors.ts:193`).
5. Otherwise it adds `origin.site` if known and a `Fix:` line suggesting `codecs.<actual>` or a SQL cast (`packages/pg-prime/src/query/errors.ts:204`).

## Gotchas
- Messages are exported as string types, not `OrmTypeError<...>` aliases: TypeScript prints a named generic alias unexpanded and would hide the sentence.
- Every sentence is one line, under 300 characters, and says what to do.
- The rendered sentences are committed goldens under `tools/type-errors/`; changing wording without updating them fails `type-errors.test.ts`.
- A `json` relation column mismatch reports `declared: 'json'` with `declaredOid: 3802` (jsonb), although `json` (114) is also accepted (`packages/pg-prime/src/query/executor.ts:262`).
- The `Fix: use codecs.<actual>` hint names `codecs.<registry name>`, but the barrel exports no `codecs` object; built-in codecs are individual exports such as `numericCodec` (`packages/pg-prime/src/query/errors.ts:209`, `packages/pg-prime/src/index.ts:284`).

## Tests
- `packages/pg-prime/test/query/assert-shape.test.ts` — the rendered message goldens (call-site, schema-drift, unregistered OID variants) and when the error fires.
- `packages/pg-prime/test/live-query/executor.test.ts` — the error against a real `RowDescription`.
- `packages/pg-prime/test/query/type-errors.test.ts` — the type-level sentences' rendered diagnostics against `tools/type-errors/` goldens on both compilers.
- Run: `pnpm --filter pg-prime exec vitest run test/query/assert-shape.test.ts test/query/type-errors.test.ts`; `... test/live-query/executor.test.ts` (live).
