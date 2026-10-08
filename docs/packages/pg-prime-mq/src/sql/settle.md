# packages/pg-prime-mq/src/sql/settle.ts

## Purpose
The one `finish` builder for terminal transitions, the token-guarded moves out of `active`
(retry, defer, release, wait for children), progress and lease extension.

## Public API
- Internal: `Terminal`, `Guard` (`token` | `flagged` | `expired` | `blocked` | `idle`), `FinishArgs`, `Settled`, `Move`;
  `finishSql`, `finish`, `lockAncestors`, `depsCtes`, `moveSql`, `move`, `progress`, `extend`.

## Flow
1. `done` updates (or deletes, `del`) the message under its guard; `expire_at` comes from the queue row (packages/pg-prime-mq/src/sql/settle.ts:119).
2. `dd` drops an `until-done` dedup row; `dp`/`pr` resolve the parent's dependency (packages/pg-prime-mq/src/sql/settle.ts:57).
3. `gd` then `qd` decrement group and queue counters, gated on the previous CTE; freed capacity wakes workers.
4. Moves (S8r/S12/S13/S14) share the counter fragments (packages/pg-prime-mq/src/sql/settle.ts:196).

## Gotchas
- Lock order is message → parent message → group → queue; claims never wait on message or group rows.
- `pr` updates the parent, a different row than `done`: no statement modifies a row twice.
- The release reads `pending_deps` on the locked parent row (EvalPlanQual): released once.
- S14 refuses `child_failed`, read on the parent's own locked row.
- Every move refuses a row flagged by `cancel()`; the caller finishes it with the `flagged` guard (`moveMessage`).

## Tests
- `test/unit/sql.test.ts` (fragment matrix, lock order); `test/pg/concurrency.test.ts`. `pnpm --filter @pg-prime/mq test:pg`.
