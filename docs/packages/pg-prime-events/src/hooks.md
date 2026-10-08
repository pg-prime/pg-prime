# packages/pg-prime-events/src/hooks.ts

## Purpose
The observer bus behind `EventsConfig.hooks` and `events.observe()`. Topics, readers, tails and
wakers emit through it.

## Public API
- `EventsHooks` — `onPublish`, `onDeliver`, `onRetry`, `onPark`, `onInternal`, all optional.
- `InternalKind` — `'listen-unavailable' | 'heartbeat-failed' | 'subscription-behind-retention' |
  'reader-failed' | 'hook-failed'`.
- `Hooks` / `createHooks(initial?)` — internal: `emit`, `internal(kind, message, cause?)`, `observe` → unsubscribe.

## Flow
1. `emit` calls the named hook on every observer (`packages/pg-prime-events/src/hooks.ts:32`).
2. A throwing hook becomes `onInternal({ kind: 'hook-failed' })` (`:38`); a throwing `onInternal`
   is swallowed so reporting cannot recurse (`:37`).

## Gotchas
- Hooks never throw into the caller; a publish or a reader never fails because an observer did.
- `reader-failed` is an addition to plan 15 §5's kinds: a reader statement failed and it retries
  after `pollMs`.

## Tests
- `test/unit/hooks.test.ts` — fan-out, unsubscribe, hook isolation. `pnpm --filter @pg-prime/events test`.
