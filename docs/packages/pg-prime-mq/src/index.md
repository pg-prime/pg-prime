# packages/pg-prime-mq/src/index.ts

## Purpose
The `@pg-prime/mq` entry point: a curated barrel over the declaration, instance, queue, worker,
flow, binding, hook and error modules. Nothing is defined here.

## Public API
- Values: `defineQueue` (`src/define.ts`), `pgMq`, `migrationSql` (`src/mq.ts`), `spanAttributes`
  (`src/hooks.ts`), and the seven error classes (`src/errors.ts`).
- Types: `QueueDef`, `QueueOptions`, `RetryOptions`, `RetryPolicy`, `Keep`, `KeepOptions`, `PayloadOf`,
  `ResultOf`, `PayloadOptions`, `Mq`, `MqConfig`, `QueueHandle`, `Handler`, `Worker`, `WorkerOptions`,
  `Message`, `WorkContext`, `Deferral`, `ChildStatus`, `SendOptions`, `MessageRef`, `ChildSendOptions`,
  `FlowRoot`, `FlowChild`, `FlowRef`, `OnFail`, `BindOptions`, `Binding`, `GroupLimits`, `MessageState`,
  `MqHooks`, `InternalKind`, `SettleEvent`, `SettleOutcome`.

## Flow
1. Re-exports only (packages/pg-prime-mq/src/index.ts:1); the statement builders under `src/sql/` stay internal.

## Gotchas
- The surface is pinned by `tools/api-snapshot/pg-prime-mq.json` and the generated
  `src/unsupported-typescript.d.ts` stub.

## Tests
- `node tools/api-snapshot.mjs --check` gates the export list; `test/unit/types.test.ts` probes the
  registry types and that `pgMq(...)` satisfies cron's `CronEnqueuer`. `pnpm --filter @pg-prime/mq test`.
