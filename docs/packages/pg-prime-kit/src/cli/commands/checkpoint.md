# packages/pg-prime-kit/src/cli/commands/checkpoint.ts

## Purpose
`pg-prime migrate checkpoint`: introspects the live database and writes a full-schema `NNNN_checkpoint.sql`, its `.plan.json`, and `checkpoints/NNNN.ir.json`, which a fresh database jumps to on `apply`. Read-only against the database. Registered at `packages/pg-prime-kit/src/cli/main.ts:189`; callees are `buildCheckpoint`, `writeCheckpoint`, `listCheckpoints` and `CHECKPOINT_NAME` from `src/checkpoint/checkpoint.ts`, and `MIGRATION_FILE` from `src/runner/files.ts`.

## Public API
- `CHECKPOINT_OPTIONS: readonly OptionSpec[]` — `--seq <n>`, `--by <name>`, `--dry-run`.
- `runCheckpoint(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput>` — status `written` or `dry_run` (exit 0), `refused` (exit 1, error code `checkpoint_refused`).
- `CHECKPOINT_SUMMARY: string` — a one-line description of the three files written; not referenced elsewhere in the repo.

## Flow
1. Refuse when `config.hasConnection` is false (`packages/pg-prime-kit/src/cli/commands/checkpoint.ts:80`).
2. `seq` is `--seq` or one past the highest `NNNN` matched by `MIGRATION_FILE` in the migrations dir (`-1 + 1 = 0` when the dir is missing); non-integer or negative is refused (`packages/pg-prime-kit/src/cli/commands/checkpoint.ts:87`).
3. `listCheckpoints` records the existing checkpoints, reported as `supersedes` (`packages/pg-prime-kit/src/cli/commands/checkpoint.ts:92`).
4. `buildCheckpoint` on one client with the managed schemas, `seq` and optional `by` (`packages/pg-prime-kit/src/cli/commands/checkpoint.ts:95`).
5. Any `error`-severity diagnostic refuses the checkpoint; non-`info` ones become `warnings` (`packages/pg-prime-kit/src/cli/commands/checkpoint.ts:103`).
6. `--dry-run` returns the SQL in the envelope and as text, writing nothing (`packages/pg-prime-kit/src/cli/commands/checkpoint.ts:112`).
7. Otherwise `writeCheckpoint` writes the three files and the envelope lists their paths (`packages/pg-prime-kit/src/cli/commands/checkpoint.ts:133`).
8. An `EEXIST` from the write becomes a refusal telling the user to pass `--seq`; any other throw is a refusal carrying its message (`packages/pg-prime-kit/src/cli/commands/checkpoint.ts:167`).

## Gotchas
- Records nothing: the `pgprime.checkpoints` row is written by `apply` when a fresh database actually jumps to the checkpoint (`packages/pg-prime-kit/src/cli/commands/checkpoint.ts:8`).
- Every error inside the `try` (including connection failures) is caught and reported as `refused` with exit 1 rather than thrown (`packages/pg-prime-kit/src/cli/commands/checkpoint.ts:174`).
- The `hasConnection` guard is defensive: through `main`, `resolveConfig` already throws a `ConfigError` for a missing connection because only `lint` sets `needsConnection: false` (`packages/pg-prime-kit/src/config/load.ts:496`).
- `nextSeq` duplicates the one in `generate.ts`; both count every file `MIGRATION_FILE` matches.
- Nothing is deleted: older migrations stay on disk and existing databases continue linearly.

## Tests
- `packages/pg-prime-kit/test/checkpoint/checkpoint.test.ts` — writes the three files and records nothing (golden `test/cli/golden/checkpoint.written.json`); existing database records it superseded; fresh database applies checkpoint plus tail; `verify --from-checkpoint` converges; fingerprint mismatch names drifted objects.
- `packages/pg-prime-kit/test/cli/usage.test.ts` — help page.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/checkpoint/checkpoint.test.ts`. Needs a real server (`PG_PRIME_TEST_URL`).
- Uncovered: `--dry-run`, the `EEXIST` refusal, the fatal-diagnostic refusal.
