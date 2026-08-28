#!/usr/bin/env node
/**
 * The `pg-prime` binary. tsc preserves this shebang into `dist/cli.js` and
 * `tools/build-package.mjs` sets the mode bit; `tools/pack-smoke.mjs` proves both by
 * running `pg-prime --help` out of the installed tarball.
 *
 * `process.exitCode` rather than `process.exit()`: `exit()` truncates a pipe that has not
 * drained, which for a JSON envelope on a slow stdout means a consumer parsing half a
 * document. Assigning the code lets Node finish the event loop and flush.
 */
import { main } from "./cli/main.js";

process.exitCode = await main(process.argv.slice(2));
