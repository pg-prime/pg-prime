# @pg-prime/cron

Distributed cron for [pg-prime](https://github.com/pg-prime/pg-prime): schedules that fire exactly
once per tick across any number of instances, with PostgreSQL as the only coordinator.

> **Status: pre-alpha.** The API may still change.

```sh
pnpm add @pg-prime/cron pg-prime
```

```ts
import { defineSchedule, pgCron } from '@pg-prime/cron'

const nightly = defineSchedule(
  'nightly-cleanup',
  { cron: '0 3 * * *', tz: 'Europe/Berlin' },
  { handler: async (run) => cleanUp(run.signal) },
  { overlap: 'skip', misfire: 'once', timeoutMs: 600_000 },
)

const cron = pgCron({ db, schedules: [nightly] })
await cron.start()
```

- Cron patterns with a time zone (5 or 6 fields), fixed intervals, one-shot times; `startAt`,
  `endAt` and `limit`.
- One claim statement per tick: a compare-and-set on the schedule row plus a unique `(schedule,
  tick)` row, so a tick runs once under any number of instances. Only the database clock is used.
- Overlap `skip | allow`; misfire `skip | once` after downtime, with a grace period.
- Handler runs under a lease with heartbeats, timeouts, in-process retries and cancel.
- Run history, pause/resume, enable/disable, manual triggers picked up only by an instance that
  registered the handler.
- Works behind PgBouncer in transaction mode (by polling), on Node ≥ 22.12 and Bun.

One runtime dependency, `croner`. `@pg-prime/mq` is an optional peer for the queue target.

Docs: [guide](https://pg-prime.dev/guides/cron/), [operations](https://pg-prime.dev/operations/cron/),
[reference](https://pg-prime.dev/reference/cron/).
