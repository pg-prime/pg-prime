# packages/pg-prime-kit/src/cli/commands/unlock.ts

## Purpose
`pg-prime migrate unlock [--force]`: inspects the migration lease row and, with `--force`, deletes it. It breaks the lease row only, never a live session advisory lock. Registered at `packages/pg-prime-kit/src/cli/main.ts:181`; callees are `inspectLease` and `forceUnlock` (`packages/pg-prime-kit/src/runner/run.ts:1234`, `packages/pg-prime-kit/src/runner/run.ts:1244`).

## Public API
- `UNLOCK_OPTIONS: readonly OptionSpec[]` — `--force`, `--stale-lock-after <duration>`.
- `runUnlock(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput>` — status `no_lock`, `released` or `stale` (exit 0), or `held` (exit 6).

## Flow
1. `staleAfter` is the flag, else `config.config.staleLockAfterMs` (`packages/pg-prime-kit/src/cli/commands/unlock.ts:32`).
2. On one client, `inspectLease(client, staleAfter)` reads the lease before any change (`packages/pg-prime-kit/src/cli/commands/unlock.ts:35`).
3. With `--force`, `forceUnlock` deletes the lease row and reports whether one was removed (`packages/pg-prime-kit/src/cli/commands/unlock.ts:36`).
4. Status: `no_lock` when there was no lease, `released` when deleted, `stale` when stale and kept, else `held` (`packages/pg-prime-kit/src/cli/commands/unlock.ts:38`).
5. Exit 6 (`EXIT.locked`) only for `held`; everything else exits 0 (`packages/pg-prime-kit/src/cli/commands/unlock.ts:41`).
6. The envelope reports the pre-change holder, staleness and `forced`/`released`; `note` warns when a non-stale lease was released (`packages/pg-prime-kit/src/cli/commands/unlock.ts:58`).

## Gotchas
- `--force` deletes the lease row whether or not it is stale; only the `note` field flags a fresh one (`packages/pg-prime-kit/src/cli/commands/unlock.ts:59`).
- A live holder's session lock is untouched; releasing a fresh lease does not let a second deploy in while the holder's backend is alive (`packages/pg-prime-kit/src/cli/commands/unlock.ts:4`).
- `held` exits non-zero on purpose so an orchestrator can use `unlock` (without `--force`) as a "is a deploy running?" probe (`packages/pg-prime-kit/src/cli/commands/unlock.ts:39`).
- Both helpers return a null lease / `false` when the `pgprime` history is absent, so the command never creates history (`packages/pg-prime-kit/src/runner/run.ts:1238`, `packages/pg-prime-kit/src/runner/run.ts:1245`).
- `holder`, `stale` and `staleAfterMs` describe the state before the force, not after.
- `--stale-lock-after 0ms` is honoured (`??`, not truthiness), making any lease stale; without flag or config, `inspectLease` applies its own default (`packages/pg-prime-kit/src/runner/run.ts:1236`).

## Tests
- `packages/pg-prime-kit/test/cli/envelope.test.ts` — the full sequence on one lease: `no_lock`, `held` (exit 6), `stale` via `--stale-lock-after 0ms`, `released` via `--force` on a fresh lease (golden pins the `note`), then `no_lock` again; goldens `test/cli/golden/unlock.{free,released}.json`.
- `packages/pg-prime-kit/test/cli/usage.test.ts` — help page.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/cli/envelope.test.ts`. Needs a real server (`PG_PRIME_TEST_URL`).
- Uncovered: `--force` against a stale lease (no `note`), `--force` with no history present.
