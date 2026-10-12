# packages/pg-prime/src/driver/errors.ts

## Purpose
Normalises anything a pg-like driver throws into seam data (`PgDriverErrorData`) and wraps it in
`PgDriverError`. Called throughout `src/driver/pg-adapter.ts`; `PgDriverError.pgPrime` is read by
`driverDataOf` in `packages/pg-prime/src/errors/map.ts:45`, which maps it to the public error classes. Re-exported by
`src/driver/index.ts`, `src/entry/driver.ts` and the root barrel.

## Public API
- `isServerErrorShape(e)` — type guard: object with string `code` and string `severity`.
- `toServerErrorData(raw)` — returns `PgServerErrorData`; numeric fields coerced from strings,
  absent or empty fields omitted.
- `normaliseError(e, opts)` — returns `PgDriverErrorData`; `opts` is `NormaliseOptions`.
- `NormaliseOptions` — `{ adapter, sql?, aborted?, timedOut?, connectionUnusable?, cancelError? }`;
  exported from the module, not from `src/driver/index.ts`.
- `PgDriverError(data)` — `Error` named `'PgDriverError'` carrying `data` on `.pgPrime` and
  `data.cause` as `cause`.

## Flow
1. Server-shaped errors become `server` data via `toServerErrorData`
   (`packages/pg-prime/src/driver/errors.ts:149`).
2. SQLSTATE `57014` is `cancelled` when `opts.aborted` is set or the message says "due to user
   request", otherwise `timeout` (`packages/pg-prime/src/driver/errors.ts:154`).
3. A server error poisons the connection only for `08xxx`, `57P01`-`57P03` and `XX000`, unless
   `opts.connectionUnusable` overrides (`packages/pg-prime/src/driver/errors.ts:118`).
4. Non-server errors default to `connection` / unusable, then: `aborted` → `cancelled` (usable);
   `timedOut` or exactly `Query read timeout` → `timeout` (usable)
   (`packages/pg-prime/src/driver/errors.ts:177`).
5. pg's own client-side validation messages → `adapter` (usable); its socket/pool messages →
   `connection` (unusable), both matched by prefix (`packages/pg-prime/src/driver/errors.ts:90`,
   `packages/pg-prime/src/driver/errors.ts:99`).
6. Anything matching `/desync|unexpected \w+ message|protocol/i` → `protocol` (unusable)
   (`packages/pg-prime/src/driver/errors.ts:194`).

## Gotchas
- Detection is duck-typed, never `instanceof`: pg, PGlite and Neon use different error classes
  (`packages/pg-prime/src/driver/errors.ts:20`).
- pg delivers `position`, `internalPosition` and `line` as strings; they are converted to numbers
  (`packages/pg-prime/src/driver/errors.ts:27`).
- Missing server fields default to `severity: 'ERROR'`, `sqlstate: ''`, `message: ''`
  (`packages/pg-prime/src/driver/errors.ts:43`).
- Message tables are exact prefixes of pg's strings, so the pool's "timeout exceeded when trying to
  connect" is `connection`, not `timeout`. A message reworded by a pg release falls through to
  `connection` (`packages/pg-prime/src/driver/errors.ts:104`).
- `Query read timeout` reports `connectionUnusable: false`; the pg adapter overrides it to `true`
  because the statement is still running (`packages/pg-prime/src/driver/pg-adapter.ts:439`).
- `opts.aborted` wins over every message rule for non-server errors.

## Tests
- `packages/pg-prime/test/driver/errors.test.ts:129` — table of pg messages and SQLSTATEs (including
  a desync and the three `57014` origins) to `kind`/`connectionUnusable`; override, `cancelError`, abort.
- `packages/pg-prime/test/driver/execute.test.ts:157` — server errors as data: numeric `position`,
  absent fields absent, notices on results.
- Run (live project): `pnpm --filter pg-prime exec vitest run test/driver/errors.test.ts`.
- Not covered: a non-pg message that matches no table (the default `connection` branch).
