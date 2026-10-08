# packages/pg-prime/src/driver/types.ts

## Purpose
The adapter seam: structural, type-only interfaces between the ORM runtime and any database driver.
Implemented by the pg adapter (`src/driver/pg-adapter.ts`); consumed by the codec layer
(`src/codec/types.ts`, `src/codec/registry.ts`, `src/codec/builtins.ts`, `src/codec/define.ts`),
the session layer (`src/session/runner.ts`, `src/session/handles.ts`, `src/session/listen.ts`,
`src/session/copy.ts`, `src/session/config.ts`), `src/errors/map.ts`, `src/observe/events.ts` and
`src/pooler/diagnose.ts`. Imports nothing.

## Public API
- `PgParam` / `PgRawValue` — `string | Uint8Array | null`; encoded parameter and raw cell value.
- `PgExecMode` — `'unnamed' | 'named' | 'simple'`.
- `PgDriver` — `init`, `acquire`, `release(conn, { dispose? })`, optional `connect` (an unpooled
  connection for `LISTEN`), `destroy`, `capabilities`.
- `PgAcquireOptions` — `{ signal?, route?: 'default' | 'direct' }`.
- `PgConnection` — required `execute`, `stream`; optional `describe`, `closeStatement`, `copyIn`,
  `copyOut`, `cancel`, `on`; state `backendPid`, `serverParameters`, `transactionStatus`, `usable`.
- `PgQuery` — `{ text, params, paramTypes?, mode?, statementName?, resultFormat?, maxRows?, signal?, timeoutMs? }`.
- `PgResult`, `PgResultChunk`, `PgField`, `PgDescribeResult` — positional raw rows plus field metadata.
- `PgCopyOptions`, `PgCopyResult`, `PgNotification` — COPY and LISTEN/NOTIFY shapes.
- `PgCapabilities` — static adapter description (`execModes`, `binaryResults`, `cancel`, `maxParams`, …).
- `PgErrorKind`, `PgDriverErrorData`, `PgServerErrorData`, `PgNoticeData` — failure data crossing
  the seam as plain objects.
- `PgRemoteCallback` — `(sql, params, meta) => Promise<{ rows, fields, rowCount?, command? }>`.

## Flow
1. The runtime calls `PgDriver.init()` once, then `acquire()` per unit of work and `release()`
   after (`packages/pg-prime/src/driver/types.ts:29`).
2. Parameters arrive already encoded by codecs; adapters must not convert them further
   (`packages/pg-prime/src/driver/types.ts:154`).
3. `execute` returns `PgResult` with array-of-arrays `rows` aligned to `fields`; values are raw
   wire text (`packages/pg-prime/src/driver/types.ts:219`).
4. `stream` yields `PgResultChunk`s, repeating `fields` on every chunk and flagging the last with
   `done` (`packages/pg-prime/src/driver/types.ts:237`).
5. Failures cross as `PgDriverErrorData`; `connectionUnusable: true` obliges the runtime to
   `release(conn, { dispose: true })` (`packages/pg-prime/src/driver/types.ts:343`).

## Gotchas
- No file under `src/` may import `pg`; structural typing is what lets Neon and others duck-type
  in (`packages/pg-prime/src/driver/types.ts:4`).
- `paramTypes` length must equal `params.length` or be 0 (`packages/pg-prime/src/driver/types.ts:160`).
- `maxRows` truncates the returned rows but a row-returning DML statement still runs to completion,
  and `rowCount` reports the truncated count (`packages/pg-prime/src/driver/types.ts:186`).
- `timeoutMs: 0` is not "no deadline": pg falls back to the pool's `query_timeout`; omit the field
  instead (`packages/pg-prime/src/driver/types.ts:204`).
- `timeoutMs` stops reading, not the statement; use `signal` for a server-side cancel.
- `transactionStatus` is the post-statement status after an awaited `execute`, including a rejected
  one (`packages/pg-prime/src/driver/types.ts:132`).
- `statementName` must be a plain identifier of at most 63 bytes with no NUL
  (`packages/pg-prime/src/driver/types.ts:176`).
- Optional `PgConnection` methods must match `capabilities` (`packages/pg-prime/src/driver/types.ts:94`).
- `PgRemoteCallback` is declared and exported from `src/driver/index.ts` but no module consumes it.
- `PgNoticeData` is an alias of `PgServerErrorData`.

## Tests
- Type-only; behaviour is covered against the pg adapter in `packages/pg-prime/test/driver/*.test.ts`
  (see `docs/packages/pg-prime/src/driver/pg-adapter.md`).
- `packages/pg-prime/test/query/_mock-driver.ts` implements the seam for unit tests above it.
- Run: `pnpm --filter pg-prime exec vitest run test/driver`.
- Not covered: `PgRemoteCallback` has no implementation or test.
