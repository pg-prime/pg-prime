# packages/pg-prime-cron/src/define.ts

## Purpose
Turns a schedule definition into validated `schedules` columns and a hash. Used by `defineSchedule` (public), by `cron.ts` for sync, `create`, `update` and `preview`, and by the SQL upsert.

## Public API
- `defineSchedule<P = undefined>(name, when, target, opts?): ScheduleDef<P>` — validates and returns `{ name, when, target, options }`; throws `ScheduleError` with the field.
- `colsOf(def): Cols` (internal) — validates and maps a definition to columns with defaults (`overlap: 'skip'`, `misfire: 'once'`, grace 60 000, keep 100, 30 days).
- `fnv(s): string` (internal) — 64-bit FNV-1a, hex; the spec hash (`fnv(JSON.stringify(cols))`) and the NOTIFY channel suffix.

## Flow
1. `defineSchedule` (`define.ts:26`) checks the name and that the target is exactly one of a `handler` function or a `queue` declaration (`kind: 'queue'` and a `name`, as `defineQueue(...)` returns); a bare `{ name }` is refused.
2. `colsOf` (`:47`) requires exactly one of `cron`/`everyMs`/`at`, a non-empty pattern, a valid `tz` (`assertTz`), `everyMs >= 1000`, valid Dates, `endAt > startAt`, integer counts and the two enums.
3. A function payload is stored as `null`; the claiming instance calls it.

## Gotchas
- The cron pattern itself is not parsed here: croner is loaded lazily, so pattern errors surface from `ticker()` at `start`/`create`/`update`/`preview`.
- `Cols` key order is the hash input order; reordering it changes every stored `spec_hash` once.
- A payload function returning `never` infers `P = never`, which is not assignable to `ScheduleDef<any>`; annotate `P`.

## Tests
- `packages/pg-prime-cron/test/unit/ticks.test.ts` ("invalid schedules"): each `ScheduleError.field`.
- Run: `pnpm --filter @pg-prime/cron test`.
