# packages/pg-prime-cron/src/sql/runs.ts

## Purpose
Statements on a live run: the batched heartbeat, F1 (finish), the token-guarded move to `cancelling`, and X1 (cancel). Called by `runner.ts` and `cron.cancel`.

## Public API
- `heartbeat(q, t, runs, leaseMs)` — extends every `(id, token)` still `running`/`cancelling`; returns `id, state` of those it found.
- `finish(q, t, Finish)` — F1: token-guarded finish to `succeeded`/`failed`/`cancelled`, then `running − 1`; one row when it applied.
- `markCancelling(q, t, id, token)` — `running` → `cancelling` for a timeout or shutdown abort.
- `cancel(db, t, id): Promise<boolean>` — X1; true when a `pending` or `running` run changed.

## Flow
1. F1 (`runs.ts:26`): `f` updates the run `where id and token and state in (running, cancelling)`; the outer update decrements the schedule from `f`.
2. X1 (`:43`), one transaction: lock the run, then its schedule (F1's order), then one statement: `pending` → `cancelled` with `running − 1`, `running` → `cancelling` (still counted).

## Gotchas
- The owner learns of a cancel at its next heartbeat (`leaseMs / 3`), which returns `cancelling` and aborts the handler.
- F1's schedule update is driven by `f`'s `RETURNING`, so a lost token changes nothing.
- An already `cancelling` run cannot be cancelled again (`false`).

## Tests
- `packages/pg-prime-cron/test/unit/sql.test.ts`: heartbeat, F1, markCancelling goldens.
- `packages/pg-prime-cron/test/live/cron.test.ts` ("cancels a pending run and a running one"), `packages/pg-prime-cron/test/pg/cron.test.ts` ("cancel under 'skip'").
