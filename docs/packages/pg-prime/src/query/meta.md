# packages/pg-prime/src/query/meta.ts

## Purpose
The codec seam: turns a schema table's `TableRuntime` into compiler metadata (`TableMeta`, per-column `ColumnMeta` with a resolved `Codec`, pre-quoted identifiers) once per (registry, table). Every downstream consumer (casts, `json_build_object`, the decoder, `assertShape`) reads codecs from here.
Callers: `src/query/ref.ts`, `src/query/scope.ts`, `src/query/relations.ts`, `src/query/insert.ts` (`clientDefaults`), `src/query/update.ts` (`clientOnUpdates`), `src/query/delete.ts`, `src/session/copy.ts` (`insertableKeys`, `generatedKeys`), `src/session/handles.ts`. Callees: the codec registry (`byName`, `arrayCodecOf`, `defaultRegistry`), `tableMeta`/`columnMeta` (`src/compile/nodes.ts`), `quoteIdentPart` (`src/sql/ident.ts`), `NoCodecError` (`src/sql/errors.ts`).

## Public API
- `TableLike` — `{ readonly $: TableRuntime }`; a `pgTable(...)` table or a `defineSchema(...)` handle.
- `TableCodecMeta` — `table`, `columns` and `keys` (declaration order, parallel), `insertableKeys`, `generatedKeys`, `byKey`, `clientDefaults`, `clientOnUpdates`.
- `metaOf(t, registry?)` — memoised `TableCodecMeta`; same object per (registry, table) until the registry generation moves; throws `NoCodecError` for an unresolvable column type.
- `codecFor(ddl, registry, table, column, schema?)` — resolves one column's codec (enum, array, or scalar); throws `NoCodecError`.

## Flow
1. `metaOf` fetches the per-registry entry, replacing it when `registry.generation` changed (`packages/pg-prime/src/query/meta.ts:106`).
2. On a miss, `build` creates `tableMeta(schema ?? 'public', name)` (`packages/pg-prime/src/query/meta.ts:124`).
3. Per column: `columnMeta(dbName, codecFor(...))`, then append to `columns`, `keys`, `byKey` (`packages/pg-prime/src/query/meta.ts:134`).
4. `insertableKeys` excludes `identity === 'always'` and `generatedAs` columns; `generatedKeys` collects `generatedAs` columns (`packages/pg-prime/src/query/meta.ts:142`).
5. `$default` / `$onUpdate` factories go into `clientDefaults` / `clientOnUpdates` (`packages/pg-prime/src/query/meta.ts:147`).
6. Everything is frozen; empty `generatedKeys` is a shared frozen array, empty default maps are `undefined` (`packages/pg-prime/src/query/meta.ts:152`).
7. `codecFor`, enum: registry `byName(enumName[ + '[]'])`, else a pending enum codec (wrapped as an array if `arrayDim > 0`) (`packages/pg-prime/src/query/meta.ts:191`).
8. `codecFor`, other: strip trailing `[]`s, try `byName(base)`, then `byName` without a trailing `(...)` typmod; wrap once in an array codec if `arrayDim > 0` (`packages/pg-prime/src/query/meta.ts:198`).

## Gotchas
- `.array().array()` resolves to the same 1-D array codec: PostgreSQL has no separate multi-dimensional array type (`packages/pg-prime/src/query/meta.ts:212`).
- The typmod strip (`vector(1536)` → `vector`, `varchar(50)` → `varchar`) is tried only after the exact name fails (`packages/pg-prime/src/query/meta.ts:199`, `packages/pg-prime/src/query/meta.ts:232`).
- A pending enum codec has `oid: undefined`, so `assertShape` skips it; it is not registered, and validates labels on encode and decode with a `TypeError` (`packages/pg-prime/src/query/meta.ts:242`).
- An enum with no declared labels accepts any string (`set.size > 0` check, `packages/pg-prime/src/query/meta.ts:245`).
- The pending codec's `sqlName` is quoted and schema-qualified when a schema is known, matching the post-`resolveDynamic` cast text (`packages/pg-prime/src/query/meta.ts:261`).
- `generatedByDefault()` identity columns stay in `insertableKeys`.
- Omitting `registry` uses the process-wide `defaultRegistry()`.
- `metaOf` is internal (`EXPECTED_ABSENT` in `packages/pg-prime/test/query/index.test.ts`).

## Tests
- Unit: `packages/pg-prime/test/query/meta.test.ts` — identity and caching per registry, invalidation on registration, schema default, casing, declaration order, `insertableKeys`, array handling, quoting, pending vs resolved enums, `NoCodecError`, every DSL builder resolves.
- `packages/pg-prime/test/query/extension-types.test.ts` — typmod stripping for extension types; `packages/pg-prime/test/session/copy.test.ts` — COPY's use of `insertableKeys`/`generatedKeys`.
- Live: `packages/pg-prime/test/live-query/codec-seam.test.ts` — every codec's OID matches what PostgreSQL reports, enum OID resolution, 2-D arrays, round trips.
- Run: `pnpm --filter pg-prime exec vitest run test/query/meta.test.ts`; `... test/live-query/codec-seam.test.ts` (live).
- Not covered in `meta.test.ts`: `generatedKeys` and `clientDefaults`/`clientOnUpdates` (exercised via insert/update/copy suites).
