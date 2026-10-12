# packages/pg-prime/src/driver/copy.ts

## Purpose
`COPY … FROM STDIN` and `COPY … TO STDOUT` over pg's Submittable protocol, with no
`pg-copy-streams` dependency. Called only by `PgConnectionImpl.copyIn`/`copyOut` in
`src/driver/pg-adapter.ts`; the session layer (`db.copyFrom`/`db.copyTo`, `src/session/handles.ts`)
reaches it through those methods. Types from `src/driver/pg-like.ts` and `src/driver/types.ts`.

## Public API
- `copyInViaSubmittable(client, text, source, signal, notices)` — streams `source` chunks into the
  COPY; resolves `PgCopyResult` with the tag's row count and the passed `notices` array.
- `copyOutViaSubmittable(client, text, signal)` — returns an `AsyncIterable<Uint8Array>` of raw
  `CopyData` payloads.

## Flow
1. Both submit the statement with `connection.query(text)`, the simple query protocol; a connection
   without it is refused at `submit` (`packages/pg-prime/src/driver/copy.ts:83`, `packages/pg-prime/src/driver/copy.ts:219`).
2. Copy-in also refuses at `submit` when `sendCopyFromChunk`, `endCopyFrom` or `sendCopyFail` is
   missing (`packages/pg-prime/src/driver/copy.ts:94`).
3. `handleCopyInResponse` starts the pump: for each non-empty chunk, `sendCopyFromChunk`, then wait
   for `'drain'` when `writableNeedDrain` is set; finally `endCopyFrom` (`packages/pg-prime/src/driver/copy.ts:116`).
4. A source error or an aborted `signal` (checked per chunk) sends `CopyFail`; the backend answers
   with an ErrorResponse (`packages/pg-prime/src/driver/copy.ts:128`, `packages/pg-prime/src/driver/copy.ts:137`).
5. `handleCommandComplete` reads `COPY n`; ReadyForQuery resolves, or rejects with the source error
   if one occurred (`packages/pg-prime/src/driver/copy.ts:152`, `packages/pg-prime/src/driver/copy.ts:171`).
6. Copy-out queues each `CopyData` chunk and wakes the single pending reader; the iterator ends at
   ReadyForQuery or throws the stored error once the queue is drained (`packages/pg-prime/src/driver/copy.ts:239`, `packages/pg-prime/src/driver/copy.ts:257`).

## Gotchas
- A source failure rejects with the source's own error, not the server's CopyFail response
  (`packages/pg-prime/src/driver/copy.ts:161`).
- Chunks become Node `Buffer`s when a global `Buffer` exists; otherwise the `Uint8Array` is passed
  as-is, unlike `src/driver/submittable.ts`, which throws (`packages/pg-prime/src/driver/copy.ts:41`).
- Copy-in has socket backpressure only; the `PgCopyOptions.highWaterMark` value is never passed here.
- Copy-out has no backpressure: frames already in memory are queued in an array
  (`packages/pg-prime/src/driver/copy.ts:196`).
- An aborted `signal` only stops copy-out's iterator from yielding; nothing tells the backend to
  stop, and the adapter's `copyOut` does not route it through its cancel path (`packages/pg-prime/src/driver/copy.ts:260`).
- Copy-out errors reach the caller as the raw pg error, not a `PgDriverError`, because
  `PgConnectionImpl.copyOut` does not wrap them (`packages/pg-prime/src/driver/pg-adapter.ts:714`).
- `notices` passed to copy-in is the adapter's per-statement sink, filled while the COPY runs.

## Tests
- `packages/pg-prime/test/pg/session-copy.test.ts` — `db.copyFrom`/`db.copyTo` end to end through
  this file, the COPY-vs-insertMany crossover, generated columns (pg project, needs `PG_PRIME_TEST_URL`).
- `packages/pg-prime/test/live/session.test.ts:387` — COPY round trip, raw/csv, and a throwing source
  rejecting with its own error; skipped on PGlite, whose socket bridge exits on a COPY message.
- Run: `PG_PRIME_TEST_URL=… pnpm --filter pg-prime exec vitest run test/pg/session-copy.test.ts`.
- Not covered: the missing-writer refusals, copy-in abort mid-stream, copy-out abort and copy-out
  error propagation; nothing under `packages/pg-prime/test/driver` exercises COPY.
