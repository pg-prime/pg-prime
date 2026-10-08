# packages/pg-prime-kit/src/history/schema.ts

## Purpose
Defines the `pgprime` history schema (migrations, repeatables, checkpoints, lock lease, data progress, meta) and creates it idempotently.
Callers: `src/runner/run.ts` (`ensureHistory`, `historyPresent`, `HISTORY_SCHEMA`), `src/runner/status.ts` (`historyPresent`, `historyVersion`), `src/history/store.ts` and `src/data/batch.ts` (`HISTORY_SCHEMA`), `src/generate.ts`, CLI `baseline` (`ensureHistory`), `doctor`/`lint`/`push` (`historyPresent`); re-exported from `src/index.ts`. Callees: only the `CatalogClient`.

## Public API
- `HISTORY_SCHEMA` — `"pgprime"`.
- `HISTORY_VERSION` — `"1"`, written to `pgprime.meta.history_version`.
- `MigrationStatus` — `"running" | "applied" | "failed" | "baselined" | "superseded"`.
- `HISTORY_DDL` — the ordered DDL: schema, `migrations`, `repeatables`, `checkpoints`, `lock`, `data_progress`, `meta`, and the `history_version` insert.
- `ensureHistory(client)` — runs `HISTORY_DDL` in one transaction; retries once on a concurrent-create SQLSTATE; rethrows otherwise.
- `historyPresent(client)` — `to_regclass('pgprime.migrations') IS NOT NULL`.
- `historyVersion(client)` — the `history_version` value, or null when the row is absent. Throws if `pgprime.meta` does not exist.

## Flow
1. `ensureHistory` opens `BEGIN`, executes each `HISTORY_DDL` statement, `COMMIT`s (`packages/pg-prime-kit/src/history/schema.ts:109-112`).
2. On error it `ROLLBACK`s; on the first attempt with SQLSTATE `23505`, `42P06`, `42P07` or `42710` it retries once (`:114-118`, `:87-92`).
3. Any other error, or a second failure, propagates (`:119`).

## Gotchas
- Every object uses `IF NOT EXISTS`, which is idempotent but not race-free; the single retry covers two runners starting together (`packages/pg-prime-kit/src/history/schema.ts:22-29`).
- `ensureHistory` must not run inside a migration transaction: it issues its own `BEGIN`/`COMMIT`.
- `history_version` is inserted with `ON CONFLICT DO NOTHING`, so an existing value is never updated (`:82-83`).
- `pgprime.lock` is a singleton row (`singleton boolean PRIMARY KEY CHECK (singleton)`), so only one lease exists per database (`:65-71`).
- `applied_by` defaults to `current_user`; `started_at` to `now()` (`:46`, `:49`).
- `historyVersion` assumes `pgprime.meta` exists; call `historyPresent` first, as `status.ts` does.
- Read-only commands must call `historyPresent`, never `ensureHistory`, to avoid creating the schema.

## Tests
- `packages/pg-prime-kit/test/runner/history.test.ts` — creates exactly the expected tables, is idempotent, survives a concurrent `Promise.all` race, and reads back `HISTORY_VERSION`. Needs a server (`PG_PRIME_TEST_URL` or localhost port 54329 (`packages/pg-prime-kit/test/support/db.ts:42`)).
- `packages/pg-prime-kit/test/seed/seed.test.ts` — asserts `db seed` never creates the schema.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/runner/history.test.ts`.
- Uncovered: the second-failure path after the single retry.
