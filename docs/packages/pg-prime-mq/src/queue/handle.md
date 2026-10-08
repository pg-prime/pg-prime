# packages/pg-prime-mq/src/queue/handle.ts

## Purpose
`QueueHandle`: sends, manual consumption, reads, `result`/`watch`, and admin for one queue. Built by
`pgMq` for declared and ad hoc queues; starts workers through `queue/worker.ts`.

## Public API
- `QueueHandle<T, R>` — `start`, `send`, `sendMany`, `work`, `claim`, `complete`, `fail`, `extend`,
  `get`, `list`, `counts`, `result`, `watch`, `pause`, `resume`, `cancel`, `retry`, `promote`,
  `remove`, `purge`, `drop`, `pauseGroup`, `resumeGroup`, `setGroupLimits`.
- `queueHandle(core, def)` — internal constructor.

## Flow
1. `sendMany` encodes each item, keeps the first of duplicate dedup keys and splits by dedup mode (packages/pg-prime-mq/src/queue/handle.ts:108).
2. Each statement's deduplicated rows take their owner from the debounce `d` row or a fresh `dedup` read; a vanished winner is sent again (≤ 3 rounds).
3. Two statements without `{ tx }` share one transaction.
4. `claim` promotes, then S3/S4, then S5 for the rest; undecodable payloads are failed (packages/pg-prime-mq/src/queue/handle.ts:177).
5. `result` opens a waker on the watch channel first, then re-reads the row on every wake (packages/pg-prime-mq/src/queue/handle.ts:260).
6. `cancel` finishes an idle message (`guard: idle`), else flags an active one (packages/pg-prime-mq/src/queue/handle.ts:312).
7. `remove` locks the tree without waiting, refuses active members, deletes, and resolves the root's dependency as ignored (packages/pg-prime-mq/src/queue/handle.ts:341).

## Gotchas
- `sendMany` takes `{ payload, opts }` items (plan 17 §7.2 also allowed bare payloads, ambiguous at runtime).
- `retry({ ids })` refuses finished parents with `pending`/`failed` children (a stale read only over-refuses).
- `fail` re-reads the row through `tx` when given (parent, retry policy); `complete` needs only the token.
- `watch()` needs a LISTEN connection; behind a transaction pooler it is refused, `result()` polls.

## Tests
- `test/live/send.test.ts`, `test/live/work.test.ts` (admin, manual consumption, result), `test/pg/listen-gap.test.ts`. `pnpm --filter @pg-prime/mq test:pg`.
