# packages/pg-prime-cron/src/wake.ts

## Purpose
The loop's sleep: a timer that LISTEN notifications, a reconnect `gap` or a local `wake()` cut short. Cron's own copy of the family wake-up loop, so the package does not depend on `@pg-prime/events`.

## Public API
- `waker(db, channel, emit): Waker` (internal).
- `Waker.listen()` — subscribes; on failure emits `onInternal('listen-unavailable')` and the loop polls.
- `Waker.sleep(ms)` / `Waker.wake()` / `Waker.close()`.

## Flow
1. `listen` (`wake.ts:20`) calls `db.listen(channel, wake)` and wakes on `gap` too.
2. `sleep` resolves at the timer or the next `wake()`; a wake that arrived while awake makes the next sleep return at once.

## Gotchas
- Under a transaction pooler without `directConnection`, `db.listen` throws and cron polls every `pollMs`; due ticks are timer-driven and unaffected.
- Payloads are ignored: any notification just re-runs the loop.

## Tests
- `packages/pg-prime-cron/test/pg/cron.test.ts` (PgBouncer target): `listen-unavailable` is reported and every scenario passes by polling.
