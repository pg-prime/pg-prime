# packages/pg-prime/src/schema/extras.ts

## Purpose
Table-level declarations returned from `pgTable`'s third-argument callback: primary keys, indexes, unique / check / exclusion constraints, foreign keys, comments, rename hints, clustering and partitioning, each as a tagged `TableExtra` node.
`pgTable` stores the array on `TableRuntime.extras` (`packages/pg-prime/src/schema/table.ts:348`); readers are the kit's `packages/pg-prime-kit/src/schema/emit.ts`, FK inference in `relations.ts:598`, and `packages/pg-prime/src/errors/refs.ts:24`. Calls `checkName`, `fragmentDdlText`, `checkFkAction`, `isFragment`, `quoteIdentPart`.

## Public API
- `TableExtra` — union keyed by `node`: `primaryKey`, `index`, `comment`, `unique`, `check`, `foreignKey`, `exclude`, `renamedFrom`, `clusterOn`, `partitionBy`, `partitionOf`, `rls` (`{ force }`), `updatedAtTrigger` (`{ column }`, built by `trigger.ts`).
- `primaryKey(...refs)` / `primaryKey({ name?, columns })` — composite / named primary key; `PrimaryKeyInput` is the object form.
- `index(name, options?)` / `uniqueIndex(name, options?)` — return a mutable index builder; `.on(...keys)` returns the `index` node.
- Index builder methods: `using`, `where` (fragment), `include(...refs)`, `nullsNotDistinct`, `with(params)`, `fillfactor(10..100)`, `tablespace`, `concurrently(bool)`.
- `IndexOptions` — the same settings as an options object; `StorageParameters` — `Record<string, string | number | boolean>`.
- `IndexColumnLike` — `AnyRef | IndexColumn | IndexExpression | AnyFragment`; `IndexColumn` / `IndexExpression` add `desc`, `nulls`, `opclass`.
- `IndexItem` — resolved key: exactly one of `column` (DB name) / `expression` (text), plus `desc`, `nulls`, `opclass`; `IndexNulls` is `'first' | 'last'`.
- `unique(name?)` — builder with `nullsNotDistinct()` and terminal `.on(...refs)` for a UNIQUE constraint.
- `check(name, fragment)` — named table CHECK; the name is mandatory.
- `exclude(name)` — builder with `using`, `where`, `deferrable`, `initiallyDeferred`, `requires(ext)` and terminal `.on(...pairs)`.
- `ExcludePair` — `[ref | fragment, operator]`; `ExcludeItem` — resolved `{ element, operator }`.
- `foreignKey(input)` — composite or self-referencing FK; `ForeignKeyExtraInput` takes `columns`, a `references` thunk and `ForeignKeyOptions`.
- `comment(text)`, `renamedFrom(from)`, `clusterOn(index)` — single-field nodes.
- `partitionBy(strategy, key)` — `'range' | 'list' | 'hash'` and the key as text.
- `partitionOf(parent, bound, options?)` — child partition; `PartitionOfOptions` has the parent `schema`.
- `rls.enable()` / `rls.force()` — `{ node: 'rls', force }`; `force` implies enable (design/20 D3–D5).

## Flow
1. `pgTable` calls the extras callback once with the frozen refs and freezes the returned array (`packages/pg-prime/src/schema/table.ts:348`).
2. Column refs are reduced to DB names by `dbNames` / `refName`, which reject empty lists and non-refs (`packages/pg-prime/src/schema/extras.ts:129`, `:451`).
3. `index` / `uniqueIndex` validate the name, build an `IndexBuilder` and apply options through the same methods (`packages/pg-prime/src/schema/extras.ts:256`–`:266`).
4. `.on()` classifies each key: bare fragment → expression, `{ expression }` → expression item, `{ column }` → column item, otherwise a ref (`packages/pg-prime/src/schema/extras.ts:401`–`:421`).
5. The `index` node's `columns` lists only column keys; `items` is the full key list (`packages/pg-prime/src/schema/extras.ts:389`–`:390`).
6. `exclude().on()` checks each operator against an operator-character regex, parenthesises expressions and quotes column names (`packages/pg-prime/src/schema/extras.ts:545`, `:633`–`:647`).
7. `foreignKey` requires a function for `references`, stores it unresolved, and validates actions (`packages/pg-prime/src/schema/extras.ts:692`–`:710`).

## Gotchas
- Index, unique and exclude builders mutate themselves and return `this`; reusing one builder for two `.on()` calls shares every setting.
- `.with()` merges into earlier calls; `.include()` replaces. `with` values are not interpreted, only type- and finiteness-checked (`packages/pg-prime/src/schema/extras.ts:314`–`:338`).
- `concurrently` defaults to `true`; it is a generate-time flag, not a catalog fact (`packages/pg-prime/src/schema/extras.ts:58`–`:67`, `:254`).
- `nullsNotDistinct()` is accepted on a non-unique index.
- `index` node `columns` / `include` hold raw DB names; `exclude` items hold an already-quoted identifier (`packages/pg-prime/src/schema/extras.ts:647`).
- `requires()` stores only the extension name; the kit checks it against exported `pgExtension(...)` declarations (`packages/pg-prime-kit/src/schema/emit.ts:732`).
- `initiallyDeferred()` on `exclude` sets `deferrable` too; `foreignKey` uses `deferrable ?? initiallyDeferred`, so explicit `deferrable: false` plus `initiallyDeferred: true` passes through.
- `partitionBy` key and `partitionOf` bound are verbatim text, not validated beyond non-blank.
- Per-column index options are item objects, not methods on `Ref` (`packages/pg-prime/src/schema/extras.ts:186`–`:191`).
- The `foreignKey` error text suggests `() => [orgs.id]`; tables expose columns under `.cols` / `[REFS]`.

## Tests
- `packages/pg-prime/test/schema/ddl.test.ts` (describe "table extras") — node order, `unique`, `check`, `foreignKey` thunk, `renamedFrom`.
- `packages/pg-prime/test/schema/k4-additions.test.ts` — index options and item objects, named `primaryKey`, `clusterOn`, `partitionBy`, `partitionOf`.
- `packages/pg-prime/test/schema/g14-ddl-closeout.test.ts` — `exclude`, expression index keys, `with` / `fillfactor` / `tablespace` / `concurrently`.
- Kit emission: `packages/pg-prime-kit/test/schema-emit/emit.test.ts`, `test/pull/ddl-closeout.test.ts`.
- Run: `pnpm --filter pg-prime exec vitest run test/schema/ddl.test.ts test/schema/k4-additions.test.ts test/schema/g14-ddl-closeout.test.ts`.
