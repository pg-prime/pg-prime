# packages/pg-prime-testing/src/pglite-bridge.ts

## Purpose
A PostgreSQL wire-protocol TCP server in front of an in-process PGlite, so the real `pg` driver talks to it over the real protocol. It frames client messages, serialises them onto PGlite's single backend via `execProtocolRaw`, strips PGlite's extra `ReadyForQuery` after extended-protocol errors, and drops a socket that would run inside another socket's transaction. Called by `startPglite` (`packages/pg-prime-testing/src/pglite.ts:83`); also the one copy used by `pg-prime`'s own live harness through the re-export `packages/pg-prime/test/live/_pglite-bridge.ts` (consumed by `packages/pg-prime/test/live/_pglite.ts`). Uses `node:net` and `node:fs`.

## Public API
- `PgliteLike` — structural `{ execProtocolRaw(message: Uint8Array): Promise<Uint8Array>; isInTransaction(): boolean }`; `PGlite` satisfies it.
- `PgliteBridge` — `{ port: number; close(): Promise<void> }`.
- `serve(db, host = '127.0.0.1'): Promise<PgliteBridge>` — listens on an ephemeral port; `close()` destroys all sockets and closes the server.
- `spuriousReadyForQuery(type, out): boolean` — true when `out` ends in a `ReadyForQuery` that real PostgreSQL would not send for message `type`. Not re-exported from `index.ts`.

## Flow
1. `serve` creates a `net` server and listens on port 0; the resolved port is captured for tracing (`packages/pg-prime-testing/src/pglite-bridge.ts:213-225`).
2. Each socket buffers incoming data and loops: a header whose declared length is below 4 is malformed and the socket is destroyed (`:126-132`, `malformed` `:229`).
3. `frame` cuts one whole message; before startup there is no type byte (`:235-245`).
4. Pre-startup, an SSL or GSS request is answered with `N`, a CancelRequest is ignored; the next message is the StartupMessage, reported as type 0 (`:139-150`).
5. Every message is appended to one bridge-wide promise chain, so only one message is ever in flight across all sockets (`:152-157`).
6. `run` first checks `crossesTransaction`: if PGlite is in a transaction owned by another socket and the message is not `Sync`/`Terminate`, it logs and destroys this socket (`:185-194`, `:208-211`).
7. Otherwise it calls `execProtocolRaw`, records `txOwner` from `isInTransaction()`, and strips the last 6 bytes if `spuriousReadyForQuery` says so (`:195-205`).
8. Output is copied (it is a view into WASM memory) into `pending`; when no messages remain outstanding for that socket, all pending output is written in one `socket.write` (`:156`, `:166-175`, `flush` `:116`).
9. A failed chain step logs and destroys the socket so the chain keeps flowing (`:158-165`).
10. When the transaction owner's socket closes, a `rollback` simple query is queued if PGlite is still in a transaction (`:99-107`).

## Gotchas
- `ReadyForQuery` stripping: PGlite answers a failing `Parse`/`Bind`/`Execute` with `ErrorResponse` + `ReadyForQuery`, then `Sync` sends another; the first is removed. Messages `Sync`, `Query`, `FunctionCall` and startup are never stripped (`:260-265`).
- `lastMessageIsReadyForQuery` walks message frames instead of checking the last 6 bytes, because a `DataRow` can contain those bytes (`:271-286`).
- Batched flush is load-bearing: writing per message lets `pg` read `transactionStatus` before the trailing `ReadyForQuery` arrives (`:168-173`).
- A second connection touching the backend during another connection's open transaction is dropped, not served; tests needing that must use `requiresConcurrency()` and tier 2.
- No TLS and no query cancellation are supported.
- `PG_PRIME_BRIDGE_TRACE=<file>` appends a per-message in/out trace to that file; it is read once at module load (`:55`).
- Errors are logged via `console.error` with a `[live]` prefix.

## Tests
- `packages/pg-prime/test/live/bridge.unit.test.ts` (pg-prime package, `unit` project): `spuriousReadyForQuery` strip/keep cases, including a `DataRow` containing the ReadyForQuery bytes. Run: `pnpm --filter pg-prime exec vitest run test/live/bridge.unit.test.ts`.
- `packages/pg-prime-testing/test/live/pglite.test.ts`: end-to-end through `startPglite`, including a session that stays usable after a SQLSTATE. Run: `pnpm --filter @pg-prime/testing exec vitest run --project live`.
- `pg-prime`'s whole `live` project runs over this bridge.
- Uncovered here: the cross-transaction refusal, malformed-header drop and owner-close rollback have no dedicated spec in this package.
