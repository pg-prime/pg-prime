# packages/pg-prime-kit/src/prove/prove.ts

## Purpose
The shadow-clone proof run at generate time: clone the current database, apply the plan stage by stage, re-extract, and require an empty diff and matching fingerprint against the desired IR, then run the `pg_dump` oracle. Called by `packages/pg-prime-kit/src/generate.ts:785` (shadow tiers 1 and 2) and `packages/pg-prime-kit/src/generate.ts:1247`; tier 3 uses `prove/temp-schema.ts` instead. Calls `extractCatalog`, `diffIR`, `buildStatements`, `orderStatements`, `applySegments` and `prove/pg-dump.ts`.

## Public API
- `ProveStage` — `{ statements, segments }`, one emitted plan file.
- `ProveInput` — `admin`, `source` (current DB, never modified), `desired` IR, `schemas`, `statements`, `segments`, plus optional `stages`, `current`, `cloneName`, `keepClone`, `desiredConn`, `dumpOracle` (default `"warn"`), `allowSkippedOracle`, `pgDump`, `dumpTimeoutMs`.
- `UnsafeCloneNameError` — code `PG_PRIME_UNSAFE_CLONE_NAME`; thrown for a `cloneName` without the `pgprime_shadow_` prefix or equal to the source/desired/admin database.
- `ProofResult` — `Proof` plus `cloneName`.
- `ShadowProvisioning` — `"template" | "materialized"`.
- `proveOnShadowClone(input)` — returns a `ProofResult` with `status: "passed" | "failed"`; failures are reported in the result, only `UnsafeCloneNameError` (and provisioning errors) throw.

## Flow
1. Pick `cloneName` (default `pgprime_shadow_<8 hex>`) and validate it with `assertCloneName` (`packages/pg-prime-kit/src/prove/prove.ts:101`).
2. `provisionShadow`: drop any existing clone, try `CREATE DATABASE … TEMPLATE source`; on 55006 (`isObjectInUse`) create an empty DB instead (`packages/pg-prime-kit/src/prove/prove.ts:126`).
3. For `materialized`, replay the current IR (`input.current` or a fresh extraction) into the empty clone via a bootstrap diff (`packages/pg-prime-kit/src/prove/prove.ts:145`).
4. Apply each stage with `applySegments`; a failure returns `failed` naming the file and statement (`packages/pg-prime-kit/src/prove/prove.ts:186`).
5. Re-extract after every stage and record `stageFingerprints` (`packages/pg-prime-kit/src/prove/prove.ts:203`).
6. `diffIR(after, desired)` must have no deltas; otherwise `failed` with `driftDeltas` and delta ids (`packages/pg-prime-kit/src/prove/prove.ts:214`).
7. Fingerprints must match unless the diff reported `adopted_partition` or `extension_retained` (`packages/pg-prime-kit/src/prove/prove.ts:233`).
8. Run the dump oracle: `off` → skipped; no `desiredConn` → skipped; resolve `pg_dump`, skip if its major is older than the server; dump clone and desired concurrently, `compareDumps` (`packages/pg-prime-kit/src/prove/prove.ts:306`).
9. Under `strict`, a `failed` oracle, or a `skipped` one without `allowSkippedOracle`, turns the result into `failed` (`packages/pg-prime-kit/src/prove/prove.ts:252`).
10. Drop the clone unless `keepClone`, and return with `provisioning`, `cloneName`, `durationMs` (`packages/pg-prime-kit/src/prove/prove.ts:176`).

## Gotchas
- The clone is dropped `WITH (FORCE)` and re-created, so only names this tool mints are accepted; `cloneName === source.database` would destroy the source.
- No session is ever terminated: a busy template demotes to the materialized tier rather than disconnecting users on the target.
- The local `fail` helper is used for every outcome, including `passed`; it is what drops the clone (`packages/pg-prime-kit/src/prove/prove.ts:176`).
- The intermediate fingerprint after stage i is stage i+1's `from` fingerprint; the runner refuses a file without it.
- `shadow` is always recorded as `"createdb"` here, regardless of provisioning tier.
- Oracle errors from a dump that ran are `failed`; only `SpawnFailure` and environment gaps are `skipped` (`packages/pg-prime-kit/src/prove/prove.ts:367`). In `warn` mode, a failed oracle still yields `passed`.
- `bothDumps` aborts the sibling `pg_dump` when one fails so a hung child does not outlive the proof (`packages/pg-prime-kit/src/prove/prove.ts:376`).
- The clone is dumped with the source's credentials (`conn: input.source`).
- Empty `stages` returns `failed` with "given no statements to prove".

## Tests
- `packages/pg-prime-kit/test/provisioning.test.ts` — bystander connections survive, template tier used when idle, unsafe clone names refused with the source intact.
- `packages/pg-prime-kit/test/oracle-strict.test.ts` — strict gating on failed/skipped oracle verdicts, `allowSkippedOracle`.
- `packages/pg-prime-kit/test/enum.test.ts`, `test/dump-oracle.test.ts`, `test/evolve.test.ts` and most generate-driven suites exercise it through `generateFromDatabases`.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/provisioning.test.ts test/oracle-strict.test.ts` (needs a real server with `CREATEDB`, `PG_PRIME_TEST_URL`, and `pg_dump`).
- Uncovered: `keepClone` and multi-stage failure messages have no direct assertions found.
