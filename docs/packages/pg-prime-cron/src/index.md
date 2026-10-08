# packages/pg-prime-cron/src/index.ts

## Purpose
The `@pg-prime/cron` entry point: re-exports the two functions, three error classes and the public types. The types live in `packages/pg-prime-cron/src/types.ts` and the errors in `packages/pg-prime-cron/src/errors.ts`; nothing else is public.

## Public API
- `defineSchedule(name, when, target, opts?)` — from `define.ts`; see `define.md`.
- `pgCron(config): Cron` — from `cron.ts`; see `cron.md`.
- `CronLeaseLostError` — code `CRON_LEASE_LOST`; the `cause` of `onInternal('heartbeat-failed')` when a heartbeat finds its run gone (`errors.ts:4`).
- `ScheduleError` — code `CRON_SCHEDULE`, with `field` naming the bad option (`errors.ts:11`).
- `SchemaVersionError` — code `CRON_SCHEMA_VERSION`; wraps core's ledger `ConfigError` and the `autoMigrate: false` refusal (`errors.ts:20`).
- Types: `ScheduleWhen`, `ScheduleOptions<P>`, `ScheduleTarget<P>`, `ScheduleDef<P>`, `RunContext<P>`, `RunState`, `CronEnqueuer`, `CronHooks`, `CronConfig`, `Cron`, `ScheduleInfo`, `RunInfo` (`types.ts`).

## Flow
1. An application builds `ScheduleDef`s with `defineSchedule`, then one `pgCron({ db, schedules })` per process.
2. `start()` migrates, syncs and runs the loop; the admin methods work on the same handle.

## Gotchas
- `Cron` extends core's `AsyncDisposable_`, not the lib `AsyncDisposable`, so the build needs no `esnext.disposable` lib (`types.ts:158`).
- `CronEnqueuer` and the queue target are structural (`{ kind: 'queue', name }`, which mq's `QueueDef` has): nothing in `src` or `dist` names `@pg-prime/mq` as a specifier (checked by `test/unit/package.test.ts`).
- `onInternal` kinds include `'loop-failed'`, added beyond plan 18 §5 so a failing iteration is reported.

## Tests
- `packages/pg-prime-cron/test/unit/package.test.ts`: the exported value names, the backoff vectors, no `@pg-prime/mq` specifier in `src/` or `dist/`.
- `tools/api-snapshot/pg-prime-cron.json` is the surface golden (`pnpm api-snapshot:check`).
