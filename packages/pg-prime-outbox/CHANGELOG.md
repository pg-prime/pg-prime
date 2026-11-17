# @pg-prime/outbox

## 0.2.6

### Patch Changes

- Updated dependencies []:
  - pg-prime@0.2.6

## 0.2.5

### Patch Changes

- [#17](https://github.com/pg-prime/pg-prime/pull/17) [`4d88f26`](https://github.com/pg-prime/pg-prime/commit/4d88f2638b320c33d1c91044ee79d08e67efd851) Thanks [@YohoCX](https://github.com/YohoCX)! - - mq: the lease-expiry scan no longer aborts on a `maxAttempts` past `int4` or on a message past 1023 attempts (`2 ^ n` overflowed float8); the SQL backoff saturates at `maxDelayMs` exactly like `backoffMs`, which now clamps its exponent too (events' copy as well).
  - mq: `worker.close({ graceMs })` clears its grace timers instead of keeping the process alive for up to 2 × `graceMs`.
  - mq, events: `queue.drop()` and `subscription.remove()` stop this instance's workers, bindings and readers of that definition first, without waiting for in-flight handlers (`force` aborts their signals), so a handler may drop or remove its own definition; a loop left running re-created the row on its next iteration (queue unpaused, subscription re-seeded at 'now').
  - events: readers are matched and `ready()` is memoised by (topic, name) tuples, not joined strings, so `a/b` + `c` and `a` + `b/c` no longer share one row or one reader set.
  - outbox, cron: `backoffMs` clamps its exponent like mq and events (`0 * 2 ** 1024` was NaN).
  - create: the `--testing` scaffold pins `@types/pg`, which `test/setup.ts` needs and pnpm does not hoist from `@pg-prime/kit`.
  - testing: the PGlite bridge no longer lets a refused cross-transaction socket's pipelined `Sync` run or take over the transaction owner.
  - testing: `scratchDatabase().drop()` is marked done only after the drop succeeds, so a failed drop is retried by the next call.
- Updated dependencies [[`2993a2b`](https://github.com/pg-prime/pg-prime/commit/2993a2b2552aba0837d23f731a231a364f1254bc), [`680ae09`](https://github.com/pg-prime/pg-prime/commit/680ae0944dc001e12d5779bfb8f03edd71e9db62), [`577fca6`](https://github.com/pg-prime/pg-prime/commit/577fca6c5706c01b43e4ea7dfa0912fe0a2ded08), [`c5aa0c4`](https://github.com/pg-prime/pg-prime/commit/c5aa0c43043cb995cf528ae6028f26b00c4b000a)]:
  - pg-prime@0.2.5

## 0.2.4

### Patch Changes

- Updated dependencies []:
  - pg-prime@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies [[`ae10bcb`](https://github.com/pg-prime/pg-prime/commit/ae10bcb575712c41afbc5831ddac66ec2da6d105)]:
  - pg-prime@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies [[`820c13e`](https://github.com/pg-prime/pg-prime/commit/820c13e80fff4e7e010dcde70af06edabaab82db)]:
  - pg-prime@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies []:
  - pg-prime@0.2.1

## 0.2.0

### Minor Changes

- [#3](https://github.com/pg-prime/pg-prime/pull/3) [`ab7b6b4`](https://github.com/pg-prime/pg-prime/commit/ab7b6b4b0180b4276ccc97746e7bc1dbcf300904) Thanks [@YohoCX](https://github.com/YohoCX)! - New package: `@pg-prime/outbox`, the transactional outbox: write inside your transaction, relay in per-key order. It peers `pg-prime >=0.2.0` and versions with the `fixed` group.

### Patch Changes

- Updated dependencies [[`a75e3a1`](https://github.com/pg-prime/pg-prime/commit/a75e3a19a2e9f615acdbc1d9e240bfc81bf9e9dd), [`6a7ed8e`](https://github.com/pg-prime/pg-prime/commit/6a7ed8e4f9e63e3437400848c0b743dad71a9708), [`98ad069`](https://github.com/pg-prime/pg-prime/commit/98ad069d689b69d4ad76a3c159bda5820341bf80), [`60b99c8`](https://github.com/pg-prime/pg-prime/commit/60b99c86c94d5a720682e775f32913e0a1c7ce31), [`7667362`](https://github.com/pg-prime/pg-prime/commit/7667362fd19a099f294d79901e2e487efb58455e), [`7e93af3`](https://github.com/pg-prime/pg-prime/commit/7e93af378387d69d2d736276527def3d63fc9e63)]:
  - pg-prime@0.2.0
