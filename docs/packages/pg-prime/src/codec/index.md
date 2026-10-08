# packages/pg-prime/src/codec/index.ts

## Purpose
Barrel for the codec layer and the source of the `pg-prime/codecs` subpath export
(`packages/pg-prime/package.json:39` maps it to `dist/codec/index.js`). Re-exports from
`src/codec/types.ts`, `src/codec/array.ts`, `src/codec/builtins.ts`, `src/codec/registry.ts`,
`src/codec/define.ts` and `src/codec/extensions.ts`. The root barrel `src/index.ts` re-exports the
same names, and internal modules (`src/compile/*`, `src/query/*`, `src/session/config.ts`,
`src/session/copy.ts`, `src/sql/fragment.ts`) import the codec layer through it.

## Public API
- Types from `src/codec/types.ts`: `AnyCodec`, `Codec`, `CodecContext`, `CodecIn`, `CodecOut`,
  `CodecPg`, `CodecRegistry`, `DynamicTypeRequest`, `JsonEncode`, `PgDateString`, `PgTimestampString`, `TypeClass`.
- Classes from `src/codec/types.ts`: `PgDecodeError`, `PgEncodeError`.
- From `src/codec/array.ts`: `parseArrayLiteral`, `writeArrayLiteral`, type `PgArrayLiteral`.
- From `src/codec/builtins.ts`: every built-in codec constant, `ALTERNATE_CODECS`, `arrayCodec`,
  `arrayCodecOf`, `builtinCodecs`, `unknownCodec`, type `PgInterval`.
- From `src/codec/registry.ts`: `Registry`, `createRegistry`, `defaultRegistry`, `enumCodec`.
- From `src/codec/define.ts`: `definePgType`, type `PgTypeDescriptor`.
- From `src/codec/extensions.ts`: `EXTENSION_CODECS`, `citextCodec`, `vectorCodec`.

## Flow
1. Pure re-export; no runtime code (`packages/pg-prime/src/codec/index.ts:1`).
2. Value exports and type exports are separate statements so type-only names erase under
   `verbatimModuleSyntax` (`packages/pg-prime/src/codec/index.ts:16`, `packages/pg-prime/src/codec/index.ts:73`).

## Gotchas
- `derivesArrayCodec` (`src/codec/define.ts`) is deliberately not re-exported; it is internal to
  `Registry.resolveDynamic`.
- Built-in codec constants are listed one by one (`packages/pg-prime/src/codec/index.ts:21`); a new
  codec in `builtins.ts` is not public until it is added here and to `src/index.ts`.
- `tools/api-snapshot.mjs --check` (root `pnpm api-snapshot:check`) fails when the `pg-prime/codecs`
  surface drifts or exports a name the root entry does not.

## Tests
- No spec imports this file for its own sake; every `packages/pg-prime/test/codec/*.test.ts` file imports
  through it, so a missing re-export fails those suites.
- `packages/pg-prime/test/query/index.test.ts` checks the root barrel's expected and absent names.
- Run: `pnpm --filter pg-prime exec vitest run test/query/index.test.ts`; surface golden:
  `pnpm api-snapshot:check` from the repo root (needs a build).
- Not covered: none known beyond the surface golden.
