# packages/pg-prime/src/errors/base.ts

## Purpose
The root of the error hierarchy: `PgPrimeError`, `UsageError`, `ConfigError` and the shared context types.
It imports nothing, so `sql/errors.ts` (which re-exports it), `errors/classes.ts` and every runtime module
can extend these classes without an import cycle. `ConfigError` is thrown by `session/config.ts`,
`session/transaction.ts`, `session/listen.ts`, `session/copy.ts` and `session/pg-lazy.ts`.

## Public API
- `PgPrimeError(code, message, options?)` — base `Error`; `code: string`, optional `callSite`, optional
  `context: ErrorContext`; `name` is the concrete class name.
- `UsageError(message, options?)` — programmer error; `code` defaults to `'USAGE'`, overridable via
  `UsageErrorInit.code`.
- `ConfigError(message, options?)` — invalid configuration; `code` is always `'CONFIG'`.
- `ErrorInit` — `{ cause?, callSite?, context? }`.
- `UsageErrorInit` — `ErrorInit` plus `code?`.
- `ErrorContext` — all optional: `label`, `attempt`, `durationMs`, `handle`, `reason`
  (`'statement_timeout' | 'lock_timeout' | 'cancel'`), `queryId`, `txId`, `depth`.
- `HandleKind` — `'db' | 'tx' | 'session'`.
- `PgPrimeErrorCode` — the builder/compiler discriminator union (`'INVALID_IDENTIFIER'` … `'USAGE'`).

## Flow
1. `PgPrimeError` calls `super(message)` with `{ cause }` only when `options.cause` is defined
   (`packages/pg-prime/src/errors/base.ts:74`).
2. It sets `name` from `new.target.name` and stores `code` (`packages/pg-prime/src/errors/base.ts:75`).
3. `callSite` and `context` are assigned only when provided (`packages/pg-prime/src/errors/base.ts:77`).
4. `UsageError` passes `options.code ?? 'USAGE'` up (`packages/pg-prime/src/errors/base.ts:96`).

## Gotchas
- The file must stay import-free; adding an import risks the cycle through `sql/ident.ts` described in its
  header (`packages/pg-prime/src/errors/base.ts:14`).
- `code` is typed `string`, not `PgPrimeErrorCode`: it holds a SQLSTATE for server errors and runtime codes
  such as `'TIMEOUT'`, `'ABORT'`, `'INDETERMINATE_COMMIT'` or `'08000'` that the union does not list.
- `callSite` and `context` are absent as own properties when not supplied, so `'context' in e` is false for
  builder errors (`packages/pg-prime/src/errors/base.ts:77`).
- `name` follows the runtime class name, so a consumer bundler that renames classes changes `e.name`.
- `UsageError` subclasses that already published a discriminator keep it via `code`, e.g.
  `TooManyParametersError` uses `'TOO_MANY_PARAMETERS'` (`packages/pg-prime/src/sql/errors.ts:89`).

## Tests
- `packages/pg-prime/test/session/session.test.ts` (unit): `PgPrimeError is the one ancestor` at line 767;
  config validation throwing `ConfigError` at line 1160.
- Run: `pnpm --filter pg-prime exec vitest run test/session/session.test.ts`.
- Uncovered: no test asserts that `callSite`/`context` are absent when not supplied.
