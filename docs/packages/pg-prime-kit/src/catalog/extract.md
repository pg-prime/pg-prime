# packages/pg-prime-kit/src/catalog/extract.ts

## Purpose
Reads a live database's `pg_catalog` into a `SchemaIR` fact base (Tier M), a list of Tier-O `ObservedObject`s and diagnostics. It is the "actual" side of every diff: called by `generate.ts`, `runner/run.ts`, `runner/status.ts`, `checkpoint/checkpoint.ts`, `pull/pull.ts`, `prove/prove.ts`, `prove/temp-schema.ts`, `schema/load.ts` and the `baseline`/`doctor`/`verify` commands. Builds facts with payload shapes from `catalog/payloads.ts` and ids from `ir/stable-id.ts`.

## Public API
- `CatalogClient` — minimal `query(text, values?) => Promise<{ rows }>` interface; satisfied by a `pg` client. Used kit-wide.
- `Diagnostic` — `{ code, severity: "info"|"warning"|"error", message, subject?, count? }`; the kit's shared diagnostic shape.
- `ExtractOptions` — `schemas` (default `["public"]`), `provenance` (default `CATALOG_PROVENANCE`), `statementTimeout` (default `"30s"`), `observe` (default on).
- `ExtractResult` — `{ ir, pgVersionNum, diagnostics, observed }`; `observed` is Tier O, kept out of `ir` so it is never diffed or fingerprinted.
- `extractCatalog(client, options?)` — runs every catalog query in one read-only snapshot and returns `ExtractResult`. Rethrows query errors after `ROLLBACK`.
- `probeEmptiness(client, tables)` — returns the encoded `table` ids proven empty by `SELECT NOT EXISTS (… LIMIT 1)`; unreadable tables are silently omitted.
- `observedCounts(observed)` — per-kind counts sorted by kind, for `doctor` and `pull` reports.
- `observationDiagnostics(observed)` — one `observed_kind` info diagnostic per kind.
- `evaluatedEnumLabels(expr, enumLabels)` — `enumLabel` ids an expression evaluates (type mentioned AND label literal present).

## Flow
1. Sort `schemas`, open `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, set `search_path = pg_catalog` and `statement_timeout` via `set_config` (`packages/pg-prime-kit/src/catalog/extract.ts:650`, `:657`).
2. Read `server_version_num`, then run each family query serially on the one connection (`packages/pg-prime-kit/src/catalog/extract.ts:664`).
3. Unless `observe === false`, run the Tier-O sweep `observe()` with one savepoint per family (`packages/pg-prime-kit/src/catalog/extract.ts:1110`).
4. Emit `schema` and `extension` facts; extensions get provenance `origin: "extension", ownership: "external"` (`packages/pg-prime-kit/src/catalog/extract.ts:699`).
5. Emit `type` facts (enum/domain/composite) with sorted domain CHECKs, then `typeAttribute` and `enumLabel` facts carrying `ordinal` (`packages/pg-prime-kit/src/catalog/extract.ts:713`).
6. Emit `table` facts incl. partition fields; a partition gets a `depends` edge to its parent (`packages/pg-prime-kit/src/catalog/extract.ts:798`).
7. Emit `column` facts; a plain DEFAULT becomes a separate `default` fact, a generation expression stays on the column (`packages/pg-prime-kit/src/catalog/extract.ts:837`, `:848`).
8. Add column → enum-type `depends` edges and `evaluates` edges to enum labels from both the column and its default (`packages/pg-prime-kit/src/catalog/extract.ts:863`, `:878`).
9. Emit `constraint` facts (trailing ` NOT VALID` stripped into `validated`) with FK `depends` edges (`packages/pg-prime-kit/src/catalog/extract.ts:890`).
10. Emit `index` facts with definitions templatized to `%ID%`; invalid indexes add an `invalid_index` warning (`packages/pg-prime-kit/src/catalog/extract.ts:921`, `:934`).
11. Emit `sequence` facts (identity-owned skipped), serial column → sequence edges, and `comment` facts (`packages/pg-prime-kit/src/catalog/extract.ts:952`, `:984`, `:998`).
12. Add diagnostics: `volatile_default` (info), `unsupported_kind` for INHERITS (error), `unmodeled_kind` census with `count` (`packages/pg-prime-kit/src/catalog/extract.ts:1012`, `:1030`, `:1045`).
13. `COMMIT`, then `SchemaIR.build(facts, edges)`; each orphan fact adds an `orphan_fact` warning (`packages/pg-prime-kit/src/catalog/extract.ts:1065`).

## Gotchas
- Only `pg_catalog` is queried; `information_schema` never is.
- `EXCLUDED_RELS` (extension-owned rels and both ends of classic `INHERITS`) is applied to every family, not just `pg_class`, to avoid orphan facts (`packages/pg-prime-kit/src/catalog/extract.ts:86`). Partitions are not excluded: `relispartition` distinguishes them.
- Indexes backing PK/UNIQUE/EXCLUDE constraints, partition child indexes and indexes on materialized views are not facts (`packages/pg-prime-kit/src/catalog/extract.ts:195`).
- `templatizeIndexDef` throws if the name cannot be replaced, and drops `ON ONLY` so a partitioned index is created on all partitions (`packages/pg-prime-kit/src/catalog/extract.ts:634`).
- Standalone composites only: `Q_TYPES` filters `typtype = 'c'` to `relkind = 'c'` (`packages/pg-prime-kit/src/catalog/extract.ts:217`).
- PG 18 NOT NULL constraints are joined on `contype = 'n'` without a version gate; on older servers `notNullConstraint`/`notNullValidated` are null. A name equal to `defaultNotNullName(table, column)` is stored as `GENERATED_NAME` (`packages/pg-prime-kit/src/catalog/extract.ts:825`).
- `Q_EXTENSIONS` is restricted to the managed schemas, so `plpgsql` (in `pg_catalog`) never appears.
- Volatile defaults are diagnostics, not payload, so redefining a function's volatility is not a schema delta (`packages/pg-prime-kit/src/catalog/extract.ts:400`).
- Tier-R kinds (`view`, `materializedView`, `function`, `procedure`, `trigger`, `policy`, `rule`) and Tier-U kinds share the `unmodeled_kind` code; `diffIR`'s `strictUnmodeled` promotes only Tier U. Language/transform/parameter-ACL/large-object counts are cluster-wide.
- A Tier-O family that fails (e.g. permission denied on `pg_subscription`) becomes an `observation_unavailable` info diagnostic instead of aborting the snapshot (`packages/pg-prime-kit/src/catalog/extract.ts:1124`).
- The `observe` option's doc comment says the shadow-clone proof disables it, but `proveOnShadowClone` extracts with observation on (`packages/pg-prime-kit/src/prove/prove.ts:203`); `proveInTempSchemas`, `checkpoint` and the third-party corpus test pass `observe: false`.
- `probeEmptiness` runs outside the snapshot and treats any query error as "not proven empty" (`packages/pg-prime-kit/src/catalog/extract.ts:1164`).
- `evaluatedEnumLabels` over-matches by design; `mentionsType` checks all four quoted/bare qualified spellings plus `::type` (`packages/pg-prime-kit/src/catalog/extract.ts:1233`).
- The `pg` client forbids concurrent queries, so family queries are sequential.

## Tests
- `packages/pg-prime-kit/test/catalog.test.ts` — `evaluatedEnumLabels` spellings, exclusion of extension/inheritance rels, partition facts, `statementTimeout` passed as a bind (injection attempt rejected), NOT NULL constraint naming.
- `packages/pg-prime-kit/test/kinds/payloads.test.ts` — each Tier-M payload field vs. a direct catalog read; `kinds/partition.test.ts`, `kinds/extension.test.ts`, `kinds/not-null-validity.test.ts`.
- `packages/pg-prime-kit/test/kinds/observation.test.ts` — Tier O kept out of `ir`, `observedCounts`, `observationDiagnostics`, Tier-U census, strict mode.
- `packages/pg-prime-kit/test/kinds/emptiness.test.ts` — `probeEmptiness` gating MF hazards; `test/ir.test.ts` — `evaluatedEnumLabels` unit cases.
- Indirectly exercised by most kit suites (`roundtrip`, `corpus`, `enum`, `rename`, `schema-emit/*`).
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/catalog.test.ts test/kinds`. All kit tests need a real PostgreSQL server (`PG_PRIME_TEST_URL`, see `packages/pg-prime-kit/test/support/db.ts`).
- Uncovered: the `observe: false` path is used by `corpus-thirdparty.test.ts` but has no dedicated assertion; `invalid_index` and `volatile_default` diagnostics have no direct test found.
