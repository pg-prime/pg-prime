# packages/pg-prime-cron/src/ticks.ts

## Purpose
The next-tick module: one `Ticker` per schedule spec for cron patterns (croner, lazily imported), `every` grids and one-shot `at`, all bounded by `startAt`/`endAt`. Used by the planner, sync, `enable` and `preview` in `cron.ts`.

## Public API
- `ticker(spec: Spec): Promise<Ticker>` — loads croner on the first pattern; throws `ScheduleError('cron')` for a pattern croner rejects.
- `Ticker.next(after)` — the first tick strictly after `after` inside `[startAt, endAt]`, or `null`.
- `Ticker.last(upTo)` — the last tick at or before `upTo`, not before `startAt`; the caller keeps `upTo <= endAt`.
- `assertTz(tz)` — throws `ScheduleError('tz')` when `Intl` rejects the zone.

## Flow
1. Patterns use `new Cron(pattern, { timezone, mode: '5-or-6-parts' })`, validated by one `nextRun()` (`ticks.ts:31`).
2. `every`: `anchor + k × everyMs` with `anchor = startAt ?? anchorAt`, for any integer `k` (`:44`).
3. `at`: one tick.
4. The wrapper applies `startAt` by asking from `startAt − 1 ms` and drops ticks after `endAt` (`:51`).

## Gotchas
- croner strips milliseconds from its reference; `previousRuns` is strictly before it, so `last` asks from the next whole second (`:39`).
- croner's `nextRuns` enumeration repeats 07:00Z on New York's spring-forward day; `nextRun(date)` does not, and only that is used.
- DST (croner 10.0.1): a nonexistent local time fires one hour later (02:30 → 03:30), at most once; a repeated local hour fires once, on its first occurrence.
- `mode: '5-or-6-parts'` refuses 7-field (year) patterns.

## Tests
- `packages/pg-prime-cron/test/unit/ticks.test.ts`: DST goldens for `America/New_York` and `Europe/Berlin` (both transitions), seconds, `L`, `W`, `#`, `@hourly`, `last`, bounds, `every` anchoring, `at`, invalid input.
- Run: `pnpm --filter @pg-prime/cron test`.
