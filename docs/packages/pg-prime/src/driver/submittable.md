# packages/pg-prime/src/driver/submittable.ts

## Purpose
pg Submittables for three protocol sequences pg's public API does not offer: Describe without
Execute, protocol `Close('S')`, and a single-round-trip row-capped Execute. `pg`'s
`Client.query(obj)` routes every backend message to an object with a `submit` method. Called only by
`src/driver/pg-adapter.ts` (`describe`, `closeStatement`, `maxRows`, and `toPgField` for every
result); types come from `src/driver/pg-like.ts` and `src/driver/types.ts`.

## Public API
- `toPgField(f)` — `PgLikeField` → `PgField`, defaulting missing `dataTypeModifier`/`dataTypeSize`
  to `-1`, `tableID`/`columnID` to `0`, `format` to `'text'`.
- `describeViaSubmittable(client, sql)` — resolves `PgDescribeResult` (`paramTypes`, `fields`).
- `closeStatementViaSubmittable(client, name)` — resolves once `Close('S', name)` + `Sync` completes.
- `CappedExecuteRequest` — `{ text, values, paramTypes, rows }` with `rows >= 1`.
- `CappedExecuteResult` — `{ rows, fields, command, rowCount, suspended }`.
- `executeCappedViaSubmittable(client, req)` — resolves a `CappedExecuteResult`.

## Flow
1. Each helper constructs a Submittable, hands it to `client.query(sub)` and returns its promise
   (`packages/pg-prime/src/driver/submittable.ts:135`).
2. Describe: `submit` subscribes to `parameterDescription`/`noData` on the connection and writes
   Parse + Describe('S') + Sync on the unnamed statement (`packages/pg-prime/src/driver/submittable.ts:73`).
3. Describe resolves at `handleReadyForQuery`, detaching its listeners; `handleError` rejects
   (`packages/pg-prime/src/driver/submittable.ts:118`).
4. Close writes `Close('S', name)` + Sync, then deletes the name from pg's `parsedStatements` and
   `submittedNamedStatements` (`packages/pg-prime/src/driver/submittable.ts:172`).
5. Capped execute corks the socket and writes Parse, Bind (text results, `toWireValue` mapper),
   Describe('P'), Execute(rows), Close('P'), Sync in one write (`packages/pg-prime/src/driver/submittable.ts:307`).
6. `handleCommandComplete` parses the tag with `COMMAND_TAG`; `handlePortalSuspended` marks the cap
   as hit (`packages/pg-prime/src/driver/submittable.ts:345`, `packages/pg-prime/src/driver/submittable.ts:358`).
7. At ReadyForQuery it resolves; a suspended portal reports `rowCount` as the rows collected and
   `command` as the SQL's leading keyword (`packages/pg-prime/src/driver/submittable.ts:376`).

## Gotchas
- Driving `client.connection.parse/describe/sync` directly crashes pg ("unexpected parseComplete");
  it only works as a Submittable (`packages/pg-prime/src/driver/submittable.ts:9`).
- Every Submittable must call `callback` on settle: pg wraps it to clear its `query_timeout` timer,
  which otherwise later destroys a healthy socket (`packages/pg-prime/src/driver/submittable.ts:41`).
- pg does not update its statement maps on Close; without the deletes a later Parse of the same
  name raises "Prepared statements must be unique" (`packages/pg-prime/src/driver/submittable.ts:148`).
- `Execute(rows = 0)` means unlimited in the protocol; callers must send `rows >= 1`
  (`packages/pg-prime/src/driver/submittable.ts:230`).
- `Bind` sets `binary: false`, so a pool built with `binary: true` does not affect this path.
- A `Uint8Array` parameter is converted to a Node `Buffer` for binary format; with no global
  `Buffer` the mapper throws (`packages/pg-prime/src/driver/submittable.ts:391`).
- PortalSuspended carries no tag, so a truncated result's `command` is a best-effort keyword parse
  that skips leading whitespace, `;` and comments (`packages/pg-prime/src/driver/submittable.ts:252`).

## Tests
- `packages/pg-prime/test/driver/describe.test.ts` — describe OIDs, typmods, table/column IDs, no
  Execute, errors leave the connection usable, the direct-drive crash control; `closeStatement` reuse.
- `packages/pg-prime/test/driver/maxrows.test.ts` — cap, real tag/count, in-transaction, notices,
  `INSERT … RETURNING`, `maxRows: 0`, truncated verb, bytea binary parameter.
- `packages/pg-prime/test/driver/adapter-lifecycle.test.ts:407` — callback clears pg's timer.
- Run (live project): `pnpm --filter pg-prime exec vitest run test/driver/describe.test.ts test/driver/maxrows.test.ts`.
- Not covered: the no-`Buffer` runtime throw in `toWireValue`.
