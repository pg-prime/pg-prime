# packages/pg-prime-mq/src/hooks.ts

## Purpose
The observer bus every mq module reports to, and the OpenTelemetry attribute mapping for settles.

## Public API
- `MqHooks` — `onSend`, `onClaim`, `onSettle`, `onLeaseExpired`, `onBind`, `onInternal` (sync).
- `InternalKind` — `listen-unavailable`, `heartbeat-failed`, `maintenance-failed`, `worker-failed`,
  `lease-lost`, `hook-failed`. `SettleEvent`, `SettleOutcome`.
- `spanAttributes(e)` — `messaging.*` attributes plus outcome and attempt.
- `createHooks(initial?)` — internal `Hooks` with `emit`, `internal`, `observe`.

## Flow
1. `emit` calls every observer in insertion order (packages/pg-prime-mq/src/hooks.ts:39).
2. A throwing observer is reported as `hook-failed` and the next observer still runs.

## Gotchas
- A throwing `onInternal` is swallowed, never re-reported (no loop).

## Tests
- `test/unit/define.test.ts` (isolation, `spanAttributes`); `test/live/work.test.ts` (a throwing hook). `pnpm --filter @pg-prime/mq test`.
