# packages/pg-prime/src/schema/index.ts

## Purpose
Barrel for the schema layer and the target of the `pg-prime/schema` subpath export (`packages/pg-prime/package.json:29`).
Re-exports the public surface of `symbols.ts`, `types.ts`, `ref.ts`, `ddl.ts`, `column.ts`, `extras.ts`, `objects.ts`, `table.ts`, `view.ts` and `relations.ts`. Imported by `packages/pg-prime/src/index.ts` (`packages/pg-prime/src/index.ts:77`, `:183`, `:205`), by `packages/pg-prime/src/query/*` and `packages/pg-prime/src/session/*`, and by code `pull` generates (`packages/pg-prime-kit/src/pull/emit-ts.ts:434`).

## Public API
- Phantom keys from `symbols.ts`: `COLS`, `DATE_BRAND`, `ERR`, `INS`, `META`, `NAME`, `OUT`, `READONLY`, `REFS`, `RELS`, `SCHEMA`, `SEL`, `SRC`, `TABLES`, `UPD`.
- Types from `types.ts`: `ColMeta`, `Cols`, `DateString`, `Defer`, `InsertRow`, `OrmTypeError`, `RelMeta`, `Rels`, `SelectRow`, `Simplify`, `UpdateRow`.
- From `ref.ts`: `AnyRef`, `Projectable`, `Ref`, `RefRuntime`, `RefsOfCols`.
- From `ddl.ts`: `fragmentDdlText`; types `CheckSpec`, `FkAction`, `ForeignKeyOptions`, `RefLike`, `RefSpec`, `UniqueSpec`.
- From `column.ts`: the column factories, `pgEnum`, `enumColumn`, `raw`, `kit`, `VECTOR_MAX_DIMENSIONS`, and the `Col` / `ColumnDdl` / `PgEnum` family of types.
- From `extras.ts`: `check`, `clusterOn`, `comment`, `exclude`, `foreignKey`, `index`, `partitionBy`, `partitionOf`, `primaryKey`, `renamedFrom`, `unique`, `uniqueIndex`, and their input / node types.
- From `objects.ts`: `pgDomain`, `pgExtension`, `pgSequence` and their option / result types.
- From `table.ts`: `pgSchema`, `pgTable`, `snakeCase`, `table`, plus `Table`, `TableRuntime`, row-shape aliases and options.
- From `view.ts`: `isView`, `pgMaterializedView`, `pgView`, plus the view handle, builder and runtime types.
- From `relations.ts`: `defineRelations`, `defineSchema`, `resolveRelations`, plus `Schema`, `Handle`, `Loaded`, `ResolvedRelation` and the lookup types.

## Flow
1. Pure re-exports; no runtime code of its own (`packages/pg-prime/src/schema/index.ts:2`–`:174`).
2. Every phantom key is re-exported because exported types reference them (TS2527) (`packages/pg-prime/src/schema/index.ts:1`).

## Gotchas
- Internal helpers are exported from their modules but deliberately absent here: `checkName` (`column.ts`), `checkFkAction` (`ddl.ts`), `TableImpl` and `buildColumnRefs` (`table.ts`), `RelConfigBase` (`relations.ts`).
- `packages/pg-prime/src/schema` must not import `packages/pg-prime/src/query`; shapes needed from there are restated structurally (`packages/pg-prime/src/schema/relations.ts:23`).
- The kit imports these types only (`packages/pg-prime-kit/src/schema/types.ts`); a value import there fails `packages/pg-prime-kit/test/schema-emit/no-value-import.test.ts`.

## Tests
- Every `packages/pg-prime/test/schema/*.test.ts` except `typecheck.test.ts` imports through this barrel (`../../src/schema/index.js`).
- `packages/pg-prime/test/schema/typecheck.test.ts` runs a `declaration: true` emit to catch unexported symbols.
- Run: `pnpm --filter pg-prime exec vitest run test/schema`.
