# packages/pg-prime/src/errors/sqlstate.ts

## Purpose
The SQLSTATE → `QueryError` subclass mapping, shipped as two frozen records and one lookup. `errors/map.ts`
calls `classForSqlState` for every server error; `src/index.ts` exports the tables and the lookup so users
and tests can read them. Depends only on `errors/classes.ts`.

## Public API
- `SQLSTATE_MAP` — frozen `Record<string, QueryErrorCtor>` of exact SQLSTATEs (classes 22, 23, 25, 26, 28,
  40, 42, 53, 55, 57 and `0A000`).
- `SQLSTATE_CLASS_FALLBACK` — frozen two-character prefix map: `22`, `23`, `25`, `26`, `28`, `40`, `42`,
  `53`, `57`.
- `classForSqlState(code: string | undefined): QueryErrorCtor` — exact match, then prefix, then
  `UnknownQueryError`.
- `SqlState` — alias of `string`.
- `QueryErrorCtor` — `new (message: string, init: QueryErrorInit) => QueryError`.

## Flow
1. `undefined` or `''` returns `UnknownQueryError` (`packages/pg-prime/src/errors/sqlstate.ts:144`).
2. Otherwise `SQLSTATE_MAP[code]`, then `SQLSTATE_CLASS_FALLBACK[code.slice(0, 2)]`, then
   `UnknownQueryError` (`packages/pg-prime/src/errors/sqlstate.ts:145`).

## Gotchas
- Class `08` is absent from the fallback: connection exceptions are routed by
  `PgDriverErrorData.kind` in `errors/map.ts` before this table is consulted
  (`packages/pg-prime/src/errors/sqlstate.ts:126`). A server error with kind `'server'` and an `08xxx` code
  therefore becomes `UnknownQueryError`.
- Every `0A000` (`feature_not_supported`) maps to `CachedPlanChangedError`, not only the
  "cached plan must not change result type" case (`packages/pg-prime/src/errors/sqlstate.ts:105`).
- `28000` and `28P01` map to `InvalidPasswordError` (an `AccessError`); the startup-time case is turned into
  `AuthenticationError` by the connection path in `errors/map.ts` (`packages/pg-prime/src/errors/sqlstate.ts:92`).
- `57P01`–`57P04` map to `OperatorInterventionError` here, but a `57P01` arriving as a connection-kind error
  becomes `ConnectionTerminatedError` in `errors/map.ts` (`packages/pg-prime/src/errors/sqlstate.ts:117`).
- `55P03` and `57014` have exact entries but no class fallback, so other `55xxx` codes are `UnknownQueryError`.
- `40001` and `40P01` share the `TransactionError` branch with class `25`.

## Tests
- `packages/pg-prime/test/session/session.test.ts` (unit), `every SQLSTATE in 07 §4.2 maps to its class` at
  line 700: walks every `SQLSTATE_MAP` entry through `classForSqlState`, the class-prefix fallback, and
  `UnknownQueryError` for unmodelled classes.
- The header comment names `test/query/session-errors.test.ts`, which does not exist.
- Run: `pnpm --filter pg-prime exec vitest run test/session/session.test.ts`.
