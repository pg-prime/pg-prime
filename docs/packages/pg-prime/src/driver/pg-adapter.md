# packages/pg-prime/src/driver/pg-adapter.ts

## Purpose
The node-postgres adapter: implements `PgDriver`/`PgConnection` (`src/driver/types.ts`) over a
user-supplied pg-like pool (`src/driver/pg-like.ts`), never importing `pg` and never owning a
credential. Uses `src/driver/submittable.ts` (describe, close, `maxRows`), `src/driver/copy.ts`
(COPY) and `src/driver/errors.ts` (normalisation). Constructed by `pgPrime()` in
`packages/pg-prime/src/query/run.ts:264` and `packages/pg-prime/src/query/run.ts:289`; public via `src/driver/index.ts`.

## Public API
- `pgDriver(config: PgDriverConfig)` — returns a `PgDriver`; the one public constructor.
- `typeSource(paramOids)` — `@internal`; an OID array carrying an identity `getTypeParser`.
- `assertSessionGucs(params)` — `@internal`; throws an adapter `PgDriverError` unless `DateStyle`,
  `IntervalStyle`, `client_encoding`, `standard_conforming_strings`, `integer_datetimes` are supported.
- Type re-exports: `PgLikeCancelClient`, `PgLikeClient`, `PgLikeConnection`, `PgLikePool`, `PgLikePoolClient`.

## Flow
1. `pgDriver` builds static `capabilities`; `cancel` is `'protocol'` only when
   `createCancelClient` is configured (`packages/pg-prime/src/driver/pg-adapter.ts:815`).
2. `init()` acquires once, runs `assertSessionGucs`, records `serverVersionNum` and pool `max`
   (`packages/pg-prime/src/driver/pg-adapter.ts:847`).
3. `acquire()` picks `directPool` for `route: 'direct'`, awaits `pool.connect()` under the signal,
   attaches `error`/`notice` listeners, then `loadServerParameters` (`packages/pg-prime/src/driver/pg-adapter.ts:864`).
4. `loadServerParameters` queries `pg_settings` once per physical client (WeakMap cache), rejects a
   `binary: true` pool, and subscribes to `parameterStatus` (`packages/pg-prime/src/driver/pg-adapter.ts:275`).
5. `execute()` validates (usable, pre-aborted, simple+params, named without name, statement name,
   `paramTypes` arity, binary format), then routes `maxRows` to `#executeCapped` (`packages/pg-prime/src/driver/pg-adapter.ts:314`).
6. Otherwise `client.query` with `rowMode: 'array'`, `queryMode: 'extended'` (except `simple`) and
   `types: typeSource(paramTypes)`; the last result of a multi-statement body wins (`packages/pg-prime/src/driver/pg-adapter.ts:373`).
7. `#run` pushes a pending entry (FIFO = wire order), wires `signal` to a token-aimed cancel, and
   normalises any rejection into `PgDriverError` (`packages/pg-prime/src/driver/pg-adapter.ts:420`).
8. A server error is held until pg handles ReadyForQuery, so `transactionStatus` reads the
   post-statement value (`packages/pg-prime/src/driver/pg-adapter.ts:484`).
9. `stream()` opens a transaction unless already in one, `DECLARE`s a cursor, `FETCH`es `chunkSize`
   rows per chunk, and closes cursor/transaction in `finally` (`packages/pg-prime/src/driver/pg-adapter.ts:529`).
10. Cancel: `cancelBackend` sends a protocol CancelRequest via `createCancelClient`, else
    `pg_cancel_backend(pid)` from a spare pooled connection within 2 s (`packages/pg-prime/src/driver/pg-adapter.ts:996`).
11. `release()` disposes when asked, when unusable, or when the session is in `'T'`/`'E'`;
    otherwise returns the client to the pool (`packages/pg-prime/src/driver/pg-adapter.ts:949`).
12. `connect()` opens a client from `createDedicatedClient` that `release` ends; with no factory it
    falls back to `acquire()` (`packages/pg-prime/src/driver/pg-adapter.ts:927`).
13. `destroy()` releases live clients with `release(true)` and ends both pools, swallowing errors
    (`packages/pg-prime/src/driver/pg-adapter.ts:969`).

## Gotchas
- `typeSource` neutralises all of pg's result parsing per query and sends Parse OIDs; nothing calls
  the global `pg.types.setTypeParser` (`packages/pg-prime/src/driver/pg-adapter.ts:124`).
- The extended protocol is forced even with zero parameters, so `select 1; drop table x` fails with
  `42601`; only `mode: 'simple'` runs multi-statement bodies (`packages/pg-prime/src/driver/pg-adapter.ts:383`).
- GUCs are asserted once in `init()` against one connection and never `SET`; a session that changes
  them later is not re-checked (`packages/pg-prime/src/driver/pg-adapter.ts:149`).
- pg's `query_timeout` give-up leaves the statement running; the connection is marked unusable and
  disposed on release (`packages/pg-prime/src/driver/pg-adapter.ts:439`).
- `timeoutMs: 0` is passed through and pg reads it as "use the pool's timeout"
  (`packages/pg-prime/src/driver/pg-adapter.ts:390`).
- `maxRows` is ignored for `mode: 'simple'`; the capped path is always unnamed and ignores
  `timeoutMs` (`packages/pg-prime/src/driver/pg-adapter.ts:369`, `packages/pg-prime/src/driver/pg-adapter.ts:629`).
- `maxRows: 0` executes with a cap of 1 and discards the row, reporting `rowCount: 0`
  (`packages/pg-prime/src/driver/pg-adapter.ts:633`).
- `stream()` refuses when `transactionStatus` is unknown or `'E'`, and allows one open stream per
  connection (`packages/pg-prime/src/driver/pg-adapter.ts:539`).
- `stream()` sets its busy flag before `begin` and outside the `try`, so a `begin` that rejects (for
  example a pre-aborted `signal`) leaves later `stream()` calls refused (`packages/pg-prime/src/driver/pg-adapter.ts:571`).
- A cancel is aimed at one statement token and re-checked just before sending; if it cannot be
  delivered, the statement fails and the connection is retired (`packages/pg-prime/src/driver/pg-adapter.ts:738`).
- The protocol cancel path never reads pg's deprecated `activeQuery`, except in the fallback for a
  canceller not shaped like `pg.Client` (`packages/pg-prime/src/driver/pg-adapter.ts:1067`).
- The adapter keeps its own `error` listener for each checkout; without it a socket death between
  checkout and release is an unhandled `'error'` event (`packages/pg-prime/src/driver/pg-adapter.ts:195`).
- An aborted `acquire()` still releases the client that arrives later (`packages/pg-prime/src/driver/pg-adapter.ts:890`).
- `copyOut` bypasses `#run`: no cancel, no notices, no `PgDriverError` wrapping
  (`packages/pg-prime/src/driver/pg-adapter.ts:714`).
- `copyIn` passes only `signal`; `PgCopyOptions.highWaterMark` is ignored (`packages/pg-prime/src/driver/pg-adapter.ts:707`).
- `connect()` with a factory ignores `options` (`signal`, `route`) and does not normalise a
  `client.connect()` failure (`packages/pg-prime/src/driver/pg-adapter.ts:930`).
- `release()` of a connection it does not know (already released) is a no-op.
- `backendPid` maps pg's `null` `processID` to `undefined` (`packages/pg-prime/src/driver/pg-adapter.ts:237`).

## Tests
- `packages/pg-prime/test/driver/execute.test.ts` — row mode, exec modes, binary refusal, error
  data, notices, `transactionStatus`, `timeoutMs`, capabilities, GUC capture.
- `packages/pg-prime/test/driver/types-trick.test.ts` — `typeSource`, forced extended protocol.
- `packages/pg-prime/test/driver/cursor.test.ts` — `DECLARE` with bind params, `stream()`, `maxRows` on DML.
- `packages/pg-prime/test/driver/adapter-lifecycle.test.ts` — fake-pool tests: error listener,
  slot leaks, binary pool, cancel tokens, timeouts, `release`, input validation, notice attribution.
- `packages/pg-prime/test/driver/cancel.test.ts`, `packages/pg-prime/test/driver/ready-for-query.test.ts`,
  `packages/pg-prime/test/driver/maxrows.test.ts`, `packages/pg-prime/test/driver/describe.test.ts`.
- Run (live project, PGlite): `pnpm --filter pg-prime exec vitest run test/driver`.
- Not covered: the `stream()` busy flag after a failed `begin`; `connect()` with `createDedicatedClient`
  outside the pg project (`packages/pg-prime/test/pg/session-listen.test.ts`).
