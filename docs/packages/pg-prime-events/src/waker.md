# packages/pg-prime-events/src/waker.ts

## Purpose
The wake-up loop: NOTIFY, LISTEN `gap`, or a poll timeout. Used by subscription readers and tails
(`src/log/subscription.ts:269`, `src/log/topic.ts:100`) and exported for `@pg-prime/mq`'s workers.

## Public API
- `waker(db, channel, { pollMs, signal?, onInternal? })` → `Waker`; LISTEN starts immediately.
- `Waker` — single-use `AsyncIterable<WakeReason>` plus `wait(ms = pollMs)` → reason, or `undefined`
  once closed, and `close()`.
- `WakeReason` — `'notify' | 'gap' | 'poll'`. `WakerOptions` — the options above.

## Flow
1. Construction calls `db.listen(channel)` (`packages/pg-prime-events/src/waker.ts:88`).
2. Once LISTEN is up it raises `'gap'` (`:46`): anything sent before it was missed.
3. Notifications raise `'notify'`; the hub's `'gap'` raises `'gap'`, which wins over a pending
   notify (`:36`). Several raises before a `wait` collapse into one reason.
4. `wait(ms)` returns a pending reason at once, else waits up to `ms`; a timeout is `'poll'` (`:65`).
5. A failed LISTEN reports `listen-unavailable` once; it is retried at each `wait` unless the error
   was `UnsupportedInPoolerModeError`, which means poll forever (`:47`).
6. `close()` or `signal` abort closes the subscription and makes `wait` return `undefined`.

## Gotchas
- Readers must treat every reason the same: read the log. NOTIFY carries nothing.
- `wait(ms)` lets a caller race its own timers (retry delays, mq's delayed jobs) without dangling
  iterator promises.
- Several wakers on one channel share the core ListenHub; each gets its own `gap` (core S0 fix).
- A pending LISTEN delays the first `wait` until it settles.

## Tests
- `test/unit/waker.test.ts` — gap first, notify/gap/poll, early wake, iteration with abort,
  pooler fallback, LISTEN retry. `test/pg/channel-gap.test.ts` — two wakers see `gap` after the
  backend is terminated. `pnpm --filter @pg-prime/events test`.
