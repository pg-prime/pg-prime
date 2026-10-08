# packages/pg-prime/src/codec/define.ts

## Purpose
`definePgType()` turns a third-party descriptor (`name`, `encode`, `decode`, optional `schema`,
`typeClass`, `arrayOf`) into a `Codec` for an extension type whose OID is per-database. Used by
`src/codec/extensions.ts` for `citext` and `vector`; `Registry.resolveDynamic` in
`src/codec/registry.ts` calls `derivesArrayCodec`; public via `src/codec/index.ts`. Depends on
`PgDecodeError` (`src/codec/types.ts`) and `quoteIdentPart` (`src/sql/ident.ts`).

## Public API
- `PgTypeDescriptor<TIn, TOut, N>` — `{ name, schema?, encode, decode, typeClass?, arrayOf? }`.
- `definePgType(descriptor)` — returns `Codec<TIn, TOut, N>` with no OID; throws `TypeError` for an
  empty `name` or a missing `encode`/`decode`.
- `derivesArrayCodec(codec)` — exported from the module but not from `src/codec/index.ts`; `false`
  when the codec was built with `arrayOf: false`.

## Flow
1. Validates `name` is a non-empty string and both functions are present
   (`packages/pg-prime/src/codec/define.ts:127`).
2. Builds the codec with `oid` and `paramOid` `undefined`, so `Parse` sends `0` until
   `resolveDynamic` stamps the catalogue OID (`packages/pg-prime/src/codec/define.ts:141`).
3. `sqlName` is `quoteIdentPart(name)`, or `"schema"."name"` when `schema` is set
   (`packages/pg-prime/src/codec/define.ts:143`).
4. `typeClass` defaults to `'other'`; `jsonEncode` is always `'text'`
   (`packages/pg-prime/src/codec/define.ts:147`).
5. `decodeText` is `decode`; `decodeJson` requires a string and calls `decode` on it
   (`packages/pg-prime/src/codec/define.ts:153`).
6. `arrayOf: false` adds the codec to the module-private `NO_DERIVED_ARRAY` `WeakSet`
   (`packages/pg-prime/src/codec/define.ts:160`).
7. The caller registers the codec and runs `registry.resolveDynamic(conn, [{ name, kind: 'base' }])`;
   the registry's `base` branch copies it with the real OID (`packages/pg-prime/src/codec/registry.ts:366`).

## Gotchas
- The codec is not registered by `definePgType`; the caller must `registry.register(codec)` before
  `resolveDynamic`, or the `base` request throws naming `definePgType`
  (`packages/pg-prime/src/codec/registry.ts:383`).
- `jsonEncode: 'text'` makes the compiler emit `::text` in nested JSON, so `decodeJson` sees the
  same text `decodeText` sees; a non-string JSON value is a `PgDecodeError`
  (`packages/pg-prime/src/codec/define.ts:154`).
- `schema` only changes the `::type` spelling; registry lookup stays by bare `name`, and
  `resolveDynamic` keeps the descriptor's `sqlName` (`packages/pg-prime/src/codec/registry.ts:393`).
- `arrayOf: false` is tracked by object identity: the flag belongs to the exact object returned, so
  register that object, not a spread copy (`packages/pg-prime/src/codec/define.ts:109`).
- `typeClass: 'vector'` makes `arrayCodec` treat a decoded JS array as one element
  (`packages/pg-prime/src/codec/builtins.ts:1071`).
- `encode` is passed through unchanged; it alone must throw `PgEncodeError` for bad input.

## Tests
- `packages/pg-prime/test/query/extension-types.test.ts:38` — no OID, `jsonEncode: 'text'`, non-string JSON rejected,
  `schema` qualification, descriptor validation, `typeClass` default (unit project).
- `packages/pg-prime/test/pg/vector.test.ts:433` — a third-party type added with `definePgType` and resolved live,
  including `arrayOf: false` at `packages/pg-prime/test/pg/vector.test.ts:461` (pg project, needs `PG_PRIME_TEST_URL`).
- Run: `pnpm --filter pg-prime exec vitest run test/query/extension-types.test.ts`.
- Not covered: `arrayOf: false` without a live server (only the pg project asserts it).
