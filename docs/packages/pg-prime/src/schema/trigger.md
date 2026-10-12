# packages/pg-prime/src/schema/trigger.ts

## Purpose
`updatedAtTrigger(column)`: a table extra that asks for a `BEFORE UPDATE … FOR EACH ROW` trigger setting the column to `now()` (design/20 §3.1, §4).
It is plain data in `TableRuntime.extras`; the kit renders the function and trigger files.

## Public API
- `updatedAtTrigger(column)` — returns the `TableExtra` `{ node: 'updatedAtTrigger', column: '<db name>' }`. The parameter type accepts only a `timestamptz`/`timestamp` column ref; throws `SchemaError` at runtime for any other type, for a non-column, or when `pgprime_set_<column>` exceeds 63 bytes.

## Flow
1. Reads the ref's `$.column.ddl.pgType` and refuses anything but `timestamptz`/`timestamp` (`packages/pg-prime/src/schema/trigger.ts:12`).
2. Validates the derived trigger and function name `pgprime_set_<db name>` with `checkName`.
3. Returns the node; nothing is rendered in core.

## Gotchas
- The column DSL has only `t.timestamptz()`; a zoneless column is `t.raw('timestamp')`, whose type is not narrowed, so typed callers need a cast.
- The SQL design/20 §4 pins (static per-column plpgsql body, `CREATE OR REPLACE TRIGGER`) belongs to the kit; `test/live/rls.test.ts` runs that SQL on PGlite.

## Tests
- `packages/pg-prime/test/schema/trigger.test.ts` — node shapes and the three refusals.
- `packages/pg-prime/test/query/types/policy.probe.ts` — a non-timestamp column is a type error.
- `packages/pg-prime/test/live/rls.test.ts` — the trigger overwrites an explicit `updated_at`.
