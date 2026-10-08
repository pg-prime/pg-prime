# packages/pg-prime/src/schema/relations.ts

## Purpose
The schema registry and relation layer: `defineRelations` declares typed `one` / `maybeOne` / `many` relations, `defineSchema` builds the registry with table handles, and `resolveRelations` validates and resolves each relation to column keys, inferring correlations from foreign keys.
The query layer calls `resolveRelations` from `packages/pg-prime/src/query/relations.ts:531` and reads `Handle` / `TableOf` / `Loaded` types through the barrel. It reads `TableRuntime` columns and extras (`table.ts`, `extras.ts`) and `RefSpec` targets (`ddl.ts`). Relations produce no DDL.

## Public API
- `Tables` — `Record<string, AnyTable>`; `RelsRecord<T>` — optional `Rels` per table key.
- `RelConfigBase` — `from?`, `to?`, `through?`, `alias?`. Not on the barrel.
- `RelConfig<T>` — adds `where?: (refs) => boolean expr` and `orderBy?: (refs) => order`, typed over target `T[REFS]`.
- `RelBuilders<T>` — `one`, `maybeOne`, `many` namespaces, one picker per table key, each with a fixed `opt` literal.
- `RelNode` — runtime node `{ kind, opt, to, config }`.
- `defineRelations(tables, build)` — calls `build(r)` with the pickers and returns its result unchanged.
- `AnySchema`, `Schema<T, R>` — registry with `[TABLES]`, `[RELS]`, `tables`, `rels`, `h` (one handle per key).
- `Handle<Sc, N>` / `AnyHandle` — `{ [SCHEMA], [NAME], $: TableRuntime }`.
- `defineSchema(tables, rels?)` — builds frozen handles, eagerly resolves `rels`, returns a frozen `Schema`; throws `SchemaError`.
- `TableOf`, `RelsAt`, `ColsAt`, `SelAt` — indexed-access lookups into a schema type.
- `RelOut<M, O>` — `many` → `O[]`, `maybeOne` → `O | null`, `one` → `O`.
- `Loaded<H, K?, F?>` — structural type for a row with relations `K` loaded and columns `F` selected.
- `ResolvedRelation` — `name`, `kind`, `required`, `parent`, `target`, `from`, `to` (TS keys), `through`, `where`, `orderBy`, `alias`.
- `ResolvedThrough` — `{ table, from, to }` junction hop; `ResolvedRelations` — table key → name → relation.
- `resolveRelations(tables, rels)` — memoised resolve-and-validate; returns a frozen map.

## Flow
1. `defineRelations` builds null-prototype namespaces whose pickers return `RelNode`s (`packages/pg-prime/src/schema/relations.ts:105`–`:134`).
2. `defineSchema` freezes one handle per table key and calls `resolveRelations` when `rels` is given (`packages/pg-prime/src/schema/relations.ts:177`–`:184`).
3. `resolveRelations` looks up a two-level `WeakMap` keyed on `tables` then `rels` (`packages/pg-prime/src/schema/relations.ts:303`, `:309`).
4. `build` rejects relations on unknown tables and relation names equal to a column key (`packages/pg-prime/src/schema/relations.ts:337`, `:353`).
5. `one()` rejects an unknown target and a lone `from` or `to` (`packages/pg-prime/src/schema/relations.ts:376`, `:384`).
6. Without `through`: declared `from` / `to` are mapped by `keysOf`; otherwise `inferFk` is called — child → parent for `one`, inverse for `many` (`packages/pg-prime/src/schema/relations.ts:397`–`:410`).
7. With `through`: both junction hops are declared together with `from` / `to`, or both are inferred from the junction's FKs (`packages/pg-prime/src/schema/relations.ts:418`–`:461`).
8. `fkPaths` collects FKs from column `.references()` and `foreignKey` extras, deduped by correlation (`packages/pg-prime/src/schema/relations.ts:579`–`:606`).
9. `arity` and `compat` check list lengths and type-family compatibility per pair (`packages/pg-prime/src/schema/relations.ts:677`, `:700`).
10. `finish` freezes the result; `required` is `true` for `many` and `!opt` for `one` (`packages/pg-prime/src/schema/relations.ts:509`).

## Gotchas
- Zero or several candidate FKs are refused with the candidates listed; the resolver never picks one (`packages/pg-prime/src/schema/relations.ts:554`, `:562`).
- FK inference matches targets by table name and schema (`packages/pg-prime/src/schema/relations.ts:618`); `keysOf` for declared `from` / `to` checks the table name only (`packages/pg-prime/src/schema/relations.ts:733`).
- `compat` uses families (numerics, string types, `timestamptz` / `timestamp`) and compares array element types; other cross-type pairs throw (`packages/pg-prime/src/schema/relations.ts:643`–`:664`).
- Declaring `through.from` / `through.to` without `from` / `to` throws (`packages/pg-prime/src/schema/relations.ts:427`).
- `through: table` is recognised by the table's `$`; a `{ table }` object is the long form (`packages/pg-prime/src/schema/relations.ts:484`).
- Validation runs in `defineSchema` / `resolveRelations`, not in `defineRelations`; the memo is by object identity, so mutating a `rels` record after first resolution is not re-validated.
- Handles' `[SCHEMA]` is `undefined` at runtime (`packages/pg-prime/src/schema/relations.ts:179`).
- `RelOrderArg` restates `packages/pg-prime/src/query` shapes structurally because `packages/pg-prime/src/schema` may not import `packages/pg-prime/src/query` (`packages/pg-prime/src/schema/relations.ts:23`).

## Tests
- `packages/pg-prime/test/schema/schema.test.ts` — `defineRelations` nodes, `defineSchema` handles.
- `packages/pg-prime/test/schema/loaded.test.ts`, `ts-expect-error.probe.ts` — `Loaded<>` typing.
- `packages/pg-prime/test/schema/audit.test.ts` — type compatibility (E6), memo key (E7), frozen registry (E17).
- `packages/pg-prime/test/query/relations.test.ts` (describe "FK inference") — inference, ambiguity, composite, self-reference, schema-qualified matching.
- Run: `pnpm --filter pg-prime exec vitest run test/schema/schema.test.ts test/query/relations.test.ts`.
