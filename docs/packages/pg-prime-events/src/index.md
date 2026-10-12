# packages/pg-prime-events/src/index.ts

## Purpose
The `@pg-prime/events` entry point: a curated barrel over the declaration, handle, log and
building-block modules. Nothing is defined here.

## Public API
- Values: `defineChannel`, `defineTopic`, `defineSubscription` (`src/define.ts`), `pgEvents`
  (`src/events.ts`), `engineChannel`, `engineChannelSql` (`src/channel.ts`), `waker` (`src/waker.ts`).
- Errors: `EventsLeaseLostError`, `NotStartedError`, `PayloadError`, `SchemaVersionError` (`src/errors.ts`).
- Types: `ChannelDef`, `TopicDef`, `SubscriptionDef`, `EventsDefinitions`, `PayloadOf`, `RetryOptions`,
  `PayloadOptions`, `StandardSchemaV1`, `Events`, `EventsConfig`, `ChannelHandle`, `TopicHandle`,
  `Entry`, `PublishOptions`, `SubscriptionHandle`, `EntryHandler`, `BatchHandler`, `ReadContext`,
  `Reader`, `RunOptions`, `Waker`, `WakeReason`, `WakerOptions`, `EventsHooks`, `InternalKind`.

## Flow
1. Re-exports only (`packages/pg-prime-events/src/index.ts:1`); internals such as `Core`, `Statements`,
   the cursor functions and `encodePayload` stay unexported.

## Gotchas
- `waker`, `engineChannel`, `engineChannelSql` and the subscription API are building blocks that
  `@pg-prime/mq` imports (plan 15 E-D7); renaming them breaks mq.
- The surface is pinned by `tools/api-snapshot/pg-prime-events.json` and the generated
  `src/unsupported-typescript.d.ts` stub.

## Tests
- `node tools/api-snapshot.mjs --check` gates the export list; `test/unit/types.test.ts` probes the
  registry types. `pnpm --filter @pg-prime/events test`.
