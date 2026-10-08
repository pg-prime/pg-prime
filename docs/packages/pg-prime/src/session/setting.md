# packages/pg-prime/src/session/setting.ts

## Purpose
Typed custom settings (GUCs): one `SettingKey` names a setting for both writing it (`tx.setLocal`, `localSettings`) and reading it in SQL (queries and `definePolicy` predicates).
Shared by design/20 (policies) and design/19 (`@pg-prime/context`). Validates names with `assertGucName` from `transaction.ts`.

## Public API
- `setting(name)` — `SettingKey<string, 'text'>` with `textCodec`.
- `setting(name, codec)` — `SettingKey<CodecOut<C>, CodecPg<C>>`; throws `UsageError` for an invalid name (same rule as `setLocal`: at most one dot, no `$`).
- `SettingKey<T, P>` — `name`, `codec`; `set(value)` returns the frozen `{ [name]: codec.encode(value) }`, throwing `UsageError` if the codec does not encode to text; `current()` returns `TypedFragment<T | null, P>`.

## Flow
1. `setting` validates the name, then builds `nullif(current_setting('<name>', true), '')::<sqlName>` once (`packages/pg-prime/src/session/setting.ts:23`).
2. The text becomes a fragment through a frozen one-chunk template object and `.as(codec)`, so it carries no bind and does not set `usedUnsafeRaw`.
3. `current()` returns that same fragment on every call; it renders identically in a query and in policy DDL.

## Gotchas
- `current()` is NULL when the setting is unset or `''`. `current_setting(x, true)` avoids the error on a fresh connection; `nullif` avoids `''::uuid` (22P02) on a connection where an earlier `SET LOCAL` left the `''` placeholder.
- A NULL makes a policy predicate false (fail-closed: zero rows, never all rows).
- `set()` performs no I/O; spread or pass its record to `tx.setLocal(...)`.

## Tests
- `packages/pg-prime/test/session/setting.test.ts` — `set()` records, `current()` SQL in a query and in DDL, name parity with `setConfigParams`, byte-codec refusal.
- `packages/pg-prime/test/live/rls.test.ts` — the placeholder reuse case and a projected `current()`.
- Run: `pnpm --filter pg-prime exec vitest run test/session/setting.test.ts`.
