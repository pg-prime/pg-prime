# packages/pg-prime/src/errors/map.ts

## Purpose
Turns driver-seam error data (`PgDriverErrorData` carried on an `Error` as `.pgPrime`) into a
`PgPrimeError` subclass, once, at the executor boundary. Called by `session/runner.ts`,
`session/handles.ts` and `session/listen.ts`. Uses `errors/sqlstate.ts` for the class, `errors/redact.ts`
for `sql`/`detail`, and `errors/refs.ts` for constraint resolution. Re-exported by the `errors/index.ts`
barrel only; not public.

## Public API
- `mapError(e, o: MapOptions): unknown` — returns `e` unchanged if it is already a `PgPrimeError` or carries
  no seam data; otherwise `mapDriverError`.
- `mapDriverError(data, cause, o): PgPrimeError` — the full mapping; `cause` becomes the error's `cause`.
- `driverDataOf(e): PgDriverErrorData | undefined` — reads `e.pgPrime`, accepting a partial carrier.
- `sqlStateOfError(e): string | undefined` — SQLSTATE from seam data, else a 5-char string `e.code`.
- `MapOptions` — `context`, `errors: ResolvedErrorOptions`, `sql?`, `params?`, `paramTypes?`, `callSite?`,
  `schema?`, `poisonedBy?`, `poolStats?`.
- `QueryError` — re-exported from `errors/classes.ts`.

## Flow
1. `driverDataOf` accepts `pgPrime` objects with a string `kind`, or any with `server.sqlstate`, which it
   normalises to `kind: 'server'` with defaults (`packages/pg-prime/src/errors/map.ts:45`).
2. `mapDriverError` redacts `o.sql ?? data.sql` and builds `{ cause, context, callSite? }`
   (`packages/pg-prime/src/errors/map.ts:131`).
3. `kind: 'cancelled'` without `server` → `AbortError`; `kind: 'timeout'` without `server` →
   `QueryTimeoutError` (`packages/pg-prime/src/errors/map.ts:138`).
4. `connection` / `protocol` / `adapter` kinds go to `connectionError` (`packages/pg-prime/src/errors/map.ts:146`).
5. Otherwise the constructor comes from `classForSqlState(server.sqlstate)`; the message is the first
   non-empty of `server.message`, `data.message`, `cause.message` (`packages/pg-prime/src/errors/map.ts:152`).
6. `detail` is redacted; `params` are included only with `includeParams`; `paramCount` is
   `o.params?.length ?? 0` (`packages/pg-prime/src/errors/map.ts:162`).
7. For `57014`, `context.reason` is set from the server wording or the data kind (`packages/pg-prime/src/errors/map.ts:175`).
8. `25P02` → `InFailedTransactionError` whose message names `poisonedBy` and suggests `tx.savepoint`
   (`packages/pg-prime/src/errors/map.ts:178`).
9. Integrity classes resolve the constraint against `o.schema` and get the constraint-violation message
   (`packages/pg-prime/src/errors/map.ts:186`).
10. `connectionError` picks a leaf by message prefix, OS error code on `data.cause`, or SQLSTATE
    (`packages/pg-prime/src/errors/map.ts:283`).

## Gotchas
- `PoolTimeoutError` is detected by pg-pool's message prefix `'timeout exceeded when trying to connect'`
  (`packages/pg-prime/src/errors/map.ts:292`).
- Connection leaf order: pool timeout, refused (`ECONNREFUSED`/`ENOTFOUND`/`EHOSTUNREACH`), timeout
  (`ETIMEDOUT` or `'timeout expired'`), TLS (`ERR_TLS*`/`CERT_*`/`UNABLE_TO_*`), auth, terminated, base.
- Authentication is matched by SQLSTATE class `28` or a `/password authentication failed|SASL|SCRAM/i`
  message (`packages/pg-prime/src/errors/map.ts:311`).
- A seam error of kind `'cancelled'` or `'timeout'` that also carries `server` is mapped by SQLSTATE
  instead (`packages/pg-prime/src/errors/map.ts:138`).
- `57014` with neither wording and kind other than `'cancelled'` gets reason `'statement_timeout'`
  (`packages/pg-prime/src/errors/map.ts:228`).
- An integrity error with an undeclared constraint keeps PostgreSQL's message plus a "not declared in your
  schema" sentence; with no constraint name it is the server message alone (`packages/pg-prime/src/errors/map.ts:248`).
- Integrity detection walks the constructor prototype chain, so a class-23 fallback (`23xxx` unmodelled)
  also resolves constraints (`packages/pg-prime/src/errors/map.ts:202`).
- A base `ConnectionError` keeps the server SQLSTATE as `code` when one exists, else `'08000'`
  (`packages/pg-prime/src/errors/map.ts:324`).
- Non-pg-prime throws (e.g. a `TypeError` in a transaction callback) pass through unmapped, which the
  retry exclusions rely on (`packages/pg-prime/src/errors/map.ts:122`).
- The header names `test/query/session-errors.test.ts`; that file does not exist.

## Tests
- `packages/pg-prime/test/session/session.test.ts` (unit): SQLSTATE mapping and pass-through at line 700,
  redaction and `paramCount` at line 789, constraint resolution at line 867, `25P02` messages at line 944,
  aborts/timeouts at line 1469, `PoolTimeoutError` stats at line 1623, `TlsError` at line 1899.
- `packages/pg-prime/test/pg/pool-error.test.ts` (pg) covers a server-killed idle connection.
- Run: `pnpm --filter pg-prime exec vitest run test/session/session.test.ts`.
- Uncovered: the partial-carrier branch of `driverDataOf` and `ConnectionRefusedError`/`ConnectionTimeoutError`
  OS-code routing have no direct unit test.
