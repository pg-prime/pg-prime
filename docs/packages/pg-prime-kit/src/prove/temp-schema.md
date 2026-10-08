# packages/pg-prime-kit/src/prove/temp-schema.ts

## Purpose
The generate-time proof for shadow tier 3 (no `CREATEDB`): instead of cloning the database, it provisions a second set of `pgprime_shadow_<token>_<schema>` schemas inside the target, materializes the current IR there, re-derives and applies the plan, and checks convergence. Called by `packages/pg-prime-kit/src/generate.ts:767` when `shadow.tier === 3`. Uses `provisionShadow` (`shadow/ladder.ts`), `remapIr` (`schema/remap.ts`), `diffIR`, `buildStatements`, `splitStages`, `applySegments`, `extractCatalog` and `prove/pg-dump.ts`.

## Public API
- `TempSchemaProveInput` — `target`, `current` and `desired` IRs (user schema names), `schemas`, optional `renameHints`, `buildOptions`, `diagnostics`, `strictUnmodeled`, `expectedStages` (statement count per file), `desiredConn` + `desiredSchemaMap` (for the dump oracle), `dumpOracle`, `allowSkippedOracle`, `pgDump`, `dumpTimeoutMs`, `token` (test-only).
- `proveInTempSchemas(input)` — returns a `ProofResult` with `provisioning: "materialized"`, `cloneName: "temp-schema:<token>"`, `shadow: "temp-schema"`; never throws (errors become `failed`).

## Flow
1. `provisionShadow(target, target, { shadow: "temp-schema", schemas, token })` creates the proof schemas; `forward`/`reverse` maps come from `shadow.schemaMap` (`packages/pg-prime-kit/src/prove/temp-schema.ts:121`).
2. Remap both IRs to shadow names with `remapIr` and strip extension facts (and comments on them) with `withoutExtensions` (`packages/pg-prime-kit/src/prove/temp-schema.ts:86`, `:130`).
3. Materialize the current state: bootstrap diff from an empty IR, `splitStages`, apply each file (`packages/pg-prime-kit/src/prove/temp-schema.ts:141`).
4. Re-derive the plan with `diffIR(current2, desired2)` using schema-remapped rename hints, then `buildStatements` + `splitStages` (`packages/pg-prime-kit/src/prove/temp-schema.ts:164`).
5. If `expectedStages` is given, per-file statement counts must equal the artifact's, else `failed` (`packages/pg-prime-kit/src/prove/temp-schema.ts:170`).
6. Apply each file, re-extract the shadow schemas (`observe: false`) and record the fingerprint remapped back to user names (`packages/pg-prime-kit/src/prove/temp-schema.ts:187`).
7. Final extract, remap back, diff against `desired` (both without extensions); any delta or (absent adoption diagnostics) a fingerprint mismatch is `failed` (`packages/pg-prime-kit/src/prove/temp-schema.ts:207`).
8. Dump oracle: dump the proof schemas and the desired shadow schemas, rewrite shadow names back with `unshadow`, `compareDumps` (`packages/pg-prime-kit/src/prove/temp-schema.ts:285`).
9. Same strict gating as `prove.ts`; `finally` disposes the shadow, ignoring dispose errors (`packages/pg-prime-kit/src/prove/temp-schema.ts:269`).

## Gotchas
- The plan is re-derived over remapped IRs, never produced by substituting schema names in SQL text; the `expectedStages` count check is what ties the proof to the artifact.
- Extensions are excluded from both sides because `CREATE EXTENSION IF NOT EXISTS … SCHEMA <shadow>` is a no-op when the extension already exists elsewhere.
- The `shadow_temp_schema_proof` diagnostic is pushed into a local array that is never returned, and its condition compares schema-fact counts that `withoutExtensions` does not change (`packages/pg-prime-kit/src/prove/temp-schema.ts:132`).
- `unshadow` rewrites shadow schema names as whole identifiers (quoted and `\b`-bounded) in dump text, including inside literals (`packages/pg-prime-kit/src/prove/temp-schema.ts:274`).
- The two dumps run sequentially (no sibling abort, unlike `prove.ts`).
- The oracle is `skipped` unless both `desiredConn` and `desiredSchemaMap` are supplied.
- Everything happens inside the live target database; proof schemas are dropped by `shadow.dispose()`.

## Tests
- `packages/pg-prime-kit/test/pull/ddl-closeout.test.ts` — the `NOCREATEDB` leg runs `generate` at tier 3 end to end and asserts `shadow.tier === 3`.
- `packages/pg-prime-kit/test/shadow/ladder.test.ts` — tier-3 provisioning as a role without `CREATEDB`, schema-map reversal, tier-2/tier-3 fingerprint equality.
- `packages/pg-prime-kit/test/schema-emit/roundtrip.test.ts` — the corpus through the tier-3 schema map yields the identical desired IR.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/shadow/ladder.test.ts test/pull/ddl-closeout.test.ts` (needs a real server, `PG_PRIME_TEST_URL`).
- No spec imports `proveInTempSchemas` directly; the `expectedStages` mismatch branch and oracle `unshadow` rewrite have no dedicated assertions.
