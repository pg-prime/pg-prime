# packages/pg-prime/src/query/executor.ts

## Purpose
Runs one `Compiled` statement on one `PgConnection`: encodes binds, picks unnamed or named protocol mode, checks the server's `RowDescription` against declared codecs, decodes rows, streams cursors and runs `EXPLAIN`. It is a module of functions, not a class; the connection comes from a runner.
Callers: `src/session/runner.ts` (`runOn`, `bindsToParams`), `src/session/handles.ts` (`streamOn`, `streamBatchesOn`), `src/query/terminals.ts` (`streamOn`, `explainOn`, `makeResult`, `needsRollbackRail`), `src/query/run.ts` (`makeEnv`), `src/query/prepared.ts` (`assertNoExtraPlaceholders`), `src/query/raw.ts` (`dynamicRowDecoder`). Callees: `src/compile/decode.ts` (`buildDecoder`), `src/compile/contract.ts` (`paramTypesOf`), the codec registry, `CodecMismatchError` from `src/query/errors.ts`.

## Public API
- `StatementMode` — `'unnamed' | 'named'`. Re-exported from the package barrel.
- `PreparedStatementOptions` — `{ maxPerConnection?, downgradeAfterFailures?, prefix? }`; defaults 100, 3, `'pgprime'`.
- `ExecOptions` — `{ assertShape?, statement?, preparedStatements?, decoder? }`; the executor half of `DbConfig`.
- `ExecEnv` — resolved options plus the registry and the mutable `named: { selfHeals, downgraded }` counter; one per `pgPrime(...)`.
- `makeEnv(registry, opts)` — builds `ExecEnv`; throws (via `assertCodegenAvailable`) when `decoder: 'codegen'` cannot run here.
- `PlaceholderValues` — `Readonly<Record<string, unknown>>`, the values a prepared query executes with.
- `bindsToParams(binds, values)` — wire params; `value` binds use `encoded`, `slot` binds call `codec.encode`; throws `BuilderError` on a missing key.
- `assertNoExtraPlaceholders(declared, values)` — throws `BuilderError` naming a key the query has no placeholder for.
- `assertShape(compiled, fields, registry)` — compares declared codec OIDs to `dataTypeID`; throws `CodecMismatchError`.
- `resolveDynamicShape(shape, dynamic, fields, registry)` — swaps `unknownCodec` columns for the registry codec of the reported OID.
- `decoderFor(compiled, registry, serverParameters, fields, mode?)` — memoised row decoder for a `Compiled`.
- `fnv1a(s)` — 32-bit FNV-1a of a string, base 36; used for statement names.
- `sqlStateOf(e)` — SQLSTATE from `e.pgPrime.server.sqlstate` or a 5-char `e.code`, else `undefined`.
- `DescribeCacheStats`, `describeCacheStats()`, `clearDescribeCache(resetCounters?)` — counters and reset of the process-wide raw-statement decode-plan cache.
- `dynamicRowDecoder(sql, fields, registry)` — name-keyed, OID-decoded row mapper for `db.sql` statements, cached by SQL text.
- `RunOptions` (`params`, `statement`, `signal`, `timing`) and `RunTiming` (`serverMs`, `decodeMs`) — per-execution inputs and the timing out-slot.
- `runOn(conn, compiled, env, opts?, knownParamTypes?)` — executes and decodes; returns `Row[]`; self-heals named statements once.
- `StreamOptions` — `{ batchSize?, signal? }`; `batchSize` defaults to 1000.
- `streamOn(...)` / `streamBatchesOn(...)` — async iterables of rows / of one decoded array per `FETCH` chunk.
- `ExplainOptions`, `ExplainNode`, `ExplainResult` — `EXPLAIN` options, a loosely typed JSON plan node, and the frozen result.
- `explainOn(conn, compiled, env, opts, run)` — runs `explain (...) <sql>` with the query's binds; parses JSON unless `format: 'text'`.
- `makeResult(plan, text, executed, rolledBack, planningMs, executionMs)` — builds the frozen `ExplainResult`; `toString()` returns `text`.
- `isMutating(compiled)` — true for insert/update/delete or any `meta.writes`.
- `needsRollbackRail(compiled, opts)` — true when `analyze` is on, `rollback !== false`, and the statement mutates.

## Flow
1. `makeEnv` resolves defaults once per db (`packages/pg-prime/src/query/executor.ts:129`); `assertShape` defaults to `NODE_ENV !== 'production'`, read once per process (`packages/pg-prime/src/query/executor.ts:121`).
2. `runOn` takes `paramTypes` from the caller or `paramTypesOf`, and builds the base `PgQuery` with `bindsToParams` (`packages/pg-prime/src/query/executor.ts:725`, `packages/pg-prime/src/query/executor.ts:695`).
3. Named mode applies when the option says `'named'` and the env has not downgraded; the key is `fnv1a(sql):paramTypes` (`packages/pg-prime/src/query/executor.ts:498`, `packages/pg-prime/src/query/executor.ts:727`).
4. `nameFor` reuses the cached name (moving it to the LRU tail) or evicts the oldest with `conn.closeStatement` and mints `${prefix}_${hash}_${seq}` (`packages/pg-prime/src/query/executor.ts:511`).
5. `conn.execute(query)`; a named success resets `selfHeals` to 0 (`packages/pg-prime/src/query/executor.ts:740`).
6. With `env.assertShape`, `assertShape` walks the plan (into `nest` groups, accepting `json`/`jsonb` for `json` fields) and throws before any decode (`packages/pg-prime/src/query/executor.ts:226`, `packages/pg-prime/src/query/executor.ts:252`).
7. `decoderFor` collects `unknownCodec` positions, resolves them by reported OID, and rebuilds only when registry, generation, `serverParameters`, OID signature or mode changed (`packages/pg-prime/src/query/executor.ts:409`).
8. On error, `healAction` clears the describe cache for `0A000`/`42P18`/`42804`, then allows one retry only for a named statement on an idle (`'I'`) connection with a SQLSTATE in `SELF_HEAL` (`packages/pg-prime/src/query/executor.ts:785`, `packages/pg-prime/src/query/executor.ts:547`).
9. A retry forgets the cached name; when `selfHeals` reaches `downgradeAfterFailures`, `downgrade` flips the env to unnamed for good and logs via `console.error` (`packages/pg-prime/src/query/executor.ts:760`, `packages/pg-prime/src/query/executor.ts:806`).
10. `streamOn`/`streamBatchesOn` call `conn.stream(query, batchSize)`, check shape and build the decoder on the first chunk, and skip empty chunks in batch mode (`packages/pg-prime/src/query/executor.ts:838`, `packages/pg-prime/src/query/executor.ts:890`).
11. `explainOn` prefixes `explain (...)`, joins column 0 of every row with newlines, and `JSON.parse`s it unless `format: 'text'` (`packages/pg-prime/src/query/executor.ts:985`).

## Gotchas
- The decoder memo is one entry per `Compiled` and compares `serverParameters` by identity, so alternating between physical connections rebuilds the decoder (`packages/pg-prime/src/query/executor.ts:423`).
- The named-statement map is keyed by `conn.serverParameters`, not the `PgConnection`, because the pg adapter builds a new `PgConnection` per `acquire()` (`packages/pg-prime/src/query/executor.ts:481`).
- The statement key is a 32-bit `fnv1a` hash plus param OIDs; the SQL text itself is not compared, so a hash collision with equal param types would reuse another statement's name (`packages/pg-prime/src/query/executor.ts:498`).
- `nameSeq` is process-wide and wraps at 1e6; the 63 limit is checked on `name.length` (UTF-16 units), not bytes (`packages/pg-prime/src/query/executor.ts:530`, `packages/pg-prime/src/query/executor.ts:532`).
- Eviction swallows `closeStatement` errors; an adapter without `closeStatement` just forgets the name and the server statement lingers (`packages/pg-prime/src/query/executor.ts:526`).
- Self-heal never runs inside a transaction (status must be `'I'`), never for unnamed statements, and at most once per execution (`packages/pg-prime/src/query/executor.ts:797`).
- After a downgrade the same loop's retry already runs unnamed (`packages/pg-prime/src/query/executor.ts:731`); the downgrade is permanent for the env.
- Streams and `EXPLAIN` always use unnamed mode and never self-heal; `explainOn` reads `ExplainOptions.signal`, not `RunOptions.signal` (`packages/pg-prime/src/query/executor.ts:999`).
- `bindsToParams` maps `null` and `undefined` to SQL NULL, but the key must exist (`Object.hasOwn`) (`packages/pg-prime/src/query/executor.ts:172`).
- `assertShape` skips: no fields, `codec.oid === undefined` (unresolved enums), `unknownCodec` (`packages/pg-prime/src/query/executor.ts:278`).
- The describe cache is module-level (shared by every db in the process), LRU-capped at 256 by SQL text, and validated by registry identity, generation and OID signature (`packages/pg-prime/src/query/executor.ts:598`).
- `buffers`/`timing`/`wal` are only emitted with `analyze`; `settings true` is on by default (`packages/pg-prime/src/query/executor.ts:966`).
- `RunTiming` is filled only when `opts.timing` is passed; it uses global `performance.now()` (`packages/pg-prime/src/query/executor.ts:737`).

## Tests
- `packages/pg-prime/test/query/executor.test.ts` — decoder memo, wire shape, `meta.reads/writes`, OID-decoded fragments, `toSQL()`.
- `packages/pg-prime/test/query/named.test.ts` — named mode, LRU `Close`, 63-byte refusal, self-heal and downgrade, the describe cache.
- `packages/pg-prime/test/query/assert-shape.test.ts` — `assertShape` cases and the `NODE_ENV` gate.
- `packages/pg-prime/test/query/stream.test.ts`, `packages/pg-prime/test/query/explain.test.ts` — cursor lifecycle and `EXPLAIN` wire text and rollback rail (mock driver).
- Live: `packages/pg-prime/test/live-query/executor.test.ts`; `streamBatches` and timing in `packages/pg-prime/test/live/session.test.ts` and `packages/pg-prime/test/session/session.test.ts`.
- Real server: `packages/pg-prime/test/pg/executor.test.ts` (server-side named statements, PgBouncer transaction mode).
- Run: `pnpm --filter pg-prime exec vitest run test/query/named.test.ts` (unit), `... test/live-query/executor.test.ts` (live), `... test/pg/executor.test.ts` with `PG_PRIME_TEST_URL` (pg).
- Not covered: `fnv1a` key collisions, and the `name.length` vs byte-length check for a non-ASCII `prefix`.
