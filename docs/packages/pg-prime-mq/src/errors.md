# packages/pg-prime-mq/src/errors.ts

## Purpose
The mq error classes, all `PgPrimeError`s with `MQ_*` codes. Thrown by queue handles, workers and
`pgMq.start()`.

## Public API
- `NonRetryableError(message, cause?)` — `MQ_NON_RETRYABLE`; thrown by a handler to fail at once.
- `LeaseLostError(message)` — `MQ_LEASE_LOST`; a token-guarded write matched no row.
- `CancelledError(message)` — `MQ_CANCELLED`; the abort reason on cancel or `close({ graceMs })`.
- `MessageFailedError(message, state)` — `MQ_FAILED`; `result()` of a failed/cancelled message.
- `PayloadError(message, path?)` — `MQ_PAYLOAD`; schema, codec, size or NUL failure, with `path`.
- `SchemaVersionError(message, cause?)` — `MQ_SCHEMA_VERSION`.
- `NotStartedError(what)` — a `UsageError` with code `MQ_NOT_STARTED`.

## Flow
1. Each constructor passes its code to `PgPrimeError`; `cause` only when given.

## Gotchas
- A handler's `LeaseLostError` from `ctx.complete({ tx })` rolls back the caller's transaction.

## Tests
- Asserted through behaviour in `test/live/*.test.ts` and `test/pg/*.test.ts`. `pnpm --filter @pg-prime/mq test`.
