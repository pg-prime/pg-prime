# packages/pg-prime-kit/src/schema/load.ts

## Purpose
Builds IR(desired): emits the DSL schema as DDL, loads it into a provisioned shadow, extracts the shadow's catalog and maps schema names back to the user's. Called by `generate.ts` (`packages/pg-prime-kit/src/generate.ts:206`) and `migrate verify` (`packages/pg-prime-kit/src/cli/commands/verify.ts:211`). Calls `emitSchema` (`schema/emit.ts`), `extractCatalog`, `remapIr`/`remapObserved`/`remapDiagnostics` (`schema/remap.ts`) and `withClient`.

## Public API
- `LoadDesiredOptions` — `{ defaultSchema?, statementTimeout?, afterLoad? }`; `afterLoad(client)` runs on the shadow connection after the DDL and before extraction (used to load Tier-R repeatables).
- `DesiredLoadError` — code `PG_PRIME_DESIRED_LOAD`, carries the failing `sql` (or `undefined`) and the emitter's `diagnostics`.
- `loadDesired(schema, shadow, options?)` — returns an `ExtractResult` in user schema names; throws `DesiredLoadError` on an error-severity emit diagnostic or a statement that fails to load.
- `desiredSql(schema, shadow, options?)` — the statements `loadDesired` would run (same `emitSchema` call), for `--dry-run` and golden tests.

## Flow
1. `emitSchema(schema, { schemaMap: shadow.schemaMap, defaultSchema })` (`packages/pg-prime-kit/src/schema/load.ts:66`).
2. Any `error`-severity emit diagnostic throws `DesiredLoadError` before any SQL runs (`packages/pg-prime-kit/src/schema/load.ts:67`).
3. Read the target's comments on the user schemas from `shadow.target` (`packages/pg-prime-kit/src/schema/load.ts:83`).
4. On `shadow.conn`, run each emitted statement; the first failure throws `DesiredLoadError` with the statement (`packages/pg-prime-kit/src/schema/load.ts:96`).
5. Run `afterLoad(client)` if provided (`packages/pg-prime-kit/src/schema/load.ts:108`).
6. Set `COMMENT ON SCHEMA <shadow>` to the target's comment for that schema, or `NULL` (`packages/pg-prime-kit/src/schema/load.ts:109`).
7. `extractCatalog` over the shadow schemas (Tier-O observation on) (`packages/pg-prime-kit/src/schema/load.ts:115`).
8. Reverse the schema map and return `remapIr`, `remapObserved`, and emitter + shadow + remapped extractor diagnostics (`packages/pg-prime-kit/src/schema/load.ts:123`).

## Gotchas
- An unmapped schema under tier 3 would put the desired state into the user's real schema, so error diagnostics are fatal rather than reported (`packages/pg-prime-kit/src/schema/load.ts:52`).
- Schema comments are not declared by the DSL; the desired state copies the target's comment so `public`'s default comment (or its absence in a tier-3 shadow schema) is never a phantom delta.
- Statements run one by one outside an explicit transaction on the shadow connection; a failure leaves a partially loaded shadow for the caller's `dispose`.
- `afterLoad` shares the connection so repeatables see the same `search_path` the load used.
- `desiredSql` does not check diagnostics; it returns SQL even when `loadDesired` would refuse.

## Tests
- `packages/pg-prime-kit/test/schema-emit/roundtrip.test.ts` — emit → load → extract → re-emit round trip, constraint naming, strict `pg_dump` oracle, identical desired IR through the tier-3 schema map.
- `packages/pg-prime-kit/test/shadow/ladder.test.ts` — `loadDesired` on a tier-3 shadow as a role without `CREATEDB`, reverse-mapped IR, tier-2/tier-3 fingerprint equality.
- Exercised by every `generate` test (`test/generate/*`, `test/e2e/loop.test.ts`).
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/schema-emit/roundtrip.test.ts test/shadow/ladder.test.ts` (needs a real server, `PG_PRIME_TEST_URL`).
- Uncovered: the schema-comment mirroring and `DesiredLoadError` on a statement failure have no direct assertions found.
