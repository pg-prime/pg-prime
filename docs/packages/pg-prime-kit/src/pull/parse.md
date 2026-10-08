# packages/pg-prime-kit/src/pull/parse.ts

## Purpose
A recogniser (not a SQL parser) for PostgreSQL's own `pg_get_constraintdef` and `pg_get_indexdef` output, turning them into structured specs that `pull` renders as DSL calls. Every function returns `null` for anything it does not recognise with certainty, and the caller records that as residue. Used only by `packages/pg-prime-kit/src/pull/emit-ts.ts:40`.

## Public API
- `splitIdentifierList(text)` — splits on top-level commas (parenthesis-aware) and unquotes `"…"` identifiers, returning `string[]`.
- `ExcludeItemSpec` — `{ column, expression, operator }`; exactly one of `column`/`expression` is non-null.
- `ParsedConstraint` — discriminated union: `primaryKey { columns }`, `unique { columns, nullsNotDistinct }`, `check { expression }`, `exclude { using, items, where, deferrable, initiallyDeferred }`, `foreignKey { columns, targetSchema, targetTable, targetColumns, onDelete, onUpdate, deferrable, initiallyDeferred }`.
- `parseConstraintDef(contype, definition)` — recognises `p`/`u`/`c`/`x`/`f` definitions; returns `ParsedConstraint | null`.
- `IndexItemSpec` — `{ column, expression, desc, nulls, opclass }` for one index key.
- `ParsedIndex` — `{ schema, table, unique, using, items, include, nullsNotDistinct, where, with, tablespace }`.
- `parseIndexDef(definition, _name)` — recognises a templatized `CREATE [UNIQUE] INDEX %ID% ON …`; returns `ParsedIndex | null`. `_name` is unused.

## Flow
1. `parseConstraintDef` dispatches on `contype` (`packages/pg-prime-kit/src/pull/parse.ts:184`).
2. PK/UNIQUE/CHECK: match the keyword, take one balanced `(…)` with `balanced()` (quote- and string-literal-aware), and require an empty tail (`packages/pg-prime-kit/src/pull/parse.ts:64`).
3. EXCLUDE: `parseExcludeDef` reads optional `USING`, splits elements, splits each at the top-level ` WITH ` into element and operator, then optional `WHERE (…)` and `DEFERRABLE [INITIALLY DEFERRED]` (`packages/pg-prime-kit/src/pull/parse.ts:288`).
4. FOREIGN KEY: local columns, `REFERENCES` qualified name, remote columns, then a loop over `ON DELETE/UPDATE`, `DEFERRABLE`, `NOT DEFERRABLE`, `INITIALLY IMMEDIATE` (`packages/pg-prime-kit/src/pull/parse.ts:233`).
5. `parseIndexDef` matches the `%ID%` header, the qualified table, optional `USING`, then the key list (`packages/pg-prime-kit/src/pull/parse.ts:403`).
6. Each key is tried as a column (`parseIndexItem`: name, opclass, ASC/DESC, NULLS) and then as an expression (`parseIndexExpressionItem`: modifiers peeled from the right, remainder must end in `)`) (`packages/pg-prime-kit/src/pull/parse.ts:424`).
7. Then optional `INCLUDE (…)`, `NULLS NOT DISTINCT`, `WITH (k='v', …)`, `TABLESPACE`, and `WHERE` (rest of string); any other leftover returns `null` (`packages/pg-prime-kit/src/pull/parse.ts:430`).

## Gotchas
- Input is assumed to be PostgreSQL's serialization; the grammar is deliberately narrow and the expression bodies (CHECK, WHERE, index expressions) are passed through verbatim for `sql.unsafeRaw`.
- Constraint definitions arrive without ` NOT VALID`: the extractor strips it into `ConstraintPayload.validated`.
- Recognised-as-residue cases: `CHECK … NO INHERIT`, FK `MATCH FULL/PARTIAL` (`packages/pg-prime-kit/src/pull/parse.ts:232`), FK `SET NULL (cols)`/`SET DEFAULT (cols)`, EXCLUDE elements with opclass/collation/direction, index keys with `COLLATE`, operators containing letters or quotes.
- An unqualified FK target or index table falls back to schema `public` (`packages/pg-prime-kit/src/pull/parse.ts:217`, `:407`); `extractCatalog` runs with `search_path = pg_catalog`, so user objects normally arrive qualified.
- `splitIdentifierList` tracks double quotes and parentheses but not single-quoted strings; `WITH` keys are re-validated as identifiers so a comma inside a reloption value becomes `null` instead of a bogus key (`packages/pg-prime-kit/src/pull/parse.ts:464`).
- `WITH` values are unquoted to plain strings; an empty `WITH ()` yields `with: null`.
- `NOT DEFERRABLE` and `INITIALLY IMMEDIATE` are consumed for FKs but not for EXCLUDE.

## Tests
- No spec imports this module directly. It is covered end to end through `pull`: `packages/pg-prime-kit/test/pull/ddl-closeout.test.ts` (EXCLUDE with `WHERE` and `DEFERRABLE INITIALLY DEFERRED`, expression index, `WITH (fillfactor)`) and `packages/pg-prime-kit/test/pull/roundtrip.test.ts` (four third-party corpora with empty residue).
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/pull` (needs a real PostgreSQL server, `PG_PRIME_TEST_URL`).
- Uncovered: the `null` (residue) branches — `MATCH FULL`, `NO INHERIT`, `COLLATE` keys, EXCLUDE opclasses — have no assertions.
