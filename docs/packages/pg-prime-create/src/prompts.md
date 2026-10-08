# packages/pg-prime-create/src/prompts.ts

## Purpose
Turns parsed `CliOptions` plus an optional terminal into a fully resolved `ProjectPlan`, asking only for what argv left unset and applying defaults otherwise. Called by `main` (`packages/pg-prime-create/src/main.ts:64`); calls `detectPackageManager` (`packages/pg-prime-create/src/args.ts:53`) and `packageNameFor` (`packages/pg-prime-create/src/scaffold.ts:140`). Not re-exported from `index.ts`.

## Public API
- `Ask` — `(question: string) => Promise<string>`.
- `PromptIo` — `{ ask: Ask | undefined; cwd: string; env: Readonly<Record<string, string | undefined>> }`; `ask: undefined` means no terminal.
- `ProjectPlan` — `{ dir (absolute), name, testing, packageManager, install, git }`; `ScaffoldOptions` plus the two side effects.
- `DEFAULT_DIR` — `'pg-prime-app'`.
- `resolveOptions(cli, io): Promise<ProjectPlan>` — asks the missing questions (if allowed) and returns the plan.

## Flow
1. `packageManager` = `--pm` or `detectPackageManager(env.npm_config_user_agent)`; never asked (`packages/pg-prime-create/src/prompts.ts:67`).
2. `ask` is disabled when `--yes` is set, and is `undefined` already when stdin is not a TTY (`:68`).
3. With `ask`, in order and only for `undefined` values: directory (empty → `DEFAULT_DIR`), test fixture, install with `<pm>`, git init (`:75-88`).
4. Yes/no answers go through `yesNo`: `y`/`yes`/`n`/`no` case-insensitive, anything else (including typos) → the default `true` (`:52-57`).
5. Unset values default to `DEFAULT_DIR` and `true` for `testing`, `install`, `git` (`:92`, `:97-100`).
6. The directory is resolved against `io.cwd` unless absolute, then `name` is derived from the absolute path, so `.` is named after the cwd (`:90-96`).

## Gotchas
- A non-TTY run never prompts; it takes `DEFAULT_DIR` if no directory was given.
- A typo in a yes/no answer silently becomes "yes"; there is no re-ask.
- `PromptIo` deliberately avoids stream types: `tools/check-dts.mjs` compiles the emitted `.d.ts` with `types: []` and asserts it names no external module (`:9-15`).
- The directory answer is trimmed; flags given in argv are never re-asked.

## Tests
- `packages/pg-prime-create/test/scaffold.test.ts` (`resolveOptions` block, with a string-backed `fakeIo`): no questions on non-TTY or with `--yes`, asking only what argv left open and accepting `n`, not asking about decided flags, `npm_config_user_agent` detection and `--pm` override.
- Run: `pnpm --filter @pg-prime/create exec vitest run test/scaffold.test.ts`.
- Uncovered: unrecognised yes/no answers falling back to the default.
