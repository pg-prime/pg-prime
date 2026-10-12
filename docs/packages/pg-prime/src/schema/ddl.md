# packages/pg-prime/src/schema/ddl.ts

## Purpose
DDL-affecting runtime metadata shared by column modifiers and table extras: foreign-key / check / unique specs, referential-action validation, and `fragmentDdlText`, which renders a `sql` fragment to DDL text.
Called by `column.ts` (`.references`, `.check`, `.generatedAlwaysAs`), `extras.ts`, `table.ts` (late-bound generation) and `view.ts` (view bodies). Calls `toNode` from `packages/pg-prime/src/sql/fragment.ts` and `quoteIdentPart` from `packages/pg-prime/src/sql/ident.ts`; specs are read by the kit's `packages/pg-prime-kit/src/schema/emit.ts`.

## Public API
- `FkAction` — `'cascade' | 'restrict' | 'no action' | 'set null' | 'set default'`.
- `checkFkAction(value, what)` — returns the action or `undefined`; throws `SchemaError` for anything else. Not on the barrel.
- `ForeignKeyOptions` — `{ name?, onDelete?, onUpdate?, deferrable?, initiallyDeferred? }` for `.references()` and `foreignKey()`.
- `RefSpec` — resolved-later FK: `target` thunk returning `RefLike[]`, plus name, actions and deferral flags.
- `RefLike` — structural ref: `{ $: { table, schema, dbName } }`.
- `CheckSpec` — `{ name, expression }` with the expression as DDL text.
- `UniqueSpec` — `{ name, nullsNotDistinct }`.
- `fragmentDdlText(fragment, what)` — renders a `sql` fragment to DDL text; throws `SchemaError` on bind parameters or unrenderable parts.

## Flow
1. `fragmentDdlText` converts the fragment to a `RawNode` and concatenates chunks with rendered parts (`packages/pg-prime/src/schema/ddl.ts:103`–`:113`).
2. `ident` renders its quoted text, `unsafeRaw` its text, `col` its qualified name, `lit` `String(value)` or `NULL` (`packages/pg-prime/src/schema/ddl.ts:120`–`:127`).
3. A `param` whose value is a column reference (has `$.dbName`) renders as the quoted DB name (`packages/pg-prime/src/schema/ddl.ts:128`–`:130`, `:146`).
4. Any other `param` throws: a CHECK is stored as a parsed expression and can hold no `$n` (`packages/pg-prime/src/schema/ddl.ts:131`).
5. Any other part kind throws a `SchemaError` naming the kind (`packages/pg-prime/src/schema/ddl.ts:137`).

## Gotchas
- Column refs render as bare quoted names, unqualified by table — correct inside CHECK, index and generation expressions, not for cross-table text.
- `sql.lit(...)` is the way to embed a number/boolean; an interpolated plain value is a bind parameter and is refused.
- Nothing here is reachable from `ColMeta`, so adding a field costs no type instantiations (`packages/pg-prime/src/schema/ddl.ts:4`).
- `RefSpec.target` is a thunk the kit calls at emit time (`packages/pg-prime/src/schema/ddl.ts:51`); an exception in it surfaces there, not at declaration.
- `deferrable` is not derived here: callers compute `deferrable ?? initiallyDeferred ?? false` (`packages/pg-prime/src/schema/column.ts:429`, `packages/pg-prime/src/schema/extras.ts:707`).

## Tests
- `packages/pg-prime/test/schema/ddl.test.ts` — `.check()` text rendering, ref-as-identifier, bind-parameter and empty-expression refusals, `.references()` actions.
- `packages/pg-prime/test/schema/g14-ddl-closeout.test.ts` — fragment rendering in `generatedAlwaysAs`, `exclude`, index expressions.
- Run: `pnpm --filter pg-prime exec vitest run test/schema/ddl.test.ts test/schema/g14-ddl-closeout.test.ts`.
- Uncovered: the `default` branch for unrenderable part kinds has no dedicated test found.
