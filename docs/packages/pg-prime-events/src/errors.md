# packages/pg-prime-events/src/errors.ts

## Purpose
The package's four error classes, rooted at core's `PgPrimeError`. Thrown by the log handles,
`pgEvents` start-up and payload encoding.

## Public API
- `EventsLeaseLostError(message)` — code `EVENTS_LEASE_LOST`; a token-guarded write (commit, park,
  nack, attempt marker) found another lease holder.
- `PayloadError(message, path?, cause?)` — code `EVENTS_PAYLOAD`; `path` is the offending location
  (schema issue or NUL character), empty for size/JSON failures.
- `SchemaVersionError(message, cause?)` — code `EVENTS_SCHEMA_VERSION`; schema behind, checksum
  mismatch or `min_client` above this client.
- `NotStartedError(what)` — a `UsageError` with code `EVENTS_NOT_STARTED`; a `{ tx }` call before the
  schema was ensured.

## Flow
1. Each constructor passes its code to `PgPrimeError` (`packages/pg-prime-events/src/errors.ts:4`);
   `NotStartedError` writes the fix into its message (`:27`).

## Gotchas
- `NotStartedError` exists because migrating from inside the caller's transaction would need a second
  pool connection, which deadlocks `max: 1` pools (plan 15 §0.3).
- `ctx.commit({ tx })` throws `EventsLeaseLostError` inside the caller's transaction, so it rolls back.

## Tests
- `test/unit/payload.test.ts` (paths of `PayloadError`), `test/live/log.test.ts` (`NotStartedError`,
  `SchemaVersionError`), `test/pg/reader.test.ts` (stale lease). `pnpm --filter @pg-prime/events test:live`.
