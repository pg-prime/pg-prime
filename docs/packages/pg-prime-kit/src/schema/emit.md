# packages/pg-prime-kit/src/schema/emit.ts

## Purpose
The DSL → DDL emitter: turns a `SchemaLike` registry into deterministic, always schema-qualified SQL statements that, loaded into an empty database (the shadow), produce the declared schema. It does not build an IR itself; `loadDesired` (`packages/pg-prime-kit/src/schema/load.ts:66`) runs the text and `extractCatalog` reads it back. Uses `makeObjectName`/`quoteIdent`/`quoteLiteral`/`quoteQualified` from `sql/ident.ts`. Re-exported from `packages/pg-prime-kit/src/index.ts:260`.

## Public API
- `EmitOptions` — `{ schemaMap?, defaultSchema? }`; `schemaMap` is user schema → emitted schema (tier-3 shadow), `defaultSchema` defaults to `"public"`.
- `EmitResult` — `{ sql, diagnostics, schemas }`; `sql` is statements in execution order without trailing semicolons, `schemas` the touched user schema names, sorted.
- `EmitError` — code `PG_PRIME_EMIT`; thrown internally for unrenderable defaults and converted to `unrenderable_default` diagnostics.
- `emitSchema(schema, options?)` — returns `EmitResult`; problems become diagnostics, it does not throw for registry errors.
- `remapTypeQualifier(type, rename)` — rewrites the schema qualifier of a `schema.type` text through `rename`, quoting it either way; unqualified types are unchanged.
- `remapNextval(expr, rename, declared, defaultSchema)` — rewrites `nextval('<seq>'[::regclass])` only for sequences in `declared`, emitting a quoted qualified name.

## Flow
1. Sort tables by `schema name`, report `duplicate_table`, collect enums used by columns (`collectEnum`, `enum_conflict` on label mismatch) (`packages/pg-prime-kit/src/schema/emit.ts:212`).
2. `buildTable` per table: column lines (type, `COLLATE` when `ColumnDdl.collation` is set, generated/identity/default, NOT NULL, inline UNIQUE/CHECK/FK) and table-level PK/UNIQUE/CHECK/EXCLUDE/FK, with server-style default names via `makeObjectName` (`packages/pg-prime-kit/src/schema/emit.ts:565`).
3. Merge standalone `pgEnum` declarations (adds comments; column-derived labels win) (`packages/pg-prime-kit/src/schema/emit.ts:265`).
4. Emit `CREATE EXTENSION IF NOT EXISTS` (user schema name; `shadow_extension_fixed_schema` warning under a non-identity map) (`packages/pg-prime-kit/src/schema/emit.ts:290`).
5. `CREATE SCHEMA IF NOT EXISTS` for every touched (mapped) schema except `public` (`packages/pg-prime-kit/src/schema/emit.ts:320`).
6. `CREATE TYPE … AS ENUM`, `CREATE DOMAIN` (CHECKs sorted by name), `CREATE SEQUENCE` (`packages/pg-prime-kit/src/schema/emit.ts:325`–`:359`).
7. Tables in `topoOrder` (iterative Tarjan SCC over FK targets and partition parents); FKs inline when the target already exists or is self, otherwise deferred (`packages/pg-prime-kit/src/schema/emit.ts:361`, `:1028`).
8. Each `CREATE TABLE` gets `PARTITION BY` when declared; a partition child is created standalone, then `ALTER TABLE <parent> ATTACH PARTITION` (`packages/pg-prime-kit/src/schema/emit.ts:391`); any `rls.enable()`/`rls.force()` extra adds one `ENABLE ROW LEVEL SECURITY` (`:398`).
9. Deferred FKs as `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` (`packages/pg-prime-kit/src/schema/emit.ts:402`).
10. Indexes sorted by qualified name via `indexStatement` (USING, keys with opclass/DESC/NULLS, INCLUDE, NULLS NOT DISTINCT, WITH, TABLESPACE, WHERE) (`packages/pg-prime-kit/src/schema/emit.ts:476`).
11. `ALTER TABLE … CLUSTER ON`, then `ALTER SEQUENCE … OWNED BY`, then comments sorted types → tables → columns (`packages/pg-prime-kit/src/schema/emit.ts:440`–`:459`).

## Gotchas
- Every statement is schema-qualified so the tier-3 map is a pure identifier rename; an unmapped schema under a map is an `error` (`shadow_schema_unmapped`) and `loadDesired` refuses to run (`packages/pg-prime-kit/src/schema/emit.ts:189`).
- `defaultSql`, `generatedAs`, CHECK/EXCLUDE/WHERE expressions are opaque text and are not remapped; the only text rewrites are `remapTypeQualifier` on column types and `remapNextval` on declared sequences.
- A domain's `baseType` and `default` are written verbatim (`packages/pg-prime-kit/src/schema/emit.ts:333`); `remapTypeQualifier` is applied to column types only.
- Default literals are rendered by the column's pg type first: `json`/`jsonb` always `JSON.stringify`; negative numbers are parenthesised; arrays cast to the emitted type (`packages/pg-prime-kit/src/schema/emit.ts:128`).
- Constraint names follow PostgreSQL's `makeObjectName`; a duplicate name is reported (`constraint_name_collision`) rather than suffixed (`packages/pg-prime-kit/src/schema/emit.ts:569`).
- A column `.primaryKey()` plus a `primaryKey()` extra is `duplicate_primary_key`; a named `primaryKey({ name })` overrides `<table>_pkey`.
- FK errors: `foreign_key_unresolved`, `foreign_key_arity`, `foreign_key_split`, `foreign_key_target_unknown` (target outside the registry) (`packages/pg-prime-kit/src/schema/emit.ts:884`).
- EXCLUDE errors: `empty_exclude`, `missing_required_extension` when `.requires()` names an undeclared `pgExtension`.
- `.generatedAlwaysAs((cols) => …)` that was never resolved by `pgTable` is `unresolved_generated`; unknown extras are `unsupported_extra` warnings.
- `FORCE ROW LEVEL SECURITY` and `updatedAtTrigger` are never emitted here: both belong to the declared lane (design/20 D4), so the IR and fingerprint of a forced table do not change.
- Partition children use `ATTACH PARTITION`, not `PARTITION OF`, because PG 18 would clone the parent's NOT NULL constraint names.
- Standalone and column-derived enums with the same name: the column's labels win without a conflict check (`packages/pg-prime-kit/src/schema/emit.ts:276`).
- An `index` extra without `items` falls back to plain column keys (`packages/pg-prime-kit/src/schema/emit.ts:983`).
- Views are not emitted here; see `schema/views.ts`.

## Tests
- `packages/pg-prime-kit/test/schema-emit/emit.test.ts` — determinism, statement order, `makeObjectName` names and collisions, default literals, FK cycle breaking and self-references, index option clause order, extensions, EXCLUDE/generated/type comments, enums, the tier-3 map (including unmapped-schema errors), load-stopping diagnostics, `pgSchema`.
- `packages/pg-prime-kit/test/schema-emit/roundtrip.test.ts` — emit → load → extract → re-emit round trip, strict `pg_dump` oracle, tier-3 map fingerprint equality (covers `remapTypeQualifier`/`remapNextval`).
- `packages/pg-prime-kit/test/kinds/rls.test.ts` — `rls.*()` emits ENABLE once per table with no diagnostics (live).
- `packages/pg-prime-kit/test/collate.test.ts` — `COLLATE "C"` in CREATE TABLE and its round trip (live).
- `packages/pg-prime-kit/test/schema-emit/no-value-import.test.ts` — the type-only `pg-prime` import rule.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/schema-emit` (`roundtrip.test.ts` needs a real server, `PG_PRIME_TEST_URL`, and `pg_dump`).
- Uncovered: domain base types qualified with a mapped schema under tier 3 have no test.
