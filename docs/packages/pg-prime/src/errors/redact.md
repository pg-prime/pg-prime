# packages/pg-prime/src/errors/redact.ts

## Purpose
The error redaction policy (`errors` config key) and caller call-site capture. `query/run.ts` resolves the
options per `pgPrime(...)`; `errors/map.ts` applies `redactSql` and `redactDetail` to every mapped server
error; `session/runner.ts`, `session/handles.ts` and `session/guard.ts` call `captureCallSite` when
`captureCallSite` is on. `ErrorOptions` is a public type via `src/index.ts`; the functions are internal.

## Public API
- `ErrorOptions` — `includeSql?` (default `true`), `maxSqlLength?` (`4096`), `includeParams?` (`false`),
  `includeDetail?` (`false`), `captureCallSite?` (`!production`).
- `ResolvedErrorOptions` — the same five keys, all required.
- `resolveErrorOptions(opts, production): ResolvedErrorOptions` — applies the defaults.
- `redactSql(sql, o): string | undefined` — `undefined` when absent or `includeSql` is off; truncates with a
  `… [N more characters elided]` marker past `maxSqlLength`.
- `ParsedDetail` — `{ columns, values, referencedTable? }`.
- `parseDetail(detail): ParsedDetail | undefined` — parses `Key (cols)=(vals)` and `in table "t"`.
- `redactDetail(detail, sqlstate, o): { detail?, detailRedacted }` — keeps columns, drops values.
- `captureCallSite(boundary?): string | undefined` — first stack frame outside the library, as `at …`.

## Flow
1. `redactDetail` returns nothing for no detail, the verbatim detail when `includeDetail` is on, and the
   verbatim detail for `40P01` (`packages/pg-prime/src/errors/redact.ts:122`).
2. Otherwise it parses the detail; no match or no columns drops it entirely with `detailRedacted: true`
   (`packages/pg-prime/src/errors/redact.ts:128`).
3. A match is rewritten to `Key (cols)=(…) [values redacted]` plus an optional referencing-table suffix
   (`packages/pg-prime/src/errors/redact.ts:132`).
4. `parseDetail` splits columns on commas and values on top-level commas only
   (`packages/pg-prime/src/errors/redact.ts:80`, `packages/pg-prime/src/errors/redact.ts:94`).
5. `captureCallSite` on V8 sets `Error.prepareStackTrace` to return raw `CallSite[]` and
   `Error.stackTraceLimit` to 8, calls `Error.captureStackTrace(holder, boundary)`, then restores both in
   `finally` (`packages/pg-prime/src/errors/redact.ts:180`).
6. It returns the first frame whose file is neither `node:` nor matched by `INTERNAL`
   (`packages/pg-prime/src/errors/redact.ts:195`).
7. Without `Error.captureStackTrace` it scans `new Error().stack` lines instead
   (`packages/pg-prime/src/errors/redact.ts:181`, `packages/pg-prime/src/errors/redact.ts:210`).

## Gotchas
- `INTERNAL` skips any path containing `/src/` or `/dist/` followed by `query`, `session`, `errors`,
  `driver`, `observe`, `pooler`, `compile`, `codec` or `sql` — including an application's own
  `src/query/` etc. (`packages/pg-prime/src/errors/redact.ts:151`).
- Only 8 frames are captured; if every one is internal the result is `undefined`
  (`packages/pg-prime/src/errors/redact.ts:159`).
- `captureCallSite` mutates two `Error` globals synchronously; anything else that relies on a custom
  `prepareStackTrace` sees it replaced only during the call.
- The non-V8 fallback ignores `boundary` and also skips `node:internal` lines.
- `maxSqlLength` counts UTF-16 code units, and the marker is appended beyond the limit
  (`packages/pg-prime/src/errors/redact.ts:60`).
- `redactDetail` does not check the SQLSTATE class: any non-`40P01` detail without the `Key (…)=(…)` shape is
  dropped (`packages/pg-prime/src/errors/redact.ts:128`).
- The `Key` regex tolerates one level of nested parentheses in values (`packages/pg-prime/src/errors/redact.ts:77`).

## Tests
- `packages/pg-prime/test/session/session.test.ts` (unit): `redaction (07 §4.3)` at line 789 — `parseDetail`,
  column-keeping redaction, `includeDetail`, the `40P01` exception, sql inclusion and params exclusion,
  truncation, `captureCallSite` defaults; `call-site capture (07 §7.4)` at line 1694 — caller frame, global
  restoration, frames without a file name.
- Run: `pnpm --filter pg-prime exec vitest run test/session/session.test.ts`.
- Uncovered: the non-V8 `fromStackString` fallback and the 8-frame limit.
