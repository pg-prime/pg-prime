# packages/pg-prime/src/session/listen.ts

## Purpose
LISTEN/NOTIFY support: `ListenHub` multiplexes every `db.listen()` channel onto one dedicated connection
outside the pool, reference-counted, with jittered reconnect and a `'gap'` event. Also holds the NOTIFY
payload limit check and the transaction-pooler refusal. `pgPrime` builds one `ListenHub` per `Db`
(`packages/pg-prime/src/query/run.ts:405`) whose host opens connections via `PgDriver.connect`;
`notify` in `packages/pg-prime/src/session/handles.ts:170` calls `assertPayloadSize`.

## Public API
- `MAX_NOTIFY_PAYLOAD_BYTES` — `8000`, an exclusive bound; re-exported from `packages/pg-prime/src/index.ts:417`.
- `assertPayloadSize(payload)` — throws `UsageError` when the UTF-8 byte length is `>= 8000`.
- `ListenerHost` — `openDedicated()`, `closeDedicated(conn)`, `errors`, `reconnect: { baseDelayMs,
  maxDelayMs }`, `warn`, `internal(kind, message, cause?)`.
- `ListenHub` — `subscribe(channel, handler, signal)` resolves a `Subscription`; `close()` drops every
  channel and the connection; getters `open` and `backendPid` (`@internal`).
- `listenUnsupported(mode)` — builds the `UnsupportedInPoolerModeError` naming `directConnection` as the fix.

## Flow
1. `subscribe` validates the channel (non-empty, no NUL, at most 63 UTF-8 bytes) and throws `UsageError`
   after `close()` (`packages/pg-prime/src/session/listen.ts:103`).
2. `#connection()` reuses the open connection or awaits a single shared `openDedicated()`
   (`packages/pg-prime/src/session/listen.ts:156`); the host refuses under a transaction profile without
   `directConnection` and routes to `'direct'` otherwise (`packages/pg-prime/src/query/run.ts:406`).
3. `#attach` subscribes to the connection's `notification` and `error` events; a driver without
   `PgConnection.on` throws `ConfigError` (`packages/pg-prime/src/session/listen.ts:169`).
4. The first subscription on a channel issues `listen "<channel>"` (quoted identifier, simple protocol)
   (`packages/pg-prime/src/session/listen.ts:112`). Each subscription is a `Sub` — its handler plus its
   own emitter — in the channel's set.
5. Notifications fan out to every subscription of that channel; a throwing handler is reported as that
   subscription's own `'error'` event (`packages/pg-prime/src/session/listen.ts:182`).
6. `Subscription.close` removes its `Sub` (handler and emitter); the last one on a channel sends
   `unlisten`, and the last channel closes the dedicated connection (`packages/pg-prime/src/session/listen.ts:125`).
7. A connection `error` starts `#reconnect`: full-jitter backoff (`random * min(max, base * 2^(n-1))`),
   new connection, re-`LISTEN` every channel, then `'reconnect'` and `'gap'` to every subscription
   (`packages/pg-prime/src/session/listen.ts:207`).
8. Failed reconnect attempts emit a mapped error on every subscription's `'error'` and loop until success,
   `close()`, or no channels remain (`packages/pg-prime/src/session/listen.ts:252`).

## Gotchas
- Notifications sent while disconnected are lost; `'gap'` (with `downMs`) is the only signal to reconcile.
  It fires after re-`LISTEN`, so a reconcile started from it cannot miss a later notification.
- Closing a subscription twice is a no-op for the channel's other subscriptions: only a `Sub` that was
  still in the set can trigger `unlisten` (`packages/pg-prime/src/session/listen.ts:127`).
- An aborted `signal` passed to `subscribe` closes the subscription immediately after it was opened
  (`packages/pg-prime/src/session/listen.ts:118`).
- Reconnect delays start at `baseDelayMs: 100` and cap at `30_000` (`packages/pg-prime/src/query/run.ts:418`);
  the reconnect loop has no attempt limit.
- `closeDedicated` releases with `{ dispose: true }`, i.e. the socket is closed, never pooled.
- `NOTIFY` itself is not gated by the pooler profile; only `LISTEN` is.

## Tests
- `packages/pg-prime/test/session/listen.test.ts` — tier 0 over a fake host: `gap`/`reconnect` reach every
  subscription of a channel, a throwing handler reports to its own subscription, and closing one
  subscription removes only its emitter. Run `pnpm --filter pg-prime exec vitest run test/session/listen.test.ts`.
- `packages/pg-prime/test/pg/session-listen.test.ts` — one dedicated backend shared by channels; a killed
  backend producing `reconnect` then `gap`; two subscribers on one channel both getting `gap`; `pg_notify($1,$2)`
  delivery; refusal and `directConnection` routing under a transaction profile. Requires a real server:
  set `PG_PRIME_TEST_URL` and run `pnpm --filter pg-prime exec vitest run --project pg test/pg/session-listen.test.ts`.
- `packages/pg-prime/test/session/session.test.ts:1093` — the profile matrix marks LISTEN unsupported under
  transaction poolers.
- Uncovered: repeated reconnect failures and the jitter schedule.
