# packages/pg-prime/src/codec/extensions.ts

## Purpose
The two extension-type codecs this package ships, `citext` and pgvector's `vector`, both built
through the public `definePgType` (`src/codec/define.ts`). `Registry`'s constructor
(`src/codec/registry.ts`) registers `EXTENSION_CODECS` by name; the schema column factories
(`t.citext()`, `t.vector(n)` in `src/schema/column.ts`) resolve to them by name. Public via
`src/codec/index.ts`.

## Public API
- `citextCodec` — `Codec<string, string, 'citext'>`; identity decode, `typeClass: 'string'`.
- `vectorCodec` — `Codec<readonly number[], number[], 'vector'>`; `[1,2,3]` wire form,
  `typeClass: 'vector'`.
- `EXTENSION_CODECS` — frozen `[citextCodec, vectorCodec]`, read once by `Registry`'s constructor.

## Flow
1. `citextCodec.encode` accepts only strings; `decode` returns the wire text unchanged
   (`packages/pg-prime/src/codec/extensions.ts:35`).
2. `vectorCodec.encode` requires an array and writes `[a,b,c]`, rejecting any non-finite or
   non-number component by index (`packages/pg-prime/src/codec/extensions.ts:60`).
3. `vectorCodec.decode` requires the `[`…`]` bracket form, returns `[]` for `[]`, and maps each
   comma-separated component through `Number`, rejecting `NaN` (`packages/pg-prime/src/codec/extensions.ts:75`).
4. `Registry`'s constructor adds both to its name map only; `forOid` cannot return them until
   `resolveDynamic(conn, [{ name, kind: 'base' }])` stamps the database's OID
   (`packages/pg-prime/src/codec/registry.ts:47`).

## Gotchas
- Neither codec has a fixed OID (`oid: undefined`), because `CREATE EXTENSION` allocates OIDs per
  database; columns of these types fall back to raw text in `planFor` until `resolveDynamic` runs.
- `typeClass: 'vector'` is what makes `vector[]` holding `[[1,2],[3,4]]` encode as two vectors
  (`{"[1,2]","[3,4]"}`), not a 2-D numeric array (`packages/pg-prime/src/codec/builtins.ts:1071`).
- `vectorCodec` only covers dense `vector`; `halfvec`/`sparsevec` are not shipped.
- `citext` case-insensitivity lives in the server's operators; decoded values keep their case.
- Both inherit `jsonEncode: 'text'` from `definePgType`, so nested JSON carries the `::text` form.
- Neither is in `builtinCodecs()`, so `packages/pg-prime/test/codec/r5-golden.test.ts` does not cover them.

## Tests
- `packages/pg-prime/test/query/extension-types.test.ts:94` (citext) and `packages/pg-prime/test/query/extension-types.test.ts:104` (vector encode/decode,
  NaN rejection, malformed wire form, array of vectors) — unit project.
- `packages/pg-prime/test/pg/vector.test.ts:208` — `resolveDynamic` reads the OID live; `packages/pg-prime/test/pg/vector.test.ts:265` builder
  round trips; `packages/pg-prime/test/pg/vector.test.ts:358` distance operators (pg project, needs `PG_PRIME_TEST_URL` with pgvector).
- Run: `pnpm --filter pg-prime exec vitest run test/query/extension-types.test.ts`.
- Not covered: a `vector` decode of components with exponents or whitespace.
