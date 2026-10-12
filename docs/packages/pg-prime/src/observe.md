# packages/pg-prime/src/observe/

## Purpose
The observability layer: the typed `QueryHooks` event model, the `HookBus` that dispatches it with
per-hook failure isolation, the slow-query log, and a dependency-free OpenTelemetry attribute mapping.
`query/run.ts` builds one bus and one resolved log config per `pgPrime(...)` and installs `db.observe`;
`session/runner.ts` and `session/handles.ts` emit query, pool, transaction and retry events;
`session/listen.ts` and `query/run.ts` emit `onInternal`. `src/index.ts` re-exports the types plus
`SEMCONV`, `spanAttributes` and `spanName`. `index.ts` is the internal barrel.

## Public API
- `HookBus` — `add(hooks | undefined)` registers and returns an unsubscribe function; `enabled` is true
  while any registration exists; one method per event (`queryStart`, `queryEnd`, ..., `internal`).
- `QueryHooks` — optional sync members `onQueryStart`, `onQueryEnd`, `onQueryError`, `onTransactionStart`,
  `onTransactionEnd`, `onRetry`, `onPool`, `onNotice`, `onInternal`, each returning `void`.
- `QueryStartEvent` — `queryId`, `sql`, `paramCount`, `execMode`, `handle`, `txId?`, `depth`, `attempt`,
  `label?`, `startedAt`, `operation?`, `tables?`, `params?` (only with `errors.includeParams`).
- `QueryEndEvent` / `QueryErrorEvent` — the start event plus `durationMs`, `waitedForConnectionMs`; end adds
  `rowCount`, `command`, `serverMs`, `decodeMs`; error adds the mapped `error: PgPrimeError`.
- `TxStartEvent` / `TxEndEvent` — `txId`, `depth`, `attempt`, `isolation`, `accessMode`, `label?`,
  `startedAt`; end adds `outcome: 'commit' | 'rollback' | 'error'`, `durationMs`, `error?`.
- `RetryEvent`, `PoolEvent` (`kind` acquire/release/create/destroy/timeout, `waitedMs?`), `NoticeEvent`.
- `InternalEvent` — `kind` (nine literals incl. `'hook-failed'`, `'session-guc-skipped'`), `message`,
  `cause?`, `hook?`.
- `QueryOperation` — `'select' | 'insert' | 'update' | 'delete' | 'ddl' | 'other'`.
- `nextQueryId()` / `nextTxId()` — process-wide monotonic ids `q<base36>` / `t<base36>`.
- `LogLevel`, `LogOptions` — `level` (default `'warn'`), `slowQueryMs` (default `null`), `logAllQueries`,
  `force`, `sink`, `format` (`'pretty' | 'json'`).
- `LogRecord` — `level`, `kind` (`'slow-query' | 'query' | 'query-error' | 'internal'`), `message`, timings,
  `sql`, `paramCount`, `rowCount`, `label`, `callSite`, `code`.
- `resolveLogOptions(opts, production, warn): ResolvedLogOptions` — fills defaults and the default sink.
- `shouldLog(resolved, level): boolean` — true when the configured level is at least `level`.
- `slowQueryRecord(endEvent, callSite, kind)` / `queryErrorRecord(errorEvent)` — build a `LogRecord`.
- `SEMCONV` — `as const` record (not frozen) of OTel database-span attribute names (`db.system.name`, ...).
- `SpanAttributes`, `SpanContext` (`namespace?`, `serverAddress?`, `serverPort?`, `poolerMode?`).
- `spanAttributes(event, ctx?)` — pure; returns a frozen attribute record for a start/end/error event.
- `spanName(event)` — `"<OPERATION> <first table>"`, or the operation alone, or `"QUERY"`.

## Flow
1. `pgPrime` creates a `HookBus`, adds `config.hooks`, and resolves `config.log`
   (`packages/pg-prime/src/query/run.ts:204`, `packages/pg-prime/src/query/run.ts:213`).
2. `db.observe(hooks)` calls `bus.add` and returns its unsubscribe (`packages/pg-prime/src/query/run.ts:430`).
3. `add` replaces the registration array (copy-on-write) and sets `enabled`
   (`packages/pg-prime/src/observe/bus.ts:49`).
4. Per statement, the runner checks `observed()` — `hooks.enabled || logAllQueries || slowQueryMs !== null`
   (`packages/pg-prime/src/session/runner.ts:726`); with nothing observing no event object or clock read exists.
5. When observed it builds a `QueryStartEvent` with `nextQueryId()` and emits `queryStart`
   (`packages/pg-prime/src/session/runner.ts:908`), then `queryEnd` or `queryError`.
6. `#emit` returns immediately when `enabled` is false, else calls each registration's member with
   `this` bound to the hook object (`packages/pg-prime/src/observe/bus.ts:61`).
7. A member that throws is added to that registration's `disabled` set and reported via every other
   registration's `onInternal` plus `console.error` (`packages/pg-prime/src/observe/bus.ts:82`).
8. After `queryEnd`, `logQuery` sinks a `slowQueryRecord` when `durationMs >= slowQueryMs` (level `warn`) or
   when `logAllQueries` is on (level `debug`), gated by `shouldLog` (`packages/pg-prime/src/session/runner.ts:962`).
9. After `queryError`, a `queryErrorRecord` is sunk when `shouldLog(log, 'error')`
   (`packages/pg-prime/src/session/runner.ts:950`).
10. The default sink writes JSON (with `logger: 'pg-prime'`) or a multi-line pretty form to
    `console.error`/`warn`/`log` by level (`packages/pg-prime/src/observe/log.ts:144`).
11. Tracing integrations call `spanAttributes`/`spanName` themselves from hooks; core never creates spans.

## Gotchas
- Hooks are synchronous by type; a returned promise is not awaited, so a rejected async hook is not caught
  by the bus (`packages/pg-prime/src/observe/bus.ts:66`).
- Disabling is per registration and per member, for the life of the bus; re-adding the same object via
  `observe` creates a fresh registration with nothing disabled (`packages/pg-prime/src/observe/bus.ts:51`).
- The failing registration's own `onInternal` is skipped; an `onInternal` that throws while reporting is
  disabled silently (`packages/pg-prime/src/observe/bus.ts:87`, `packages/pg-prime/src/observe/bus.ts:93`).
- `logAllQueries` records are `debug`, but the default level is `'warn'`, so `logAllQueries: true` alone
  emits nothing (`packages/pg-prime/src/session/runner.ts:975`, `packages/pg-prime/src/observe/log.ts:80`).
- `logAllQueries` is forced off when `production` is true unless `force: true`, with one `warn` call
  (`packages/pg-prime/src/observe/log.ts:70`). `run.ts` suppresses that warning when `level` is `'silent'`.
- Default `format` is `'pretty'` only when `process.stdout.isTTY === true`, read via `globalThis`
  (`packages/pg-prime/src/observe/log.ts:88`).
- `InternalEvent` kinds `'downgrade'`, `'cache-flush'` and `'self-heal'`, and `PoolEvent` kinds `'create'`
  and `'destroy'`, are declared but no code in `packages/pg-prime/src` emits them.
- `acquire`/`timeout` pool events fire only when observed; `release` fires only when hooks are registered
  (`packages/pg-prime/src/session/runner.ts:757`, `packages/pg-prime/src/session/runner.ts:775`).
- `spanAttributes` tells event kinds apart structurally: `error !== undefined` means error, numeric
  `rowCount` means end (`packages/pg-prime/src/observe/semconv.ts:44`). Hand-built events must match.
- `db.response.status_code` is omitted when `error.code` is `''` (`packages/pg-prime/src/observe/semconv.ts:86`);
  only `tables[0]` becomes `db.collection.name`. Bind params are never emitted as attributes.
- `execMode` carries the executor's `StatementMode` (`'unnamed' | 'named'`) and is emitted as
  `pg_prime.exec_mode` (`packages/pg-prime/src/observe/events.ts:32`).
- Id counters wrap at `0xffffffff` and are module-global, shared by every `Db` in the process
  (`packages/pg-prime/src/observe/events.ts:139`).

## Tests
- `packages/pg-prime/test/session/session.test.ts` (unit): `QueryHooks (07 §7.1)` at line 1266 — ids,
  operation/tables, error/tx events, throwing-hook disablement, `observe()` compose/unsubscribe, the
  `enabled` hot path; `spanAttributes / spanName` at line 1363 — semconv keys and `pg_prime.*` namespacing;
  slow-query sink timing fields at line 1765.
- `packages/pg-prime/test/live/session.test.ts` (live): `hooks report real timings` at line 314, including
  `onNotice`.
- `packages/pg-prime/test/pg/pool-error.test.ts` and `packages/pg-prime/test/pg/session-pooler.test.ts`
  (pg): `onInternal` for idle-connection errors and skipped session GUCs.
- Run: `pnpm --filter pg-prime exec vitest run test/session/session.test.ts`; live/pg files need the live
  project setup (pg needs `PG_PRIME_TEST_URL`).
- Uncovered: the `logAllQueries` production refusal, the pretty/json default sink, and id wraparound have
  no direct test.
