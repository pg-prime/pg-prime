# packages/pg-prime-kit/src/cli/commands/check.ts

## Purpose
`pg-prime migrate check`, the CI gate: answers (a) would `generate` produce a diff the pending migrations do not account for, (b) do checksums match and are recorded files on disk, (c) are migrations pending — as one exit code. Registered at `packages/pg-prime-kit/src/cli/main.ts:137`; callees are `readMigrationsDir`, `migrationStatus` (`packages/pg-prime-kit/src/runner/status.ts:105`), `loadSchema`, `generate` and `shadowStrategy` from `./generate.ts`.

## Public API
- `CHECK_OPTIONS: readonly OptionSpec[]` — `--shadow <url|temp-schema|createdb>`, `--strict-unmodeled`, `--no-schema`.
- `runCheck(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput>` — status `ok`/`error`/`missing_hints`/`lint`/`drift`/`pending` with exit 0/1/2/3/4/5.

## Flow
1. Read the migrations directory and run `migrationStatus` with the repeatables pass (`packages/pg-prime-kit/src/cli/commands/check.ts:51`).
2. Question (a) runs only when `--no-schema` is absent and the config names schema paths (`packages/pg-prime-kit/src/cli/commands/check.ts:63`).
3. Load the schema and call `generate` with `seq: 0`, `name: "check"`, `multiFile: false`, `prove: false`; `--shadow` wins over `config.config.shadow` (`packages/pg-prime-kit/src/cli/commands/check.ts:66`).
4. The diff is "accounted for" when there are pending migrations and the last file's `plan.to.fingerprint` equals `result.desiredIR.fingerprint` (`packages/pg-prime-kit/src/cli/commands/check.ts:101`).
5. `schemaDrift` is `[]` when the diff is empty or accounted for, otherwise every generated statement's SQL (`packages/pg-prime-kit/src/cli/commands/check.ts:105`).
6. Collect `unresolved` and unacknowledged error-severity `hazards` from the generated plans (`packages/pg-prime-kit/src/cli/commands/check.ts:109`).
7. `OfflineShadowError`, `GenerateRefusedError` and `ConfigError` become `generateError`; anything else is rethrown (`packages/pg-prime-kit/src/cli/commands/check.ts:115`).
8. Exit precedence: 1 generate error, 2 unresolved, 3 hazards, 4 checksum/missing-file or schema drift, 5 pending, else 0 (`packages/pg-prime-kit/src/cli/commands/check.ts:124`).
9. Envelope carries `schemaChecked`, `schemaDrift`, `checksumDrift`, `missingFiles`, `pending`, `repeatableDrift`, `unresolved`, `hazards`; text lists at most 20 would-generate statements (`packages/pg-prime-kit/src/cli/commands/check.ts:150`).

## Gotchas
- No history writes, no lock, no `ensureHistory` — but the shadow is still provisioned, and on tier 3 that creates and drops a temp schema inside the target database; pass `--shadow <url>` to avoid it (`packages/pg-prime-kit/src/cli/commands/check.ts:10`).
- With nothing pending, any non-empty diff is exit 4, whether the database or the schema moved (`packages/pg-prime-kit/src/cli/commands/check.ts:97`).
- `schemaDrift` is `null` (not `[]`) when the schema was not or could not be checked; the text then says "not checked" or "could not be checked".
- `repeatableDrift` is reported but never affects the exit code.
- A config with no `schema` silently skips question (a); `schemaChecked` is `false`.
- The `--shadow` parser is shared with `generate` and `push` via `shadowStrategy` so the three cannot disagree (`packages/pg-prime-kit/src/cli/commands/check.ts:32`).

## Tests
- `packages/pg-prime-kit/test/cli/authoring.test.ts` — pending, then ok, then drift when the schema moves ahead; goldens `test/cli/golden/check.{ok,pending,drift}.json`.
- `packages/pg-prime-kit/test/e2e/loop.test.ts` — check is green after verify; catches a database tampered with behind history.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/cli/authoring.test.ts`. Needs a real server (`PG_PRIME_TEST_URL`); builds `dist/` in `globalSetup`.
- Uncovered: exit 2 and 3 paths, `--no-schema`, `--strict-unmodeled`, the `generate_failed` error envelope.
