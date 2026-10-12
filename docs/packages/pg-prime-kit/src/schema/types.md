# packages/pg-prime-kit/src/schema/types.ts

## Purpose
The kit's structural, type-only view of a `pg-prime` DSL schema: re-exports the DSL's runtime-metadata types and defines the minimal `SchemaLike` registry shape the emitter, view renderer and declared lane consume. Imported by `schema/emit.ts`, `schema/load.ts`, `schema/views.ts`, `schema/declared.ts`, `generate.ts` and the `generate`/`verify`/`check`/`push` commands; populated by `loadSchema` in `packages/pg-prime-kit/src/config/load.ts:314`. Re-exported as types from `packages/pg-prime-kit/src/index.ts:263`.

## Public API
- Re-exported `pg-prime` types: `ColumnDdl`, `PgDomain`, `PgEnum`, `PgExtension`, `PgSchema`, `PgSequence`, `PolicyRuntime`, `RefRuntime`, `TableExtra`, `TableRuntime`, `ViewInfo`, `ViewRuntime`.
- `TableLike` — `{ $: TableRuntime }`, one table from `defineSchema(...)`.
- `ViewLike` — `{ $: ViewRuntime }`, one `pgView`/`pgMaterializedView`; distinguished from a table by a populated `$.view`.
- `PolicyLike` — `{ kind: "policy", name, $: PolicyRuntime }`, one `definePolicy(...)` declaration.
- `SchemaLike` — `{ tables, enums?, domains?, sequences?, extensions?, schemas?, views?, policies? }`; `pg-prime`'s `Schema<T, R>` and a bare `{ tables }` literal are both assignable.

## Flow
1. `loadSchema` (`packages/pg-prime-kit/src/config/load.ts:314`) walks the user's schema module exports and builds a `SchemaLike`, collecting enums, domains, sequences, extensions, `pgSchema`s, views and policies from the module's own exports.
2. `emitSchema` reads `tables`, `enums`, `domains`, `sequences`, `extensions`, `schemas` to emit DDL.
3. `renderViewRepeatables` reads `views` and `renderDeclared` reads `policies` plus the `rls`/`updatedAtTrigger` table extras, rendering them into the `sql/` lane; neither goes through `emitSchema`.

## Gotchas
- `pg-prime` is a peer dependency and must be imported with `import type` only; `test/schema-emit/no-value-import.test.ts` greps `src/` and fails on any value import.
- The standalone object lists are not properties of `defineSchema(...)`; they are optional so a `{ tables }` literal remains a valid `SchemaLike` in tests.
- The kit only looks at `ColumnDdl`/runtime metadata, never a column's TypeScript type.

## Tests
- `packages/pg-prime-kit/test/schema-emit/no-value-import.test.ts` — enforces the type-only import rule across `src/`.
- Used as the input type in `test/schema-emit/*.test.ts` and `test/generate/*.test.ts`.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/schema-emit/no-value-import.test.ts` (no database needed for this spec, though the kit's global setup still builds `dist/` and probes for `pg_dump`).
- No runtime code to test beyond type-checking (`pnpm --filter @pg-prime/kit typecheck`).
