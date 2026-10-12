# packages/pg-prime-testing/src/expect-sql.ts

## Purpose
The golden-string assertion for compiled SQL: `expectSql` compiles a query, compares its whitespace-normalised text (and optionally its wire binds) to an expectation, and throws an `Error` carrying a unified diff on mismatch. Meant to pair with `pg-prime`'s `compileOnly(schema)` for no-database tier-0 tests. Re-exported by `packages/pg-prime-testing/src/index.ts:40`; imports nothing (structural types only).

## Public API
- `CompiledLike` — `{ sql: string; binds: readonly unknown[] }`; `pg-prime`'s `Compiled<Row>` satisfies it.
- `CompilableLike` — anything with `compile(): CompiledLike` (every query-builder terminal).
- `SqlExpectation` — `{ text: string; values?: readonly unknown[] }`; `values` are wire values, omit to check text only.
- `expectSql(query, expected): CompiledLike` — asserts, returns the compiled artifact; throws `Error('expectSql: SQL did not match…')`.
- `normaliseSql(sql): string` — trims every line, collapses runs of spaces/tabs, drops blank lines.

## Flow
1. `expectSql` calls `query.compile()` once (`packages/pg-prime-testing/src/expect-sql.ts:72`).
2. Both texts go through `normaliseSql` and are compared as strings; a mismatch pushes a line diff labelled `sql` (`:73-78`).
3. If `expected.values` is given, each bind is mapped through `bindValue` (`:80`): `{k:'value'}` → `encoded`, `{k:'slot'}` → `':' + name`, anything else as-is (`:114-120`).
4. Values are compared element-wise by `sameValue`: byte equality for `Uint8Array`, else `Object.is` or equal `showValue` renderings (`:127-132`); a mismatch pushes a diff labelled `values`.
5. Any problem throws one `Error` whose message joins both diffs (`:87`); otherwise the compiled object is returned (`:88`).
6. Diffs are hand-rolled LCS (`lcsDiff`, `:159`) printed as `--- expected <label>` / `+++ actual <label>` with ` `/`-`/`+` prefixes (`:152-156`).

## Gotchas
- `normaliseSql` does not respect string literals: it would collapse spaces inside one too (`:100`). Safe only because `pg-prime` emits every value as `$n`.
- Newlines are significant: normalisation keeps line structure, so a golden must break lines where the compiler does.
- `values` compare post-codec wire values (`'1'` for a `bigint`, serialised JSON for `jsonb`), not the inputs passed to the builder (`:56-62`).
- Value comparison falls back to `showValue` string equality (`:131`), so e.g. `1` and `'1'` differ (`showValue` JSON-quotes strings) but two structurally equal objects match via `JSON.stringify`.
- A prepared query's unfilled slot shows as `:name`; an expected `':name'` string matches it.
- Throws a plain `Error`, not a runner assertion error, so it works under any runner.

## Tests
- `packages/pg-prime-testing/test/unit/expect-sql.test.ts` (schema fixture in `test/unit/_schema.ts`): indented goldens, no-database use via `compileOnly`, text diff and bind diff messages, wire-value binds, text-only when `values` omitted, `normaliseSql` rules.
- Run: `pnpm --filter @pg-prime/testing exec vitest run test/unit/expect-sql.test.ts`.
- Uncovered: `Uint8Array` binds and slot (`:name`) rendering have no dedicated case.
