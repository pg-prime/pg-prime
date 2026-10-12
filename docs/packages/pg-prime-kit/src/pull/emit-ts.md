# packages/pg-prime-kit/src/pull/emit-ts.ts

## Purpose
Renders a `SchemaIR` (from `extractCatalog`) as a deterministic `pg-prime/schema` DSL TypeScript file for `pg-prime pull`. Anything it cannot express exactly is listed in an `-- pull: unsupported` comment block and the returned `unsupported` list instead of being emitted approximately. Called only by `pullSchema` (`packages/pg-prime-kit/src/pull/pull.ts:75`); uses `parseConstraintDef`/`parseIndexDef` from `pull/parse.ts`.

## Public API
- `UnsupportedItem` — `{ kind, name, reason }`, one residue line.
- `EmitTsResult` — `{ ts, unsupported, counts }`; `counts` keyed by `schema`, `extension`, `enum`, `domain`, `sequence`, `table`, `rlsTable`, `policy`.
- `EmitTsOptions` — `{ schemas, sqlDir?, repeatableCount?, extraUnsupported?, lane? }`; the first three feed the file header, `extraUnsupported` is merged into the residue block, `lane` (a `LaneState`) supplies FORCE flags, policies and the `updatedAtTrigger`s to write.
- `emitTypeScript(ir, options)` — returns `EmitTsResult`; does not throw for unsupported shapes.
- `camel(name)` — snake/space/PascalCase identifier to camelCase; prefixes `_` when it would start with a digit.
- `splitIdentifierList` — re-export from `pull/parse.ts`.

## Flow
1. Index comment facts by encoded target id (`packages/pg-prime-kit/src/pull/emit-ts.ts:223`).
2. Claim unique, non-reserved JS const names (`Names`) for non-`public` schemas, enums, domains, sequences and tables, each list sorted by qualified name (`packages/pg-prime-kit/src/pull/emit-ts.ts:157`).
3. Drop composite types, partitioned parents without a key, non-permanent (unlogged/temp) tables and partitions without a bound to residue (`packages/pg-prime-kit/src/pull/emit-ts.ts:249`, `:267`).
4. Order tables with `dependencyOrder`: DFS over FK targets and partition parents, roots sorted by name; cycles are left to the FK thunk (`packages/pg-prime-kit/src/pull/emit-ts.ts:837`).
5. Emit `pgSchema`, `pgExtension`, `pgEnum` (labels by `ordinal`), `pgDomain` (CHECKs unwrapped via `parseConstraintDef("c", …)`) and `pgSequence` declarations (`packages/pg-prime-kit/src/pull/emit-ts.ts:292`–`:398`).
6. `renderTable` for each ordered table: columns by `ordinal` with camelCase keys, `pgTable` or `<schemaConst>.table`, plus extras (`packages/pg-prime-kit/src/pull/emit-ts.ts:489`).
7. `renderColumn`: enum → `t.enum`, exact `BUILDERS` match → `t.<builder>`, otherwise `t.raw(<format_type>)`; then `.array()`, `.collate()` for a non-default `pg_catalog` collation, identity, `.nullable()`, `.defaultSql`, `.generatedAlwaysAs(sql.unsafeRaw(…))`, `.comment` (`packages/pg-prime-kit/src/pull/emit-ts.ts:555`).
8. `renderExtras`: `partitionOf`/`partitionBy`, `comment`, `clusterOn`, `rls.force()` or `rls.enable()`, `updatedAtTrigger(t.<key>)`, then PK, uniques, checks, excludes, FKs, and indexes of the same schema whose parsed table matches (`packages/pg-prime-kit/src/pull/emit-ts.ts:622`).
9. One exported `definePolicy` per policy (`for`, `as`, `to` only when not the default; `using`/`withCheck` as `() => sql.unsafeRaw(<pg_get_expr text>)`, omitted when null), then `export default defineSchema({ … })` over the ordered tables (`packages/pg-prime-kit/src/pull/emit-ts.ts:432`).
10. Prepend header, sorted residue block and imports (only `sql`/`RefLike` when used), collapse blank-line runs (`packages/pg-prime-kit/src/pull/emit-ts.ts:457`).

## Gotchas
- `BUILDERS` is an exact-string table of eleven `format_type` outputs; `character varying(40)` is not `varchar` and goes to `t.raw` to keep the length (`packages/pg-prime-kit/src/pull/emit-ts.ts:181`).
- Every column passes its DB name explicitly; the TS key is invented by `camel` and deduped with a numeric suffix.
- Residue (never emitted): composite types, unlogged/temp tables, column collations outside `pg_catalog` (a payload starting with `"`), virtual (`v`) generated columns, NOT NULL NOT VALID, NOT VALID constraints, any def `parse.ts` rejects, FKs to tables outside the managed set, invalid indexes.
- Only table, column, enum and domain comments are emitted; comments on schemas, constraints, indexes and sequences are neither emitted nor listed as residue.
- `.defaultSql` is skipped on identity columns (`packages/pg-prime-kit/src/pull/emit-ts.ts:589`); `.generatedAlwaysAs` comes after `.nullable()` because of the DSL's type-level gating.
- Self-referencing FKs use `t.<key>`; cross-table FKs use `<const>.cols.<key>` with a `(): readonly RefLike[]` thunk to avoid TS7022/TS7024 (`packages/pg-prime-kit/src/pull/emit-ts.ts:710`).
- Indexes are matched to tables by parsed `schema.table`; an unparseable index is reported only if `indexBelongsHere` finds the table name in its text (`packages/pg-prime-kit/src/pull/emit-ts.ts:823`).
- `.using` is omitted for `btree`; `.with` values stay strings; EXCLUDE never gets `.requires()`.
- `rls.force()` is written only for a table that is also enabled: FORCE without ENABLE is inert and `rls.force()` implies ENABLE. A policy on a table pull could not emit is residue. Policies are not in `defineSchema`; they are export-discovered.
- Partition key text is unwrapped from `RANGE (…)` by regex before `partitionBy` (`packages/pg-prime-kit/src/pull/emit-ts.ts:527`).

## Tests
- `packages/pg-prime-kit/test/pull/roundtrip.test.ts` — chinook, northwind, adventureworks, pagila: pull → `migrate generate` is `up_to_date`, second pull byte-identical, residue matches an exact per-corpus expectation (all empty).
- `packages/pg-prime-kit/test/pull/rls.test.ts` — `rls.*()`, `updatedAtTrigger` and `definePolicy` text, byte-stable re-pull (needs `CREATE ROLE`).
- `packages/pg-prime-kit/test/pull/ddl-closeout.test.ts` — asserts emitted text for EXCLUDE, generated columns, expression indexes, `.with`, domain/type comments; empty residue; repeats as a `NOCREATEDB` role.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/pull` (needs a real PostgreSQL server, `PG_PRIME_TEST_URL`; spawns the built CLI).
- `packages/pg-prime-kit/test/collate.test.ts` calls `emitTypeScript` directly and asserts `.collate("C")` on a scalar and an array column with empty residue, and a `public` collation listed as residue.
- `camel` has no direct test; residue branches (composite, unlogged, NOT VALID) are not asserted.
