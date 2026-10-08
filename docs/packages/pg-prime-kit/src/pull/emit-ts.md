# packages/pg-prime-kit/src/pull/emit-ts.ts

## Purpose
Renders a `SchemaIR` (from `extractCatalog`) as a deterministic `pg-prime/schema` DSL TypeScript file for `pg-prime pull`. Anything it cannot express exactly is listed in an `-- pull: unsupported` comment block and the returned `unsupported` list instead of being emitted approximately. Called only by `pullSchema` (`packages/pg-prime-kit/src/pull/pull.ts:60`); uses `parseConstraintDef`/`parseIndexDef` from `pull/parse.ts`.

## Public API
- `UnsupportedItem` — `{ kind, name, reason }`, one residue line.
- `EmitTsResult` — `{ ts, unsupported, counts }`; `counts` keyed by `schema`, `extension`, `enum`, `domain`, `sequence`, `table`, `rlsTable`.
- `EmitTsOptions` — `{ schemas, sqlDir?, repeatableCount?, extraUnsupported? }`; the first three feed the file header, `extraUnsupported` is merged into the residue block.
- `emitTypeScript(ir, options)` — returns `EmitTsResult`; does not throw for unsupported shapes.
- `camel(name)` — snake/space/PascalCase identifier to camelCase; prefixes `_` when it would start with a digit.
- `splitIdentifierList` — re-export from `pull/parse.ts`.

## Flow
1. Index comment facts by encoded target id (`packages/pg-prime-kit/src/pull/emit-ts.ts:220`).
2. Claim unique, non-reserved JS const names (`Names`) for non-`public` schemas, enums, domains, sequences and tables, each list sorted by qualified name (`packages/pg-prime-kit/src/pull/emit-ts.ts:154`).
3. Drop composite types, partitioned parents without a key, non-permanent (unlogged/temp) tables and partitions without a bound to residue (`packages/pg-prime-kit/src/pull/emit-ts.ts:246`, `:264`).
4. Order tables with `dependencyOrder`: DFS over FK targets and partition parents, roots sorted by name; cycles are left to the FK thunk (`packages/pg-prime-kit/src/pull/emit-ts.ts:796`).
5. Emit `pgSchema`, `pgExtension`, `pgEnum` (labels by `ordinal`), `pgDomain` (CHECKs unwrapped via `parseConstraintDef("c", …)`) and `pgSequence` declarations (`packages/pg-prime-kit/src/pull/emit-ts.ts:293`–`:399`).
6. `renderTable` for each ordered table: columns by `ordinal` with camelCase keys, `pgTable` or `<schemaConst>.table`, plus extras (`packages/pg-prime-kit/src/pull/emit-ts.ts:465`).
7. `renderColumn`: enum → `t.enum`, exact `BUILDERS` match → `t.<builder>`, otherwise `t.raw(<format_type>)`; then `.array()`, `.collate()` for a non-default collation, identity, `.nullable()`, `.defaultSql`, `.generatedAlwaysAs(sql.unsafeRaw(…))`, `.comment` (`packages/pg-prime-kit/src/pull/emit-ts.ts:521`).
8. `renderExtras`: `partitionOf`/`partitionBy`, `comment`, `clusterOn`, then PK, uniques, checks, excludes, FKs, and indexes of the same schema whose parsed table matches (`packages/pg-prime-kit/src/pull/emit-ts.ts:581`).
9. Append `export default defineSchema({ … })` over the ordered tables (`packages/pg-prime-kit/src/pull/emit-ts.ts:408`).
10. Prepend header, sorted residue block and imports (only `sql`/`RefLike` when used), collapse blank-line runs (`packages/pg-prime-kit/src/pull/emit-ts.ts:433`).

## Gotchas
- `BUILDERS` is an exact-string table of eleven `format_type` outputs; `character varying(40)` is not `varchar` and goes to `t.raw` to keep the length (`packages/pg-prime-kit/src/pull/emit-ts.ts:178`).
- Every column passes its DB name explicitly; the TS key is invented by `camel` and deduped with a numeric suffix.
- Residue (never emitted): composite types, unlogged/temp tables, virtual (`v`) generated columns, NOT NULL NOT VALID, NOT VALID constraints, any def `parse.ts` rejects, FKs to tables outside the managed set, invalid indexes.
- `.collate()` carries the bare `collname`; a column collation from a non-`pg_catalog` schema is emitted unqualified.
- Only table, column, enum and domain comments are emitted; comments on schemas, constraints, indexes and sequences are neither emitted nor listed as residue.
- `.defaultSql` is skipped on identity columns (`packages/pg-prime-kit/src/pull/emit-ts.ts:548`); `.generatedAlwaysAs` comes after `.nullable()` because of the DSL's type-level gating.
- Self-referencing FKs use `t.<key>`; cross-table FKs use `<const>.cols.<key>` with a `(): readonly RefLike[]` thunk to avoid TS7022/TS7024 (`packages/pg-prime-kit/src/pull/emit-ts.ts:669`).
- Indexes are matched to tables by parsed `schema.table`; an unparseable index is reported only if `indexBelongsHere` finds the table name in its text (`packages/pg-prime-kit/src/pull/emit-ts.ts:782`).
- `.using` is omitted for `btree`; `.with` values stay strings; EXCLUDE never gets `.requires()`.
- RLS-enabled tables are emitted normally and only counted (`rlsTable`); enablement is written by `pull/tier-r.ts`.
- Partition key text is unwrapped from `RANGE (…)` by regex before `partitionBy` (`packages/pg-prime-kit/src/pull/emit-ts.ts:503`).

## Tests
- `packages/pg-prime-kit/test/pull/roundtrip.test.ts` — chinook, northwind, adventureworks, pagila: pull → `migrate generate` is `up_to_date`, second pull byte-identical, residue matches an exact per-corpus expectation (all empty).
- `packages/pg-prime-kit/test/pull/ddl-closeout.test.ts` — asserts emitted text for EXCLUDE, generated columns, expression indexes, `.with`, domain/type comments; empty residue; repeats as a `NOCREATEDB` role.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/pull` (needs a real PostgreSQL server, `PG_PRIME_TEST_URL`; spawns the built CLI).
- `packages/pg-prime-kit/test/collate.test.ts` calls `emitTypeScript` directly and asserts `.collate("C")` on a scalar and an array column with empty residue.
- `camel` has no direct test; residue branches (composite, unlogged, NOT VALID) are not asserted.
