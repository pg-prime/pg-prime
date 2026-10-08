# packages/pg-prime-kit/src/cli.ts

## Purpose
The `pg-prime` binary entry point (`bin` in `packages/pg-prime-kit/package.json` points at the emitted `dist/cli.js`).
It forwards `process.argv` to `main` in `packages/pg-prime-kit/src/cli/main.ts` and sets the process exit code from its result.
Nothing imports it; it is run by Node, by the CLI tests (`packages/pg-prime-kit/test/support/cli.ts`) and by `tools/pack-smoke.mjs`.

## Public API
- none — the module has no exports; importing it runs the CLI as a top-level `await`.

## Flow
1. The `#!/usr/bin/env node` shebang (`packages/pg-prime-kit/src/cli.ts:1`) is preserved by tsc into `dist/cli.js`; `tools/build-package.mjs` sets the executable bit.
2. `main(process.argv.slice(2))` runs with the default `CliIo` (real stdout/stderr, `process.env`, `process.cwd()`).
3. The returned code is assigned to `process.exitCode` (`packages/pg-prime-kit/src/cli.ts:13`) and Node exits once the event loop drains.

## Gotchas
- `process.exitCode` is assigned instead of calling `process.exit()`, so a large `--output json` envelope on a slow pipe is fully flushed before exit.
- Only the built file is runnable: the source imports `./cli/main.js`, which Node's type stripping does not map to `main.ts`, so tests build `dist/` first (`packages/pg-prime-kit/test/globalSetup.ts`).
- The shebang and exec bit surviving `pnpm pack` are checked by `tools/pack-smoke.mjs:282`, which runs `pg-prime --help` from the installed tarball.

## Tests
- Every CLI spec spawns `node dist/cli.js` through `runCli`/`spawnCli` in `packages/pg-prime-kit/test/support/cli.ts`, so this file is exercised by all of `packages/pg-prime-kit/test/cli/*.test.ts`.
- Server-free coverage: `pnpm --filter @pg-prime/kit exec vitest run test/cli/usage.test.ts`.
- The installed-tarball path (shebang, exec bit) is covered only by `node tools/pack-smoke.mjs`, not by vitest.
