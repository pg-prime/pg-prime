---
'@pg-prime/mq': patch
'@pg-prime/events': patch
'@pg-prime/testing': patch
'@pg-prime/create': patch
'@pg-prime/outbox': patch
'@pg-prime/cron': patch
---

- mq: the lease-expiry scan no longer aborts on a `maxAttempts` past `int4` or on a message past 1023 attempts (`2 ^ n` overflowed float8); the SQL backoff saturates at `maxDelayMs` exactly like `backoffMs`, which now clamps its exponent too (events' copy as well).
- mq: `worker.close({ graceMs })` clears its grace timers instead of keeping the process alive for up to 2 × `graceMs`.
- mq, events: `queue.drop()` and `subscription.remove()` stop this instance's workers, bindings and readers of that definition first, without waiting for in-flight handlers (`force` aborts their signals), so a handler may drop or remove its own definition; a loop left running re-created the row on its next iteration (queue unpaused, subscription re-seeded at 'now').
- events: readers are matched and `ready()` is memoised by (topic, name) tuples, not joined strings, so `a/b` + `c` and `a` + `b/c` no longer share one row or one reader set.
- outbox, cron: `backoffMs` clamps its exponent like mq and events (`0 * 2 ** 1024` was NaN).
- create: the `--testing` scaffold pins `@types/pg`, which `test/setup.ts` needs and pnpm does not hoist from `@pg-prime/kit`.
- testing: the PGlite bridge no longer lets a refused cross-transaction socket's pipelined `Sync` run or take over the transaction owner.
- testing: `scratchDatabase().drop()` is marked done only after the drop succeeds, so a failed drop is retried by the next call.
