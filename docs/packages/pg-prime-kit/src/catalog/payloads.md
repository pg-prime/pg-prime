# packages/pg-prime-kit/src/catalog/payloads.ts

## Purpose
Type definitions for the Tier-M fact payloads the catalog extractor produces and the diff engine compares, plus the Tier-O `ObservedObject` shape. Written by `catalog/extract.ts` and `schema/remap.ts`; read by `diff/ddl.ts`, `diff/rename.ts` and `pull/emit-ts.ts`; re-exported as types from `packages/pg-prime-kit/src/index.ts:46`. Every payload is identity-free: a fact's own name lives in its `StableId`, never in its payload.

## Public API
- `SchemaPayload` — `{ kind: "schema" }`.
- `TablePayload` — `relkind` (`r`/`p`), `persistence`, `rowSecurity`, `partitionStrategy`, `partitionKey`, `partitionOf` (encoded parent table id), `partitionBound`, `clusterOn` (bare index name).
- `GENERATED_NAME` — constant `"%GENERATED%"`, stands in for a server-generated NOT NULL constraint name.
- `ColumnPayload` — `type` (`format_type`), `notNull`, `notNullConstraint`, `notNullValidated`, `generationExpr`, `identity` (`a`/`d`), `generated` (`s`/`v`), `collation`.
- `DefaultPayload` — `{ kind: "default", expression }`, `pg_get_expr` spelling of a column DEFAULT.
- `ConstraintPayload` — `contype` (`p`/`f`/`u`/`c`/`x`), `definition` (without ` NOT VALID`), `validated`, `deferrable`.
- `IndexPayload` — `definition` (`pg_get_indexdef` with own name replaced by `%ID%`), `unique`, `valid`.
- `TypePayload` — enum/domain/composite by `typtype`; domain-only `baseType`, `notNull`, `default`, `collation`, `checks` (sorted `<name> <def>` strings), null otherwise.
- `TypeAttributePayload` — composite attribute `type` and `collation`.
- `CommentPayload` — `{ kind: "comment", text }`; the fact id is `commentId(target)`.
- `ExtensionPayload` — `{ kind: "extension", schema }`; no version field.
- `EnumLabelPayload` — `{ kind: "enumLabel" }` only; label text is the id, position is the fact's `ordinal`.
- `SequencePayload` — `dataType`, `start`, `increment`, `minValue`, `maxValue`, `cache` (all strings), `cycle`, `ownedBy` (encoded column id or null).
- `AnyPayload` — union of the twelve payloads above.
- `ObservedObject` — Tier-O `{ kind, name, detail }`, strings only; carried on `ExtractResult.observed`, never a fact.

## Flow
1. `extractCatalog` fills one payload per fact with `satisfies <Payload>` (`packages/pg-prime-kit/src/catalog/extract.ts:688` onward).
2. Payloads are hashed into fact content hashes and the fingerprint (`ir/hash.ts`'s `Payload` base); `ordinal` and the id are outside the payload.
3. `diff/ddl.ts` reads payload fields to render DDL; `GENERATED_NAME` is resolved back to `defaultNotNullName(table, column)` (`packages/pg-prime-kit/src/diff/ddl.ts:162`).
4. `diff/rename.ts` relies on `GENERATED_NAME` so a table rename does not change column hashes (`packages/pg-prime-kit/src/diff/rename.ts:447`).

## Gotchas
- `notNullConstraint` has three states: `null` (PG < 18 or nullable), `GENERATED_NAME` (server default name), any other string (user-chosen name) (`packages/pg-prime-kit/src/catalog/payloads.ts:83`).
- `notNullValidated` is `null` on PG < 18 or a nullable column, so the same schema does not diff between 17 and 18 (`packages/pg-prime-kit/src/catalog/payloads.ts:99`).
- A plain DEFAULT is a separate `default` fact; only a generation expression sits on the column (`generationExpr`) (`packages/pg-prime-kit/src/catalog/payloads.ts:110`).
- `contype = 'n'` (PG 18 NOT NULL) is never a `ConstraintPayload`; it is carried by the column.
- `partitionOf` contains the parent's name; this is allowed because it is another fact's name, not this fact's own.
- `clusterOn` is on the table, because the clustered index is often a constraint-backing index that is not a fact (`packages/pg-prime-kit/src/catalog/payloads.ts:50`).
- `ExtensionPayload` deliberately has no `extversion`, so version skew between environments never produces a delta.
- Domain CHECKs live inside `TypePayload.checks` rather than as `constraint` facts, since a constraint id is `[schema, table, name]`.
- Sequence numeric fields are strings, read with `::text` (`packages/pg-prime-kit/src/catalog/extract.ts:349`).

## Tests
- `packages/pg-prime-kit/test/kinds/payloads.test.ts` — compares each Tier-M payload field (domain, composite attributes, EXCLUDE, comment, extension, default vs generation expression, `notNullValidated`) to a direct catalog read.
- `packages/pg-prime-kit/test/catalog.test.ts` — `GENERATED_NAME` folding for default-named NOT NULL constraints.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/kinds/payloads.test.ts test/catalog.test.ts` (needs a real PostgreSQL server via `PG_PRIME_TEST_URL`).
- The module is type-only apart from `GENERATED_NAME`; it has no logic of its own to test.
