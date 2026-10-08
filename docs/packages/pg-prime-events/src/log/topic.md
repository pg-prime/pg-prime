# packages/pg-prime-events/src/log/topic.ts

## Purpose
Topic handles: publish into the log (optionally inside the caller's transaction), ephemeral tails
with an in-memory cursor, and an admin browse. Built by `pgEvents` (`src/events.ts:146`).

## Public API
- `TopicHandle<T>` — `publish(payload, { tx?, type?, key?, headers? })` → `{ id }`;
  `publishMany(items, { tx? })` → `{ id }[]` in item order.
- `tail(handler, { from?: 'now' | { after }, signal?, pollMs? = 5000 })` → core `Subscription`.
- `read({ afterId?, limit? = 100 })` → entries by id without `cursor`; not a resume handle.
- `Entry<T>` — `id`, `topic`, `type`, `key`, `payload`, `headers`, `at`, `cursor`.
- `PublishOptions` — publish options. `entryOf(def, row)` — internal decoder.

## Flow
1. `publishMany` without `tx` ensures the topic (`packages/pg-prime-events/src/log/topic.ts:67`); with
   `tx` it requires a started instance, then encodes every payload and runs P1 (`:78`).
2. `tail` seeds a cursor (`'now'` or a decoded `Entry.cursor`) and starts a waker on the topic's
   engine channel (`:90`, `:100`).
3. Each wake drains: read 500, advance per entry, call the handler, `advanceTo`, repeat while `next`
   returned rows (`:108`).

## Gotchas
- One P1 per call; PostgreSQL collapses identical NOTIFYs per transaction, so 1 000 entries wake once.
- A rolled-back producer transaction leaves no entry and sends no wake-up.
- Tails heal gaps from the log, so their subscription only emits `'error'` (handler throws, decode
  failures, read errors); a failing entry is skipped, not retried.
- `Entry.cursor` from a tail is valid for `tail({ from: { after } })` and `subscription.reset`.
- Tails are closed by `events.close()` through `core.running`.

## Tests
- `test/live/log.test.ts` — ordered delivery, rolled-back publish, tails from `now` and from an
  `Entry.cursor`. `test/pg/cursor.test.ts` — publish in concurrent transactions.
  `pnpm --filter @pg-prime/events test:live`.
