# packages/pg-prime/src/codec/types.ts

## Purpose
Type-only contract of the codec layer plus its two error classes: what a `Codec` is, what a
`CodecRegistry` must do, and the branded scalar strings. Implemented by `src/codec/builtins.ts`,
`src/codec/define.ts`, `src/codec/extensions.ts` and `Registry` in `src/codec/registry.ts`; consumed
through `src/codec/index.ts` by `src/compile/*`, `src/query/*`, `src/sql/fragment.ts` and
`src/session/*`, and directly by `src/schema/types.ts`. It imports only driver seam types
(`PgField`, `PgParam`, `PgRawValue`, `PgConnection`) from `src/driver/types.ts`.

## Public API
- `PgDateString` — branded `'YYYY-MM-DD'` string; what `dateCodec` decodes to.
- `PgTimestampString` — branded zoneless timestamp wire text; what `timestampCodec` decodes to.
- `PgDecodeError(codec, raw, detail)` — `Error` with `.codec` and `.raw`; message embeds a bounded
  excerpt of the raw value (`packages/pg-prime/src/codec/types.ts:30`).
- `PgEncodeError(codec, value, detail)` — `Error` with `.codec` and `.value`; message names the JS
  type of the rejected value (`packages/pg-prime/src/codec/types.ts:73`).
- `TypeClass` — family union (`'boolean' | 'number' | … | 'vector' | 'other'`).
- `JsonEncode` — `'native' | 'text'`: whether the compiler must emit `::text` inside `json_build_object`.
- `CodecContext` — `{ typmod, registry, serverParameters, column? }` handed to every decode call.
- `Codec<TIn, TOut, N>` — `name` (literal `N`), `oid`, `paramOid`, `sqlName`, `typeClass`,
  `jsonEncode`, optional `arrayOf`/`arrayOid`, `encode`, `decodeText`, `decodeJson`, optional `decodeBinary`/`toJson`.
- `AnyCodec` — `Codec<never, unknown, string>`, the heterogeneous bucket type.
- `CodecIn<C>`, `CodecOut<C>`, `CodecPg<C>` — extract a codec's input type, output type and name literal.
- `CodecRegistry` — `forOid`, `byName`, `planFor`, `jsonPlanFor`, `jsonCastFor`, `register`,
  `resolveDynamic`, plus read-only `resolved` and `generation`.
- `DynamicTypeRequest` — `{ schema?, name, kind, enumLabels?, fields? }`; input to `resolveDynamic`.

## Flow
1. A codec's `encode` turns a JS value into a `PgParam`: `string` (text format), `Uint8Array`
   (binary format) or `null` (`packages/pg-prime/src/codec/types.ts:206`).
2. Decoding at depth 0 calls `decodeText(raw, ctx)` with wire text; the registry short-circuits
   `null` before the call (`packages/pg-prime/src/codec/types.ts:215`).
3. Decoding inside a `json_agg` payload calls `decodeJson(raw, ctx)` on the already-parsed JSON
   value, and must return the same value `decodeText` returns for the same datum
   (`packages/pg-prime/src/codec/types.ts:218`).
4. `jsonEncode: 'text'` tells the compiler to cast the column `::text` inside `json_build_object`
   so the JSON value is the wire spelling; `CodecRegistry.jsonCastFor` maps it to the cast string.
5. Error messages run the raw value through `describeRaw`, which is total (never throws on a
   `bigint` or a cycle) and truncates to 200 chars (`packages/pg-prime/src/codec/types.ts:42`,
   `packages/pg-prime/src/codec/types.ts:50`).

## Gotchas
- `typeClass` drives no operator dispatch at runtime; the operator gate is type-level over
  `Codec['name']` literals. It is read by `arrayCodec` to decide leaf elements
  (`packages/pg-prime/src/codec/types.ts:94`).
- `name`, not `sqlName`, is the identity: `int4`'s `sqlName` is `'integer'`, but the schema DSL
  and `.as(codec)` publish `name` (`packages/pg-prime/src/codec/types.ts:159`).
- `oid`/`paramOid` are `undefined` for user and extension types until `resolveDynamic` runs;
  `paramOid` may deliberately differ from `oid` (domains send 705)
  (`packages/pg-prime/src/codec/types.ts:179`).
- `decodeBinary` is optional and no built-in implements it; a binary cell for such a codec makes
  `Registry.planFor` throw `PgDecodeError` (`packages/pg-prime/src/codec/types.ts:226`).
- `toJson` is declared for an ORM `serialize()`; nothing outside `src/codec` reads it.
- `encode` must throw `PgEncodeError` for values outside `TIn`; decode failures are `PgDecodeError`.
  Callers distinguish the two (`packages/pg-prime/src/codec/types.ts:211`).
- `CodecRegistry.generation` is the cache key for derived views (`metaOf` in `src/query/meta.ts`,
  the decode-plan memo in `packages/pg-prime/src/query/executor.ts:403`); a cache that ignores it keeps pre-resolve
  codecs with `oid: undefined` (`packages/pg-prime/src/codec/types.ts:285`).

## Tests
- No spec targets this file alone; the contract is exercised by `packages/pg-prime/test/codec/registry.test.ts`
  ("every shipped codec has a decodeJson"), `packages/pg-prime/test/codec/r5-golden.test.ts` (depth 0 equals depth 3
  for every built-in) and `packages/pg-prime/test/codec/decoding-strictness.test.ts:240` (error classes, the 10 MB raw
  value does not produce a 10 MB message at `packages/pg-prime/test/codec/decoding-strictness.test.ts:274`).
- Run (live project, PGlite): `pnpm --filter pg-prime exec vitest run test/codec`.
- Not covered: `PgEncodeError` message wording for every `typeOf` branch; `toJson` has no consumer.
