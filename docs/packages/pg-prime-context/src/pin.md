# packages/pg-prime-context/src/pin.ts

## Purpose
The two statements of a pinned savepoint: capture the session's settings before it, restore them
before `RELEASE`. A `propagation: 'savepoint'` with settings uses them for its own keys only.

## Public API
- Internal: `capture(tx, keys, builtins = true)` (`packages/pg-prime-context/src/pin.ts:6`),
  `restore(tx, before, keys)` (`:14`).

## Flow
1. `capture`: one `select jsonb_object_agg(name, current_setting(name, true))` over
   `pg_settings where context = 'user'` (unless `builtins` is false) ∪ `keys` (a JSON array bind).
2. `restore`: keys learned since the capture are added as `null`; one statement runs
   `set_config(key, coalesce(value, ''), true)` for each entry whose `current_setting` differs.

## Gotchas
- Custom (dotted) settings never appear in `pg_settings`, `SHOW ALL` or `pg_show_all_settings()`
  (PG 17, 18, PGlite), so only keys the host knows are restored; one set only by a raw
  `tx.setLocal` leaks into the next pinned request.
- `''` is written only for keys captured as `NULL` (placeholders); built-ins go back to their
  captured value, e.g. `statement_timeout` to `30s`.
- The comparison runs server-side, so a `role` or `search_path` change by the request is restored
  too.

## Tests
- `packages/pg-prime-context/test/unit/pin.test.ts` — statement order and binds.
- `packages/pg-prime-context/test/live/context.test.ts` — "two tenants in sequence", "restores
  built-ins".
