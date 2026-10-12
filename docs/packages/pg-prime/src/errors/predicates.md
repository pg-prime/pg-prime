# packages/pg-prime/src/errors/predicates.ts

## Purpose
Type-guard predicates that match a caught error against schema column references or a resolved
`ConstraintRef`, so application code tests "which constraint broke" without comparing constraint-name
strings. Public via `src/index.ts`; reads the `constraint`/`columns` that `errors/map.ts` attaches using
`errors/refs.ts`.

## Public API
- `isUniqueViolation(e, ...cols: ColumnRef[])` / `isUniqueViolation(e, constraint: ConstraintRef)` —
  `e is UniqueViolationError`.
- `isForeignKeyViolation(e, ...cols)` / `isForeignKeyViolation(e, fk: ConstraintRef)` —
  `e is ForeignKeyViolationError`.
- `isCheckViolation(e, ...cols)` / `isCheckViolation(e, constraint)` — `e is CheckViolationError`.
- `isNotNullViolation(e, ...cols)` — `e is NotNullViolationError`; no `ConstraintRef` overload.

## Flow
1. Each predicate checks `instanceof` its class, then calls `matches` (`packages/pg-prime/src/errors/predicates.ts:58`).
2. No extra arguments: the `instanceof` result alone (`packages/pg-prime/src/errors/predicates.ts:29`).
3. First argument with string `kind` and `name` is treated as a `ConstraintRef` and compared by
   `e.constraint.name` (`packages/pg-prime/src/errors/predicates.ts:31`).
4. Otherwise every given column must appear in `e.columns`, compared by `$.dbName` and `$.table`
   (`packages/pg-prime/src/errors/predicates.ts:36`).

## Gotchas
- Column matching is a subset test: `isUniqueViolation(e, users.email)` is true for a composite
  constraint that includes `email` (`packages/pg-prime/src/errors/predicates.ts:38`).
- When the constraint was not resolved against the schema (`e.columns` undefined), any column-argument
  call returns `false` even though the class matches (`packages/pg-prime/src/errors/predicates.ts:35`).
- A `ConstraintRef` argument compares by name only; arguments after it are ignored.
- Mixing a column first and a `ConstraintRef` later is not allowed by the overloads and throws at runtime
  (the ref has no `$`).
- `instanceof` is realm-bound: errors from a second copy of `pg-prime` do not match.

## Tests
- `packages/pg-prime/test/session/session.test.ts` (unit): `isUniqueViolation(e, users.email)` at line 887,
  including the negative `isForeignKeyViolation(e)` check at line 895.
- Run: `pnpm --filter pg-prime exec vitest run test/session/session.test.ts`.
- Uncovered: `isCheckViolation`, `isNotNullViolation`, and the `ConstraintRef` overloads have no direct test.
