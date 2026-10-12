# packages/pg-prime-kit/src/plan/emit.ts

## Purpose
Writes a finished `Plan` to disk as `NNNN_name.sql` + `NNNN_name.plan.json`, refusing unproven plans, unacknowledged error hazards, unsafe paths and overwrites. Called by `generate.ts` (both `generate` and `generateFromDatabases`) and `cli/commands/baseline.ts`; renders through `renderSql` and validates names with `migrationId` from `plan/plan.ts`.

## Public API
- `WriteRefusedError` — abstract base with `code`; lets callers tell a refusal from an I/O error.
- `ProofRequiredError` — `code = "PG_PRIME_PROOF_REQUIRED"`, carries `plan`; message includes `proof.error` and residual `proof.deltas`.
- `UnacknowledgedHazardError` — `code = "PG_PRIME_UNACKNOWLEDGED_HAZARD"`, carries `plan` and the blocking `hazards`.
- `UnsafePlanPathError` — `code = "PG_PRIME_UNSAFE_PLAN_PATH"`; bad name, escape from `dir`, or existing file.
- `planSql(plan): string` — `renderSql` with arguments taken from the plan.
- `planOrderKey(plan)` — `[Number(migration.id), migration.name]`, the `(seq, name)` apply order.
- `writePlan(dir, plan, { allowUnproven?, allowDataLoss? }?)` — resolves `{ sqlPath, planPath }`; throws the three refusals or rethrows other I/O errors.

## Flow
1. Refuse unless `proof.status === "passed"` or `allowUnproven` (`packages/pg-prime-kit/src/plan/emit.ts:84`).
2. Unless `allowDataLoss`, refuse if any `error` hazard is unacknowledged (`packages/pg-prime-kit/src/plan/emit.ts:85-88`).
3. Re-validate `migration.id`/`name` through `migrationId`, mapping its error to `UnsafePlanPathError` (`packages/pg-prime-kit/src/plan/emit.ts:93-97`).
4. Resolve both paths under `resolve(dir)` and refuse any that is not inside it (`packages/pg-prime-kit/src/plan/emit.ts:98-106`).
5. `mkdir -p` the directory, then write the `.sql` and the pretty-printed `.plan.json` with flag `wx` (`packages/pg-prime-kit/src/plan/emit.ts:108-113`).
6. Map `EEXIST` to `UnsafePlanPathError`; return both paths (`packages/pg-prime-kit/src/plan/emit.ts:114-122`).

## Gotchas
- The hazard gate covers every unacknowledged `error` hazard (DS, MF, TX, EN, unknown codes, error diagnostics), not only destructive ones (`packages/pg-prime-kit/src/plan/emit.ts:86`).
- The proof gate fires before the hazard gate, so an unproven plan never reports its hazards here (`packages/pg-prime-kit/src/plan/emit.ts:84-88`).
- `wx` makes migrations immutable: re-running `generate` into the same `dir` with the same id fails rather than overwriting (`packages/pg-prime-kit/src/plan/emit.ts:109-113`).
- The two writes are not atomic: if the `.plan.json` write fails after the `.sql` succeeded, the `.sql` stays on disk.
- `planSql` omits `data`/`checkpoint` header flags, so its text differs from what `buildPlan` hashed into `migration.sha256` when those were set (`packages/pg-prime-kit/src/plan/emit.ts:51-62`); checkpoints use `checkpointSql` in `checkpoint/checkpoint.ts` instead.
- `planOrderKey` is exported for package consumers only; nothing inside the kit calls it.

## Tests
- `packages/pg-prime-kit/test/plan-gates.test.ts` — rejects bad names and seqs, refuses writing outside `outDir` with a doctored plan, never overwrites, DS103 refusal, per-subject and blanket acknowledgement, proof gate first, and `generate()` reporting a refusal distinctly from an I/O failure (last two describes are live).
- `test/enum.test.ts` writes a deliberately mis-ordered plan; `test/lint/*` use `planSql` to produce lintable text.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/plan-gates.test.ts`; live cases need `PG_PRIME_TEST_URL`.
- Uncovered: partial writes (`.sql` written, `.plan.json` failed) and `planOrderKey` have no assertion.
