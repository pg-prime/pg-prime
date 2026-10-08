# packages/pg-prime/src/errors/index.ts

## Purpose
The error layer's internal barrel: one import path for everything in `src/errors/`. Imported by
`session/*`, `query/run.ts`, `query/types.ts`, `observe/events.ts`, `pooler/diagnose.ts` and `src/index.ts`.
The public surface is the curated subset that `src/index.ts` re-exports, not this file.

## Public API
- From `errors/base.ts`: `PgPrimeError`, `UsageError`, `ConfigError`; types `ErrorContext`, `ErrorInit`,
  `HandleKind`, `PgPrimeErrorCode`, `UsageErrorInit`.
- From `errors/classes.ts`: every error class (`QueryError` tree, `ConnectionError` tree, timeouts, aborts,
  `UsageError` leaves, `IndeterminateCommitError`); types `PoolStats`, `QueryErrorInit`.
- From `errors/sqlstate.ts`: `SQLSTATE_MAP`, `SQLSTATE_CLASS_FALLBACK`, `classForSqlState`; types
  `QueryErrorCtor`, `SqlState`.
- From `errors/map.ts`: `mapError`, `mapDriverError`, `driverDataOf`, `sqlStateOfError`; type `MapOptions`.
- From `errors/refs.ts`: `constraintIndex`, `describeConstraint`, `resolveConstraint`; types `ColumnRef`,
  `ConstraintKind`, `ConstraintRef`, `TableRef`.
- From `errors/predicates.ts`: `isUniqueViolation`, `isForeignKeyViolation`, `isCheckViolation`,
  `isNotNullViolation`.
- From `errors/redact.ts`: `captureCallSite`, `parseDetail`, `redactDetail`, `redactSql`,
  `resolveErrorOptions`; types `ErrorOptions`, `ParsedDetail`, `ResolvedErrorOptions`.

## Flow
1. Pure re-exports; no code runs beyond module evaluation of the seven source files
   (`packages/pg-prime/src/errors/index.ts:3`).

## Gotchas
- Not everything here is public: `mapError`, `mapDriverError`, `driverDataOf`, `sqlStateOfError`, the refs
  functions and the redaction functions are absent from `src/index.ts` (`packages/pg-prime/src/index.ts:426`).
- `errors/map.ts` also re-exports `QueryError`, but this barrel takes `QueryError` from `errors/classes.ts`
  (`packages/pg-prime/src/errors/index.ts:50`).
- `PgPrimeError` is publicly exported through the `sql` block of `src/index.ts`, not the errors block
  (`packages/pg-prime/src/index.ts:232`).

## Tests
- `packages/pg-prime/test/session/session.test.ts` imports through this barrel and covers the members (see
  the per-file docs in this directory).
- `packages/pg-prime/test/query/index.test.ts` asserts the public subset via `src/index.ts`.
- Run: `pnpm --filter pg-prime exec vitest run test/session/session.test.ts test/query/index.test.ts`.
