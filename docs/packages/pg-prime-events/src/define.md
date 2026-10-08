# packages/pg-prime-events/src/define.ts

## Purpose
Frozen, typed declarations for channels, topics and subscriptions. `pgEvents` (`src/events.ts`)
turns them into handles; the payload type travels in `payload: PayloadOptions<T>`.

## Public API
- `defineChannel<T>(name, opts?)` → `ChannelDef<T>`; `name` is the literal NOTIFY channel, 1–63 UTF-8
  bytes without NUL, else `UsageError`.
- `defineTopic<T>(name, opts?)` → `TopicDef<T>`; `keepMs` (default `null`: forever) and
  `keepUntilConsumed` (default false) plus `schema`/`codec`.
- `defineSubscription<T>(topic, name, opts?)` → `SubscriptionDef<T>`; `types` (null: all), `from`
  (default `'now'`, first creation only), `retry` defaults `{ 3, 1000, 60 000, 'full' }`.
- `ChannelDef`, `TopicDef`, `SubscriptionDef`, `RetryOptions`, `EventsDefinitions` — declaration shapes.
- `PayloadOf<D>` — the payload type of any declaration.

## Flow
1. Validate the name (`packages/pg-prime-events/src/define.ts:53`, `:95`).
2. Split topic options into retention and payload options (`:67`); merge retry defaults (`:78`).
3. Return a frozen object tagged by `kind`.

## Gotchas
- `T` is carried structurally through `schema`/`codec` types, so `PayloadOf` infers it even when
  neither option is given (`:42`).
- `from` only matters when the subscription row is first inserted; later upserts update `types` only.
- `types` is copied and frozen; the reader filters by it in SQL.

## Tests
- `test/unit/channel.test.ts` (channel names), `test/unit/types.test.ts` (registry and `PayloadOf`).
  `pnpm --filter @pg-prime/events test`.
