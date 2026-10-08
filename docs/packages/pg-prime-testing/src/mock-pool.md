# packages/pg-prime-testing/src/mock-pool.ts

## Purpose
The tier-0 driver double: `createMockPool` returns a `PgLikePool` that goes straight into `pgPrime({ pool })`, records every statement it is handed and answers from a script of wire rows or SQLSTATE errors, with no I/O. It imports only the structural driver types (`PgLikeClient`, `PgLikePool`, `PgLikeQueryConfig`, `PgLikeResult`) from `pg-prime`. Re-exported by `packages/pg-prime-testing/src/index.ts:28`.

## Public API
- `createMockPool(options?: MockPoolOptions): MockPool` — a fresh recording pool; never throws.
- `MockPoolOptions` — `script?` (steps in order), `serverParameters?` (merged over the defaults), `max?` (`pool.options.max`, default 10).
- `MockPool` — `PgLikePool` plus `queries`, `texts`, `stepsUsed`, `connectCount`, `checkedOut`, `ended`, `push(...steps)`, `reset()`.
- `RecordedQuery` — `text`, `values`, `mode`, `binary`, `rowMode`, `name`, `client` (connection index), `config` (verbatim).
- `MockQueryMode` — `'simple' | 'unnamed' | 'named'`.
- `MockStep` — `MockResult | MockError | ((query: RecordedQuery) => MockResult | MockError)`.
- `MockResult` — `rows?` (arrays of wire text or `null`), `fields?` (`string` = text column), `rowCount?`, `command?`.
- `MockError` — `code` (SQLSTATE, required) plus optional `message`, `severity`, `detail`, `hint`, `position`, `schema`, `table`, `column`, `dataType`, `constraint`, `where`, `routine`.
- `MockField` — `pg`'s field shape; only `name` and `dataTypeID` are read by `pg-prime`.
- `DEFAULT_SERVER_PARAMETERS` — frozen GUC map the handshake reports (`TimeZone: 'UTC'`, `server_version_num: '170011'`, …).

## Flow
1. `createMockPool` copies `script`, merges `serverParameters` over `DEFAULT_SERVER_PARAMETERS` into handshake rows (`packages/pg-prime-testing/src/mock-pool.ts:191-196`).
2. `connect()` hands out a new `MockClient` per call with an incrementing index, bumps `connectCount` and `checkedOut`, and wires `onRelease` to decrement `checkedOut` (`:235-244`).
3. `MockClient.query` with a Submittable (anything with `submit`) throws, pointing at `startPglite()` (`:324-332`).
4. A config whose text contains `pg_catalog.pg_settings` is answered from the parameter rows without recording or consuming a step (`:334-341`).
5. Every other config is recorded (`record`, `:212`): `mode` is `named` if `queryMode === 'extended'` and a `name` is set, `unnamed` if extended without a name, else `simple` (`:216-221`).
6. `answer` takes the next script step; an exhausted script yields an empty `SELECT` result without advancing (`:203-204`).
7. A function step is called with the recorded query (`:207`); a step with a string `code` is rejected as a server error (`:208`), otherwise resolved via `toResult` (`:375`).
8. `toServerError` builds a plain `Error` with `name = 'error'`, `severity` defaulting to `'ERROR'`, and every defined step field copied on (`:393-402`).

## Gotchas
- Rows are wire rows: strings as PostgreSQL would send them in text format (`'1'`, not `1n`); the schema codecs decode them.
- `fields` matter only for dynamic result shapes (bare `db.sql` fragments); a string field becomes OID 25 `text` (`:169-177`).
- The script and recording are shared by every client of the pool; `client` on `RecordedQuery` tells which connection ran it.
- The handshake is detected by substring, so any test statement whose text contains `pg_catalog.pg_settings` is also swallowed (`:167`, `:334`).
- `reset()` clears queries, script and `stepsUsed` but not `connectCount`, `checkedOut` or `ended` (`:280-284`).
- `release()` counts only the first call per client (`:369`); `getTransactionStatus()` always returns `'I'` and `processID` is fixed at `4242` (`:362-366`), so transaction-state tracking cannot be exercised here.
- `waitingCount` is always 0 and `idleCount` is `connectCount - checkedOut` (`:253-258`); `end()` only flips `ended`.
- `MockClient.emit` and `releases` exist on the client but are not on any exported type.
- Error detection by `pg-prime` is duck-typed, so the mock never subclasses `Error` (`:385-392`).

## Tests
- `packages/pg-prime-testing/test/unit/mock-pool.test.ts`: works through `pgPrime({ pool })` with codec decode, recorded fields/mode/rowMode, handshake not recorded, script order and exhaustion, function steps, SQLSTATE → `pg-prime` error class, `serverParameters` override, pool counters/`release`, `reset()`, Submittable refusal.
- Run: `pnpm --filter @pg-prime/testing exec vitest run test/unit/mock-pool.test.ts`.
- Uncovered: `emit`/listener plumbing, `release(true)`/`'destroy'` recording.
