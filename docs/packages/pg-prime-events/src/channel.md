# packages/pg-prime-events/src/channel.ts

## Purpose
Typed LISTEN/NOTIFY channels over core's `db.notify` / `db.listen`, plus the engine-channel name
scheme shared with `@pg-prime/mq`. Built by `pgEvents` (`src/events.ts`); topics use the names for
wake-ups (`src/events.ts:109`).

## Public API
- `engineChannel(schema, kind, name)` → `'ev_' + first 24 hex chars of sha256(schema/kind/name)`.
- `engineChannelSql(schema, kind, nameFragment)` → a SQL `Fragment` computing the same name; the
  prefix is bound, the name fragment spliced.
- `ChannelHandle<T>` — `notify(payload, { tx? })`, `listen(handler, { signal?, onGap? })` → core
  `Subscription`.
- `channelHandle(db, def)` — internal constructor.

## Flow
1. `notify` encodes and validates the payload, then calls `(tx ?? db).notify(name, json)`
   (`packages/pg-prime-events/src/channel.ts:35`).
2. `listen` subscribes through `db.listen`; each raw payload is `JSON.parse`d and decoded (`:44`).
3. Parse or validation failures and hub errors go to the subscription's `'error'` handlers, never to
   the handler (`:39`, `:55`); `onGap` attaches to the hub's `'gap'` (`:56`).
4. The returned subscription keeps the hub's `channel`, `close` and `gap`/`reconnect` events (`:57`).

## Gotchas
- User channels use their literal name, so SQL triggers can `pg_notify` into them; engine names are
  fixed-length and schema-isolated (plan 15 E-D6).
- TS and SQL hashes must match: kind `'t'` names topic wake channels, mq uses its own kinds.
- Without an `'error'` listener, invalid payloads are dropped silently.
- Delivery is live only; behind a transaction pooler `listen` throws core's
  `UnsupportedInPoolerModeError` unless `directConnection` is configured, while `notify` works.
- Needs `node:crypto` (Node ≥ 22.12, Bun).

## Tests
- `test/unit/channel.test.ts` — fixed hash vector, SQL twin text, name limits, notify/listen over a
  fake `Db`. `test/pg/channel-gap.test.ts` — two listeners and two wakers all see `gap` after the
  LISTEN backend is terminated. `test/pg/pgbouncer.test.ts` — `listen` refused, `notify` works.
