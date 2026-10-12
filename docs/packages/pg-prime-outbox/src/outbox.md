# packages/pg-prime-outbox/src/outbox.ts

## Purpose
`pgOutbox`: the outbox handle, schema start-up, and one `OutboxTopic` per definition. It wires the
write path, the admin statements and the relay to a shared `TopicCtx`
(`packages/pg-prime-outbox/src/context.ts:15`).

## Public API
- `pgOutbox(config)` → `Outbox<D>` (`packages/pg-prime-outbox/src/outbox.ts:18`): `topics`,
  `topic(def)`, `start()`, `migrate()`, `close()`, `[Symbol.asyncDispose]`.
- `OutboxTopic<T>`: `name`, `start`, `write`, `writeMany`, `relay`, `parked`, `replay`, `discard`,
  `pause`, `resume`, `stats`.
- `context.ts` (internal): `TopicCtx` (its `decode(row, raw?)` can leave the payload as stored),
  `hooksOf` (hook isolation), `channelOf` (`ob_` + 24 hex of
  `sha256(schema/topic)`), `errorText` (message capped at 2 000 chars).

## Flow
1. `ensure` (`packages/pg-prime-outbox/src/outbox.ts:38`) runs `migrateOwnedSchema` with
   `apply = autoMigrate`, maps its `ConfigError` to `SchemaVersionError`, and throws
   `SchemaVersionError` when the ledger is below the client's version. A failure clears the memo.
2. A topic's `start()` runs `ensure`, then `createTopic` (`packages/pg-prime-outbox/src/sql/admin.ts:5`),
   and refuses with `ConfigError` when the stored `partitions` differs. It sets `ready`.
3. `writeMany` before `ready`: a `Db` handle starts lazily, any other handle throws `NotStartedError`
   without a statement; then `writeRecords`.
4. Admin calls (`parked`, `replay`, `discard`, `pause`, `resume`, `stats`) start lazily, then run
   their statement.
5. `relay(sink, opts)` calls `startRelay` and tracks the relay until it closes; `close()` closes all.

## Gotchas
- Handles are memoized per definition object (`packages/pg-prime-outbox/src/outbox.ts:53`): two
  `defineOutbox` calls with the same name are two handles with their own `ready` state.
- Starting from inside the caller's transaction is refused on purpose: it would wait for a second
  pool connection while the caller holds one (deadlock with `max: 1`).
- `outbox.start()` starts only declared topics; `outbox.topic(def)` handles need their own `start()`.

## Tests
- `packages/pg-prime-outbox/test/live/outbox.test.ts` — tier 1 (PGlite): migrate idempotence,
  `autoMigrate: false`, vendored SQL, partitions mismatch, write rules, relay, park/replay/discard,
  pause, retention, hooks. `pnpm --filter @pg-prime/outbox test:live`.
- `packages/pg-prime-outbox/test/unit/api.test.ts` — registry types and write-before-start on a mock pool.
