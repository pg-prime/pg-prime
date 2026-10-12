# packages/pg-prime-kit/src/cli/commands/verify.ts

## Purpose
`pg-prime migrate verify`: provisions an ephemeral database, replays every migration from empty through the real runner, applies repeatables, extracts the result, and asserts it diffs empty against IR(desired) or the live target. Catches "the committed file does not do what the schema says". Registered at `packages/pg-prime-kit/src/cli/main.ts:147`; callees are `provisionShadow`, `applyPending`, `extractCatalog`, `diffIR`, `loadSchema`, `loadDesired`, `shadowRepeatables`, `applyRepeatables`, `declaredCensus`, `readLaneState`, `listCheckpoints` and `createRepeatablesPass`.

## Public API
- `VERIFY_OPTIONS: readonly OptionSpec[]` — `--to <id>`, `--shadow <url>`, `--from-checkpoint`, `--keep`, `--against <schema|target>`.
- `runVerify(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput>` — status `verified`/`replayed` (exit 0), `drift` (exit 4), or `refused`/`unavailable`/`replay_failed`/`error` (exit 1).

## Flow
1. `--from-checkpoint` with no checkpoint on disk is refused (`packages/pg-prime-kit/src/cli/commands/verify.ts:106`).
2. `--against` defaults to `schema`, or `target` when the config names no schema; anything else is refused, as is `schema` without schema paths (`packages/pg-prime-kit/src/cli/commands/verify.ts:131`).
3. Provision the replay database: `--shadow <url>`, else `"createdb"`; failure is `unavailable` (`packages/pg-prime-kit/src/cli/commands/verify.ts:147`).
4. A tier-3 (temp-schema) result is disposed and reported `unavailable` (`packages/pg-prime-kit/src/cli/commands/verify.ts:164`).
5. `applyPending` into the replay database with `appliedFrom: "migrate-verify"`, `checkpoints: "auto"` only under `--from-checkpoint` (else `"ignore"`), and optional `to` (`packages/pg-prime-kit/src/cli/commands/verify.ts:176`).
6. A replay status other than `applied`/`up_to_date` is `replay_failed` (`packages/pg-prime-kit/src/cli/commands/verify.ts:184`).
7. Extract the replayed IR with `observe: false`, run `declaredCensus` over the repeatables on disk, and warn `rls_no_policies` for each RLS-enabled table without a policy (`packages/pg-prime-kit/src/cli/commands/verify.ts:191`, `:195`).
8. `target`: extract the live database and diff replayed → live (`packages/pg-prime-kit/src/cli/commands/verify.ts:209`).
9. `schema`: load the TS schema, provision a temp-schema shadow inside the replay database, `loadDesired` (plus hand repeatables and the rendered declared lane via `afterLoad`), and diff replayed → desired (`packages/pg-prime-kit/src/cli/commands/verify.ts:218`).
10. Deltas render as `<op> <encoded id>`; exit 0 when there are no deltas and no census findings, or when `--to` was given, else 4 (`packages/pg-prime-kit/src/cli/commands/verify.ts:247`).
11. `finally` disposes the replay database unless `--keep` (`packages/pg-prime-kit/src/cli/commands/verify.ts:302`).

## Gotchas
- Fails rather than skips when no ephemeral database is available; the role needs `CREATEDB` or `--shadow` must name a throwaway database (`packages/pg-prime-kit/src/cli/commands/verify.ts:159`).
- Replays through `applyPending`, not `applySegments`, so directives, markers, txmode dispatch, the fingerprint gate and history bookkeeping are all exercised (`packages/pg-prime-kit/src/cli/commands/verify.ts:12`).
- Checkpoints are ignored by default: a fresh replay database would otherwise always jump to the newest checkpoint and report a partial replay as full (`packages/pg-prime-kit/src/cli/commands/verify.ts:98`).
- `--to` is a bisect: non-empty deltas still exit 0 and status is `replayed` (`packages/pg-prime-kit/src/cli/commands/verify.ts:253`).
- IR(desired) is normalized in temp schemas inside the replay database, so one database suffices for a restricted role (`packages/pg-prime-kit/src/cli/commands/verify.ts:216`).
- `ConfigError` maps to `refused`; every other throw after provisioning is caught and reported as `error`, exit 1 (`packages/pg-prime-kit/src/cli/commands/verify.ts:299`).
- `--shadow` here accepts only a URL; there is no `temp-schema` replay.
- `rls_no_policies` warnings are reported in `warnings` and never change the exit code.

## Tests
- `packages/pg-prime-kit/test/cli/authoring.test.ts` — replays from empty; `--from-checkpoint` with none on disk refused; exit 4 when a committed migration diverges from the schema; goldens `test/cli/golden/verify.{verified,refused,drift}.json`.
- `packages/pg-prime-kit/test/checkpoint/checkpoint.test.ts` — full replay and `--from-checkpoint` converge.
- `packages/pg-prime-kit/test/corpus-thirdparty.test.ts` — `--against target --keep` after `baseline`.
- `packages/pg-prime-kit/test/e2e/loop.test.ts` — verify replays the whole repository (run with a superuser `--url`, since the loop role lacks `CREATEDB`).
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/cli/authoring.test.ts`. Needs a real server (`PG_PRIME_TEST_URL`).
- `packages/pg-prime-kit/test/cli/verify-declared.test.ts` — the replay finds every declared marker; goldens carry `census` and `warnings`.
- Uncovered: `--to` bisect, the tier-3 `unavailable` refusal, `replay_failed`.
