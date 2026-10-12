# packages/pg-prime/src/errors/refs.ts

## Purpose
Resolves a PostgreSQL constraint name (or a NOT NULL table/column pair) into the schema objects the user
declared, so class-23 errors carry `constraint`, `table` and `columns`. `errors/map.ts` calls
`resolveConstraint` and `describeConstraint`; `errors/predicates.ts` and `errors/classes.ts` use its types.
It reads `TableRuntime`, `RefRuntime` and `TableExtra` from `schema/*` structurally. The types are public
via `src/index.ts`.

## Public API
- `TableRef` — `{ $: TableRuntime }`; a `pgTable(...)` or `defineSchema` handle satisfies it.
- `ColumnRef` — `{ $: RefRuntime }`; e.g. `users.cols.email`.
- `ConstraintKind` — `'unique' | 'primaryKey' | 'foreignKey' | 'check' | 'exclusion' | 'notNull'`.
- `ConstraintRef` — `kind`, `name`, `table`, `columns`, optional `referencedTable`, `referencedColumns`.
- `constraintIndex(schema): ReadonlyMap<string, ConstraintRef>` — built once per schema object, cached.
- `resolveConstraint(schema, constraintName, tableName, columnName): ConstraintRef | undefined`.
- `describeConstraint(ref): string` — `table(col, …)`, or the table name when there are no columns.

## Flow
1. `constraintIndex` returns a shared empty map for `undefined`, else a `WeakMap` hit, else builds from
   `schema.tables` (`packages/pg-prime/src/errors/refs.ts:220`).
2. `indexTable` registers per-column `unique`, `references` and `checks`, using the declared name or
   PostgreSQL's default (`<t>_<cols>_key`, `<t>_<cols>_fkey`, `<t>_<col>_check`) (`packages/pg-prime/src/errors/refs.ts:112`).
3. Column primary keys are combined into one `<t>_pkey` entry (`packages/pg-prime/src/errors/refs.ts:150`).
4. Table extras add `primaryKey`, `unique`, named unique `index`, named `check`, and `foreignKey` entries
   (`packages/pg-prime/src/errors/refs.ts:154`).
5. FK targets are resolved by calling the user's thunk inside `try`; a throw yields no target
   (`packages/pg-prime/src/errors/refs.ts:197`).
6. `resolveConstraint` looks the name up in the index; on a miss with both table and column it scans
   `schema.tables` for a matching table and column and returns a synthetic `notNull` ref
   (`packages/pg-prime/src/errors/refs.ts:245`).

## Gotchas
- The index is built lazily on the first constraint error, not at startup, and cached per schema object
  in a `WeakMap` (`packages/pg-prime/src/errors/refs.ts:61`).
- First registration wins when two constraints map to the same name (`packages/pg-prime/src/errors/refs.ts:117`).
- Unnamed table-level checks and unnamed unique indexes are not indexed (`add` skips `undefined` names)
  (`packages/pg-prime/src/errors/refs.ts:116`).
- `resolveTarget` only sets `referencedColumns`; `referencedTable` is never populated
  (`packages/pg-prime/src/errors/refs.ts:213`).
- The `notNull` fallback is not gated on SQLSTATE `23502`: any unresolved name with a table and column
  becomes kind `notNull` (`packages/pg-prime/src/errors/refs.ts:256`).
- Table matching compares `t.$.name` to the server's table name only; the PostgreSQL schema is ignored, so
  same-named tables in different schemas resolve to the first one.
- Synthesized `ColumnRef`s are new wrappers; equality with user refs is structural (table + `dbName`) in
  `errors/predicates.ts`, never by identity (`packages/pg-prime/src/errors/refs.ts:86`).
- PostgreSQL's default-name truncation to 63 bytes is not modelled; long default names will not match.

## Tests
- `packages/pg-prime/test/session/session.test.ts` (unit), `constraint → schema object (07 §4.4)` at line 867:
  default-named unique, PK and FK resolution, undeclared constraints degrading to the server message, NOT NULL
  by (table, column), `isUniqueViolation` with column refs.
- Run: `pnpm --filter pg-prime exec vitest run test/session/session.test.ts`.
- Uncovered: table-extra entries (`uniqueIndex`, named checks), FK thunks that throw, and the cache.
