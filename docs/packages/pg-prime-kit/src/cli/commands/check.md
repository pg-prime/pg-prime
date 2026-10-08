# packages/pg-prime-kit/src/cli/commands/check.ts

## Purpose
`pg-prime migrate check`, the CI gate: answers (a) would `generate` produce a diff the pending migrations do not account for, (b) do checksums match and are recorded files on disk, (c) are migrations pending — as one exit code. Registered at `packages/pg-prime-kit/src/cli/main.ts:137`; callees are `readMigrationsDir`, `migrationStatus` (`packages/pg-prime-kit/src/runner/status.ts:105`), `loadSchema`, `generate` and `shadowStrategy` from `./generate.ts`.

## Public API
- `CHECK_OPTIONS: readonly OptionSpec[]` — `--shadow <url|temp-schema|createdb>`, `--strict-unmodeled`, `--no-schema`.
- `runCheck(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput>` — status `ok`/`error`/`missing_hints`/`lint`/`drift`/`pending` with exit 0/1/2/3/4/5.

## Flow
1. Read the migrations directory and run `migrationStatus` with the repeatables pass (`packages/pg-prime-kit/src/cli/commands/check.ts:53`).
2. Question (a) runs only when `--no-schema` is absent and the config names schema paths (`packages/pg-prime-kit/src/cli/commands/check.ts:65`).
3. Load the schema and call `generate` with `seq: 0`, `name: "check"`, `multiFile: false`, `prove: false`; `--shadow` wins over `config.config.shadow` (`packages/pg-prime-kit/src/cli/commands/check.ts:68`).
4. The diff is "accounted for" when there are pending migrations and the last file's `plan.to.fingerprint` equals `result.desiredIR.fingerprint` (`packages/pg-prime-kit/src/cli/commands/check.ts:103`).
5. `schemaDrift` is `[]` when the diff is empty or accounted for, otherwise every generated statement's SQL (`packages/pg-prime-kit/src/cli/commands/check.ts:107`).
6. Collect `unresolved` and unacknowledged error-severity `hazards` from the generated plans, plus `declared_lane_stale` and `declared_conflict` diagnostics (`packages/pg-prime-kit/src/cli/commands/check.ts:111`, `:117`).
7. A `LaneRefusedError` becomes lint hazards (its diagnostics and unacknowledged lane hazards); `OfflineShadowError`, `GenerateRefusedError` and `ConfigError` become `generateError`; anything else is rethrown (`packages/pg-prime-kit/src/cli/commands/check.ts:124`).
8. Exit precedence: 1 generate error, 2 unresolved, 3 hazards, 4 checksum/missing-file or schema drift, 5 pending, else 0 (`packages/pg-prime-kit/src/cli/commands/check.ts:144`).
9. Envelope carries `schemaChecked`, `schemaDrift`, `checksumDrift`, `missingFiles`, `pending`, `repeatableDrift`, `unresolved`, `hazards`; text lists at most 20 would-generate statements (`packages/pg-prime-kit/src/cli/commands/check.ts:170`).

## Gotchas
- No history writes, no lock, no `ensureHistory` — but the shadow is still provisioned, and on tier 3 that creates and drops a temp schema inside the target database; pass `--shadow <url>` to avoid it (`packages/pg-prime-kit/src/cli/commands/check.ts:10`).
- With nothing pending, any non-empty diff is exit 4, whether the database or the schema moved (`packages/pg-prime-kit/src/cli/commands/check.ts:99`).
- `schemaDrift` is `null` (not `[]`) when the schema was not or could not be checked; the text then says "not checked" or "could not be checked".
- `repeatableDrift` is reported but never affects the exit code; a stale or conflicting declared lane does, as exit 3.
- A config with no `schema` silently skips question (a); `schemaChecked` is `false`.
- The `--shadow` parser is shared with `generate` and `push` via `shadowStrategy` so the three cannot disagree (`packages/pg-prime-kit/src/cli/commands/check.ts:32`).

## Tests
- `packages/pg-prime-kit/test/cli/authoring.test.ts` — pending, then ok, then drift when the schema moves ahead; goldens `test/cli/golden/check.{ok,pending,drift}.json`.
- `packages/pg-prime-kit/test/e2e/loop.test.ts` — check is green after verify; catches a database tampered with behind history.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/cli/authoring.test.ts`. Needs a real server (`PG_PRIME_TEST_URL`); builds `dist/` in `globalSetup`.
- `packages/pg-prime-kit/test/cli/verify-declared.test.ts` — exit 3 on a stale lane and on a hand file that creates a declared policy.
- Uncovered: exit 2, `--no-schema`, `--strict-unmodeled`, the `generate_failed` error envelope.
