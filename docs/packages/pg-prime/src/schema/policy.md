# packages/pg-prime/src/schema/policy.ts

## Purpose
Declares row-level security policies (design/20 §3.1). `definePolicy` validates the declaration and returns a frozen `Policy` whose `$.ddl(schemaOf)` renders the `CREATE POLICY` statement.
The kit discovers exported policies and writes them into the `sql/` repeatable lane; the core never runs them. Rendering goes through `compileDdlExpr` (`packages/pg-prime/src/compile/compiler.ts:1582`).

## Public API
- `definePolicy(name, spec)` — returns `Policy<T>`; throws `SchemaError` for a bad name or role, a duplicate role, an empty `to`, `on` that is not a table (a view included), a bad `for`/`as`, a non-function predicate, or a predicate on the wrong command.
- `PolicySpec<T>` — `{ on, as?, to?, for?, using?, withCheck? }`; `for: 'insert'` forbids `using`, `for: 'select' | 'delete'` forbids `withCheck` at the type level.
- `PolicyRuntime` — `name`, `table` (`TableRuntime`), `command`, `permissive`, `roles` (as declared, default `['public']`), `ddl(schemaOf)`.
- `Policy<T>` — `{ kind: 'policy', name, $ }`; `__table` is a phantom slot, never present at runtime.
- `PolicyCommand`, `PolicyRole` (keywords `public`/`current_user`/`current_role`/`session_user` or any role name), `PolicyExpr` (a boolean expression or a `sql` fragment).

## Flow
1. `definePolicy` validates everything except the predicates' bodies (`packages/pg-prime/src/schema/policy.ts:57`).
2. `ddl(schemaOf)` prints `CREATE POLICY "<name>" ON "<schemaOf(schema)>"."<table>" AS PERMISSIVE|RESTRICTIVE FOR <CMD> TO <roles>`, always with all three clauses (`packages/pg-prime/src/schema/policy.ts:120`).
3. Role keywords print bare and upper-case; other roles are quoted identifiers.
4. Each predicate thunk is called at render time with column refs that are compiler `col` nodes aliased to the bare table name; each codec is `defaultRegistry().byName(pgType)`, else `unknownCodec` (`packages/pg-prime/src/schema/policy.ts:100`).
5. The result goes through `compileDdlExpr` with the scope `{ alias: table.name, schemaOf }`, appended as `\n  USING (…)` and `\n  WITH CHECK (…)`; an omitted predicate omits its clause.

## Gotchas
- The statement has no trailing `;`; the kit adds it and hashes the statement.
- Columns render as `"<table>"."<col>"`, never schema-qualified. A raw subquery over the policy's own table, or a same-named table in another schema, must alias it (`FROM documents d`), or `"documents"` binds to the inner scan. A typed FROM aliased like the policy's table is a `SchemaError`.
- A bind whose column type has no codec in the default registry (enums, arrays, typmods) renders as an untyped literal, which PostgreSQL coerces.
- Thunks run on every `ddl()` call, so a policy may reference tables declared later.
- A typed subquery's FROM tables go through `schemaOf` like the ON table; a raw subquery's text is never remapped.
- Errors in a predicate body (`SchemaError` for placeholders, aggregates, window calls, binary binds) surface at render time, not at declaration.

## Tests
- `packages/pg-prime/test/schema/policy.test.ts` — goldens per command/as/to, inlined binds, raw subqueries, a typed subquery and its `schemaOf` remap and alias refusal, `schemaOf`, lazy thunks, every refusal.
- `packages/pg-prime/test/query/types/policy.probe.ts` — type goldens (run by `test/query/typecheck.test.ts`).
- `packages/pg-prime/test/live/rls.test.ts` (PGlite or server) and `test/pg/rls.test.ts` (server with CREATEROLE) — the rendered policies filter rows.
- Run: `pnpm --filter pg-prime exec vitest run test/schema/policy.test.ts`.
