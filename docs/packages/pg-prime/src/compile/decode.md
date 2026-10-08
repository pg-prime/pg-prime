# packages/pg-prime/src/compile/decode.ts

## Purpose
Turns a `ResultShape` decode plan into a function that maps driver array rows (`rowMode: 'array'`) to `Row[]`, binding codecs and a `CodecContext` once per plan. Called by `decoderFor` in `packages/pg-prime/src/query/executor.ts` (which caches the result per compiled statement and connection) and by `assertCodegenAvailable` at `pgPrime()` construction; reads plans produced by `hoist.ts` via `compiler.ts`.

## Public API
- `buildDecoder<Row>(shape, ctx = defaultDecodeContext(), mode = 'closure')` — returns `(rows) => Row[]`; throws `DecodePlanError` for a malformed plan at build time.
- `DecoderMode` — `'closure' | 'codegen'`; re-exported from `packages/pg-prime/src/index.ts:564`.
- `assertCodegenAvailable()` — probes `new Function`; throws `DecodePlanError` naming the option when the runtime forbids it.
- `defaultDecodeContext()` — `{ typmod: -1, registry: defaultRegistry(), serverParameters: {} }` for decoding without an executor.

## Flow
1. `buildDecoder` switches on `shape.k`: `void` returns `() => []`; `scalar` decodes one index per row; `row` picks a row builder by `mode` (`packages/pg-prime/src/compile/decode.ts:406`).
2. `closureRowDecoder` builds parallel `keys` / `decoders` arrays and a template object with every key set to `null` (`packages/pg-prime/src/compile/decode.ts:379`).
3. Per row it clones the template and fills each key from its field decoder (`packages/pg-prime/src/compile/decode.ts:397`).
4. `rowFieldDecoder` handles each field: `col` is fused (null/undefined → `null`, string → `codec.decodeText`, otherwise pass-through); `json` delegates to `fieldDecoder`; `group` reads the whole row (`packages/pg-prime/src/compile/decode.ts:173`).
5. A nullable group is `null` when all witness indexes are NULL; witnesses are `witnesses`, else `[sentinel]`, else every leaf `col` index (`packages/pg-prime/src/compile/decode.ts:199`).
6. A `json` field `JSON.parse`s a string cell (or takes a pre-parsed value) and walks it with `jsonDecoder`, which uses `codec.decodeJson` at leaves (`packages/pg-prime/src/compile/decode.ts:247`, `packages/pg-prime/src/compile/decode.ts:112`).
7. `codegenRowDecoder` emits one function whose loop body is an object literal; `col` fields are inlined, other fields call bound closure-tree decoders (`packages/pg-prime/src/compile/decode.ts:325`).

## Gotchas
- `'__proto__'` as a result key throws `DecodePlanError` at build time in both builders and in JSON `obj` plans (`packages/pg-prime/src/compile/decode.ts:76`).
- A required `one` relation (`obj` with `nullable: false`) that is NULL throws `PgDecodeError` naming the column instead of returning `{}` (`packages/pg-prime/src/compile/decode.ts:86`, `packages/pg-prime/src/compile/decode.ts:137`).
- A NULL `arr` (a `many` relation) decodes to `[]`; a NULL JSON leaf decodes to `null` (`packages/pg-prime/src/compile/decode.ts:121`, `packages/pg-prime/src/compile/decode.ts:116`).
- `json` fields are excluded from the fallback witness set because `coalesce(json_agg(…), '[]')` is never NULL; no leaf columns means the group is never null (`packages/pg-prime/src/compile/decode.ts:157`).
- `undefined` (missing cell) is treated like SQL NULL everywhere.
- Codegen source names only positional parameters (`c0`, `x0`, `f0`); keys go through `jsString` (escapes U+2028/U+2029) and indexes through `assertPlanIndex` (`packages/pg-prime/src/compile/decode.ts:289`, `packages/pg-prime/src/compile/decode.ts:296`).
- The closure builder is the default because CSP-restricted runtimes forbid `new Function`; `pgPrime({ decoder: 'codegen' })` calls `assertCodegenAvailable` up front (`packages/pg-prime/src/query/executor.ts:140`).
- `ctx` is bound once per plan, with `column` set per field; the `scalar` shape uses the context without a column name (`packages/pg-prime/src/compile/decode.ts:415`).

## Tests
- `packages/pg-prime/test/compile/decode-guards.test.ts` — required relation NULL errors, group witness/sentinel rules, `__proto__` refusal.
- `packages/pg-prime/test/compile/decode-oracle.test.ts` — closure vs codegen vs hand mapper agreement, pre-parsed and missing cells, codegen input hardening, CSP refusal via `assertCodegenAvailable`.
- `packages/pg-prime/test/compile/contract.test.ts`, `nested.test.ts` — positional decoding, scalar/void shapes, exact types at every nesting depth.
- Run: `pnpm --filter pg-prime exec vitest run test/compile/decode-guards.test.ts test/compile/decode-oracle.test.ts test/compile/nested.test.ts`.
- Uncovered: `fieldDecoder`'s `group` branch is unreachable by construction and untested.
