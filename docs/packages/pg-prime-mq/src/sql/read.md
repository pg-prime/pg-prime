# packages/pg-prime-mq/src/sql/read.ts

## Purpose
Reads: the message row shape and its mapping, `get`/`list`/`counts`, child results and the
unlocked holder check the worker and settles use.

## Public API
- `MessageState` (exported); internal `STATES`, `MsgRow`, `msgRow`, `Ref`, `get`, `byId`, `list`,
  `counts`, `DepRow`, `deps`, `holder`.

## Flow
1. `get` by id or by latest `key` (packages/pg-prime-mq/src/sql/read.ts:85); `list` is keyset-paginated by id.

## Gotchas
- `holder` is unlocked on purpose: it may only be blocked by a short admin update otherwise.

## Tests
- `test/live/work.test.ts` (list, counts). `pnpm --filter @pg-prime/mq test:pg`.
