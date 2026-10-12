# packages/pg-prime-mq/src/queue/flow.ts

## Purpose
Send options, message refs, flows (`mq.flow`) and `ctx.spawn`: everything that turns options into
S1 rows for `sql/send.ts`.

## Public API
- `SendOptions`, `MessageRef`, `ChildSendOptions`, `OnFail`, `FlowRoot`, `FlowChild`, `FlowRef`.
- Internal: `newRow(def, payload, opts, n, parentN?, kids?)`, `flow(core, root, tx?)`, `spawn(core, parent, def, payload, opts?)`.

## Flow
1. `newRow` validates the group key and `dedup`-needs-`key`, merges retry overrides, encodes (packages/pg-prime-mq/src/queue/flow.ts:58).
2. `flow` walks the tree depth-first, numbering nodes; inner nodes carry their child count (packages/pg-prime-mq/src/queue/flow.ts:110).
3. One insert; a deduplicated root returns the owner with `children: []`. An owner that finished before it was read sends the flow again (≤ 3 rounds), never a zero id.
4. `spawn` inserts one child guarded by the parent's token; 0 rows ⇒ `LeaseLostError` (packages/pg-prime-mq/src/queue/flow.ts:155).

## Gotchas
- `key`/`dedup` on a flow child or in `spawn` is a `UsageError` (dedup is root-only).
- A flow without `{ tx }` readies every queue in it; with `{ tx }` it needs `start()` first.

## Tests
- `test/live/flow.test.ts`. `pnpm --filter @pg-prime/mq test:pg`.
