# packages/pg-prime-cron/src/planner.ts

## Purpose
The misfire policy as a pure function: from a due row (Q1) and DB `now()`, decide which tick the claim records, how many it folds, and the next `next_at`. Called by `tick()` in `cron.ts` before K1 or the queue target.

## Public API
- `plan(input: PlanInput, ticker: Ticker): Plan` — returns `{ expect, fire, decided, missed, next, lateMs, misfired }`.
- `PlanInput` — `nextAt`, `dbNow`, `endAt`, `maxRuns`, `runs`, `misfire`, `graceMs`.

## Flow
1. `expect` is always the stored `next_at`: K1's CAS compares it.
2. The horizon is `min(dbNow, endAt)`; a stored `next_at` past it fires nothing and ends the schedule (`planner.ts:33`).
3. Within `graceMs`: fire `next_at`, next is the following tick, so a late loop catches up tick by tick.
4. Beyond it: fire the last tick ≤ horizon; count the ticks in `[next_at, fire]` (capped at 10 000); `missed = count − 1`; `'skip'` sets `decided: 'missed'`; next is the first tick after `dbNow`.
5. `next` is `null` once `runs + 1 >= maxRuns`: the limit counts claimed ticks.

## Gotchas
- Plan 18 §3.2 counted `missed` over `(next_at, h]`; the code counts `[next_at, h]` so ten overdue ticks give `missed = 9`, as the tier-2 oracle states.
- No tick after `endAt` is ever fired, under either policy and any grace.
- `onMisfire.missed` is the ticks that did not run: `missed` for `'once'`, `missed + 1` for `'skip'`.

## Tests
- `packages/pg-prime-cron/test/unit/planner.test.ts`: catch-up inside grace, both policies after downtime, the 10 000 cap, `endAt` (a sweep over policies × grace × lateness), limit, one-shot `at`.
- Run: `pnpm --filter @pg-prime/cron test`.
